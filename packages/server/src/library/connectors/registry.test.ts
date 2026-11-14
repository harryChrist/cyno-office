import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { WriteQueue } from "../../store/write-queue";
import { useTempDirs } from "../../dev/test-utils";
import { candidateName, importCandidates, parseClaudeMcpList, splitCommand } from "./import-claude";
import { ConnectorRegistry, type RegistryChange } from "./registry";
import { libraryConnectorPaths, maskUrl, publicLibraryConnector, readConnectorsFile, redact, secretValues, workspaceConnector, type StoredConnector } from "./store";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const tempDir = useTempDirs();

async function setup(workspaces: Record<string, string[]> = { a: ["maestro", "clara", "beto"], b: ["dora"] }) {
  const dir = await tempDir();
  const changes: RegistryChange[] = [];
  const paths = libraryConnectorPaths(dir);
  const queue = new WriteQueue();
  const make = (records: StoredConnector[]) =>
    new ConnectorRegistry(records, {
      paths,
      queue,
      onChange: (change) => changes.push(structuredClone(change)),
      workspaceExists: (ws) => ws in workspaces,
      agentExists: (ws, id) => workspaces[ws]?.includes(id) ?? false,
      log: { error: () => undefined },
      now: () => NOW,
    });
  return { dir, changes, paths, queue, registry: make([]), make };
}

describe("segredos dos conectores", () => {
  it("maskUrl esconde valores de query e pedaços de caminho com cara de chave", () => {
    expect(maskUrl("https://mcp.notion.com/mcp")).toBe("https://mcp.notion.com/mcp");
    expect(maskUrl("https://x.com/mcp?api_key=abc123&modo=1")).toBe("https://x.com/mcp?api_key=•••&modo=•••");
    expect(maskUrl("https://mcp.zapier.com/api/mcp/s/AbC123dEf456GhI789jKl0/mcp")).toBe("https://mcp.zapier.com/api/mcp/s/•••/mcp");
  });

  it("redact troca os valores (e o token sem o 'Bearer') por •••", () => {
    const secrets = secretValues({ headers: { Authorization: "Bearer tok-http-987654" }, env: { KEY: "valor-secreto" }, url: "https://x.com/mcp?k=chave-na-url" });
    const text = redact("falhou com Bearer tok-http-987654, tok-http-987654, valor-secreto e chave-na-url", secrets);
    expect(text).not.toMatch(/tok-http|valor-secreto|chave-na-url/);
  });
});

