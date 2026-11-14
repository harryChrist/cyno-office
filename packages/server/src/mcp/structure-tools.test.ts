import { ROOM_THEME_IDS } from "@cyno/shared";
import { AVATAR_OPTIONS, MAESTRO, type EngineInfo, type ModelChoice, type ServerEvent } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { useTestApp } from "../dev/test-app";
import type { McpTool } from "./protocol";
import { avatarFromName, nextRoomTheme, sizesAndPurposesText, structureTools } from "./structure-tools";

const setupApp = useTestApp();

const ENGINES: EngineInfo[] = [
  { engine: "mock", label: "Simulado", available: true, models: [], freeModel: false },
  { engine: "claude", label: "Claude Code", available: true, version: "2.1.0", models: [], freeModel: true },
  { engine: "gemini", label: "Antigravity", available: false, reason: "comando agy não encontrado", models: [], freeModel: false },
];

/**
 * Ferramentas do Maestro com os serviços de verdade do workspace "principal" (os testes nunca
 * sobem CLIs reais). `engines` substitui a detecção (nenhum `claude`/`agy` de verdade roda).
 */
async function setup(options: { engines?: EngineInfo[] | null; agentDefaults?: ModelChoice } = {}) {
  const testApp = await setupApp();
  const runtime = testApp.workspaces.get("principal");
  const engines = options.engines === null ? undefined : async () => options.engines ?? ENGINES;
  const tools = structureTools({ state: runtime.state, services: runtime.services, simulated: true, engines, agentDefaults: () => options.agentDefaults });
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool: McpTool = tools.find((candidate) => candidate.name === name)!;
    return tool.call(tool.input.parse(args));
  };
  return { ...testApp, runtime, tools, call, read: () => runtime.state.read() };
}

/** Id que a ferramenta devolveu no texto ("(id: x)"). */
const idIn = (text: string) => /\(id: ([a-z0-9-]+)\)/.exec(text)![1]!;

