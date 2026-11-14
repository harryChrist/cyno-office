import type { ForYouItem, OfficeState, ServerEvent, Task } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import type { StateManager } from "../../store/state-manager";
import { ForYouService, type AutoVerdict } from "./service";

const AT = "2026-11-11T12:00:00.000Z";
const OFFICE = { rooms: [], teams: [], agents: [{ id: "eco", name: "Eco" }], tasks: [] } as unknown as OfficeState;
const task = (extra: Partial<Task> = {}) => ({ id: "t1", roomId: "r", agentId: "eco", work: { projectId: "p1", step: 0, ref: "T1" }, ...extra }) as unknown as Task;

/** Modo Automático falso: libera só os tipos dados, até o teto, e conta (como o ProjectService faz). */
function setup(options: { actions: string[]; cap: number }) {
  let items: ForYouItem[] = [];
  const state = {
    read: () => OFFICE,
    readForYou: () => items,
    commit: async (change: { forYou?: ForYouItem[]; events?: ServerEvent[] }) => {
      if (change.forYou) items = change.forYou;
    },
  } as unknown as StateManager;
  let used = 0;
  const decided: string[] = [];
  const approved: string[][] = [];
  const service = new ForYouService({
    state,
    log: { error: vi.fn() },
    now: () => new Date(AT),
    types: { ensure: (type?: string) => type ?? "outro", resolve: (type?: string) => type ?? "outro", list: () => [] },
    decideTask: vi.fn(),
    media: { linkForYou: vi.fn(), approve: (ids) => void approved.push([...ids]) },
    autoReserve: (_task, type): AutoVerdict => {
      if (!options.actions.includes(type)) return { ok: false, note: `O tipo “${type}” não está liberado no Automático` };
      if (used >= options.cap) return { ok: false, note: `Teto de ${options.cap} por dia atingido` };
      used += 1;
      return { ok: true, projectId: "p1", label: `${used} de ${options.cap} hoje` };
    },
    onAutoDecided: (item, _task, label) => void decided.push(`${item.id}:${label}`),
  });
  return { service, items: () => items, decided, approved };
}

const draft = (type: string, text: string) => ({ question: `Pode ${text}?`, draft: { type, text, where: "Post X" } });

describe("Modo Automático: decisão automática dos itens", () => {
  it("tipo liberado: o item nasce aprovado, decidedBy automatico, e o agente recebe a aprovação na hora", () => {
    const { service, decided } = setup({ actions: ["comentario"], cap: 8 });
    const item = service.open(task(), draft("comentario", "oi"));
    expect(item).toMatchObject({ status: "aprovado", decidedBy: "automatico", text: "oi", decidedAt: AT });
    expect(item.meta["Modo Automático"]).toBe("Decidido sozinho (1 de 8 hoje)");
    expect(service.autoDecision(task(), [item])).toEqual({ approved: true, text: "oi", itemId: item.id });
    expect(decided).toEqual([`${item.id}:1 de 8 hoje`]);
  });

  it("tipo fora do grant: fica pendente com a nota do motivo e não segue sozinho", () => {
    const { service, decided } = setup({ actions: ["comentario"], cap: 8 });
    const item = service.open(task(), draft("convite", "oi"));
    expect(item.status).toBe("pendente");
    expect(item.decidedBy).toBeUndefined();
    expect(item.meta["Modo Automático"]).toContain("não está liberado");
    expect(service.autoDecision(task(), [item])).toBeUndefined();
    expect(decided).toEqual([]);
  });

  it("lote com itens dentro e fora (teto 2 de 3): 2 decididos sozinhos, o 3º pede OK com a nota do teto; a decisão só sai quando todos estão decididos", () => {
    const { service, items } = setup({ actions: ["comentario"], cap: 2 });
    const created = service.openMany(task(), { question: "Lote", items: [draft("comentario", "a"), draft("comentario", "b"), draft("comentario", "c")] });
    expect(created.map((item) => item.status)).toEqual(["aprovado", "aprovado", "pendente"]);
    expect(created[2]!.meta["Modo Automático"]).toBe("Teto de 2 por dia atingido");
    expect(new Set(created.map((item) => item.groupId)).size).toBe(1);
    expect(service.autoDecision(task(), created)).toBeUndefined();
    expect(items()).toHaveLength(3);
  });

  it("lote inteiro dentro do grant: uma decisão agregada com o texto de cada item", () => {
    const { service } = setup({ actions: ["comentario"], cap: 5 });
    const created = service.openMany(task(), { question: "Lote", items: [draft("comentario", "a"), draft("comentario", "b")] });
    const decision = service.autoDecision(task(), created);
    expect(decision?.approved).toBe(true);
    expect(decision?.items?.map((entry) => [entry.status, entry.text])).toEqual([
      ["approved", "a"],
      ["approved", "b"],
    ]);
  });

  it("pergunta (ask_user) nunca é decidida sozinha e tarefa sem projeto não passa pelo Automático", () => {
    const { service } = setup({ actions: ["pergunta", "comentario"], cap: 5 });
    const asked = service.open(task(), { question: "Qual o tom?", questions: [{ id: "q1", text: "Qual o tom?" }] });
    expect(asked.status).toBe("pendente");
    const loose = service.open(task({ work: undefined }), draft("comentario", "x"));
    expect(loose.status).toBe("pendente");
    expect(loose.meta["Modo Automático"]).toBeUndefined();
  });

  it("a mídia em rascunho do item decidido sozinho é aprovada", () => {
    const { service, approved } = setup({ actions: ["comentario"], cap: 5 });
    service.open(task(), { question: "Q", draft: { type: "comentario", text: "t", mediaIds: ["M-0001"] } });
    expect(approved).toEqual([["M-0001"]]);
  });
});
