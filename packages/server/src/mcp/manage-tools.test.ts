import { MAESTRO, type AgentLogEntry, type ServerEvent, type SubscriptionUsage } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../platform/http/errors";
import { useTestApp } from "../dev/test-app";
import { agentTools, type AgentToolsDeps } from "./agent-tools";
import { localDate } from "./calendar-tools";
import { toolInputSchema, type McpTool } from "./protocol";

const setupApp = useTestApp();

/** Nomes das ferramentas novas (gestão, agentes, acompanhamento e calendário): só do Maestro. */
const NEW_TOOLS = [
  "update_room",
  "update_team",
  "update_agent",
  "set_room_brain_sharing",
  "delete_room",
  "delete_team",
  "delete_agent",
  "set_agent_access",
  "set_agent_connectors",
  "set_agent_skills",
  "delete_approval_type",
  "start_agent",
  "stop_agent",
  "message_agent",
  "get_agent_activity",
  "list_requests",
  "list_plans",
  "get_usage",
  "list_events",
  "create_event",
  "update_event",
  "delete_event",
];

/** Ferramentas do Maestro com os serviços de verdade do workspace "principal" (nenhuma CLI real sobe). */
async function setup() {
  const testApp = await setupApp();
  const runtime = testApp.workspaces.get("principal");
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool: McpTool | undefined = runtime.officeTools(MAESTRO.agentId).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`sem a ferramenta ${name}`);
    return tool.call(tool.input.parse(args));
  };
  return { ...testApp, runtime, call, read: () => runtime.state.read() };
}

const has = (events: ServerEvent[], predicate: (event: ServerEvent) => boolean) => events.some(predicate);