describe("ferramentas de estrutura do Maestro", () => {
  it("o Maestro de CLI recebe as ferramentas novas", async () => {
    const { runtime } = await setup();
    const names = runtime.officeTools(MAESTRO.agentId).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["list_room_options", "create_room", "create_team", "create_agent", "set_agent_model", "set_team_lead"]));
    expect(names.some((name) => /apagar|remover|deletar/.test(name))).toBe(false);
  });

  it("list_room_options mostra o piso de cada tamanho e os tipos com descrição", async () => {
    const text = sizesAndPurposesText();
    expect(text).toContain("grows by itself");
    expect(text).toMatch(/- m: 13×12 tiles initial floor, fits ~8 desks/);
    expect(text).toContain("- auto: grows with the teams and agents — default");
    expect(text).toContain("- research: More bookshelves");
    expect(text).toContain("- meeting: Big meeting table");
  });

  it("create_room: padrões (auto, geral, tema ainda não usado) e eventos normais", async () => {
    const { call, read, log } = await setup();
    const usedBefore = read().rooms.filter((room) => room.kind === "team").map((room) => room.theme);
    const result = await call("create_room", { name: "Estúdio de Vídeo" });
    expect(result.isError).toBeUndefined();
    const room = read().rooms.find((candidate) => candidate.id === idIn(result.text))!;
    expect(room).toMatchObject({ name: "Estúdio de Vídeo", kind: "team", size: "auto", purpose: "geral" });
    if (usedBefore.length < 5) expect(usedBefore).not.toContain(room.theme);
    expect(log.events.some((event: ServerEvent) => event.type === "room:upserted" && event.room.id === room.id)).toBe(true);
  });

  it("create_room: tipo, tamanho e tema escolhidos pelo Maestro", async () => {
    const { call, read } = await setup();
    const result = await call("create_room", { name: "Laboratório", purpose: "research", size: "l", theme: "ocean" });
    expect(result.text).toContain("purpose research (Pesquisa)");
    expect(result.text).toContain("size l (16×14 tiles");
    expect(read().rooms.find((room) => room.id === idIn(result.text))).toMatchObject({ purpose: "pesquisa", size: "g", theme: "ocean" });
  });

  it("create_team, create_agent (simulado, avatar pelo nome) e set_team_lead montam o time", async () => {
    const { call, read } = await setup();
    const roomId = idIn((await call("create_room", { name: "Vídeo", purpose: "design" })).text);
    const teamResult = await call("create_team", { room: roomId, name: "Edição", focus: "editar vídeos curtos" });
    const teamId = idIn(teamResult.text);
    expect(read().teams.find((team) => team.id === teamId)).toMatchObject({ roomId, name: "Edição", focus: "editar vídeos curtos" });

    const bia = await call("create_agent", { team: teamId, name: "Bia", role: "Editora", instructions: "Corta e monta." });
    expect(bia.isError).toBeUndefined();
    expect(bia.text).toContain("Simulado");
    const agent = read().agents.find((candidate) => candidate.id === idIn(bia.text))!;
    expect(agent).toMatchObject({ teamId, name: "Bia", role: "Editora", status: "idle" });
    expect(agent.engine).toBeUndefined();
    expect(agent.avatar).toEqual(avatarFromName("Bia"));

    // Nome do time também serve (sem acento/maiúsculas).
    await call("create_agent", { team: "edicao", name: "Leo", role: "Roteirista", instructions: "" });
    const lead = await call("set_team_lead", { team: teamId, agent: "bia" });
    expect(lead.isError).toBeUndefined();
    expect(read().teams.find((team) => team.id === teamId)!.leadAgentId).toBe(agent.id);
  });

  it("sala/time que não existe e a Sala do Maestro voltam erro claro", async () => {
    const { call } = await setup();
    expect(await call("create_team", { room: "nao-existe", name: "X", focus: "y" })).toMatchObject({ isError: true });
    const maestroRoom = await call("create_team", { room: MAESTRO.roomId, name: "X", focus: "y" });
    expect(maestroRoom).toMatchObject({ isError: true });
    expect(maestroRoom.text).toContain("Maestro's room");
    expect(await call("create_agent", { team: "nao-existe", name: "X", role: "y", instructions: "" })).toMatchObject({ isError: true });
  });

  it("set_team_lead recusa agente de outro time", async () => {
    const { call } = await setup();
    const roomId = idIn((await call("create_room", { name: "Dois Times" })).text);
    const a = idIn((await call("create_team", { room: roomId, name: "A", focus: "a" })).text);
    const b = idIn((await call("create_team", { room: roomId, name: "B", focus: "b" })).text);
    await call("create_agent", { team: a, name: "Ana", role: "x", instructions: "" });
    const result = await call("set_team_lead", { team: b, agent: "Ana" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("is not in team B");
  });

  it("sem limite de capacidade: muitos times e agentes cabem numa sala pequena (ela cresce)", async () => {
    const { call, read } = await setup();
    const roomId = idIn((await call("create_room", { name: "Pequena", size: "s" })).text);
    for (const name of ["T1", "T2"]) {
      const teamId = idIn((await call("create_team", { room: roomId, name: name, focus: "x" })).text);
      for (let i = 0; i < 5; i++) expect((await call("create_agent", { team: teamId, name: `${name} Ag${i}`, role: "x", instructions: "" })).isError).toBeUndefined();
    }
    expect(read().teams.filter((team) => team.roomId === roomId)).toHaveLength(2);
  });
});

