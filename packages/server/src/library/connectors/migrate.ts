import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { connectorToolPrefix, type LibraryGrants } from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { writeJsonAtomic } from "../../store/atomic-write";
import { rootPaths } from "../../store/paths";
import { readWorkspaceList } from "../../store/workspace-registry";
import { libraryDirOf } from "../library-service";
import {
  estimateWeightTokens,
  legacyConnectorPaths,
  libraryConnectorPaths,
  readConnectorsFile,
  readLegacyConnectorsFile,
  toConnectorsFile,
  type LegacyStoredConnector,
  type StoredConnector,
} from "./store";

/**
 * Migração dos conectores de cada workspace (`workspaces/<ws>/connectors.json`) para a Biblioteca da
 * plataforma (`platform/library/connectors.json`). Roda no boot, antes dos workspaces abrirem, e é
 * idempotente (`migrated.json` é gravado por último):
 * 1. copia `connectors.json` e `connectors/` de cada workspace para `backup/pre-biblioteca-<data>/`;
 * 2. junta conectores de workspaces diferentes só quando são IDÊNTICOS (mesmo tipo, mesmo endereço ou
 *    comando e argumentos, mesmos segredos com os mesmos valores, mesmo ligado/desligado); segredo ou
 *    conteúdo diferente = conectores separados (id repetido ganha o workspace no fim);
 * 3. mantém o prefixo das ferramentas do primeiro (o agente continua vendo `notion__create_page`);
 * 4. grava a Biblioteca com as liberações (`grants`) de cada workspace e os agentes dele;
 * 5. CONFERE (na memória e relendo do disco) que o conjunto de pares (conector, workspace, agente) é
 *    igual antes e depois e que há o mesmo número de conectores distintos; se não bater, desfaz tudo
 *    (a Biblioteca volta ao que era, os arquivos antigos são restaurados do backup) e nada é marcado
 *    como migrado: o próximo boot tenta de novo.
 * 6. só depois da conferência, o arquivo antigo vira `connectors.legacy.json` (nada é apagado).
 */

export type ConnectorsMigrationReport = {
  migratedAt: string;
  backupDir: string;
  workspaces: { id: string; connectors: number }[];
  before: { connectors: number; distinct: number; pairs: number };
  after: { connectors: number; distinct: number; pairs: number };
  /** Cada conector da Biblioteca e de onde veio (sem segredos: só ids). */
  connectors: { id: string; name: string; toolPrefix: string; from: { workspaceId: string; connectorId: string }[]; grants: Record<string, string[]> }[];
  /** Conectores com o mesmo nome e endereço mas segredo ou configuração diferente (ficaram separados). */
  separated: { name: string; ids: string[]; reason: string }[];
  warnings: string[];
};

export type ConnectorsMigrationResult =
  | { ran: false; reason: "already-migrated" | "no-workspaces" }
  | { ran: true; ok: true; report: ConnectorsMigrationReport }
  | { ran: true; ok: false; error: string };

export type ConnectorsMigrationOptions = {
  dataDir: string;
  now: () => Date;
  log?: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
  /** Gancho de teste: depois de gravar a Biblioteca, antes da conferência do disco (pode estragar o arquivo). */
  afterWrite?: (libraryDir: string) => void | Promise<void>;
};

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const sortedEntries = (record: Record<string, string>) => Object.entries(record).sort(([a], [b]) => a.localeCompare(b));

/** Impressão digital de um conector: o que o faz ser "o mesmo" (inclui os valores dos segredos, por isso só o hash circula). */
function fingerprint(record: { kind: string; url?: string; command?: string; args?: string[]; headers: Record<string, string>; env: Record<string, string>; enabled: boolean }): string {
  return sha([record.kind, record.url ?? null, record.command ?? null, record.args ?? [], sortedEntries(record.headers), sortedEntries(record.env), record.enabled]);
}

type LegacyEntry = { workspaceId: string; record: LegacyStoredConnector };

/** Os pares (conector, workspace, agente) mais "o workspace tem o conector", como um conjunto de textos. */
function pairsOf(entries: { fingerprint: string; workspaceId: string; agentIds: readonly string[] }[]): Set<string> {
  const pairs = new Set<string>();
  for (const entry of entries) {
    pairs.add(`${entry.fingerprint}|${entry.workspaceId}|*`);
    for (const agentId of entry.agentIds) pairs.add(`${entry.fingerprint}|${entry.workspaceId}|${agentId}`);
  }
  return pairs;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((item) => b.has(item));
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function uniqueDir(base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!(await exists(candidate))) return candidate;
  }
}