describe("ferramentas de gestão do Maestro", () => {
  it("só o Maestro recebe as ferramentas novas; um agente de time não", async () => {
    const { runtime } = await setup();
    const maestro = runtime.officeTools(MAESTRO.agentId).map((tool) => tool.name);
    expect(maestro).toEqual(expect.arrayContaining(NEW_TOOLS));
    const worker = runtime.officeTools("clara").map((tool) => tool.name);
    for (const name of NEW_TOOLS) expect(worker).not.toContain(name);
    // Toda ferramenta vira um JSON Schema válido no tools/list.
    for (const tool of runtime.officeTools(MAESTRO.agentId)) expect(toolInputSchema(tool.input)).toMatchObject({ type: "object" });
  });

  it("update_room / update_team / update_agent: só os campos passados, id estável e eventos normais", async () => {
    const { call, read, log } = await setup();
    const room = await call("update_room", { room: "projetoy", name: "Projeto Ypsilon", purpose: "research", size: "l" });
    expect(room.isError).toBeUndefined();
    expect(read().rooms.find((candidate) => candidate.id === "projetoy")).toMatchObject({ name: "Projeto Ypsilon", purpose: "pesquisa", size: "g" });
    expect(has(log.events, (event) => event.type === "room:upserted" && event.room.id === "projetoy")).toBe(true);

    const team = await call("update_team", { team: "Conteúdo", focus: "textos curtos", room: "projetox" });
    expect(team.isError).toBeUndefined();
    expect(read().teams.find((candidate) => candidate.id === "projetoy-conteudo")).toMatchObject({ focus: "textos curtos", roomId: "projetox" });

    const agent = await call("update_agent", { agent: "clara", name: "Clarice", role: "Redatora sênior" });
    expect(agent.text).toContain("Clarice (was Clara)");
    expect(read().agents.find((candidate) => candidate.id === "clara")).toMatchObject({ name: "Clarice", role: "Redatora sênior" });
    expect(has(log.events, (event) => event.type === "agent:upserted" && event.agent.id === "clara" && event.agent.name === "Clarice")).toBe(true);

    expect((await call("update_agent", { agent: "clara" })).isError).toBe(true);
    expect((await call("update_agent", { agent: "ninguem", name: "X" })).text).toContain("not found");
  });

  it("o Maestro não mexe na própria sala/time/papel e só muda o próprio nome", async () => {
    const { call, read } = await setup();
    const maestroRoom = read().rooms.find((room) => room.kind === "maestro")!;
    expect((await call("update_room", { room: maestroRoom.id, size: "l" })).isError).toBe(true);
    expect((await call("update_agent", { agent: MAESTRO.agentId, instructions: "outra coisa" })).isError).toBe(true);
    expect((await call("update_agent", { agent: MAESTRO.agentId, name: "Regente" })).isError).toBeUndefined();
    expect((await call("delete_room", { room: maestroRoom.id, user_confirmed: true })).isError).toBe(true);
    expect((await call("delete_agent", { agent: MAESTRO.agentId, user_confirmed: true })).isError).toBe(true);
  });

  it("delete_room sem user_confirmed só mostra o que sairia; com true remove tudo (mesma cascata da rota)", async () => {
    const { call, read, log } = await setup();
    const preview = await call("delete_room", { room: "projetoy" });
    expect(preview.isError).toBe(true);
    expect(preview.text).toContain("Nothing deleted");
    expect(preview.text).toMatch(/2 teams, \d+ agents/);
    expect(read().rooms.some((room) => room.id === "projetoy")).toBe(true);

    const done = await call("delete_room", { room: "projetoy", user_confirmed: true });
    expect(done.isError).toBeUndefined();
    expect(read().rooms.some((room) => room.id === "projetoy")).toBe(false);
    expect(read().teams.some((team) => team.roomId === "projetoy")).toBe(false);
    expect(has(log.events, (event) => event.type === "room:deleted" && event.id === "projetoy")).toBe(true);
  });

  it("delete_team e delete_agent pedem confirmação e removem com os eventos da rota", async () => {
    const { call, read, log } = await setup();
    const preview = (await call("delete_agent", { agent: "beto" })).text;
    expect(preview).toContain("Nothing deleted");
    expect(preview).toContain("no active tasks to cancel");
    expect(preview).not.toContain("(cancelled)");
    expect(read().agents.some((agent) => agent.id === "beto")).toBe(true);
    await call("delete_agent", { agent: "beto", user_confirmed: true });
    expect(read().agents.some((agent) => agent.id === "beto")).toBe(false);
    expect(has(log.events, (event) => event.type === "agent:deleted" && event.id === "beto")).toBe(true);

    expect((await call("delete_team", { team: "projetox-backend" })).isError).toBe(true);
    await call("delete_team", { team: "projetox-backend", user_confirmed: true });
    expect(read().teams.some((team) => team.id === "projetox-backend")).toBe(false);
    expect(has(log.events, (event) => event.type === "team:deleted" && event.id === "projetox-backend")).toBe(true);
  });

  it("set_room_brain_sharing troca o global e a lista de quartos lidos (por nome ou id)", async () => {
    const { call, read } = await setup();
    const result = await call("set_room_brain_sharing", { room: "projetox", reads_global: true, reads_rooms: ["projetoy"] });
    expect(result.text).toContain("the global Brain");
    expect(read().rooms.find((room) => room.id === "projetox")).toMatchObject({ readsGlobalBrain: true, readsBrainsOf: ["projetoy"] });
    expect((await call("set_room_brain_sharing", { room: "projetox", reads_rooms: ["projetox"] })).isError).toBe(true);
  });

  it("set_agent_access exige user_confirmed e nunca passa da política do workspace", async () => {
    const { call, read, runtime } = await setup();
    const tool = runtime.officeTools(MAESTRO.agentId).find((candidate) => candidate.name === "set_agent_access")!;
    expect(tool.input.safeParse({ agent: "clara", internet: false }).success).toBe(false);

    const off = await call("set_agent_access", { agent: "clara", internet: false, user_confirmed: true });
    expect(off.text).toContain("effective access is now: none");
    expect(off.text).toContain("The workspace policy allows:");
    expect(read().agents.find((agent) => agent.id === "clara")).toMatchObject({ internet: false });
    // Terminal está desligado no workspace (padrão): pedir true não libera.
    const terminal = await call("set_agent_access", { agent: "clara", internet: true, terminal: true, user_confirmed: true });
    expect(terminal.text).toContain("Still off: terminal");
    expect(runtime.access().terminal).toBe(false);
  });

  it("o Maestro que responde um pedido de ajuda liberando acesso solta a espera do agente na hora (e só se ele estiver esperando)", async () => {
    const { call, runtime } = await setup();
    const chat = vi.spyOn(runtime.agentChat, "send").mockResolvedValue({ mode: "nota", taskId: "t1", live: true, messageId: "m1" });
    const waiting = vi.spyOn(runtime.cliRunner, "isWaitingHelp").mockReturnValue(false);
    await call("set_agent_access", { agent: "clara", internet: false, user_confirmed: true });
    expect(chat).not.toHaveBeenCalled();
    waiting.mockReturnValue(true);
    await call("set_agent_access", { agent: "clara", internet: true, user_confirmed: true });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledWith("clara", expect.stringContaining("Respondi ao seu pedido de acesso"));
    expect(chat.mock.calls[0]![1]).toContain("submit_result");
  });

  it("set_agent_connectors usa os conectores do workspace (por nome) e publica connector:upserted", async () => {
    const { call, runtime, log } = await setup();
    await runtime.connectors.create({ name: "Notion", kind: "http", url: "https://mcp.notion.com/mcp" } as never);
    const tool = runtime.officeTools(MAESTRO.agentId).find((candidate) => candidate.name === "set_agent_connectors")!;
    expect(tool.input.safeParse({ agent: "clara", connectors: ["notion"] }).success).toBe(false);
    const result = await call("set_agent_connectors", { agent: "Clara", connectors: ["Notion"], user_confirmed: true });
    expect(result.text).toContain("Clara now uses: Notion");
    expect(runtime.connectors.list()[0]!.agentIds).toEqual(["clara"]);
    expect(has(log.events, (event) => event.type === "connector:upserted")).toBe(true);
    expect((await call("set_agent_connectors", { agent: "clara", connectors: ["slack"], user_confirmed: true })).text).toContain('Connector "slack" not found');
    await call("set_agent_connectors", { agent: "clara", connectors: [], user_confirmed: true });
    expect(runtime.connectors.list()[0]!.agentIds).toEqual([]);
  });

  it("delete_approval_type tira um tipo criado e recusa os do sistema", async () => {
    const { call, runtime } = await setup();
    const created = await runtime.forYouTypes.define({ name: "Reels", description: "Roteiro de reels" } as never);
    const typeId = created.type.id;
    expect((await call("delete_approval_type", { type: "Reels", user_confirmed: true })).isError).toBeUndefined();
    expect(runtime.forYouTypes.list().some((type) => type.id === typeId)).toBe(false);
    await expect(call("delete_approval_type", { type: "outro", user_confirmed: true })).rejects.toThrow();
  });

  it("start_agent/stop_agent: simulado e o próprio Maestro recusam; force exige user_confirmed", async () => {
    const { call, runtime } = await setup();
    expect((await call("start_agent", { agent: "clara" })).text).toContain("simulated");
    expect((await call("stop_agent", { agent: MAESTRO.agentId })).isError).toBe(true);
    await runtime.services.agents.update("clara", { engine: "claude" });
    expect((await call("stop_agent", { agent: "clara", force: true })).text).toContain("user_confirmed");
    const stopped = await call("stop_agent", { agent: "clara" });
    expect(stopped.text).toContain("stopped");
  });

  it("message_agent usa a conversa do agente (marcada como do Maestro) e aparece em get_agent_activity", async () => {
    const { call } = await setup();
    const sent = await call("message_agent", { agent: "clara", text: "Lembra de usar o tom leve." });
    expect(sent.text).toContain("as a conversation");
    expect((await call("message_agent", { agent: MAESTRO.agentId, text: "oi" })).isError).toBe(true);
    const activity = await call("get_agent_activity", { agent: "clara" });
    expect(activity.text).toContain("Conversation");
    expect(activity.text).toContain("(Mensagem do Maestro, não do usuário) Lembra de usar o tom leve.");
  });

  it("list_requests e list_projects listam os pedidos do Maestro", async () => {
    const { call, runtime } = await setup();
    expect((await call("list_requests")).text).toBe("No open requests.");
    const request = runtime.cliMaestro.openRequest({ title: "Post de lançamento", description: "Um post curto" });
    const open = await call("list_requests");
    expect(open.text).toContain(request.id);
    expect(open.text).toContain("Post de lançamento");
    expect((await call("list_requests", { status: "done" })).text).toBe("No done requests.");
    expect((await call("list_projects")).text).toBe("No plans yet.");
  });

  it("calendário: cria, lista (com a data de hoje), edita e apaga com os eventos da rota", async () => {
    const { call, log, runtime } = await setup();
    const today = localDate(new Date());
    const created = await call("create_event", { title: "Reunião de pauta", date: today, time: "10:00", end_time: "11:00", room: "projetoY" });
    expect(created.isError).toBeUndefined();
    expect(created.text).toContain(`Today is ${today}`);
    const event = runtime.calendar.list()[0]!;
    expect(event).toMatchObject({ title: "Reunião de pauta", date: today, time: "10:00", endTime: "11:00", roomId: "projetoy" });
    expect(has(log.events, (item) => item.type === "calendar:upserted" && item.calendarEvent.id === event.id)).toBe(true);

    const listed = await call("list_events");
    expect(listed.text).toContain("10:00–11:00 — Reunião de pauta");

    await call("update_event", { id: event.id, time: null, done: true });
    expect(runtime.calendar.list()[0]).toMatchObject({ done: true });
    expect(runtime.calendar.list()[0]!.time).toBeUndefined();

    expect((await call("create_event", { title: "Ruim", date: today, end_time: "09:00" })).isError).toBe(true);
    await call("delete_event", { id: event.id });
    expect(runtime.calendar.list()).toEqual([]);
    expect(has(log.events, (item) => item.type === "calendar:deleted" && item.id === event.id)).toBe(true);
    expect((await call("delete_event", { id: event.id })).isError).toBe(true);
  });
});

