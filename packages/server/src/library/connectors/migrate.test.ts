import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { rootPaths } from "../../store/paths";
import { migrateConnectorsToLibrary } from "./migrate";
import { legacyConnectorPaths, libraryConnectorPaths, readConnectorsFile, type LegacyStoredConnector } from "./store";
import { libraryDirOf } from "../library-service";

const NOW = new Date("2026-11-11T12:00:00.000Z");
const tempDir = useTempDirs();
const LOG = { info: () => undefined, warn: () => undefined, error: () => undefined };

const legacy = (over: Partial<LegacyStoredConnector> & { id: string }): LegacyStoredConnector => ({
  name: over.id,
  kind: "http",
  url: "https://mcp.notion.com/mcp",
  headers: {},
  env: {},
  icon: { kind: "monogram" },
  enabled: true,
  agentIds: [],
  toolPrefix: over.id,
  origin: "manual",
  status: { state: "connected", checkedAt: NOW.toISOString(), tools: [{ name: "search", description: "Busca", inputSchema: { type: "object" } }] },
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

/** DATA_DIR no formato antigo: workspaces a e b, com conectores por workspace. */
async function fixture(files: Record<string, LegacyStoredConnector[]>) {
  const dataDir = await tempDir();
  const root = rootPaths(dataDir);
  await writeFile(root.workspacesFile, JSON.stringify(Object.keys(files).map((id) => ({ id, name: id.toUpperCase(), createdAt: NOW.toISOString() }))));
  for (const [ws, connectors] of Object.entries(files)) {
    const paths = legacyConnectorPaths(root.workspaceDir(ws));
    await mkdir(path.dirname(paths.file), { recursive: true });
    if (connectors.length > 0) await writeFile(paths.file, JSON.stringify({ version: 1, connectors }, null, 2), { mode: 0o600 });
  }
  return { dataDir, root, library: libraryConnectorPaths(libraryDirOf(dataDir)) };
}

const NOTION_SECRET = { Authorization: "Bearer tok-notion-1" };

describe("migração dos conectores para a Biblioteca", () => {
  it("junta conectores idênticos de workspaces diferentes; separa os que diferem no segredo; mantém prefixos e agentes", async () => {
    const { dataDir, root, library } = await fixture({
      a: [
        legacy({ id: "notion", headers: NOTION_SECRET, agentIds: ["maestro", "clara"], icon: { kind: "brand", slug: "notion" } }),
        legacy({ id: "linkedin", url: "https://mcp.linkedin.example/mcp", headers: { Authorization: "Bearer li-a" }, agentIds: ["clara"] }),
        legacy({ id: "fake", kind: "stdio", url: undefined, command: "node", args: ["fake.mjs"], env: { K: "v" }, agentIds: [] }),
      ],
      b: [
        legacy({ id: "notion", headers: NOTION_SECRET, agentIds: ["dora"] }),
        // Mesmo endereço, segredo diferente: fica separado (e o id repetido ganha o workspace).
        legacy({ id: "linkedin", url: "https://mcp.linkedin.example/mcp", headers: { Authorization: "Bearer li-b" }, agentIds: ["dora"] }),
      ],
    });
    // Ícone próprio e pasta de trabalho do stdio são levados junto.
    const iconDir = legacyConnectorPaths(root.workspaceDir("a")).dir("fake");
    await mkdir(iconDir, { recursive: true });
    await writeFile(path.join(iconDir, "icon.bin"), "x");

    const result = await migrateConnectorsToLibrary({ dataDir, now: () => NOW, log: LOG });
    expect(result).toMatchObject({ ran: true, ok: true });
    if (!result.ran || !result.ok) throw new Error("migração não rodou");
    const records = await readConnectorsFile(library.file);
    expect(records.map((record) => record.id)).toEqual(["notion", "linkedin", "fake", "linkedin-b"]);
    expect(records.find((record) => record.id === "notion")).toMatchObject({
      toolPrefix: "notion",
      icon: { kind: "brand", slug: "notion" },
      grants: { a: { agentIds: ["maestro", "clara"] }, b: { agentIds: ["dora"] } },
      status: { state: "connected", tools: [{ name: "search" }] },
    });
    expect(records.find((record) => record.id === "linkedin")).toMatchObject({ toolPrefix: "linkedin", grants: { a: { agentIds: ["clara"] } } });
    expect(records.find((record) => record.id === "linkedin-b")).toMatchObject({ toolPrefix: "linkedin-2", headers: { Authorization: "Bearer li-b" }, grants: { b: { agentIds: ["dora"] } } });
    expect((await stat(library.file)).mode & 0o777).toBe(0o600);
    expect((await stat(library.iconFile("fake"))).isFile()).toBe(true);
    // Nada liberado a mais: 5 conectores antigos viram 4 (um deles em 2 workspaces).
    expect(result.report).toMatchObject({ before: { connectors: 5, distinct: 4 }, after: { connectors: 4, distinct: 4 } });
    expect(result.report.before.pairs).toBe(result.report.after.pairs);
    expect(result.report.separated).toEqual([{ name: "linkedin", ids: ["linkedin", "linkedin-b"], reason: "segredos diferentes" }]);
    expect(result.report.warnings.join(" ")).toMatch(/linkedin/);
    // Backup completo, arquivos antigos renomeados (nada apagado), relatório e marcador gravados.
    expect(await readFile(path.join(result.report.backupDir, "a", "connectors.json"), "utf8")).toContain("tok-notion-1");
    expect(await readFile(path.join(root.workspaceDir("a"), "connectors.legacy.json"), "utf8")).toContain("tok-notion-1");
    await expect(stat(legacyConnectorPaths(root.workspaceDir("a")).file)).rejects.toThrow();
    expect(JSON.parse(await readFile(path.join(libraryDirOf(dataDir), "migrated.json"), "utf8"))).toMatchObject({ connectors: 4 });
    // O relatório nunca leva os valores dos segredos.
    expect(JSON.stringify(result.report)).not.toMatch(/tok-notion|li-a|li-b/);
  });

  it("desligado num workspace e ligado no outro não se juntam (o comportamento de cada um não muda)", async () => {
    const { dataDir, library } = await fixture({
      a: [legacy({ id: "notion", enabled: true, agentIds: ["clara"] })],
      b: [legacy({ id: "notion", enabled: false, agentIds: ["dora"], status: { state: "disabled", tools: [] } })],
    });
    await migrateConnectorsToLibrary({ dataDir, now: () => NOW, log: LOG });
    const records = await readConnectorsFile(library.file);
    expect(records).toHaveLength(2);
    expect(records.find((record) => record.id === "notion")).toMatchObject({ enabled: true, grants: { a: { agentIds: ["clara"] } } });
    expect(records.find((record) => record.id === "notion-b")).toMatchObject({ enabled: false, grants: { b: { agentIds: ["dora"] } } });
  });

  it("é idempotente: a segunda vez não faz nada e não mexe na Biblioteca", async () => {
    const { dataDir, library } = await fixture({ a: [legacy({ id: "notion", agentIds: ["clara"] })], b: [] });
    expect(await migrateConnectorsToLibrary({ dataDir, now: () => NOW, log: LOG })).toMatchObject({ ran: true, ok: true });
    const first = await readFile(library.file, "utf8");
    expect(await migrateConnectorsToLibrary({ dataDir, now: () => NOW, log: LOG })).toEqual({ ran: false, reason: "already-migrated" });
    expect(await readFile(library.file, "utf8")).toBe(first);
  });

  it("sem conectores em lugar nenhum: só marca como migrado", async () => {
    const { dataDir, library } = await fixture({ a: [], b: [] });
    expect(await migrateConnectorsToLibrary({ dataDir, now: () => NOW, log: LOG })).toMatchObject({ ran: true, ok: true });
    expect(await readConnectorsFile(library.file)).toEqual([]);
    expect((await migrateConnectorsToLibrary({ dataDir, now: () => NOW, log: LOG })).ran).toBe(false);
  });

  it("a conferência falhou (arquivo estragado depois de gravar): restaura tudo e não marca como migrado; o próximo boot tenta de novo", async () => {
    const { dataDir, root, library } = await fixture({
      a: [legacy({ id: "notion", headers: NOTION_SECRET, agentIds: ["clara"] })],
      b: [legacy({ id: "notion", headers: NOTION_SECRET, agentIds: ["dora"] })],
    });
    const original = await readFile(legacyConnectorPaths(root.workspaceDir("a")).file, "utf8");
    const broken = await migrateConnectorsToLibrary({
      dataDir,
      now: () => NOW,
      log: LOG,
      // Um agente some das liberações entre a gravação e a releitura.
      afterWrite: async () => {
        const records = await readConnectorsFile(library.file);
        records[0]!.grants.b!.agentIds = [];
        await writeFile(library.file, JSON.stringify({ version: 1, connectors: records }));
      },
    });
    expect(broken).toMatchObject({ ran: true, ok: false, error: expect.stringMatching(/conferência \(disco\) falhou/) });
    // A Biblioteca voltou ao que era (nada), os arquivos antigos estão como estavam, sem marcador.
    await expect(stat(library.file)).rejects.toThrow();
    expect(await readFile(legacyConnectorPaths(root.workspaceDir("a")).file, "utf8")).toBe(original);
    await expect(stat(path.join(libraryDirOf(dataDir), "migrated.json"))).rejects.toThrow();
    // Sem o defeito, a mesma migração passa.
    expect(await migrateConnectorsToLibrary({ dataDir, now: () => NOW, log: LOG })).toMatchObject({ ran: true, ok: true });
    expect(await readConnectorsFile(library.file)).toHaveLength(1);
  });
});
