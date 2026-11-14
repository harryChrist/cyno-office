import { stat } from "node:fs/promises";
import path from "node:path";
import { OFFICE_MCP_PATH, type ActivityEntry, type ApiErrorBody, type Connector, type LibraryConnector, type ServerEvent } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { call, createAgent, createRoom, createTeam, createWorkspace } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";
import { writeAuthFile } from "../platform/auth/store";
import type { McpClient } from "../library/connectors/mcp-client";
import { setActivityLog, type ActivityLog } from "../workspace/activity/log";

const setupApp = useTestApp();
const LIB = "/api/library/connectors";
const SECRET = "Bearer tok-biblioteca-123456";

/** Cliente falso: duas ferramentas e eco nas chamadas (nenhuma rede nos testes de rota). */
const fakeClient = (): McpClient => ({
  listTools: async () => [{ name: "fetch", description: "Lê uma página", inputSchema: { type: "object", properties: { url: { type: "string" } } } }, { name: "search" }],
  callTool: async (name, args) => ({ content: [{ type: "text", text: `${name}: ${JSON.stringify(args)}` }], isError: false }),
  close: async () => undefined,
});

const options = { connectors: { autoTest: false, gateway: { createClient: fakeClient } } };

afterEach(() => setActivityLog(undefined));

/** Dois workspaces com um agente cada (o "principal" do seed e "outro"). */
async function twoWorkspaces() {
  const test = await setupApp(options);
  const other = await createWorkspace(test.app, "Outro");
  const room = await createRoom(test.app, "Sala", {}, other.id);
  const team = await createTeam(test.app, room.id, "Time", other.id);
  const dora = await createAgent(test.app, team.id, "Dora", other.id);
  const pRoom = await createRoom(test.app, "Sala P");
  const pTeam = await createTeam(test.app, pRoom.id, "Time P");
  const clara = await createAgent(test.app, pTeam.id, "Clara");
  const maestro = test.workspaces.get("principal").state.read().agents.find((agent) => agent.id !== clara.id && agent.name !== "Clara")!;
  return { ...test, other: other.id, dora, clara, maestro };
}

const toolNames = (test: Awaited<ReturnType<typeof twoWorkspaces>>, ws: string, agentId: string) =>
  test.workspaces.get(ws).officeTools(agentId).map((tool) => tool.name);

