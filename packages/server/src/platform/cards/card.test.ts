import { cardSummarySchema, type Agent, type ForYouItem, type Project, type Routine, type SubscriptionUsage } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { buildCard, type CardInput } from "./card";
import { diffFacts, factsMapOf, renderCardCompact, renderCardFull, renderDigest, COMPACT_LIMITS } from "./compact";

const NOW = new Date("2026-11-11T12:00:00-03:00");

const maestro: Agent = {
  id: "maestro",
  teamId: "gerencia",
  name: "Maestro",
  role: "maestro",
  instructions: "",
  avatar: { skin: "tone3", hair: "short", hairColor: "cloud", shirt: "wine", pants: "charcoal" },
  status: "idle",
  engine: "claude",
  model: "sonnet",
};

const ana: Agent = { id: "ana", teamId: "a-time", name: "Ana", role: "posts", instructions: "", avatar: maestro.avatar, status: "idle", engine: "claude", model: "haiku" };

function office(extra: Agent[] = []) {
  const room = (id: string, name: string, kind: "team" | "maestro" = "team") => ({ id, kind, name, theme: "mint", gridPosition: { x: 0, y: 0 }, readsGlobalBrain: true, readsBrainsOf: [] });
  return {
    rooms: [room("a", "A"), room("b", "B"), room("sala-do-maestro", "Sala do Maestro", "maestro")],
    teams: [
      { id: "a-time", roomId: "a", name: "Time", focus: "testar" },
      { id: "gerencia", roomId: "sala-do-maestro", name: "Gerência", focus: "coordenar" },
    ],
    agents: [ana, maestro, ...extra],
  };
}

const project = (over: Partial<Project> & { id: string }): Project =>
  ({ kind: "projeto", title: over.id, origin: "maestro", status: "ativo", version: 1, priority: "normal", mode: { kind: "pede-ok" }, worked: {}, tasks: [], createdAt: "2026-11-10T10:00:00-03:00", updatedAt: "2026-11-10T10:00:00-03:00", ...over }) as Project;

const routine = (over: Partial<Routine> & { id: string }): Routine =>
  ({ title: "Convites", unit: "convite", kind: "convites", site: "linkedin.com", target: 10, period: "semana", status: "ativa", type: "meta", schedules: [], lastRuns: [], ...over }) as unknown as Routine;

const forYou = (id: string, over: Partial<ForYouItem> = {}): ForYouItem => ({ id, agentId: "ana", roomId: "a", type: "post", status: "pendente", meta: {}, text: "", originalText: "", editedByUser: false, createdAt: "2026-11-10T09:00:00-03:00", ...over }) as ForYouItem;

function input(over: Partial<CardInput> = {}): CardInput {
  return {
    workspace: "linkedin",
    name: "LinkedIn",
    summary: cardSummarySchema.parse({ summary: "Posts do perfil." }),
    office: office(),
    terminals: { ana: { status: "busy" }, maestro: { status: "idle" } },
    access: { allowedDomains: [] },
    connectors: [],
    routines: [],
    projects: [],
    forYou: [],
    engineBlocked: () => false,
    usage: [],
    turns5h: 3,
    now: NOW,
    ...over,
  };
}

