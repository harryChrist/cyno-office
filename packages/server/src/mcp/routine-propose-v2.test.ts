import path from "node:path";
import { emptyRoutinesData, type Agent, type ForYouItem, type OfficeState, type RoutineProposalPayload } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { RoutineService } from "../workspace/routines/routine-service";
import { WriteQueue } from "../store/write-queue";
import { useTempDirs } from "../dev/test-utils";
import type { McpTool } from "./protocol";
import { maestroRoutineTools, normalizeTime } from "./routine-tools";

const tempDir = useTempDirs();
const queues: WriteQueue[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.idle()));
});

const NOW = new Date("2026-11-09T14:00:00Z");
const ECO = { id: "eco", name: "Eco", teamId: "time" } as Agent;
const LIA = { id: "lia", name: "Lia", teamId: "time" } as Agent;

async function setup() {
  const dir = await tempDir();
  const queue = new WriteQueue();
  queues.push(queue);
  const cards: RoutineProposalPayload[] = [];
  const stopped: unknown[] = [];
  const state = { read: () => ({ rooms: [], teams: [{ id: "time", name: "Time" }], agents: [ECO, LIA], tasks: [] }) as unknown as OfficeState };
  const service = new RoutineService(emptyRoutinesData(), {
    workspaceId: "lab",
    file: path.join(dir, "routines.json"),
    queue,
    publish: () => undefined,
    owners: { agent: (id) => [ECO, LIA].find((agent) => agent.id === id), team: (id) => (id === "time" ? { id, name: "Time" } : undefined) },
    openCard: (payload) => {
      cards.push(payload);
      return { id: `A-000${cards.length}` } as ForYouItem;
    },
    log: { warn: () => undefined, error: () => undefined },
    now: () => NOW,
  });
  const tracking = {
    list: () => ({ items: [], total: 0 }),
    add: () => ({ item: {}, created: true }),
    update: () => ({ item: {}, changes: [] }),
    stop: (routineId: string, itemId: string, input: unknown) => {
      stopped.push({ routineId, itemId, input });
      return { id: itemId };
    },
    specOf: () => ({ routine: {}, spec: { fields: [], statuses: [] } }),
  } as never;
  const tools = maestroRoutineTools({ state, routines: service, workspaceId: "lab", tracking, now: () => NOW });
  const call = (name: string, args: object) => tools.find((tool: McpTool) => tool.name === name)!.call(args);
  return { service, cards, call, stopped, tools };
}

const POSTS = { label: "Olhar posts novos", days: "business_days", times: ["09:00", "13:00", "18:00"], action: "Olhe posts novos e prepare comentários" };
const CONNECT = { label: "Buscar pessoas", days: "selected_weekdays", weekdays: [2, 4, 5], times: ["10:00"], action: "Busque pessoas para conexão", agent: "lab/lia" };
const TRACKING = {
  type: "tracking",
  title: "Minhas inscrições",
  owner: "lab/eco",
  instruction: "Acompanhe as candidaturas",
  schedules: [
    { label: "E-mail", days: "every_day", times: ["8h", "18h"], action: "Leia os e-mails novos e crie ou atualize itens" },
    { label: "Site da vaga", days: "every_day", times: ["10:00"], scope: "due_items_only", action: "Abra o link de cada item vencido e atualize o status" },
  ],
  tracking: {
    fields: [
      { key: "company", label: "Empresa", type: "text", required: true },
      { key: "link", label: "Link", type: "link" },
    ],
    statuses: [{ name: "Inscrito" }, { name: "Entrevista", alert: true }, { name: "Recusado", terminal: true }, { name: "Sem resposta" }],
    lifespan_days: 15,
    until_terminal: true,
    expire_status: "Sem resposta",
    check_every_hours: 24,
  },
};