export async function migrateConnectorsToLibrary(options: ConnectorsMigrationOptions): Promise<ConnectorsMigrationResult> {
  const { dataDir, now, log } = options;
  const libraryDir = libraryDirOf(dataDir);
  const marker = path.join(libraryDir, "migrated.json");
  if (await exists(marker)) return { ran: false, reason: "already-migrated" };
  const root = rootPaths(dataDir);
  const workspaces = await readWorkspaceList(root.workspacesFile);
  if (!workspaces) return { ran: false, reason: "no-workspaces" };

  const libraryPaths = libraryConnectorPaths(libraryDir);
  const legacy: LegacyEntry[] = [];
  const counts: { id: string; connectors: number }[] = [];
  for (const workspace of workspaces) {
    const records = await readLegacyConnectorsFile(legacyConnectorPaths(root.workspaceDir(workspace.id)).file);
    counts.push({ id: workspace.id, connectors: records.length });
    for (const record of records) legacy.push({ workspaceId: workspace.id, record });
  }
  const migratedAt = now().toISOString();

  // Nada a migrar: só marca (um workspace restaurado depois não é tocado por engano).
  if (legacy.length === 0) {
    await mkdir(libraryDir, { recursive: true });
    await writeJsonAtomic(marker, { migratedAt, connectors: 0 });
    return { ran: true, ok: true, report: emptyReport(migratedAt, counts) };
  }

  const backupDir = await uniqueDir(path.join(root.root, "backup", `pre-biblioteca-${migratedAt.slice(0, 10)}`));
  const previousLibrary = await readFile(libraryPaths.file, "utf8").catch(() => undefined);
  const copiedDirs: string[] = [];
  try {
    // 1. Backup.
    for (const { id } of counts) {
      const legacyPaths = legacyConnectorPaths(root.workspaceDir(id));
      const wsBackup = path.join(backupDir, id);
      if (await exists(legacyPaths.file)) {
        await mkdir(wsBackup, { recursive: true });
        await cp(legacyPaths.file, path.join(wsBackup, "connectors.json"));
      }
      const connectorsDir = path.join(root.workspaceDir(id), "connectors");
      if (await exists(connectorsDir)) await cp(connectorsDir, path.join(wsBackup, "connectors"), { recursive: true });
    }

    // 2-4. Junta os idênticos e monta a Biblioteca.
    const existing = await readConnectorsFile(libraryPaths.file);
    const taken = new Set(existing.map((record) => record.id));
    const prefixes = new Set(existing.map((record) => record.toolPrefix));
    const groups = new Map<string, LegacyEntry[]>();
    for (const entry of legacy) {
      const key = fingerprint(entry.record);
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    const built: StoredConnector[] = [];
    const reportConnectors: ConnectorsMigrationReport["connectors"] = [];
    const sources = new Map<string, LegacyEntry>();
    for (const members of groups.values()) {
      const first = members[0]!;
      let id = first.record.id;
      if (taken.has(id)) id = `${first.record.id}-${first.workspaceId}`.slice(0, 64).replace(/-+$/, "");
      for (let n = 2; taken.has(id); n++) id = `${first.record.id}`.slice(0, 60) + `-${n}`;
      taken.add(id);
      let toolPrefix = first.record.toolPrefix;
      for (let n = 2; prefixes.has(toolPrefix); n++) toolPrefix = `${connectorToolPrefix(first.record.toolPrefix).slice(0, 17)}-${n}`;
      prefixes.add(toolPrefix);
      const grants: LibraryGrants = {};
      for (const member of members) {
        const was = grants[member.workspaceId]?.agentIds ?? [];
        grants[member.workspaceId] = { agentIds: [...new Set([...was, ...member.record.agentIds])], grantedAt: migratedAt };
      }
      const { agentIds: _agentIds, ...rest } = first.record;
      const record: StoredConnector = {
        ...structuredClone(rest),
        id,
        toolPrefix,
        description: "",
        warnings: [],
        weightTokens: estimateWeightTokens(first.record.status.tools),
        grants,
        createdAt: members.map((member) => member.record.createdAt).sort()[0]!,
        updatedAt: migratedAt,
      };
      built.push(record);
      sources.set(id, first);
      reportConnectors.push({
        id,
        name: record.name,
        toolPrefix,
        from: members.map((member) => ({ workspaceId: member.workspaceId, connectorId: member.record.id })),
        grants: Object.fromEntries(Object.entries(grants).map(([ws, grant]) => [ws, grant.agentIds])),
      });
    }

    // Conferência 1 (memória).
    const beforeEntries = legacy.map((entry) => ({ fingerprint: fingerprint(entry.record), workspaceId: entry.workspaceId, agentIds: entry.record.agentIds }));
    const beforePairs = pairsOf(beforeEntries);
    const toEntries = (records: StoredConnector[]) =>
      records.flatMap((record) => Object.entries(record.grants).map(([workspaceId, grant]) => ({ fingerprint: fingerprint(record), workspaceId, agentIds: grant.agentIds })));
    const check = (records: StoredConnector[], where: string) => {
      const afterPairs = pairsOf(toEntries(records));
      const distinctBefore = new Set(beforeEntries.map((entry) => entry.fingerprint)).size;
      const distinctAfter = new Set(records.map((record) => fingerprint(record))).size;
      if (!sameSet(beforePairs, afterPairs)) throw new Error(`a conferência (${where}) falhou: o conjunto de pares (conector, workspace, agente) mudou (${beforePairs.size} antes, ${afterPairs.size} depois)`);
      if (distinctBefore !== distinctAfter || records.length !== distinctAfter) throw new Error(`a conferência (${where}) falhou: ${distinctBefore} conectores distintos antes e ${records.length} (${distinctAfter} distintos) depois`);
      return { distinct: distinctAfter, pairs: afterPairs.size };
    };
    check(built, "memória");

    // Grava a Biblioteca (0600) e copia ícone e pasta de trabalho (cwd do stdio) de cada conector.
    await mkdir(libraryDir, { recursive: true });
    await writeJsonAtomic(libraryPaths.file, toConnectorsFile([...existing, ...built]), 0o600);
    for (const record of built) {
      const source = sources.get(record.id)!;
      const from = legacyConnectorPaths(root.workspaceDir(source.workspaceId)).dir(source.record.id);
      if (await exists(from)) {
        const to = libraryPaths.dir(record.id);
        copiedDirs.push(to);
        await cp(from, to, { recursive: true });
      }
    }
    await options.afterWrite?.(libraryDir);

    // Conferência 2 (relendo do disco só o que foi migrado).
    const onDisk = (await readConnectorsFile(libraryPaths.file)).filter((record) => built.some((candidate) => candidate.id === record.id));
    const verified = check(onDisk, "disco");

    // 6. Só agora os arquivos antigos saem do caminho (viram *.legacy.json), e o marcador vai por último.
    for (const { id } of counts) {
      const file = legacyConnectorPaths(root.workspaceDir(id)).file;
      if (!(await exists(file))) continue;
      await rename(file, await uniqueFile(path.join(root.workspaceDir(id), "connectors.legacy.json")));
    }
    const report: ConnectorsMigrationReport = {
      migratedAt,
      backupDir,
      workspaces: counts,
      before: { connectors: legacy.length, distinct: new Set(beforeEntries.map((entry) => entry.fingerprint)).size, pairs: beforePairs.size },
      after: { connectors: built.length, distinct: verified.distinct, pairs: verified.pairs },
      connectors: reportConnectors,
      separated: separatedOf(built),
      warnings: [],
    };
    for (const item of reportConnectors) {
      const original = legacy.filter((entry) => item.from.some((from) => from.workspaceId === entry.workspaceId && from.connectorId === entry.record.id));
      if (original.some((entry) => entry.record.toolPrefix !== item.toolPrefix)) report.warnings.push(`O prefixo das ferramentas de "${item.name}" mudou para ${item.toolPrefix}__ (o antigo já era de outro conector)`);
    }
    await writeJsonAtomic(path.join(libraryDir, "migration-report.json"), report);
    await writeJsonAtomic(marker, { migratedAt, connectors: built.length, backupDir });
    log?.info({ connectors: built.length, from: legacy.length, backupDir }, "conectores migrados para a Biblioteca");
    return { ran: true, ok: true, report };
  } catch (error) {
    // Desfaz: a Biblioteca volta ao que era e os arquivos antigos são restaurados do backup.
    const message = error instanceof Error ? error.message : String(error);
    log?.error({ err: error }, "migração dos conectores para a Biblioteca falhou: desfazendo");
    for (const dir of copiedDirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    if (previousLibrary === undefined) await rm(libraryPaths.file, { force: true }).catch(() => undefined);
    else await writeFile(libraryPaths.file, previousLibrary, { mode: 0o600 }).catch(() => undefined);
    for (const { id } of counts) {
      const saved = path.join(backupDir, id, "connectors.json");
      if (await exists(saved)) await cp(saved, legacyConnectorPaths(root.workspaceDir(id)).file).catch(() => undefined);
    }
    return { ran: true, ok: false, error: message };
  }
}

async function uniqueFile(file: string): Promise<string> {
  if (!(await exists(file))) return file;
  const { dir, name, ext } = path.parse(file);
  for (let n = 2; ; n++) {
    const candidate = path.join(dir, `${name}-${n}${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
}

function emptyReport(migratedAt: string, counts: { id: string; connectors: number }[]): ConnectorsMigrationReport {
  return { migratedAt, backupDir: "", workspaces: counts, before: { connectors: 0, distinct: 0, pairs: 0 }, after: { connectors: 0, distinct: 0, pairs: 0 }, connectors: [], separated: [], warnings: [] };
}

/** Mesmo nome e mesmo endereço/comando, mas ficaram separados (segredo, argumentos ou "ligado" diferentes). */
function separatedOf(built: StoredConnector[]): ConnectorsMigrationReport["separated"] {
  const byTarget = new Map<string, StoredConnector[]>();
  for (const record of built) {
    const target = `${record.kind}|${record.url ?? record.command ?? ""}`;
    byTarget.set(target, [...(byTarget.get(target) ?? []), record]);
  }
  const out: ConnectorsMigrationReport["separated"] = [];
  for (const records of byTarget.values()) {
    if (records.length < 2) continue;
    const secrets = new Set(records.map((record) => JSON.stringify([sortedEntries(record.headers), sortedEntries(record.env)])));
    out.push({ name: records[0]!.name, ids: records.map((record) => record.id), reason: secrets.size > 1 ? "segredos diferentes" : "configuração diferente (argumentos ou ligado/desligado)" });
  }
  return out;
}
