import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { ServerEvent } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { handleMcpPayload } from "../../mcp/protocol";
import { useTempDirs } from "../../dev/test-utils";
import { ConnectorAuthError } from "./mcp-client";
import { ConnectorsService } from "./service";
import { LibraryService } from "../library-service";
import { statusFromError } from "./gateway";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const TOKEN = "tok-http-987654";
const tempDir = useTempDirs();

type FakeOptions = { requireToken?: boolean; sse?: boolean };
type Seen = { method: string; auth?: string; session?: string; args?: unknown };

/** Servidor MCP HTTP falso (Streamable HTTP): sessão, JSON ou SSE, e 401 sem o token. */
async function fakeHttpMcp(options: FakeOptions = {}) {
  const seen: Seen[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      if (req.method !== "POST") return void res.writeHead(405).end();
      const auth = req.headers.authorization;
      const message = JSON.parse(raw) as { id?: number; method: string; params?: { name?: string; arguments?: unknown; protocolVersion?: string } };
      seen.push({ method: message.method, auth, session: req.headers["mcp-session-id"] as string | undefined, args: message.params?.arguments });
      if (options.requireToken && auth !== `Bearer ${TOKEN}`) return void res.writeHead(401, { "www-authenticate": "Bearer" }).end();
      if (message.id === undefined) return void res.writeHead(202).end();
      let result: unknown;
      if (message.method === "initialize") result = { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } };
      else if (message.method === "tools/list")
        result = {
          tools: [
            { name: "create_page", description: "Cria uma página", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
            { name: "buscar página", description: "Busca", inputSchema: { type: "object", properties: {} } },
          ],
        };
      else if (message.method === "tools/call") result = { content: [{ type: "text", text: `criada: ${JSON.stringify(message.params?.arguments)}` }] };
      const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
      const headers = { "mcp-session-id": "sessao-1" };
      if (options.sse) res.writeHead(200, { ...headers, "content-type": "text/event-stream" }).end(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: ${body}\n\n`);
      else res.writeHead(200, { ...headers, "content-type": "application/json" }).end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen };
}

const servers: Server[] = [];
const services: LibraryService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

type FakeTerminal = { status: () => "stopped" | "idle" | "busy"; stop: () => Promise<void>; stops: number };

export const AVATAR = { skin: "#f", hair: "#f", hairColor: "#f", shirt: "#f", pants: "#f" };

async function setup(terminals: Record<string, FakeTerminal> = {}, allowStdio = true) {
  const dir = await tempDir();
  const events: ServerEvent[] = [];
  const library = await LibraryService.open({
    libraryDir: dir,
    publishPlatform: () => undefined,
    claudeList: { command: "/nao-existe/claude" },
    autoTest: false,
    allowStdio,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => NOW,
  });
  const agents = [
    { id: "maestro", name: "Maestro" },
    { id: "clara", name: "Clara" },
    { id: "beto", name: "Beto" },
  ];
  // eslint-disable-next-line prefer-const -- atribuído depois do `attach`
  let service: ConnectorsService | undefined;
  library.attach("a", {
    name: () => "Principal",
    agents: () => agents.map((agent) => ({ ...agent, avatar: AVATAR, maestro: agent.id === "maestro" })),
    publish: (event) => {
      events.push(structuredClone(event));
      service?.handleEvent(event);
    },
  });
  service = new ConnectorsService(library, {
    workspaceId: "a",
    agents: () => agents,
    terminal: (agentId) => terminals[agentId],
    claudeList: { command: "/nao-existe/claude" },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  services.push(library);
  return { service, events, library };
}

function fakeTerminal(status: "stopped" | "idle" | "busy"): FakeTerminal {
  const terminal: FakeTerminal = {
    status: () => status,
    stops: 0,
    stop: async () => {
      terminal.stops++;
    },
  };
  return terminal;
}

describe("gateway HTTP", () => {
  it("testa (initialize + tools/list), guarda as ferramentas e mostra só ao agente ligado, com prefixo", async () => {
    const fake = await fakeHttpMcp({ requireToken: true });
    const { service } = await setup();
    await service.create({ name: "Notion", kind: "http", url: fake.url, headers: { Authorization: `Bearer ${TOKEN}` }, agentIds: ["clara"] });
    const tested = await service.test("notion");
    expect(tested.status).toMatchObject({ state: "connected", checkedAt: NOW.toISOString(), tools: [{ name: "create_page", description: "Cria uma página" }, { name: "buscar página" }] });
    expect(fake.seen.map((s) => s.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    // A sessão do servidor volta nos pedidos seguintes.
    expect(fake.seen.at(-1)!.session).toBe("sessao-1");

    const tools = service.toolsFor("clara");
    expect(tools.map((t) => t.name)).toEqual(["notion__create_page", expect.stringMatching(/^notion__buscar_p_gina_[0-9a-z]{5}$/)]);
    expect(tools[0]!.description).toBe("[Connector Notion] Cria uma página");
    expect(service.toolsFor("beto")).toEqual([]);
    expect(service.toolsFor("maestro")).toEqual([]);

    // tools/list do nosso servidor MCP repassa o JSON Schema do conector.
    const listed = (await handleMcpPayload({ jsonrpc: "2.0", id: 1, method: "tools/list" }, () => tools)) as { result: { tools: { name: string; inputSchema: unknown }[] } };
    expect(listed.result.tools[0]!.inputSchema).toEqual({ type: "object", properties: { title: { type: "string" } }, required: ["title"] });
  });

  it("chamada: repassa os argumentos com o cabeçalho secreto, devolve o conteúdo e publica a atividade", async () => {
    const fake = await fakeHttpMcp({ requireToken: true, sse: true });
    const { service, events } = await setup();
    await service.create({ name: "Notion", kind: "http", url: fake.url, headers: { Authorization: `Bearer ${TOKEN}` }, agentIds: ["clara"] });
    await service.test("notion");
    const response = (await handleMcpPayload(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "notion__create_page", arguments: { title: "Ata" } } },
      () => service.toolsFor("clara"),
    )) as { result: { content: { text: string }[]; isError: boolean } };
    expect(response.result).toEqual({ content: [{ type: "text", text: 'criada: {"title":"Ata"}' }], isError: false });
    const call = fake.seen.find((s) => s.method === "tools/call")!;
    expect(call).toMatchObject({ auth: `Bearer ${TOKEN}`, args: { title: "Ata" } });
    const activity = events.flatMap((event) => (event.type === "connector:activity" ? [event.activity] : []));
    expect(activity).toEqual([
      { connectorId: "notion", agentId: "clara", tool: "create_page", phase: "started", at: NOW.toISOString() },
      { connectorId: "notion", agentId: "clara", tool: "create_page", phase: "finished", ok: true, at: NOW.toISOString() },
    ]);
    // Nada de segredo em evento nenhum.
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it("sem credencial = precisa de login; servidor fora do ar = erro com motivo; nenhum segredo no motivo", async () => {
    const fake = await fakeHttpMcp({ requireToken: true });
    const { service } = await setup();
    await service.create({ name: "Notion", kind: "http", url: fake.url, headers: { Authorization: "Bearer errado-123456" } });
    expect((await service.test("notion")).status).toMatchObject({ state: "needs_auth", reason: "o servidor pediu login/credencial (HTTP 401)" });
    await service.create({ name: "Fora", kind: "http", url: "http://127.0.0.1:9/mcp?key=segredo-da-url" });
    const down = await service.test("fora");
    expect(down.status.state).toBe("error");
    expect(down.status.reason).toMatch(/não conectou/);
    expect(JSON.stringify(down)).not.toContain("segredo-da-url");
    // Desligado: nem tenta.
    await service.update("fora", { enabled: false });
    expect((await service.test("fora")).status.state).toBe("disabled");
  });

  it("chamada que falha vira resultado com erro para o agente e atualiza o estado", async () => {
    const fake = await fakeHttpMcp({ requireToken: true });
    const { service } = await setup();
    await service.create({ name: "Notion", kind: "http", url: fake.url, headers: { Authorization: `Bearer ${TOKEN}` }, agentIds: ["clara"] });
    await service.test("notion");
    await service.update("notion", { headers: { Authorization: "Bearer trocado-errado" } });
    const tool = service.toolsFor("clara")[0]!;
    const result = await tool.call({ title: "x" });
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toMatch(/needs a login/);
    expect(service.list()[0]!.status.state).toBe("needs_auth");
  });

  it("statusFromError mapeia credencial e apaga segredos", () => {
    expect(statusFromError(new ConnectorAuthError("HTTP 401"), [])).toEqual({ state: "needs_auth", reason: "HTTP 401" });
    expect(statusFromError(new Error("falhou com abc-segredo"), ["abc-segredo"])).toEqual({ state: "error", reason: "falhou com •••" });
  });
});

describe("gateway stdio", () => {
  const script = fileURLToPath(new URL("./fake-mcp-stdio.mjs", import.meta.url));

  it("sobe o processo com as variáveis secretas (que o agente nunca vê), lista e chama", async () => {
    const { service } = await setup();
    await service.create({ name: "Local", kind: "stdio", command: process.execPath, args: [script], env: { FAKE_TOKEN: "tok-stdio-123456" }, agentIds: ["maestro"] });
    expect((await service.test("local")).status).toMatchObject({ state: "connected", tools: [{ name: "eco" }, { name: "segredo" }, { name: "morrer" }] });
    const tools = service.toolsFor("maestro");
    expect(tools.map((t) => t.name)).toEqual(["local__eco", "local__segredo", "local__morrer"]);
    expect(await tools[0]!.call({ texto: "oi" })).toMatchObject({ content: [{ type: "text", text: "eco: oi" }], isError: false });
    expect(await tools[1]!.call({})).toMatchObject({ content: [{ type: "text", text: "token ok" }] });
    // O processo morre: erro para o agente, sem o segredo que ele escreveu no stderr.
    const died = await tools[2]!.call({});
    expect(died.isError).toBe(true);
    expect(died.text).toMatch(/o processo saiu/);
    expect(died.text).not.toContain("tok-stdio-123456");
    // A próxima chamada sobe de novo.
    expect(await tools[0]!.call({ texto: "de novo" })).toMatchObject({ content: [{ type: "text", text: "eco: de novo" }] });
  });

  it("stdio desligado (padrão do server): não cadastra nem executa comando", async () => {
    const { service } = await setup({}, false);
    await expect(service.create({ name: "Local", kind: "stdio", command: process.execPath })).rejects.toMatchObject({ statusCode: 403 });
    expect(service.list()).toHaveLength(0);
  });

  it("comando que não existe = erro claro", async () => {
    const { service } = await setup();
    await service.create({ name: "Nada", kind: "stdio", command: "/nao-existe/servidor-mcp" });
    expect((await service.test("nada")).status).toMatchObject({ state: "error", reason: expect.stringMatching(/comando não encontrado/) });
  });
});

describe("terminais e Maestro", () => {
  it("ferramentas do agente mudaram: terminal ocioso reinicia; ocupado espera; parado não precisa", async () => {
    const fake = await fakeHttpMcp();
    const terminals = { clara: fakeTerminal("idle"), beto: fakeTerminal("busy"), maestro: fakeTerminal("stopped") };
    const { service } = await setup(terminals);
    await service.create({ name: "Notion", kind: "http", url: fake.url });
    await service.test("notion");
    expect(terminals.clara.stops).toBe(0);
    await service.setAgentConnectors("clara", ["notion"]);
    await service.setAgentConnectors("beto", ["notion"]);
    await service.setAgentConnectors("maestro", ["notion"]);
    expect(terminals.clara.stops).toBe(1);
    expect(terminals.beto.stops).toBe(0);
    expect(terminals.maestro.stops).toBe(0);
    // O beto termina o turno (agent:terminal idle): agora reinicia.
    terminals.beto.status = () => "idle";
    service.handleEvent({ type: "agent:terminal", terminal: { agentId: "beto", engine: "claude", status: "idle", updatedAt: NOW.toISOString() } });
    expect(terminals.beto.stops).toBe(1);
    // Só o nome do conector mudou: as ferramentas são as mesmas, ninguém reinicia.
    await service.update("notion", { name: "Notion 2" });
    expect(terminals.clara.stops).toBe(1);
  });

  it("get_team ganha a lista de conectores e quem usa cada um", async () => {
    const { service } = await setup();
    await service.create({ name: "Notion", kind: "http", url: "https://n.com/mcp", agentIds: ["clara", "maestro"] });
    expect(service.teamNote()).toBe("## Conectores (servidores MCP externos)\n- Notion (ferramentas notion__*; 0 ferramentas; estado: unknown) — usado por: Clara, Maestro");
  });
});