describe("agent-tools com dependências falsas", () => {
  const STATE = {
    rooms: [
      { id: "gerencia", name: "Sala do Maestro", kind: "maestro" },
      { id: "conteudo", name: "Conteúdo", kind: "team" },
    ],
    teams: [
      { id: "t-ger", roomId: "gerencia", name: "Gerência", focus: "coordenar" },
      { id: "t-cont", roomId: "conteudo", name: "Conteúdo", focus: "textos" },
    ],
    agents: [
      { id: "maestro", teamId: "t-ger", name: "Maestro", status: "idle" },
      { id: "clara", teamId: "t-cont", name: "Clara", status: "working", engine: "claude" },
    ],
    tasks: [{ id: "t1", roomId: "conteudo", teamId: "t-cont", agentId: "clara", prompt: "Escrever post\nbriefing", status: "in_progress", createdAt: "", updatedAt: "" }],
  };

  function tools(overrides: Partial<AgentToolsDeps> = {}) {
    const deps: AgentToolsDeps = {
      state: { read: () => structuredClone(STATE) as never },
      terminals: { start: vi.fn(), stop: vi.fn(async () => { throw new HttpError(409, "ocupado"); }) },
      chat: { send: vi.fn(async () => ({ mode: "nota" as const, taskId: "t1", live: true, messageId: "m1" })) },
      agentLog: { recentForAgent: vi.fn(async () => [] as AgentLogEntry[]), summary: () => ({ activeSubagents: 0 }) },
      now: () => new Date("2026-11-09T12:00:00.000Z"),
      ...overrides,
    };
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const tool = agentTools(deps).find((candidate) => candidate.name === name)!;
      return tool.call(tool.input.parse(args));
    };
    return { deps, call };
  }

  it("stop_agent no meio de um turno: explica e pede force + user_confirmed", async () => {
    const { call } = tools();
    const result = await call("stop_agent", { agent: "clara" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("force: true and user_confirmed: true");
  });

  it("message_agent numa tarefa em andamento vira nota ao vivo", async () => {
    const { call, deps } = tools();
    const result = await call("message_agent", { agent: "Clara", text: "Foca no público jovem" });
    expect(result.text).toContain("note on task t1 (delivered live)");
    expect(deps.chat.send).toHaveBeenCalledWith("clara", "(Mensagem do Maestro, não do usuário) Foca no público jovem");
  });

  it("get_agent_activity resume as entradas por tarefa", async () => {
    const entries = [
      { id: "1", taskId: "t1", agentId: "clara", at: "2026-11-09T11:58:00.000Z", kind: "tool", toolUseId: "x", name: "WebSearch", summary: "tendências", status: "ok" },
      { id: "2", taskId: "t1", agentId: "clara", at: "2026-11-09T11:59:00.000Z", kind: "result", text: "Post pronto" },
    ] as AgentLogEntry[];
    const { call } = tools({ agentLog: { recentForAgent: async () => entries, summary: () => ({ activeTaskId: "t1", activeSubagents: 1 }) } });
    const text = (await call("get_agent_activity", { agent: "clara" })).text;
    expect(text).toContain("working on task t1; 1 subagent(s) running");
    expect(text).toContain("## Task t1: Escrever post");
    expect(text).toContain("- 11:58 tool WebSearch (tendências): ok");
    expect(text).toContain("RESULT: Post pronto");
  });

  it("get_usage mostra janelas, disponibilidade e o uso por agente", async () => {
    const usage: SubscriptionUsage[] = [
      { provider: "claude", windows: [{ id: "five_hour", utilization: 0.42 }, { id: "seven_day", utilization: 1, resetsAt: "2026-11-10T00:00:00.000Z" }], updatedAt: "2026-11-09T11:00:00.000Z" },
    ];
    const { call } = tools({
      usage: () => usage,
      availability: (engine) => (engine === "claude" ? { reason: "quota", resetsAt: "2026-11-10T00:00:00.000Z" } : undefined),
      engines: async () => [{ engine: "gemini", label: "Antigravity", available: false, models: [], freeModel: false }],
      agentUsage: () => ({ since: "2026-11-09T07:00:00.000Z", agents: [{ agentId: "clara", provider: "claude", turns: 3, measuredTurns: 3, inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 50000, cacheCreationTokens: 0, lastAt: "" }] }),
    });
    const text = (await call("get_usage")).text;
    expect(text).toContain("Claude Code — UNAVAILABLE (sem cota");
    expect(text).toContain("Sessão 5h: 42% used");
    expect(text).toContain("Antigravity — not installed");
    expect(text).toContain("- Clara: 3 turn(s), 3k tokens (+50k cache)");
  });
});