describe("routine_propose v2", () => {
  it("meta com dois horários (dias úteis e ter/qui/sex), agente por endereço e Automático sugerido", async () => {
    const { service, cards, call } = await setup();
    const result = await call("routine_propose", {
      type: "goal",
      title: "Posts da semana",
      owner: "lab/eco",
      instruction: "Comente posts de IA",
      kind: "comment",
      site: "linkedin.com",
      unit: "comentário",
      goal: { target: 5, period: "week", preferred_days: [2, 4] },
      schedules: [POSTS, CONNECT],
      suggested_mode: "auto",
      auto_scope: { actions: ["comentario"], sites: ["linkedin.com"], daily_cap: 4 },
    });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("does NOT run");
    const routine = service.get("R-0001");
    expect(routine).toMatchObject({ status: "proposta", type: "meta", agentId: "eco", needsApproval: true });
    expect(routine.mode).toEqual({ kind: "pede-ok" });
    expect(routine.goal).toMatchObject({ target: 5, period: "week", preferredDays: [2, 4], stopOnHit: true, prepareFactor: 1 });
    expect(routine.schedules.map((schedule) => ({ days: schedule.days, times: schedule.times, agent: schedule.agent }))).toEqual([
      { days: { kind: "uteis" }, times: ["09:00", "13:00", "18:00"], agent: undefined },
      { days: { kind: "semana", weekdays: [2, 4, 5] }, times: ["10:00"], agent: "lab/lia" },
    ]);
    // O Automático só fica como sugestão (modeProposal): o modo segue Pede OK.
    expect(routine.modeProposal?.grant).toMatchObject({ actions: ["comentario"], sites: ["linkedin.com"], dailyCap: 4 });
    expect(cards[0]).toMatchObject({ mode: "criar", type: "meta", suggestedMode: { actions: ["comentario"], dailyCap: 4 } });
    expect(cards[0]!.view?.schedules[1]).toMatchObject({ agent: "lab/lia", agentName: "Lia" });
  });

  it("acompanhamento: horas em '8h', escopo, esquema e vida do item", async () => {
    const { service, cards, call } = await setup();
    const result = await call("routine_propose", TRACKING);
    expect(result.isError).toBeUndefined();
    const routine = service.get("R-0001");
    expect(routine).toMatchObject({ type: "acompanhamento", status: "proposta", site: "", kind: "other" });
    expect(routine.schedules.map((schedule) => [schedule.times, schedule.scope])).toEqual([[["08:00", "18:00"], undefined], [["10:00"], "itens_vencidos"]]);
    expect(routine.tracking).toMatchObject({ lifespan: { days: 15, untilTerminal: true }, expireStatus: "Sem resposta", checkEveryHours: 24 });
    expect(routine.tracking?.fields.map((field) => [field.key, field.type])).toEqual([["company", "texto"], ["link", "link"]]);
    expect(cards[0]!.view?.tracking?.statuses.map((status) => status.name)).toEqual(["Inscrito", "Entrevista", "Recusado", "Sem resposta"]);
  });

  it("meta de 2 posts por semana (ter e qui) sem horários", async () => {
    const { service, call } = await setup();
    const result = await call("routine_propose", { type: "goal", title: "Posts", owner: "eco", instruction: "Poste sobre IA", kind: "post", site: "linkedin.com", unit: "post", goal: { target: 2, preferred_days: [2, 4] } });
    expect(result.isError).toBeUndefined();
    expect(service.get("R-0001")).toMatchObject({ target: 2, period: "week", schedules: [] });
    expect(service.get("R-0001").goal?.preferredDays).toEqual([2, 4]);
  });

  it.each([
    ["meta sem goal", { type: "goal", title: "x", owner: "eco", instruction: "x", kind: "post", site: "linkedin.com" }, "needs goal"],
    ["meta sem site", { type: "goal", title: "x", owner: "eco", instruction: "x", kind: "post", goal: { target: 2 } }, "needs kind"],
    ["acompanhamento sem horário", { ...TRACKING, schedules: undefined }, "at least one schedule"],
    ["acompanhamento sem status", { ...TRACKING, tracking: { fields: [] } }, "tracking.statuses"],
    ["hora inválida", { ...TRACKING, schedules: [{ ...TRACKING.schedules[0], times: ["25:00"] }] }, 'is not a time'],
    ["dias da semana sem weekdays", { ...TRACKING, schedules: [{ ...TRACKING.schedules[0], days: "selected_weekdays" }] }, "needs weekdays"],
    ["agente do horário inexistente", { ...TRACKING, schedules: [{ ...TRACKING.schedules[0], agent: "lab/fantasma" }] }, "not found"],
    ["dono inexistente", { ...TRACKING, owner: "Fantasma" }, "Owner"],
    ["expire_status fora dos status", { ...TRACKING, tracking: { ...TRACKING.tracking, expire_status: "Nada" } }, "must be one of the statuses"],
    ["até terminal sem status terminal", { ...TRACKING, tracking: { ...TRACKING.tracking, statuses: [{ name: "Ativo" }] } }, "terminal"],
    ["opção sem opções", { ...TRACKING, tracking: { ...TRACKING.tracking, fields: [{ key: "x", label: "X", type: "option" }] } }, "no options"],
    ["Automático sem escopo", { ...TRACKING, suggested_mode: "auto" }, "auto_scope"],
  ])("recusa com texto útil: %s", async (_name, args, expected) => {
    const { service, cards, call } = await setup();
    const result = await call("routine_propose", args);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(expected);
    expect(service.list()).toHaveLength(0);
    expect(cards).toHaveLength(0);
  });

  it("normalizeTime entende 9h, 18h30 e 7:05", () => {
    expect([normalizeTime("9h"), normalizeTime("18h30"), normalizeTime("7:05"), normalizeTime("09:00"), normalizeTime("24:00"), normalizeTime("abc")]).toEqual(["09:00", "18:30", "07:05", "09:00", undefined, undefined]);
  });
});

