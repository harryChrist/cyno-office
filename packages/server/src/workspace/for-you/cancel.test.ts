import type { ApiErrorBody, ForYouItem, ForYouQuestion, OfficeState, ServerEvent, Task } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { call, createTask, getOffice, soloTeam, wsApi } from "../../dev/test-api";
import { useTestApp, type TestApp } from "../../dev/test-app";
import type { StateManager } from "../../store/state-manager";
import { ForYouService, remapAnswers } from "./service";

const setupApp = useTestApp();

type App = TestApp["app"];

const cancelItem = (app: App, id: string, body: { reason?: string } = {}, status = 200) => call<ForYouItem>(app, "POST", `${wsApi()}/for-you/${id}/cancel`, body, status);

async function waitingTask(setup: TestApp, prompt: string) {
  const { room, team } = await soloTeam(setup.app, "Solo");
  const task = await createTask(setup.app, room.id, team.id, prompt);
  await setup.log.waitForTask(task.id, "waiting_approval");
  const event = await setup.log.waitFor((e) => e.type === "foryou:upserted" && e.item.taskId === task.id);
  return { task, item: (event as Extract<ServerEvent, { type: "foryou:upserted" }>).item };
}

const taskOf = async (app: App, id: string): Promise<Task> => (await getOffice(app)).tasks.find((task) => task.id === id)!;

describe("Para você: Descartar (POST /for-you/:id/cancel)", () => {
  it("o item vai para cancelado com o motivo; a tarefa que ele segurava segue sem a resposta", async () => {
    const setup = await setupApp();
    const { task, item } = await waitingTask(setup, "Post sobre o evento [aprovar]");
    const cancelled = await cancelItem(setup.app, item.id, { reason: "  já resolvi na conversa " });
    expect(cancelled).toMatchObject({ status: "cancelado", cancelledBy: "usuario", cancelReason: "já resolvi na conversa" });
    expect(cancelled.decidedAt).toBeDefined();
    expect(cancelled.history).toEqual([expect.objectContaining({ by: "usuario", action: "cancelado", reason: "já resolvi na conversa" })]);
    expect(setup.log.events.some((event) => event.type === "foryou:upserted" && event.item.id === item.id && event.item.status === "cancelado")).toBe(true);

    await setup.log.waitForTask(task.id, "done");
    const done = await taskOf(setup.app, task.id);
    expect(done.result).toContain("### Sem aprovação");
    expect(done.result).toContain("descartado pelo usuário (já resolvi na conversa)");
    expect(done.result).not.toContain("### Texto aprovado");
  });

  it("sem motivo também vale; descartar de novo, decidir ou reabrir um cancelado dá 409", async () => {
    const setup = await setupApp();
    const { item } = await waitingTask(setup, "Convite para a Ana [aprovar]");
    const cancelled = await cancelItem(setup.app, item.id);
    expect(cancelled.cancelReason).toBeUndefined();
    expect(((await cancelItem(setup.app, item.id, {}, 409)) as unknown as ApiErrorBody).error).toContain("já foi decidido ou cancelado");
    await call(setup.app, "POST", `${wsApi()}/for-you/${item.id}/decision`, { status: "aprovado" }, 409);
    const reopen = await call<ApiErrorBody>(setup.app, "POST", `${wsApi()}/for-you/${item.id}/decision`, { status: "pendente" }, 409);
    expect(reopen.error).toContain("não reabre");
  });

  it("validação: motivo longo ou campo extra dá 400; item inexistente 404; decidir como cancelado não existe", async () => {
    const setup = await setupApp();
    await cancelItem(setup.app, "A-9999", {}, 404);
    await call(setup.app, "POST", `${wsApi()}/for-you/A-0001/cancel`, { reason: "x".repeat(501) }, 400);
    await call(setup.app, "POST", `${wsApi()}/for-you/A-0001/cancel`, { motivo: "x" }, 400);
    await call(setup.app, "POST", `${wsApi()}/for-you/A-0001/decision`, { status: "cancelado" }, 400);
  });
});

// ---------- ForYouService direto (estado em memória) ----------

const AT = "2026-11-09T10:00:00.000Z";
const q = (id: string, text: string, extra: Partial<ForYouQuestion> = {}): ForYouQuestion => ({ id, text, ...extra });

function serviceWith(items: ForYouItem[], release = vi.fn()) {
  const office = { rooms: [], teams: [], agents: [], tasks: [] } as unknown as OfficeState;
  const events: ServerEvent[] = [];
  const state = {
    read: () => office,
    readForYou: () => items,
    commit: async (change: { forYou?: ForYouItem[]; events?: ServerEvent[] }) => {
      if (change.forYou) items = change.forYou;
      events.push(...(change.events ?? []));
    },
  } as unknown as StateManager;
  const service = new ForYouService({
    state,
    log: { error: vi.fn() },
    now: () => new Date(AT),
    types: { ensure: (type: string) => type, resolve: (type?: string) => type ?? "outro", list: () => [] },
    decideTask: vi.fn(),
    release,
  });
  return { service, events, release, items: () => items };
}

