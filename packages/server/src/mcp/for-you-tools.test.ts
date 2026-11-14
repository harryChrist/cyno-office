import { legacyForYouTypes, type ForYouItem, type OfficeState, type ServerEvent } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { ForYouService } from "../workspace/for-you/service";
import type { StateManager } from "../store/state-manager";
import { forYouTools } from "./for-you-tools";

const AT = "2026-11-09T10:00:00.000Z";

const OFFICE = {
  rooms: [],
  teams: [],
  agents: [
    { id: "maestro", name: "Maestro" },
    { id: "clara", name: "Clara" },
  ],
  tasks: [{ id: "t-clara", agentId: "clara", status: "waiting_approval", projectId: "req" }],
} as unknown as OfficeState;

const base = { roomId: "r", meta: {}, editedByUser: false, createdAt: AT } as const;
const ITEMS: ForYouItem[] = [
  {
    ...base,
    id: "A-0001",
    agentId: "maestro",
    type: "pergunta",
    status: "pendente",
    kind: "questionario",
    title: "Detalhes do post",
    text: "",
    originalText: "",
    questions: [
      { id: "q1", text: "Qual o público?" },
      { id: "q2", text: "Qual o tom?" },
    ],
    answers: { q1: { text: "devs" }, q2: { text: "leve" } },
  },
  { ...base, id: "A-0002", agentId: "clara", taskId: "t-clara", type: "convite", status: "pendente", why: "Posso mandar?", text: "rascunho", originalText: "rascunho" },
  { ...base, id: "A-0003", agentId: "clara", taskId: "t-velha", type: "post", status: "pendente", why: "De outra tarefa", text: "x", originalText: "x" },
  { ...base, id: "A-0004", agentId: "maestro", type: "pergunta", status: "respondido", text: "y", originalText: "y" },
  { ...base, id: "A-0005", agentId: "maestro", type: "outro", status: "pendente", kind: "plano", text: "plano", originalText: "plano" },
];

function setup() {
  let items = structuredClone(ITEMS);
  const release = vi.fn();
  const state = {
    read: () => OFFICE,
    readForYou: () => items,
    commit: async (change: { forYou?: ForYouItem[]; events?: ServerEvent[] }) => {
      if (change.forYou) items = change.forYou;
    },
  } as unknown as StateManager;
  const forYou = new ForYouService({ state, log: { error: vi.fn() }, now: () => new Date(AT), types: { ensure: (type?: string) => type ?? "outro", resolve: (type?: string) => type ?? "outro", list: () => [] }, decideTask: vi.fn(), release });
  const types = { list: () => legacyForYouTypes(AT), define: vi.fn() };
  const deps = { state: { read: () => OFFICE }, forYou, types };
  const maestro = forYouTools({ actor: "maestro" }, deps);
  const clara = forYouTools({ actor: "agente", agentId: "clara", currentTaskId: () => "t-clara" }, deps);
  const run = async (tools: typeof maestro, name: string, args: Record<string, unknown>) => {
    const tool = tools.find((candidate) => candidate.name === name)!;
    return tool.call(tool.input.parse(args));
  };
  return { maestro, clara, run, release, items: () => items };
}

