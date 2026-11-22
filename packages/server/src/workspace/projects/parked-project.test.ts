import type { OfficeState, Project, Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { soloTeam } from "../../dev/test-api";
import { API, gatedSleep, testRunner, useTestApp, type TestApp } from "../../dev/test-app";
import type { TerminalEvent } from "../../engines/terminals/types";
import { resumeOpenRequests } from "../maestro/maestro-resume";
import { CHAT_TAG_PREFIX } from "../maestro/maestro-text";

/**
 * Projeto "estacionado" (status ativo/pausado, todas as folhas abertas Planejadas, nenhuma em andamento nem
 * esperando você): não segura o pedido do Maestro aberto, permite `complete_request`, fecha no fim do turno
 * sem cancelar o projeto, não trava em `maestro-resume` e sobrevive à liberação posterior e a reinícios.
 */

const setupApp = useTestApp();
const runtimeOf = (ctx: TestApp) => ctx.workspaces.get("principal");
const AT = "2026-11-21T15:00:00.000Z";
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

async function setup(options: { gated?: boolean } = {}) {
  const gate = gatedSleep();
  const ctx = await setupApp({ now: () => new Date(AT), runner: testRunner(options.gated ? { sleep: gate.sleep } : {}) });
  const { agent } = await soloTeam(ctx.app);
  const runtime = runtimeOf(ctx);
  // Marca o Maestro como CLI no estado para os fluxos de pedido do Maestro de CLI.
  const office = runtime.state.read();
  office.agents.find((candidate) => candidate.id === "maestro")!.engine = "claude";
  await runtime.state.commit({ office: { rooms: office.rooms, teams: office.teams, agents: office.agents }, events: [] });
  const openRequest = (title = "Pedido do teste"): Task => runtime.cliMaestro.openRequest({ title, description: `Briefing de ${title}` });
  const live = (id: string): Project => (runtime.plans as unknown as { plans: Project[] }).plans.find((plan) => plan.id === id)!;
  return { ctx, gate, agent, runtime, openRequest, live };
}

describe("projeto estacionado: holds e blocksConclusion", () => {
  it("todo Planejado (ativo ou pausado) não segura nem bloqueia; misto, em andamento, esperando você e proposto seguram", async () => {
    const t = await setup({ gated: true });

    // 1) Ativo, todo Planejado -> estacionado (não segura, não bloqueia).
    const reqParked = t.openRequest("Backlog do livro").id;
    await t.runtime.plans.propose(reqParked, {
      release: "later",
      approval: "skip",
      tasks: [
        { ref: "T1", title: "Cap 1", briefing: "escrever", owner: t.agent.id },
        { ref: "T2", title: "Cap 2", briefing: "escrever", owner: t.agent.id, depends_on: ["T1"] },
      ],
    });
    expect(t.runtime.plans.holds(reqParked)).toBe(false);
    expect(t.runtime.plans.blocksConclusion(reqParked)).toBeUndefined();

    // 2) Pausado com tudo Planejado -> continua estacionado.
    await t.runtime.plans.setProjectStatus(reqParked, "pausado", "maestro");
    expect(t.runtime.plans.holds(reqParked)).toBe(false);
    expect(t.runtime.plans.blocksConclusion(reqParked)).toBeUndefined();

    // 3) Pausado com UMA folha liberada -> deixa de ser estacionado (segura e bloqueia).
    await t.runtime.plans.releaseWork(reqParked, { refs: ["T1"] }, "maestro");
    expect(t.runtime.plans.holds(reqParked)).toBe(true);
    expect(t.runtime.plans.blocksConclusion(reqParked)).toBeDefined();

    // 4) Misto (ativo com uma folha liberada e outra Planejada) e folha em andamento -> segura e bloqueia.
    const reqMixed = t.openRequest("Projeto misto").id;
    await t.runtime.plans.propose(reqMixed, {
      release: "later",
      approval: "skip",
      tasks: [
        { ref: "T1", title: "Agora", briefing: "fazer", owner: t.agent.id, release: "now" },
        { ref: "T2", title: "Depois", briefing: "fazer", owner: t.agent.id, release: "later" },
      ],
    });
    expect(t.runtime.plans.holds(reqMixed)).toBe(true);
    expect(t.runtime.plans.blocksConclusion(reqMixed)).toBeDefined();
    await t.ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === reqMixed && event.project.tasks.find((task) => task.ref === "T1")?.status === "em_andamento");
    expect(t.runtime.plans.holds(reqMixed)).toBe(true);
    expect(t.runtime.plans.blocksConclusion(reqMixed)).toBeDefined();

    // 5) Folha esperando você (mesmo com released: false) -> não é estacionado.
    const reqWait = t.openRequest("Esperando dono").id;
    await t.runtime.plans.propose(reqWait, {
      release: "later",
      approval: "skip",
      tasks: [{ ref: "T1", title: "Aguardar", briefing: "fazer", owner: t.agent.id }],
    });
    t.live(reqWait).tasks[0]!.status = "esperando_voce";
    expect(t.runtime.plans.holds(reqWait)).toBe(true);
    expect(t.runtime.plans.blocksConclusion(reqWait)).toBeDefined();

    // 6) Proposto (esperando aprovação), mesmo tudo Planejado -> segura o pedido!
    const reqProposed = t.openRequest("Aguardando OK").id;
    await t.runtime.plans.propose(reqProposed, {
      release: "later",
      approval: "ask",
      tasks: [{ ref: "T1", title: "Cap 1", briefing: "escrever", owner: t.agent.id }],
    });
    expect(t.runtime.plans.get(reqProposed).status).toBe("proposto");
    expect(t.runtime.plans.holds(reqProposed)).toBe(true);
    t.gate.open();
  });
});