const questionnaire = (overrides: Partial<ForYouItem> = {}): ForYouItem => ({
  id: "A-0001",
  agentId: "maestro",
  roomId: "gerencia",
  type: "pergunta",
  status: "pendente",
  kind: "questionario",
  title: "Detalhes",
  why: "3 pergunta(s); responda no seu tempo e envie tudo de uma vez",
  meta: {},
  text: "",
  originalText: "",
  editedByUser: false,
  questions: [q("q1", "Qual o público?"), q("q2", "Qual o tom?"), q("q3", "Qual o prazo?")],
  answers: { q1: { text: "devs" }, q2: { text: "leve" }, q3: { skipped: true } },
  createdAt: AT,
  ...overrides,
});

describe("update: troca perguntas preservando o rascunho", () => {
  it("remapAnswers: a resposta acompanha a pergunta igual (sem diferença de caixa/espaço), as trocadas somem", () => {
    const before = [q("q1", "Qual o público?"), q("q2", "Qual o tom?"), q("q3", "Qual o prazo?")];
    const next = [q("q1", "Qual o público?"), q("q2", "Qual a cor?"), q("q3", "  qual o   PRAZO? ")];
    expect(remapAnswers(before, { q1: { text: "devs" }, q2: { text: "leve" }, q3: { skipped: true } }, next)).toEqual({ q1: { text: "devs" }, q3: { skipped: true } });
    // Ordem trocada: a resposta vai junto para o id novo.
    expect(remapAnswers(before, { q1: { text: "devs" } }, [q("q1", "Qual o tom?"), q("q2", "Qual o público?")])).toEqual({ q2: { text: "devs" } });
  });

  it("questionário: perguntas novas, rascunho das iguais mantido, contagem do 'por quê', histórico e evento", async () => {
    const { service, events } = serviceWith([questionnaire()]);
    const updated = await service.update("A-0001", { questions: [q("q1", "Qual o público?"), q("q2", "Qual a cor da marca?", { options: ["azul", "verde"] })], reason: "trocar a pergunta 2" }, "maestro");
    expect(updated.questions?.map((question) => question.text)).toEqual(["Qual o público?", "Qual a cor da marca?"]);
    expect(updated.answers).toEqual({ q1: { text: "devs" } });
    expect(updated.why).toBe("2 pergunta(s); responda no seu tempo e envie tudo de uma vez");
    expect(updated.text).toContain("Qual a cor da marca?");
    expect(updated.status).toBe("pendente");
    expect(updated.history).toEqual([{ at: AT, by: "maestro", action: "alterado", reason: "trocar a pergunta 2" }]);
    expect(events).toEqual([{ type: "foryou:upserted", item: updated }]);
  });

  it("aprovação: texto e pergunta novos (o texto novo vira o original); não pendente ou plano dá 409", async () => {
    const approval: ForYouItem = { ...questionnaire(), id: "A-0002", kind: undefined, type: "post", why: "Posso postar?", text: "velho", originalText: "velho", editedByUser: true, questions: undefined, answers: undefined };
    const { service } = serviceWith([approval, { ...approval, id: "A-0003", status: "aprovado" }, { ...approval, id: "A-0004", kind: "plano" }]);
    const updated = await service.update("A-0002", { text: " novo ", question: "Posso postar amanhã?" }, "agente");
    expect(updated).toMatchObject({ text: "novo", originalText: "novo", editedByUser: false, why: "Posso postar amanhã?" });
    expect(updated.history?.[0]).toMatchObject({ by: "agente", action: "alterado" });
    await expect(service.update("A-0003", { text: "x" }, "maestro")).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.update("A-0004", { title: "x" }, "maestro")).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.update("A-0002", { questions: [q("q1", "a")] }, "maestro")).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.update("A-0002", {}, "maestro")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("cancel: grava cancelado e chama o release (sem tarefa esperando: waitingTaskId undefined); plano não", async () => {
    const release = vi.fn();
    const { service } = serviceWith([questionnaire(), questionnaire({ id: "A-0002", kind: "plano" })], release);
    const cancelled = await service.cancel("A-0001", { by: "maestro", reason: "duplicado" });
    expect(cancelled).toMatchObject({ status: "cancelado", cancelledBy: "maestro", cancelReason: "duplicado", decidedAt: AT });
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ id: "A-0001", status: "cancelado" }), { by: "maestro", reason: "duplicado" }, undefined);
    await expect(service.cancel("A-0001", { by: "maestro" })).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.cancel("A-0002", { by: "usuario" })).rejects.toMatchObject({ statusCode: 409 });
    // Respostas de um cancelado não gravam mais.
    await expect(service.saveAnswers("A-0001", { q1: { text: "x" } })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("cancelAllFor: os pendentes do pedido e das subtarefas viram cancelado (planos ficam)", async () => {
    const { service } = serviceWith([
      questionnaire({ id: "A-0001", taskId: "req" }),
      questionnaire({ id: "A-0002", projectId: "req", taskId: "sub" }),
      questionnaire({ id: "A-0003", taskId: "outro" }),
      questionnaire({ id: "A-0004", taskId: "req", kind: "plano" }),
    ]);
    const changed = await service.cancelAllFor(new Set(["req", "sub"]), { by: "maestro", reason: "Pedido cancelado" });
    expect(changed.map((item) => item.id)).toEqual(["A-0001", "A-0002"]);
  });
});