describe("create_agent: motor real só com confirmação do usuário", () => {
  const base = { name: "Rafa", role: "Pesquisador", instructions: "Pesquisa." };

  async function team(call: (name: string, args: Record<string, unknown>) => Promise<{ text: string }>) {
    const roomId = idIn((await call("create_room", { name: "Lab" })).text);
    return idIn((await call("create_team", { room: roomId, name: "Pesquisa", focus: "pesquisar" })).text);
  }

  it("motor real sem user_confirmed: erro e nada é criado", async () => {
    const { call, read } = await setup();
    const teamId = await team(call);
    const before = read().agents.length;
    const result = await call("create_agent", { ...base, team: teamId, engine: "claude" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("subscription");
    expect(result.text).toContain("user_confirmed");
    expect(read().agents).toHaveLength(before);
  });

  it("motor real confirmado e disponível: cria com o motor e o modelo", async () => {
    const { call, read } = await setup();
    const teamId = await team(call);
    const result = await call("create_agent", { ...base, team: teamId, engine: "claude", model: "sonnet", user_confirmed: true });
    expect(result.isError).toBeUndefined();
    expect(read().agents.find((agent) => agent.id === idIn(result.text))).toMatchObject({ engine: "claude", model: "sonnet" });
  });

  it("motor confirmado mas não instalado: erro com o motivo", async () => {
    const { call } = await setup();
    const teamId = await team(call);
    const result = await call("create_agent", { ...base, team: teamId, engine: "gemini", user_confirmed: true });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("comando agy não encontrado");
  });

  it("sem detecção de motores: só o simulado", async () => {
    const { call } = await setup({ engines: null });
    const teamId = await team(call);
    const result = await call("create_agent", { ...base, team: teamId, engine: "claude", user_confirmed: true });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("does not report which engines");
  });

  it("sem motor: nasce com o padrão de agentes do workspace (motor real ainda pede confirmação)", async () => {
    const agentDefaults: ModelChoice = { engine: "claude", model: "sonnet", effort: "medium" };
    const { call, read } = await setup({ agentDefaults });
    const teamId = await team(call);
    const refused = await call("create_agent", { ...base, team: teamId });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("this workspace's default");
    expect(refused.text).toContain('engine: "mock"');
    const created = await call("create_agent", { ...base, team: teamId, user_confirmed: true });
    expect(created.isError).toBeUndefined();
    expect(created.text).toContain("Claude Code · sonnet · médio");
    expect(read().agents.find((agent) => agent.id === idIn(created.text))).toMatchObject({ engine: "claude", model: "sonnet", effort: "medium" });
    // Pedido explícito de outro modelo vence o padrão; motor "mock" cria simulado sem confirmação.
    const opus = await call("create_agent", { ...base, name: "Ana", team: teamId, model: "opus", user_confirmed: true });
    expect(read().agents.find((agent) => agent.id === idIn(opus.text))).toMatchObject({ engine: "claude", model: "opus", effort: "medium" });
    const mock = await call("create_agent", { ...base, name: "Leo", team: teamId, engine: "mock" });
    expect(mock.isError).toBeUndefined();
    const leo = read().agents.find((agent) => agent.id === idIn(mock.text))!;
    expect(leo.engine).toBeUndefined();
    expect(leo.model).toBeUndefined();
  });

  it("mock com model: o modelo é ignorado (e avisado)", async () => {
    const { call, read } = await setup();
    const teamId = await team(call);
    const result = await call("create_agent", { ...base, team: teamId, model: "sonnet" });
    expect(result.text).toContain("ignored");
    const agent = read().agents.find((candidate) => candidate.id === idIn(result.text))!;
    expect(agent.engine).toBeUndefined();
    expect(agent.model).toBeUndefined();
  });
});

describe("set_agent_model: só quando o usuário pede", () => {
  async function teamWithAgents(call: (name: string, args: Record<string, unknown>) => Promise<{ text: string }>) {
    const roomId = idIn((await call("create_room", { name: "Vídeo" })).text);
    const teamId = idIn((await call("create_team", { room: roomId, name: "Edição", focus: "editar" })).text);
    const bia = idIn((await call("create_agent", { team: teamId, name: "Bia", role: "Editora", instructions: "", engine: "claude", model: "sonnet", effort: "medium", user_confirmed: true })).text);
    const leo = idIn((await call("create_agent", { team: teamId, name: "Leo", role: "Roteirista", instructions: "", engine: "claude", user_confirmed: true })).text);
    return { teamId, bia, leo };
  }

  it("troca o modelo/esforço de um agente (sem mexer no motor)", async () => {
    const { call, read } = await setup();
    const { bia, leo } = await teamWithAgents(call);
    const result = await call("set_agent_model", { agent: "Bia", model: "opus", effort: "high", user_confirmed: true });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Claude Code · sonnet · médio → Claude Code · opus · alto");
    expect(read().agents.find((agent) => agent.id === bia)).toMatchObject({ engine: "claude", model: "opus", effort: "high" });
    expect(read().agents.find((agent) => agent.id === leo)!.model).toBeUndefined();
  });

  it("troca todos os agentes de um time; para simulado, modelo e esforço saem", async () => {
    const { call, read } = await setup();
    const { teamId, bia, leo } = await teamWithAgents(call);
    const result = await call("set_agent_model", { team: teamId, model: "haiku", user_confirmed: true });
    expect(result.text).toContain("Bia");
    expect(result.text).toContain("Leo");
    expect(read().agents.filter((agent) => agent.teamId === teamId).map((agent) => agent.model)).toEqual(["haiku", "haiku"]);
    await call("set_agent_model", { team: "Edição", engine: "mock", user_confirmed: true });
    for (const id of [bia, leo]) {
      const agent = read().agents.find((candidate) => candidate.id === id)!;
      expect(agent.engine).toBeUndefined();
      expect(agent.model).toBeUndefined();
      expect(agent.effort).toBeUndefined();
    }
  });

  it("sem user_confirmed, sem alvo, com dois alvos ou sem mudança: nada muda", async () => {
    const { call, tools, read } = await setup();
    await teamWithAgents(call);
    const tool = tools.find((candidate) => candidate.name === "set_agent_model")!;
    expect(tool.input.safeParse({ agent: "Bia", model: "opus" }).success).toBe(false);
    expect(tool.input.safeParse({ agent: "Bia", model: "opus", user_confirmed: false }).success).toBe(false);
    expect((await call("set_agent_model", { model: "opus", user_confirmed: true })).isError).toBe(true);
    expect((await call("set_agent_model", { agent: "Bia", team: "Edição", model: "opus", user_confirmed: true })).isError).toBe(true);
    expect((await call("set_agent_model", { agent: "Bia", user_confirmed: true })).isError).toBe(true);
    expect(read().agents.find((agent) => agent.name === "Bia")!.model).toBe("sonnet");
  });

  it("motor real indisponível e motor do próprio Maestro: erro", async () => {
    const { call } = await setup();
    await teamWithAgents(call);
    const gemini = await call("set_agent_model", { agent: "Bia", engine: "gemini", user_confirmed: true });
    expect(gemini.isError).toBe(true);
    expect(gemini.text).toContain("is not available");
    const maestro = await call("set_agent_model", { agent: MAESTRO.agentId, engine: "claude", user_confirmed: true });
    expect(maestro.isError).toBe(true);
    expect(maestro.text).toContain("Maestro");
  });
});

describe("padrões", () => {
  it("avatarFromName é determinístico e sempre válido", () => {
    expect(avatarFromName("Bia")).toEqual(avatarFromName(" bia "));
    for (const name of ["Ana", "Leo", "Clara", "Rafa", "Zé", "Maria Eduarda"]) {
      const avatar = avatarFromName(name);
      expect(AVATAR_OPTIONS.skin).toContain(avatar.skin);
      expect(AVATAR_OPTIONS.hair).toContain(avatar.hair);
      expect(AVATAR_OPTIONS.hairColor).toContain(avatar.hairColor);
      expect(AVATAR_OPTIONS.shirt).toContain(avatar.shirt);
      expect(AVATAR_OPTIONS.pants).toContain(avatar.pants);
      if (avatar.accessory) expect(AVATAR_OPTIONS.accessory).toContain(avatar.accessory);
    }
  });

  it("nextRoomTheme pega um tema não usado (ignora a Sala do Maestro) ou o menos usado", () => {
    const room = (theme: string, kind = "team") => ({ theme, kind }) as never;
    expect(nextRoomTheme([room("mint"), room("lavender"), room("ocean", "maestro")])).toBe("terracotta");
    // Todos os temas já usados (o primeiro duas vezes): o menos usado é o segundo da lista.
    expect(nextRoomTheme([...ROOM_THEME_IDS, ROOM_THEME_IDS[0]].map((theme) => room(theme)))).toBe(ROOM_THEME_IDS[1]);
  });
});
