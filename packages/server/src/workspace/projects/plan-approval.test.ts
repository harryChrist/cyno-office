import type { ActivityEntry, PlanApprovalSettings, Project } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { soloTeam } from "../../dev/test-api";
import { API, gatedSleep, testRunner, useTestApp, type TestApp } from "../../dev/test-app";
import { handleMcpPayload } from "../../mcp/protocol";
import { ActivityLog, setActivityLog } from "../activity/log";

/**
 * LOTE 4 (Servidor + MCP): aprovação opcional por regra de workspace e sprints fora de projetos novos.
 * - Workspace sem `planApproval` comporta-se como "maestro"
 * - Rotas GET/PUT /api/w/:ws/settings/plan-approval (persistência, limpeza da nota no PUT, validação)
 * - Regras "always", "never" e "maestro" nos 3 caminhos (cartão vs aprovado direto, Project.approval, Atividade, `released` preservado)
 * - `set_plan_approval_rule` (feliz, frase curta recusada, nota gravada, Atividade, projetos já em `proposto` intocados)
 * - `add_project_tasks` nunca exige aprovação; `add_sprint` escondida/recusada sem sprints e funcionando onde já há
 */

const setupApp = useTestApp();
const runtimeOf = (ctx: TestApp) => ctx.workspaces.get("principal");
const AT = "2026-11-21T15:00:00.000Z";
afterEach(() => setActivityLog(undefined));