describe("ferramentas do Para você (list/update/cancel_pending_item)", () => {
  it("list: o Maestro vê os pendentes do workspace (com o rascunho das respostas); o agente só os dele nesta tarefa", async () => {
    const { maestro, clara, run } = setup();
    const all = (await run(maestro, "list_pending_items", {})).text;
    expect(all).toContain("A-0001 — questionnaire — “Detalhes do post” · asked by Maestro · pending");
    expect(all).toContain("1. Qual o público? (draft answer: devs)");
    expect(all).toContain("A-0002 — approval");
    expect(all).toContain("A-0003");
    expect(all).not.toContain("A-0004");
    expect((await run(maestro, "list_pending_items", { status: "answered" })).text).toContain("A-0004");
    expect((await run(maestro, "list_pending_items", { kind: "plan" })).text).toContain("A-0005");
    const mine = (await run(clara, "list_pending_items", { status: "all" })).text;
    expect(mine).toContain("A-0002");
    expect(mine).not.toContain("A-0001");
    expect(mine).not.toContain("A-0003");
  });

  it("update (Maestro): troca as perguntas de um questionário, mantém o rascunho da que ficou igual e marca quem alterou", async () => {
    const { maestro, run, items } = setup();
    const result = await run(maestro, "update_pending_item", {
      id: "A-0001",
      questions: [{ question: "Qual o público?" }, { question: "Qual a cor da marca?", options: ["azul", "verde"] }],
      reason: "o usuário pediu para trocar a pergunta 2",
    });
    expect(result).toEqual({ text: expect.stringContaining("Item A-0001 updated. 1 of 2 draft answer(s) kept.") });
    const item = items().find((candidate) => candidate.id === "A-0001")!;
    expect(item.questions?.map((question) => question.text)).toEqual(["Qual o público?", "Qual a cor da marca?"]);
    expect(item.answers).toEqual({ q1: { text: "devs" } });
    expect(item.history).toEqual([{ at: AT, by: "maestro", action: "alterado", reason: "o usuário pediu para trocar a pergunta 2" }]);
    expect(items()).toHaveLength(ITEMS.length);
  });

  it("update: erros claros em inglês (não pendente, plano, campo do tipo errado, nada para mudar, limite do tipo)", async () => {
    const { maestro, run } = setup();
    expect(await run(maestro, "update_pending_item", { id: "A-0004", title: "x" })).toEqual({ text: expect.stringContaining("already answered: only pending items"), isError: true });
    expect(await run(maestro, "update_pending_item", { id: "A-0005", title: "x" })).toEqual({ text: expect.stringContaining("is a plan approval"), isError: true });
    expect(await run(maestro, "update_pending_item", { id: "A-0002", questions: [{ question: "a" }] })).toEqual({ text: expect.stringContaining("is not a questionnaire"), isError: true });
    expect(await run(maestro, "update_pending_item", { id: "A-0001", text: "a" })).toEqual({ text: expect.stringContaining("is a questionnaire"), isError: true });
    expect(await run(maestro, "update_pending_item", { id: "A-0001" })).toEqual({ text: expect.stringContaining("Nothing to change"), isError: true });
    expect(await run(maestro, "update_pending_item", { id: "A-9999", title: "x" })).toEqual({ text: expect.stringContaining("does not exist"), isError: true });
    const over = await run(maestro, "update_pending_item", { id: "A-0002", text: "x".repeat(300) });
    expect(over.isError).toBe(true);
    expect(over.text).toContain("call update_pending_item again");
  });

  it("agente: altera e cancela só os itens que criou na tarefa atual", async () => {
    const { clara, run, release, items } = setup();
    expect(await run(clara, "update_pending_item", { id: "A-0001", title: "x" })).toEqual({ text: expect.stringContaining("is not yours"), isError: true });
    expect(await run(clara, "cancel_pending_item", { id: "A-0003", reason: "x" })).toEqual({ text: expect.stringContaining("is not yours"), isError: true });
    expect((await run(clara, "update_pending_item", { id: "A-0002", text: "rascunho novo", reason: "corrigi um erro" })).isError).toBeUndefined();
    expect(items().find((item) => item.id === "A-0002")).toMatchObject({ text: "rascunho novo", history: [expect.objectContaining({ by: "agente" })] });
    const cancelled = await run(clara, "cancel_pending_item", { id: "A-0002", reason: "não precisa mais" });
    expect(cancelled.text).toContain("continue in this turn");
    expect(items().find((item) => item.id === "A-0002")).toMatchObject({ status: "cancelado", cancelledBy: "agente", cancelReason: "não precisa mais" });
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ id: "A-0002" }), { by: "agente", reason: "não precisa mais" }, "t-clara");
  });

  it("cancel (Maestro): exige motivo; item já cancelado volta erro; plano não se cancela por aqui", async () => {
    const { maestro, run, items } = setup();
    expect(() => maestro.find((tool) => tool.name === "cancel_pending_item")!.input.parse({ id: "A-0001" })).toThrow();
    expect((await run(maestro, "cancel_pending_item", { id: "A-0001", reason: "mandei duplicado" })).text).toContain("Item A-0001 cancelled (moved to Cancelados).");
    expect(items().find((item) => item.id === "A-0001")).toMatchObject({ status: "cancelado", cancelledBy: "maestro" });
    expect(await run(maestro, "cancel_pending_item", { id: "A-0001", reason: "de novo" })).toEqual({ text: expect.stringContaining("already cancelled"), isError: true });
    expect(await run(maestro, "cancel_pending_item", { id: "A-0005", reason: "x" })).toEqual({ text: expect.stringContaining("is a plan approval"), isError: true });
  });
});