describe("ConnectorRegistry", () => {
  it("CRUD: cria, edita, apaga; a visão pública e os eventos nunca levam os valores dos segredos; arquivo 0600", async () => {
    const { registry, changes, paths, make } = await setup();
    const created = await registry.create({ name: "Notion", kind: "http", url: "https://mcp.notion.com/mcp?token=segredo-na-url", headers: { Authorization: "Bearer tok-abc-123456" }, icon: { kind: "brand", slug: "notion" }, color: "#000000" }, { a: { agentIds: ["maestro"] } });
    expect(created).toMatchObject({ id: "notion", toolPrefix: "notion", kind: "http", enabled: true, origin: "manual", grants: { a: { agentIds: ["maestro"] } } });
    const pub = publicLibraryConnector(created, []);
    expect(pub).toMatchObject({ secretHeaders: ["Authorization"], secretEnv: [], url: "https://mcp.notion.com/mcp?token=•••", status: { state: "unknown" } });
    expect(JSON.stringify([pub, workspaceConnector(created, "a")])).not.toMatch(/tok-abc|segredo-na-url/);
    expect(workspaceConnector(created, "a").agentIds).toEqual(["maestro"]);
    expect(workspaceConnector(created, "b").agentIds).toEqual([]);

    await registry.save();
    expect((await stat(paths.file)).mode & 0o777).toBe(0o600);
    const onDisk = await readConnectorsFile(paths.file);
    expect(onDisk[0]!.headers).toEqual({ Authorization: "Bearer tok-abc-123456" });

    // PATCH: valor novo troca, null apaga, ausente mantém; mudar a conexão volta o estado para "unknown".
    const { record, change } = await registry.update("notion", { headers: { authorization: "Bearer novo-tok-999999", "X-Extra": "e" } });
    expect(change.connectionChanged).toBe(true);
    expect(publicLibraryConnector(record, []).secretHeaders).toEqual(["X-Extra", "authorization"]);
    expect(registry.record("notion")!.headers).toEqual({ authorization: "Bearer novo-tok-999999", "X-Extra": "e" });
    const renamed = await registry.update("notion", { name: "Notion da firma" });
    expect(renamed.change.connectionChanged).toBe(false);
    await registry.update("notion", { headers: { "X-Extra": null } });
    expect(Object.keys(registry.record("notion")!.headers)).toEqual(["authorization"]);

    // Recarrega do disco: igual (inclusive as liberações).
    await registry.save();
    const reopened = make(await readConnectorsFile(paths.file));
    expect(reopened.get("notion")).toMatchObject({ name: "Notion da firma", grants: { a: { agentIds: ["maestro"] } } });

    await registry.remove("notion");
    expect(registry.all()).toEqual([]);
    expect(changes.at(-1)).toEqual({ kind: "deleted", id: "notion", name: "Notion da firma", notify: ["a"] });
    await expect(registry.update("notion", { name: "x" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("ids e prefixos únicos; desligar = estado disabled; workspace e agente que não existem = 404", async () => {
    const { registry } = await setup();
    await registry.create({ name: "GitHub", kind: "http", url: "https://api.githubcopilot.com/mcp/" });
    const second = await registry.create({ name: "GitHub", kind: "stdio", command: "npx", args: ["-y", "gh-mcp"], env: { GITHUB_TOKEN: "ghp_x1y2z3" } });
    expect(second.id).toBe("github-2");
    expect(second.toolPrefix).toBe("github-2");
    expect(publicLibraryConnector(second, []).secretEnv).toEqual(["GITHUB_TOKEN"]);
    const { record } = await registry.update("github", { enabled: false });
    expect(record.status.state).toBe("disabled");
    await expect(registry.create({ name: "X", kind: "http", url: "https://x.com" }, { a: { agentIds: ["fantasma"] } })).rejects.toMatchObject({ statusCode: 404 });
    await expect(registry.create({ name: "X", kind: "http", url: "https://x.com" }, { nenhum: { agentIds: [] } })).rejects.toMatchObject({ statusCode: 404 });
    // Agente de outro workspace não vale: "dora" é do workspace b.
    await expect(registry.create({ name: "X", kind: "http", url: "https://x.com" }, { a: { agentIds: ["dora"] } })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("liberações em dois níveis: workspace e agentes; mapa inteiro; retirar; só entrega o que o workspace recebeu", async () => {
    const { registry, changes } = await setup();
    await registry.create({ name: "Notion", kind: "http", url: "https://n.com/mcp" });
    await registry.create({ name: "Pastebin", kind: "http", url: "https://p.com/mcp" });
    // Nada vem liberado por padrão.
    expect(registry.grantedTo("a")).toEqual([]);
    expect(registry.attachedTo("a", "clara")).toEqual([]);
    // Nível 1: o workspace recebe; nível 2: nenhum agente ainda.
    await registry.setGrants("notion", { a: { agentIds: [] } });
    expect(registry.grantedTo("a").map((c) => c.id)).toEqual(["notion"]);
    expect(registry.attachedTo("a", "clara")).toEqual([]);
    // O Maestro (ou o dono) entrega a agentes: só o que o workspace recebeu.
    await expect(registry.setAgentConnectors("a", "clara", ["notion", "pastebin"])).rejects.toMatchObject({ statusCode: 404 });
    expect((await registry.setAgentConnectors("a", "clara", ["notion"])).map((c) => c.id)).toEqual(["notion"]);
    expect(registry.attachedTo("a", "clara").map((c) => c.id)).toEqual(["notion"]);
    // O workspace b não vê nada, nem com o mesmo agente.
    expect(registry.grantedTo("b")).toEqual([]);
    expect(registry.attachedTo("b", "clara")).toEqual([]);
    // Liberar a b e a dora; a de clara continua.
    await registry.setGrants("notion", { a: { agentIds: ["clara"] }, b: { agentIds: ["dora"] } });
    expect(registry.attachedTo("b", "dora").map((c) => c.id)).toEqual(["notion"]);
    // Retirar o workspace a: clara perde, dora fica, e a recebe `dropped`.
    await registry.setGrants("notion", { b: { agentIds: ["dora"] } });
    expect(registry.attachedTo("a", "clara")).toEqual([]);
    expect(changes.at(-1)).toMatchObject({ kind: "upserted", notify: ["b"], dropped: ["a"] });
    // Desligado não conta.
    await registry.update("notion", { enabled: false });
    expect(registry.attachedTo("b", "dora")).toEqual([]);
    // Agente removido sai; workspace removido sai.
    await registry.update("notion", { enabled: true });
    await registry.forgetAgent("b", "dora");
    expect(registry.get("notion").grants.b!.agentIds).toEqual([]);
    await registry.forgetWorkspace("b");
    expect(registry.get("notion").grants).toEqual({});
    await expect(registry.setAgentConnectors("a", "fantasma", [])).rejects.toMatchObject({ statusCode: 404 });
  });

  it("ícone próprio: só PNG/WebP de verdade (conferido pelos bytes); versão sobe a cada envio", async () => {
    const { registry } = await setup();
    await registry.create({ name: "Sistema", kind: "http", url: "https://s.com/mcp" });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("resto")]);
    await expect(registry.setIcon("sistema", "image/png", Buffer.from("<svg onload=alert(1)>"))).rejects.toMatchObject({ statusCode: 400 });
    await expect(registry.setIcon("sistema", "image/webp", png)).rejects.toMatchObject({ statusCode: 400 });
    expect((await registry.setIcon("sistema", "image/png", png)).icon).toEqual({ kind: "custom", version: 1 });
    expect((await registry.setIcon("sistema", "image/png", png)).icon).toEqual({ kind: "custom", version: 2 });
    expect(await registry.readIcon("sistema")).toEqual({ mime: "image/png", bytes: png });
    await registry.update("sistema", { icon: { kind: "monogram" } });
    expect(await registry.readIcon("sistema")).toBeUndefined();
  });

  it("a visão pública tira o inputSchema das ferramentas e esconde o segredo", () => {
    const record = {
      id: "a",
      name: "A",
      kind: "http",
      url: "https://a.com",
      headers: { K: "v-secreto" },
      env: {},
      icon: { kind: "monogram" },
      enabled: true,
      toolPrefix: "a",
      origin: "manual",
      description: "",
      warnings: [],
      weightTokens: 0,
      grants: {},
      status: { state: "connected", tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }] },
      createdAt: "x",
      updatedAt: "x",
    } satisfies StoredConnector;
    expect(publicLibraryConnector(record, []).status.tools).toEqual([{ name: "t", description: "d" }]);
    expect(JSON.stringify(publicLibraryConnector(record, []))).not.toContain("v-secreto");
  });

  it("connectors.json ausente = nenhum; JSON quebrado = erro claro", async () => {
    const { dir, paths } = await setup();
    expect(await readConnectorsFile(paths.file)).toEqual([]);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${dir}/connectors.json`, "{", "utf8");
    await expect(readConnectorsFile(paths.file)).rejects.toThrow(/JSON malformado/);
    expect(await readFile(`${dir}/connectors.json`, "utf8")).toBe("{");
  });
});

const CLAUDE_MCP_LIST = `Checking MCP server health…

claude.ai Notion: https://mcp.notion.com/mcp - ✔ Connected
claude.ai n8n: https://n8n.exemplo.com/mcp-server/http - ! Needs authentication
plugin:desktop-commander:desktop-commander: npx -y @wonderwhy-er/desktop-commander@latest - ✔ Connected
plugin:design:slack: https://mcp.slack.com/mcp (HTTP) - ! Needs authentication
plugin:design:google calendar:  (HTTP) - - Not configured
homarr: http://192.168.1.20:7575/api/mcp (HTTP) - ✔ Connected
antigo: https://velho.com/sse (SSE) - ✗ Failed to connect
chave: https://mcp.x.com/mcp?api_key=abcdef123 (HTTP) - ✔ Connected
meu sistema: node "/opt/meu sistema/server.js" --porta 3 - ✔ Connected
`;

describe("importar do Claude Code (claude mcp list)", () => {
  it("lê nome (com ':' e espaços), alvo, transporte e estado", () => {
    const entries = parseClaudeMcpList(CLAUDE_MCP_LIST);
    expect(entries).toHaveLength(9);
    expect(entries[0]).toEqual({ sourceName: "claude.ai Notion", target: "https://mcp.notion.com/mcp", status: "connected" });
    expect(entries[2]).toEqual({ sourceName: "plugin:desktop-commander:desktop-commander", target: "npx -y @wonderwhy-er/desktop-commander@latest", status: "connected" });
    expect(entries[3]).toMatchObject({ sourceName: "plugin:design:slack", target: "https://mcp.slack.com/mcp", transport: "http", status: "needs_auth" });
    expect(entries[4]).toMatchObject({ sourceName: "plugin:design:google calendar", target: "", status: "not_configured" });
    expect(entries[6]).toMatchObject({ transport: "sse", status: "failed" });
  });

  it("candidatos: sem os não configurados e SSE; stdio separado em comando/args; chave na URL mascarada; já importados marcados", () => {
    const candidates = importCandidates(CLAUDE_MCP_LIST, [{ url: "http://192.168.1.20:7575/api/mcp" }]);
    expect(candidates.map((c) => c.name)).toEqual(["Notion", "N8n", "Desktop-commander", "Slack", "Homarr", "Chave", "Meu sistema"]);
    expect(candidates[0]).toMatchObject({ kind: "http", hostedByClaudeAi: true, alreadyImported: false });
    expect(candidates[2]).toMatchObject({ kind: "stdio", command: "npx", args: ["-y", "@wonderwhy-er/desktop-commander@latest"] });
    expect(candidates[4]).toMatchObject({ alreadyImported: true, hostedByClaudeAi: false });
    expect(candidates[5]).toMatchObject({ url: "https://mcp.x.com/mcp?api_key=•••", urlMasked: true });
    expect(JSON.stringify(candidates)).not.toContain("abcdef123");
    expect(candidates[6]).toMatchObject({ command: "node", args: ["/opt/meu sistema/server.js", "--porta", "3"] });
  });

  it("nome bonito e divisão de comando", () => {
    expect(candidateName("claude.ai Google Drive")).toBe("Google Drive");
    expect(candidateName("plugin:marketing:canva")).toBe("Canva");
    expect(splitCommand(`uvx 'a b' "c d" e`)).toEqual(["uvx", "a b", "c d", "e"]);
  });
});