describe("routine_update_propose, pausar, retomar e parar item", () => {
  async function withRoutine() {
    const env = await setup();
    await env.call("routine_propose", { ...TRACKING, schedules: [{ ...TRACKING.schedules[0], times: ["09:00", "18:00"] }, TRACKING.schedules[1]] });
    env.service.decide({ id: "A-0001", routine: env.cards[0] } as ForYouItem, { status: "aprovado" });
    env.cards.length = 0;
    return env;
  }

  it("passa o horário das 9h para as 8h: cartão com antes e depois; nada muda antes do OK", async () => {
    const { service, cards, call } = await withRoutine();
    const result = await call("routine_update_propose", { routine_id: "R-0001", reason: "Pedido do usuário", schedule_changes: [{ id: "S1", times: ["08:00", "18:00"] }] });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("NOTHING changed");
    expect(service.get("R-0001").schedules[0]!.times).toEqual(["09:00", "18:00"]);
    expect(cards[0]).toMatchObject({ mode: "alterar", routineId: "R-0001", reason: "Pedido do usuário" });
    expect(cards[0]!.before?.schedules[0]!.times).toEqual(["09:00", "18:00"]);
    expect(cards[0]!.view?.schedules[0]!.times).toEqual(["08:00", "18:00"]);
    // Aprovar aplica; o resto do horário (ação, dias) fica como estava.
    service.decide({ id: "A-0002", routine: cards[0] } as ForYouItem, { status: "aprovado" });
    expect(service.get("R-0001").schedules[0]).toMatchObject({ times: ["08:00", "18:00"], label: "E-mail", days: { kind: "todo_dia" } });
  });

  it("remover, acrescentar e acrescentar campo; ids ruins e mudança vazia voltam com erro", async () => {
    const { service, cards, call } = await withRoutine();
    const bad = await call("routine_update_propose", { routine_id: "R-0001", schedule_changes: [{ id: "S9", times: ["08:00"] }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("S9 is not a schedule");
    expect((await call("routine_update_propose", { routine_id: "R-0099", title: "x" })).isError).toBe(true);
    expect((await call("routine_update_propose", { routine_id: "R-0001" })).isError).toBe(true);
    expect((await call("routine_update_propose", { routine_id: "R-0001", title: "Minhas inscrições" })).text).toContain("exactly as it is");
    expect((await call("routine_update_propose", { routine_id: "R-0001", goal: { target: 3 } })).text).toContain("tracking routine");
    const good = await call("routine_update_propose", {
      routine_id: "R-0001",
      remove_schedule_ids: ["S2"],
      schedule_changes: [{ label: "Sexta", days: "selected_weekdays", weekdays: [5], times: ["17:00"], action: "Resumo da semana" }],
      tracking: { add_fields: [{ key: "salary", label: "Salário", type: "number" }] },
    });
    expect(good.isError).toBeUndefined();
    service.decide({ id: "A-0002", routine: cards[0] } as ForYouItem, { status: "aprovado" });
    const routine = service.get("R-0001");
    expect(routine.schedules.map((schedule) => schedule.label)).toEqual(["E-mail", "Sexta"]);
    expect(routine.tracking?.fields.map((field) => field.key)).toEqual(["company", "link", "salary"]);
  });

  it("recusar a mudança não muda nada; ajustar também não", async () => {
    const { service, cards, call } = await withRoutine();
    await call("routine_update_propose", { routine_id: "R-0001", schedule_changes: [{ id: "S1", times: ["07:00"] }] });
    service.decide({ id: "A-0002", routine: cards[0] } as ForYouItem, { status: "rejeitado" });
    service.decide({ id: "A-0002", routine: cards[0] } as ForYouItem, { status: "respondido", response: "às 7h30" });
    expect(service.get("R-0001").schedules[0]!.times).toEqual(["09:00", "18:00"]);
  });

  it("pausa e retoma direto; parar item aplica direto com a nota do Maestro", async () => {
    const { service, call, stopped } = await withRoutine();
    expect((await call("routine_pause", { routine_id: "R-0001" })).isError).toBeUndefined();
    expect(service.get("R-0001").status).toBe("pausada");
    expect((await call("routine_resume", { routine_id: "R-0001" })).isError).toBeUndefined();
    expect(service.get("R-0001").status).toBe("ativa");
    expect((await call("routine_resume", { routine_id: "R-0001" })).isError).toBe(true);
    const result = await call("routine_item_stop", { routine_id: "R-0001", item_id: "I-0003", reason: "não quero mais" });
    expect(result.isError).toBeUndefined();
    expect(stopped[0]).toMatchObject({ routineId: "R-0001", itemId: "I-0003", input: { by: "agente" } });
    expect(JSON.stringify(stopped[0])).toContain("não quero mais");
  });

  it("routine_list e routine_status mostram horários, próximas execuções, modo e o esquema", async () => {
    const { call } = await withRoutine();
    const list = await call("routine_list", {});
    expect(list.text).toContain("R-0001 “Minhas inscrições” [ativa] tracking");
    expect(list.text).toContain("S1 “E-mail” Todo dia · 9h, 18h");
    expect(list.text).toContain("S2 “Site da vaga”");
    expect(list.text).toContain("[only if items are due]");
    expect(list.text).toContain("next runs:");
    expect(list.text).toContain("mode: asks the user's OK");
    const status = await call("routine_status", { routine_id: "R-0001" });
    expect(status.text).toContain("statuses Inscrito [initial] > Entrevista [alert] > Recusado [terminal]");
    expect(status.text).toContain("lifespan 15 day(s) or until a terminal status");
  });
});