describe("fechamento do pedido com projeto estacionado, liberação posterior e reinício", () => {
  it("complete_request fecha o pedido mantendo o projeto estacionado aberto; liberar depois roda e sobrevive ao reinício; wake em pedido fechado é ignorado", async () => {
    const t = await setup();
    const req = t.openRequest("Estruturar livro");
    await t.runtime.plans.propose(req.id, {
      release: "later",
      approval: "skip",
      title: "Livro",
      tasks: [{ ref: "T1", title: "Cap 1", briefing: "escrever", owner: t.agent.id }],
    });

    // Maestro consegue concluir o pedido mesmo com o projeto estacionado.
    const reply = t.runtime.cliMaestro.conclude({ requestId: req.id, text: "Projeto estruturado no backlog." });
    expect(reply).toContain("Request completed");
    await flush();
    expect(t.runtime.state.read().tasks.find((task) => task.id === req.id)?.status).toBe("done");
    // Projeto estacionado NÃO é cancelado quando o pedido fecha como done!
    expect(t.runtime.plans.get(req.id).status).toBe("ativo");
    expect(t.runtime.plans.get(req.id).tasks[0]!.released).toBe(false);

    // Reinício (WorkScheduler.resume) mantém o projeto estacionado aberto.
    t.runtime.plans.resume();
    expect(t.runtime.plans.get(req.id).status).toBe("ativo");

    // Dono libera depois: o trabalho roda normalmente, o projeto conclui e wake no pedido fechado é ignorado.
    const released = await t.ctx.app.inject({ method: "POST", url: `${API}/projects/${req.id}/release`, payload: { all: true } });
    expect(released.statusCode, released.body).toBe(200);
    await t.ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === req.id && event.project.status === "concluido");
    expect(t.runtime.state.read().tasks.find((task) => task.id === req.id)?.status).toBe("done");
  });

  it("projeto estacionado liberado depois do pedido fechado sobrevive a reinício enquanto ainda está em andamento", async () => {
    const t = await setup({ gated: true });
    const req = t.openRequest("Estacionado depois liberado");
    await t.runtime.plans.propose(req.id, {
      release: "later",
      approval: "skip",
      tasks: [{ ref: "T1", title: "Cap 1", briefing: "escrever", owner: t.agent.id }],
    });
    t.runtime.cliMaestro.conclude({ requestId: req.id, text: "Deixei planejado." });
    await flush();

    // Libera depois de o pedido fechar: T1 começa a rodar.
    await t.runtime.plans.releaseWork(req.id, { all: true });
    await t.ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === req.id && event.project.tasks[0]?.status === "em_andamento");

    // Reinício no meio da execução não cancela o projeto cujo pedido já fechou como done.
    t.runtime.plans.resume();
    expect(t.runtime.plans.get(req.id).status).toBe("ativo");
    t.gate.open();
    await t.ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === req.id && event.project.status === "concluido");
  });

  it("fim do turno do Maestro (pedido e conversa) fecha o pedido com projeto estacionado sem cancelar o projeto", async () => {
    const t = await setup();
    const turns = (t.runtime.cliMaestro as unknown as { turns: { onTerminalEvent: (maestroId: string, terminal: { provider: string }, event: TerminalEvent) => void } }).turns;
    const fakeTerm = { provider: "claude" };

    // 1) Turno de pedido (`afterTurn`): cria projeto estacionado e termina o turno sem chamar `complete_request`.
    const reqTurn = t.openRequest("Pedido por turno");
    turns.onTerminalEvent("maestro", fakeTerm, { type: "turn_start", tag: reqTurn.id, prompt: "Pedido" });
    await t.runtime.plans.propose(reqTurn.id, {
      release: "later",
      approval: "skip",
      tasks: [{ ref: "T1", title: "Cap 1", briefing: "escrever", owner: t.agent.id }],
    });
    turns.onTerminalEvent("maestro", fakeTerm, { type: "turn_end", tag: reqTurn.id, ok: true, result: "Estruturei o projeto no backlog." });
    await flush();
    expect(t.runtime.state.read().tasks.find((task) => task.id === reqTurn.id)).toMatchObject({ status: "done", result: "Estruturei o projeto no backlog." });
    expect(t.runtime.plans.get(reqTurn.id).status).toBe("ativo");

    // 2) Turno de conversa (`afterChat`): Maestro abre pedido com `open_request`, cria projeto estacionado e responde sem `complete_request`.
    const chatTag = `${CHAT_TAG_PREFIX}1`;
    turns.onTerminalEvent("maestro", fakeTerm, { type: "turn_start", tag: chatTag, prompt: "Cria um projeto no backlog" });
    const reqChat = t.openRequest("Projeto pela conversa");
    await t.runtime.plans.propose(reqChat.id, {
      release: "later",
      approval: "skip",
      tasks: [{ ref: "T1", title: "Cap 1", briefing: "escrever", owner: t.agent.id }],
    });
    turns.onTerminalEvent("maestro", fakeTerm, { type: "turn_end", tag: chatTag, ok: true, result: "Pronto, deixei o projeto planejado para você liberar." });
    await flush();
    expect(t.runtime.state.read().tasks.find((task) => task.id === reqChat.id)).toMatchObject({ status: "done", result: "Pronto, deixei o projeto planejado para você liberar." });
    expect(t.runtime.plans.get(reqChat.id).status).toBe("ativo");
  });

  it("maestro-resume não deixa preso um pedido aberto que só tem projeto estacionado", async () => {
    const t = await setup();
    const req = t.openRequest("Pedido preso antes do fix");
    await t.runtime.plans.propose(req.id, {
      release: "later",
      approval: "skip",
      tasks: [{ ref: "T1", title: "Cap 1", briefing: "escrever", owner: t.agent.id }],
    });
    const pushed: { id: string; text: string }[] = [];
    const progress: string[] = [];
    const state: OfficeState = t.runtime.state.read();
    resumeOpenRequests({
      core: {
        deps: {
          state: { read: () => state, readForYou: () => [] },
          plans: () => t.runtime.plans,
          refreshStatus: () => undefined,
        },
        owns: (_s: OfficeState, task: Task) => task.id === req.id,
        agentName: () => "Agente",
        setProgress: (_task: Task, _p: number, message: string) => progress.push(message),
        setTask: () => Promise.resolve(),
      } as never,
      enabled: () => true,
      submit: () => undefined,
      session: { push: (id: string, text: string) => pushed.push({ id, text }), addNotice: () => undefined } as never,
      turns: { markNotified: () => undefined } as never,
      forYou: { restorePending: () => undefined } as never,
    });
    // Como holds() é false para projeto estacionado, o pedido não fica preso em "Plano em andamento" — o Maestro é acordado.
    expect(progress).not.toContain("Plano em andamento");
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.id).toBe(req.id);
  });
});