describe("buildCard", () => {
  it("equipe: tira o Maestro da lista, resume o estado dele e dos agentes", () => {
    const card = buildCard(input());
    expect(card.team.agents.map((agent) => [agent.name, agent.engine, agent.model, agent.terminal])).toEqual([["Ana", "claude", "haiku", "busy"]]);
    expect(card.team.maestro).toEqual({ engine: "claude", model: "sonnet", status: "ocioso" });
    expect(card.team.rooms.map((room) => room.name)).toEqual(["A", "B"]);
    expect(card.engines).toEqual([{ engine: "claude", available: true }]);
  });

  it.each([
    ["parado", undefined],
    ["parado", "stopped"],
    ["ocioso", "idle"],
    ["ocioso", "starting"],
    ["ocupado", "busy"],
  ] as const)("Maestro %s quando o terminal está %s", (expected, status) => {
    const card = buildCard(input({ terminals: status ? { maestro: { status } } : {} }));
    expect(card.team.maestro.status).toBe(expected);
  });

  it("motor sem cota entra como indisponível", () => {
    expect(buildCard(input({ engineBlocked: (engine) => engine === "claude" })).engines).toEqual([{ engine: "claude", available: false }]);
  });

  it("sites: os declarados em rotinas ativas e nos domínios liberados, sempre 'login não verificado'", () => {
    const card = buildCard(input({ routines: [routine({ id: "R-1" }), routine({ id: "R-2", site: "x.com", status: "pausada" })], access: { allowedDomains: ["Gmail.com", "linkedin.com"] } }));
    expect(card.sites).toEqual([
      { domain: "gmail.com", login: "nao-verificado" },
      { domain: "linkedin.com", login: "nao-verificado" },
    ]);
  });

  it("conectores: só os ligados, com o nome de quem usa", () => {
    const card = buildCard(input({ connectors: [{ id: "gmail", name: "Gmail", enabled: true, agentIds: ["ana", "maestro"] }, { id: "off", name: "Off", enabled: false, agentIds: ["ana"] }] }));
    expect(card.connectors).toEqual([{ id: "gmail", usedBy: ["Ana", "Maestro"] }]);
  });

  it("rotinas: só as ativas, com a meta; sem horário não há próxima execução", () => {
    const card = buildCard(input({ routines: [routine({ id: "R-1" }), routine({ id: "R-2", status: "encerrada" })] }));
    expect(card.routines).toEqual([{ id: "R-1", title: "Convites", type: "meta", target: 10, unit: "convite", period: "semana" }]);
  });

  it("rotina com horário mostra a próxima execução", () => {
    const withSlots = routine({
      id: "R-3",
      type: "acompanhamento",
      schedules: [{ id: "S-1", label: "Manhã", enabled: true, times: ["18:00"], days: { kind: "todo_dia" }, action: "verificar" }] as never,
    });
    const next = buildCard(input({ routines: [withSlots] })).routines[0]?.next;
    expect(next).toBeDefined();
    expect(new Date(next!).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("projetos: em andamento com etapa atual e progresso; contagem por estado; entregas recentes", () => {
    const task = (ref: string, status: string, what: string) => ({ ref, title: `Tarefa ${ref}`, status, current: 0, dependsOn: [] as string[], steps: [{ agentId: "ana", what, status: "pendente" }] });
    const card = buildCard(
      input({
        projects: [
          project({ id: "P-1", title: "Comentários", dueAt: "2026-11-14", tasks: [task("T1", "concluida", "a"), task("T2", "em_andamento", "revisar"), task("T3", "backlog", "c")] as never }),
          project({ id: "P-2", status: "concluido", title: "Post HxH", finishedAt: "2026-11-10T20:00:00-03:00" }),
          project({ id: "P-3", status: "concluido", title: "Antigo", finishedAt: "2026-11-01T20:00:00-03:00" }),
          project({ id: "P-4", status: "pausado" }),
        ],
      }),
    );
    expect(card.projects.active).toEqual([{ id: "P-1", title: "Comentários", stage: "Tarefa T2: revisar", done: 1, total: 3, dueAt: "2026-11-14", status: "ativo" }]);
    expect(card.projects.counts).toEqual({ ativo: 1, concluido: 2, pausado: 1 });
    expect(card.deliveries.map((delivery) => delivery.title)).toEqual(["Post HxH", "Antigo"]);
  });

  it("esperando você: só os pendentes (contagem e ids)", () => {
    const card = buildCard(input({ forYou: [forYou("A-1"), forYou("A-2", { status: "aprovado" as never }), forYou("A-3")] }));
    expect(card.waitingForYou).toBe(2);
    expect(card.waitingIds).toEqual(["A-1", "A-3"]);
  });

  it("uso: a janela de 5 h do motor do Maestro, em porcentagem", () => {
    const usage = [{ provider: "claude", windows: [{ id: "five_hour", utilization: 0.414 }], updatedAt: NOW.toISOString() }] as SubscriptionUsage[];
    expect(buildCard(input({ usage })).usage).toEqual({ windowPercent: 41, windowEngine: "claude", turns5h: 3 });
    expect(buildCard(input()).usage).toEqual({ turns5h: 3 });
  });
});

describe("formato compacto, digest e delta", () => {
  const rich = () =>
    buildCard(
      input({
        routines: [routine({ id: "R-1" })],
        projects: [project({ id: "P-1", title: "Comentários da semana", dueAt: "2026-11-14T12:00:00-03:00" }), project({ id: "P-2", status: "concluido", title: "Post HxH", finishedAt: "2026-11-10T20:00:00-03:00" })],
        forYou: [forYou("A-1"), forYou("A-2")],
        connectors: [{ id: "gmail", name: "Gmail", enabled: true, agentIds: ["ana"] }],
        access: { allowedDomains: ["linkedin.com"] },
      }),
    );

  it("cabe em 900 caracteres e traz a frase, a equipe, o andamento e o que espera o dono", () => {
    const text = renderCardCompact(rich());
    expect(text.length).toBeLessThanOrEqual(COMPACT_LIMITS.card);
    expect(text).toContain("## linkedin · LinkedIn  [maestro claude/sonnet · ocioso]");
    expect(text).toContain("Faz: Posts do perfil.");
    expect(text).toContain("Ana(claude/haiku: posts)");
    expect(text).toContain("linkedin.com (login não verificado)");
    expect(text).toContain("P-1 \"Comentários da semana\"");
    expect(text).toContain("Esperando você: 2");
    expect(text).toContain("\"Post HxH\" (10/11)");
  });

  it("sem frase, avisa em vez de inventar", () => {
    expect(renderCardCompact(buildCard(input({ summary: cardSummarySchema.parse({}) })))).toContain("sem frase ainda");
  });

  it("a ficha cheia de agentes ainda respeita o teto de 900 caracteres", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...maestro, id: `ag${i}`, teamId: "a-time", name: `Agente${i}`, role: "faz coisas muito longas e detalhadas", engine: "claude" as const, model: "sonnet" }));
    expect(renderCardCompact(buildCard(input({ office: office(many) }))).length).toBeLessThanOrEqual(COMPACT_LIMITS.card);
  });

  it("digest: sem workspaces diz isso; acima de 6 mil caracteres os mais parados viram uma linha", () => {
    expect(renderDigest([])).toContain("nenhum");
    const cards = Array.from({ length: 30 }, (_, i) => ({ ...rich(), workspace: `ws${i}`, name: `Workspace ${i}`, waitingForYou: i === 0 ? 5 : 0, projects: { ...rich().projects, active: i === 0 ? rich().projects.active : [] } }));
    const digest = renderDigest(cards);
    expect(digest.length).toBeLessThanOrEqual(COMPACT_LIMITS.total + 200);
    expect(digest).toContain("## ws0 · Workspace 0");
    expect(digest).toMatch(/- ws1 · Workspace 1: 0 esperando você/);
  });

  it("get_workspace_card: ficha completa com salas, equipe e rotinas", () => {
    const text = renderCardFull(rich());
    expect(text).toContain("Salas: A, B");
    expect(text).toContain("- Ana (ana) claude/haiku · busy · posts");
    expect(text).toContain("R-1 Convites");
  });

  it("delta: nada mudou = vazio; mudou = uma linha por workspace, em palavras do código", () => {
    const before = factsMapOf([rich()]);
    expect(diffFacts(before, factsMapOf([rich()]))).toEqual([]);
    const after = { ...rich(), waitingForYou: 3, projects: { ...rich().projects, active: [] }, deliveries: [{ title: "Comentários da semana", at: NOW.toISOString() }, ...rich().deliveries] };
    expect(diffFacts(before, factsMapOf([after]))).toEqual(['linkedin: +1 waiting for you (now 3); "Comentários da semana" finished']);
  });

  it("delta: workspace novo, removido e projeto que começou", () => {
    const base = factsMapOf([rich()]);
    expect(diffFacts({}, base)).toEqual(['linkedin: new workspace "LinkedIn"']);
    expect(diffFacts(base, {})).toEqual(["linkedin: workspace removed"]);
    const started = { ...rich(), projects: { ...rich().projects, active: [...rich().projects.active, { id: "P-9", title: "Novo", status: "ativo", done: 0, total: 2 }] } };
    expect(diffFacts(base, factsMapOf([started]))).toEqual(['linkedin: "Novo" started']);
  });
});