async function setup(options: { gated?: boolean } = {}) {
  const clock = { now: Date.parse(AT) };
  const gate = gatedSleep();
  const activity = new ActivityLog({ dataDir: "/nunca-grava", flushMs: 1_000_000 });
  const entries: ActivityEntry[] = [];
  activity.onAppend((entry) => entries.push(entry));
  const ctx = await setupApp({ activity, now: () => new Date(clock.now), runner: testRunner(options.gated ? { sleep: gate.sleep } : {}) });
  const { agent } = await soloTeam(ctx.app);
  const runtime = runtimeOf(ctx);
  // Marca o Maestro como CLI no estado (sem publicar evento de terminal) para `cliMaestro.requestFor` reconhecer pedidos abertos no MCP.
  const office = runtime.state.read();
  office.agents.find((candidate) => candidate.id === "maestro")!.engine = "claude";
  await runtime.state.commit({ office: { rooms: office.rooms, teams: office.teams, agents: office.agents }, events: [] });
  const openRequest = (title = "Pedido do teste"): string => runtime.cliMaestro.openRequest({ title, description: `Briefing de ${title}` }).id;
  const mcpCall = async (name: string, args: Record<string, unknown>) => {
    const tools = () => runtime.officeTools("maestro");
    const response = (await handleMcpPayload({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, tools)) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    return { isError: response.result.isError, text: response.result.content[0]?.text ?? "" };
  };
  return { ctx, clock, gate, entries, agent, runtime, openRequest, mcpCall };
}

describe("regra de aprovação do workspace: GET/PUT, set_plan_approval_rule e 3 caminhos", () => {
  it("padrão é maestro; PUT grava e persiste; set_plan_approval_rule grava nota + Atividade; PUT do dono limpa a nota", async () => {
    const t = await setup();
    const initial = await t.ctx.app.inject({ method: "GET", url: `${API}/settings/plan-approval` });
    expect(initial.statusCode).toBe(200);
    expect(initial.json<PlanApprovalSettings>()).toEqual({ rule: "maestro" });

    // Workspace inexistente -> 404; regra inválida -> 400.
    expect((await t.ctx.app.inject({ method: "GET", url: "/api/w/nao-existe/settings/plan-approval" })).statusCode).toBe(404);
    expect((await t.ctx.app.inject({ method: "PUT", url: `${API}/settings/plan-approval`, payload: { rule: "talvez" } })).statusCode).toBe(400);

    // Maestro tenta gravar com frase curta -> erro MCP.
    const shortQuote = await t.mcpCall("set_plan_approval_rule", { rule: "never_ask", owner_quote: "ok" });
    expect(shortQuote.isError).toBe(true);

    // Maestro grava a pedido do dono -> regra + nota com data + Atividade.
    const setRes = await t.mcpCall("set_plan_approval_rule", {
      rule: "never_ask",
      owner_quote: "não precisa da minha aprovação, pode fazer",
    });
    expect(setRes.isError, setRes.text).toBe(false);
    const afterMaestro = (await t.ctx.app.inject({ method: "GET", url: `${API}/settings/plan-approval` })).json<PlanApprovalSettings>();
    expect(afterMaestro).toEqual({
      rule: "never",
      note: { quote: "não precisa da minha aprovação, pode fazer", at: AT, by: "maestro" },
    });
    expect(t.entries.find((entry) => entry.action === "regra-aprovacao")).toMatchObject({
      actor: "maestro",
      summary: "O Maestro passou a regra de aprovação para «nunca pedir» a pedido do dono: «não precisa da minha aprovação, pode fazer»",
    });

    // Persiste ao reiniciar o app (workspaces.json).
    const dataDir = t.ctx.dataDir;
    await t.ctx.app.close();
    const reloaded = await setupApp({ dataDir });
    const afterReload = (await reloaded.app.inject({ method: "GET", url: `${API}/settings/plan-approval` })).json<PlanApprovalSettings>();
    expect(afterReload).toEqual(afterMaestro);

    // Dono desfaz pelo PUT -> limpa a nota!
    const putOwner = await reloaded.app.inject({ method: "PUT", url: `${API}/settings/plan-approval`, payload: { rule: "always" } });
    expect(putOwner.statusCode).toBe(200);
    expect(putOwner.json<PlanApprovalSettings>()).toEqual({ rule: "always" });
    const afterPut = (await reloaded.app.inject({ method: "GET", url: `${API}/settings/plan-approval` })).json<PlanApprovalSettings>();
    expect(afterPut).toEqual({ rule: "always" });
    expect(afterPut.note).toBeUndefined();
  });

  it("regras always, never e maestro nos 3 caminhos: cartão vs aprovado direto, Project.approval, Atividade e released preservado", async () => {
    const t = await setup({ gated: true });

    // 1) Regra "always": mesmo Maestro pedindo "skip", abre cartão no Para você; ao aprovar pelo cartão grava approval.by = "dono".
    await t.ctx.app.inject({ method: "PUT", url: `${API}/settings/plan-approval`, payload: { rule: "always" } });
    const reqAlways = t.openRequest("Campanha Always");
    const rAlways = await t.mcpCall("create_project", {
      request_id: reqAlways,
      release: "later",
      approval: "skip",
      title: "Campanha Always",
      tasks: [{ ref: "T1", title: "Post 1", briefing: "Faça", owner: t.agent.id }],
    });
    expect(rAlways.isError, rAlways.text).toBe(false);
    expect(rAlways.text).toContain('workspace rule "always" overrode your "skip"');
    const pAlways = t.runtime.plans.get(reqAlways);
    expect(pAlways.status).toBe("proposto");
    expect(pAlways.approval).toBeUndefined();
    const cardAlways = t.runtime.forYou.list().find((item) => item.projectId === reqAlways);
    expect(cardAlways).toBeDefined();
    // add_project_tasks nunca exige aprovação mesmo com regra "always".
    const addedAlways = await t.mcpCall("add_project_tasks", {
      project_id: reqAlways,
      release: "later",
      tasks: [{ ref: "T2", title: "Post 2", briefing: "Faça", owner: t.agent.id }],
    });
    expect(addedAlways.isError, addedAlways.text).toBe(false);
    // Aprovação pelo dono no cartão -> approval.by = "dono".
    const approvedByOwner = await t.ctx.app.inject({ method: "POST", url: `${API}/for-you/${cardAlways!.id}/decision`, payload: { status: "aprovado" } });
    expect(approvedByOwner.statusCode).toBe(200);
    expect(t.runtime.plans.get(reqAlways)).toMatchObject({ status: "ativo", approval: { by: "dono", at: AT } });

    // 2) Projeto já em "proposto" NÃO muda quando a regra passa para "never".
    const reqPending = t.openRequest("Projeto Pendente");
    await t.mcpCall("create_project", {
      request_id: reqPending,
      release: "later",
      approval: "ask",
      title: "Projeto Pendente",
      tasks: [{ ref: "T1", title: "A", briefing: "a", owner: t.agent.id }],
    });
    expect(t.runtime.plans.get(reqPending).status).toBe("proposto");

    // Muda regra para "never" via Maestro (com quote).
    await t.mcpCall("set_plan_approval_rule", { rule: "never_ask", owner_quote: "pode seguir direto sem perguntar" });
    expect(t.runtime.plans.get(reqPending).status).toBe("proposto");

    // 3) Regra "never": mesmo Maestro pedindo "ask", nasce aprovado sem cartão, com approval.by = "regra" + quote, e mantém released por item!
    const reqNever = t.openRequest("Projeto Direto");
    const rNever = await t.mcpCall("create_project", {
      request_id: reqNever,
      release: "later",
      approval: "ask",
      title: "Projeto Direto",
      tasks: [
        { ref: "T1", title: "Liberada", briefing: "a", owner: t.agent.id, release: "now" },
        { ref: "T2", title: "Planejada", briefing: "b", owner: t.agent.id, release: "later" },
      ],
    });
    expect(rNever.isError, rNever.text).toBe(false);
    expect(rNever.text).toContain('workspace rule "never" overrode your "ask"');
    const pNever = t.runtime.plans.get(reqNever);
    expect(pNever.status).toBe("ativo");
    expect(pNever.forYouId).toBeUndefined();
    expect(pNever.approval).toEqual({ by: "regra", at: AT, quote: "pode seguir direto sem perguntar" });
    expect(t.runtime.forYou.list().some((item) => item.projectId === reqNever)).toBe(false);
    expect(pNever.tasks.find((task) => task.ref === "T1")!.released).toBe(true);
    expect(pNever.tasks.find((task) => task.ref === "T2")!.released).toBe(false);
    // Distribuição começou só para a folha liberada (T1), deixando T2 parada como Planejada.
    await t.ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === reqNever && event.project.tasks.find((task) => task.ref === "T1")?.status === "em_andamento");
    expect(t.runtime.plans.get(reqNever).tasks.find((task) => task.ref === "T2")!.status).toBe("a_fazer");
    expect(t.entries.some((entry) => entry.summary === "Plano de «Projeto Direto» começou sem pedir aprovação (regra do workspace)")).toBe(true);

    // 4) Regra "maestro": Maestro escolhe "ask" -> abre cartão; Maestro escolhe "skip" -> aprova direto com approval.by = "maestro".
    await t.ctx.app.inject({ method: "PUT", url: `${API}/settings/plan-approval`, payload: { rule: "maestro" } });

    const reqAsk = t.openRequest("Proposta Maestro");
    const rAsk = await t.mcpCall("create_project", {
      request_id: reqAsk,
      release: "later",
      approval: "ask",
      title: "Proposta Maestro",
      tasks: [{ ref: "T1", title: "A", briefing: "a", owner: t.agent.id }],
    });
    expect(rAsk.isError, rAsk.text).toBe(false);
    expect(t.runtime.plans.get(reqAsk).status).toBe("proposto");
    expect(t.runtime.forYou.list().some((item) => item.projectId === reqAsk)).toBe(true);

    const reqSkip = t.openRequest("Execução Maestro");
    const rSkip = await t.mcpCall("create_project", {
      request_id: reqSkip,
      release: "later",
      approval: "skip",
      title: "Execução Maestro",
      tasks: [
        { ref: "T1", title: "Vai agora", briefing: "a", owner: t.agent.id, release: "now" },
        { ref: "T2", title: "Fica depois", briefing: "b", owner: t.agent.id },
      ],
    });
    expect(rSkip.isError, rSkip.text).toBe(false);
    expect(rSkip.text).toContain('your choice "skip"');
    const pSkip = t.runtime.plans.get(reqSkip);
    expect(pSkip.status).toBe("ativo");
    expect(pSkip.forYouId).toBeUndefined();
    expect(pSkip.approval).toEqual({ by: "maestro", at: AT });
    expect(pSkip.tasks.find((task) => task.ref === "T1")!.released).toBe(true);
    expect(pSkip.tasks.find((task) => task.ref === "T2")!.released).toBe(false);
    expect(t.runtime.forYou.list().some((item) => item.projectId === reqSkip)).toBe(false);
    expect(t.entries.some((entry) => entry.summary === "Plano de «Execução Maestro» começou sem pedir aprovação (escolha do Maestro)")).toBe(true);
    t.gate.open();
  });

  it("sprints via MCP: add_sprint escondida e recusada em projeto sem sprints, mas funciona em projeto legado com sprints", async () => {
    const t = await setup();
    const reqId = t.openRequest("Novo");
    const created = await t.mcpCall("create_project", {
      request_id: reqId,
      release: "later",
      approval: "skip",
      title: "Novo",
      tasks: [{ ref: "T1", title: "A", briefing: "a", owner: t.agent.id }],
    });
    expect(created.isError, created.text).toBe(false);

    // add_sprint recusada em projeto sem sprints
    const addDenied = await t.mcpCall("add_sprint", { project_id: reqId, name: "Sprint 1" });
    expect(addDenied.isError).toBe(true);
    expect(addDenied.text).toContain("Sprints are retired for new projects: use modules and release_work/set_release_pace");
    // update_sprint, close_sprint e move_task com sprint também recusam
    expect((await t.mcpCall("update_sprint", { project_id: reqId, sprint: "S1", name: "X" })).isError).toBe(true);
    expect((await t.mcpCall("close_sprint", { project_id: reqId, sprint: "S1" })).isError).toBe(true);
    expect((await t.mcpCall("move_task", { project_id: reqId, ref: "T1", sprint: null })).isError).toBe(true);

    // Em projeto legado que JÁ tem sprints, add_sprint funciona!
    const raw = (t.runtime.plans as unknown as { plans: Project[] }).plans.find((plan) => plan.id === reqId)!;
    raw.sprints = [{ id: "S1", name: "Sprint 1", startAt: AT, endAt: "2026-11-28T15:00:00.000Z", order: 1, status: "ativa" }];
    const addAllowed = await t.mcpCall("add_sprint", { project_id: reqId, name: "Sprint 2" });
    expect(addAllowed.isError, addAllowed.text).toBe(false);
    expect(t.runtime.plans.get(reqId).sprints?.map((sprint) => sprint.id)).toEqual(["S1", "S2"]);
  });
});