describe("API: Biblioteca (conectores da plataforma)", () => {
  it("cria na plataforma, nada vem liberado; testa e mostra as ferramentas; nenhum segredo sai", async () => {
    const test = await twoWorkspaces();
    const created = await call<LibraryConnector>(test.app, "POST", LIB, { name: "Fetch", kind: "http", url: "https://mcp.fetch.example/mcp?key=segredo-na-url", headers: { Authorization: SECRET }, description: "Lê páginas da web" });
    expect(created).toMatchObject({ id: "fetch", description: "Lê páginas da web", grants: {}, uses: [], secretHeaders: ["Authorization"], status: { state: "unknown" } });
    // Nada liberado: nenhum workspace enxerga.
    expect(await call<Connector[]>(test.app, "GET", `/api/w/principal/connectors`)).toEqual([]);
    expect(await call<Connector[]>(test.app, "GET", `/api/w/${test.other}/connectors`)).toEqual([]);

    const tested = await call<LibraryConnector>(test.app, "POST", `${LIB}/fetch/test`, undefined, 200);
    expect(tested.status).toMatchObject({ state: "connected", tools: [{ name: "fetch", description: "Lê uma página" }, { name: "search" }] });
    expect(tested.weightTokens).toBeGreaterThan(0);
    const list = await call<LibraryConnector[]>(test.app, "GET", LIB);
    const everything = JSON.stringify([created, tested, list, test.log.events]);
    expect(everything).not.toMatch(/tok-biblioteca|segredo-na-url/);
    // Os conectores moram na plataforma, com 0600.
    expect((await stat(path.join(test.dataDir, "platform", "library", "connectors.json"))).mode & 0o777).toBe(0o600);
    await call(test.app, "POST", `${LIB}/nao-existe/test`, undefined, 404);
  });

  it("libera em dois níveis (workspace e agente): cada agente só vê o que recebeu; 'quem usa' atualiza ao vivo; retirar some", async () => {
    const test = await twoWorkspaces();
    await call<LibraryConnector>(test.app, "POST", LIB, { name: "Fetch", kind: "http", url: "https://mcp.fetch.example/mcp" });
    await call(test.app, "POST", `${LIB}/fetch/test`, undefined, 200);
    const platformEvents: ServerEvent[] = [];
    test.workspaces.listHub.subscribe((event) => platformEvents.push(structuredClone(event)));

    // Nível 1: libera ao workspace principal e a um agente dele.
    const granted = await call<LibraryConnector>(test.app, "PUT", `${LIB}/fetch/grants`, { grants: { principal: { agentIds: [test.clara.id] } } }, 200);
    expect(granted.grants.principal!.agentIds).toEqual([test.clara.id]);
    expect(granted.uses).toEqual([{ workspaceId: "principal", workspaceName: expect.any(String), agents: [expect.objectContaining({ id: test.clara.id, name: "Clara", maestro: false, avatar: expect.objectContaining({ skin: expect.any(String) }) })] }]);
    // A Biblioteca avisa todos os sockets, e o workspace recebe o conector na forma de sempre.
    expect(platformEvents.some((event) => event.type === "library:upserted" && event.item.id === "fetch" && event.item.uses.length === 1)).toBe(true);
    expect(test.log.events.some((event) => event.type === "connector:upserted" && event.connector.id === "fetch" && event.connector.agentIds.includes(test.clara.id))).toBe(true);
    const ws = await call<Connector[]>(test.app, "GET", `/api/w/principal/connectors`);
    expect(ws).toMatchObject([{ id: "fetch", agentIds: [test.clara.id] }]);

    // Quem recebeu vê a ferramenta; o Maestro do mesmo workspace (sem entrega) e o agente do outro workspace, não.
    expect(toolNames(test, "principal", test.clara.id)).toEqual(expect.arrayContaining(["fetch__fetch", "fetch__search"]));
    expect(toolNames(test, "principal", test.maestro.id)).not.toContain("fetch__fetch");
    expect(toolNames(test, test.other, test.dora.id)).not.toContain("fetch__fetch");

    // Liberar o outro workspace só no nível 1 (sem agentes) ainda não entrega nada.
    await call(test.app, "PUT", `${LIB}/fetch/grants`, { grants: { principal: { agentIds: [test.clara.id] }, [test.other]: { agentIds: [] } } }, 200);
    expect(toolNames(test, test.other, test.dora.id)).not.toContain("fetch__fetch");
    // O Maestro do outro workspace só entrega o que foi liberado ao workspace dele (set_agent_connectors).
    const otherRuntime = test.workspaces.get(test.other);
    await otherRuntime.connectors.setAgentConnectors(test.dora.id, ["fetch"]);
    expect(toolNames(test, test.other, test.dora.id)).toContain("fetch__fetch");
    await expect(test.workspaces.get("principal").connectors.setAgentConnectors(test.clara.id, ["nao-liberado"])).rejects.toMatchObject({ statusCode: 404 });
    const both = await call<LibraryConnector[]>(test.app, "GET", LIB);
    expect(both[0]!.uses.map((use) => [use.workspaceId, use.agents.map((agent) => agent.name)])).toEqual(expect.arrayContaining([["principal", ["Clara"]], [test.other, ["Dora"]]]));

    // Retirar do workspace principal: some para Clara, fica para Dora; o workspace recebe `connector:deleted`.
    await call(test.app, "PUT", `${LIB}/fetch/grants`, { grants: { [test.other]: { agentIds: [test.dora.id] } } }, 200);
    expect(toolNames(test, "principal", test.clara.id)).not.toContain("fetch__fetch");
    expect(toolNames(test, test.other, test.dora.id)).toContain("fetch__fetch");
    expect(test.log.events.some((event) => event.type === "connector:deleted" && event.id === "fetch")).toBe(true);
    expect(await call<Connector[]>(test.app, "GET", `/api/w/principal/connectors`)).toEqual([]);

    // Remover da Biblioteca tira de todo mundo.
    await call(test.app, "DELETE", `${LIB}/fetch`);
    expect(toolNames(test, test.other, test.dora.id)).not.toContain("fetch__fetch");
    expect(platformEvents.some((event) => event.type === "library:deleted" && event.id === "fetch")).toBe(true);
    expect(await call<LibraryConnector[]>(test.app, "GET", LIB)).toEqual([]);
  });

  it("valida liberações (workspace ou agente que não existe, agente de outro workspace) e o corpo", async () => {
    const test = await twoWorkspaces();
    await call(test.app, "POST", LIB, { name: "Fetch", kind: "http", url: "https://f.example/mcp" });
    const noWs = await call<ApiErrorBody>(test.app, "PUT", `${LIB}/fetch/grants`, { grants: { fantasma: { agentIds: [] } } }, 404);
    expect(noWs.error).toMatch(/Workspace "fantasma"/);
    await call(test.app, "PUT", `${LIB}/fetch/grants`, { grants: { principal: { agentIds: ["fantasma"] } } }, 404);
    await call(test.app, "PUT", `${LIB}/fetch/grants`, { grants: { principal: { agentIds: [test.dora.id] } } }, 404);
    await call(test.app, "POST", LIB, { name: "X", kind: "http", url: "javascript:alert(1)" }, 201).catch(() => undefined);
    await call(test.app, "POST", LIB, { name: "X", kind: "ftp", url: "https://x.com" }, 400);
    await call(test.app, "POST", LIB, { name: "X", kind: "http" }, 400);
    await call(test.app, "PATCH", `${LIB}/nao-existe`, { name: "x" }, 404);
    // Criar já liberando (corpo com grants).
    const created = await call<LibraryConnector>(test.app, "POST", LIB, { name: "Direto", kind: "http", url: "https://d.example/mcp", grants: { principal: { agentIds: [test.clara.id] } } });
    expect(created.uses[0]!.agents.map((agent) => agent.name)).toEqual(["Clara"]);
  });

  it("stdio continua dependendo de CONNECTORS_STDIO", async () => {
    const test = await setupApp({ connectors: { autoTest: false, allowStdio: false } });
    const denied = await call<ApiErrorBody>(test.app, "POST", LIB, { name: "Local", kind: "stdio", command: process.execPath }, 403);
    expect(denied.error).toMatch(/CONNECTORS_STDIO=1/);
    expect(await call<LibraryConnector[]>(test.app, "GET", LIB)).toEqual([]);
  });

  it("registra na Atividade da plataforma: liberado, retirado, agente entregue e removido", async () => {
    const test = await twoWorkspaces();
    const entries: ActivityEntry[] = [];
    setActivityLog({ record: (input: Omit<ActivityEntry, "id" | "at">) => entries.push(input as ActivityEntry) } as unknown as ActivityLog);
    await call(test.app, "POST", LIB, { name: "Fetch", kind: "http", url: "https://f.example/mcp" });
    await call(test.app, "PUT", `${LIB}/fetch/grants`, { grants: { principal: { agentIds: [] } } }, 200);
    await call(test.app, "PUT", `${LIB}/fetch/grants`, { grants: { principal: { agentIds: [test.clara.id] } } }, 200);
    await call(test.app, "PUT", `${LIB}/fetch/grants`, { grants: { principal: { agentIds: [] } } }, 200);
    await call(test.app, "PUT", `${LIB}/fetch/grants`, { grants: {} }, 200);
    await call(test.app, "DELETE", `${LIB}/fetch`);
    expect(entries.map((entry) => entry.action)).toEqual(["conector-criado", "conector-liberado", "conector-entregue", "conector-tirado-do-agente", "conector-retirado", "conector-removido"]);
    // Da plataforma (sem workspaceId), do usuário, e sem segredos.
    expect(entries.every((entry) => entry.category === "sistema" && entry.actor === "usuario" && entry.workspaceId === undefined)).toBe(true);
    expect(entries[1]!.summary).toMatch(/Fetch liberado para o workspace/);
  });

  it("atrás da senha: sem sessão é 401, e o token de um agente (MCP) não abre a Biblioteca nem vê segredo", async () => {
    const test = await twoWorkspaces();
    await call(test.app, "POST", LIB, { name: "Fetch", kind: "http", url: "https://f.example/mcp", headers: { Authorization: SECRET } });
    await writeAuthFile(test.dataDir, "senha-de-teste-1");
    expect((await test.app.inject({ method: "GET", url: LIB })).statusCode).toBe(401);
    expect((await test.app.inject({ method: "PUT", url: `${LIB}/fetch/grants`, payload: { grants: {} } })).statusCode).toBe(401);
    // O token de agente só vale no /mcp (e só do 127.0.0.1): em /api/library não é sessão.
    const bearer = await test.app.inject({ method: "GET", url: LIB, headers: { authorization: "Bearer tok-de-agente" } });
    expect(bearer.statusCode).toBe(401);
    expect(bearer.body).not.toContain("tok-biblioteca");
    const mcp = await test.app.inject({ method: "POST", url: OFFICE_MCP_PATH, headers: { authorization: "Bearer tok-de-agente" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(mcp.body).not.toContain("tok-biblioteca");
    // Logado: lista, sem o valor do segredo.
    const login = await test.app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "senha-de-teste-1" } });
    const cookie = String(([] as string[]).concat(login.headers["set-cookie"] as string)[0]).split(";")[0]!;
    const ok = await test.app.inject({ method: "GET", url: LIB, headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain("Authorization");
    expect(ok.body).not.toContain("tok-biblioteca");
  });

  it("workspace excluído sai das liberações; agente excluído sai do 'quem usa'", async () => {
    const test = await twoWorkspaces();
    await call(test.app, "POST", LIB, { name: "Fetch", kind: "http", url: "https://f.example/mcp", grants: { principal: { agentIds: [test.clara.id] }, [test.other]: { agentIds: [test.dora.id] } } });
    await call(test.app, "DELETE", `/api/w/principal/agents/${test.clara.id}`);
    let fetch = (await call<LibraryConnector[]>(test.app, "GET", LIB))[0]!;
    expect(fetch.grants.principal!.agentIds).toEqual([]);
    await call(test.app, "DELETE", `/api/workspaces/${test.other}`);
    fetch = (await call<LibraryConnector[]>(test.app, "GET", LIB))[0]!;
    expect(Object.keys(fetch.grants)).toEqual(["principal"]);
  });
  it("o conector de um app não sai pela aba Conectores (409); o de uso manual continua saindo", async () => {
    const test = await setupApp(options);
    const library = (test.workspaces as unknown as { options: { library: { upsertAppConnector(input: object): Promise<string> } } }).options.library;
    const id = await library.upsertAppConnector({ appId: "meuapp", name: "Meu app", command: "/bin/true", args: [], env: {}, description: "x", warnings: [] });
    const refused = await call<ApiErrorBody>(test.app, "DELETE", `${LIB}/${id}`, undefined, 409);
    expect(refused.error).toContain("desinstale o app na aba Apps");
    expect((await call<LibraryConnector[]>(test.app, "GET", LIB)).map((connector) => connector.id)).toContain(id);
    await call(test.app, "POST", LIB, { name: "Manual", kind: "http", url: "https://m.example/mcp" });
    await call(test.app, "DELETE", `${LIB}/manual`);
  });
});
