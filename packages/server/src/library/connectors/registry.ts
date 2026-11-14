import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  connectorToolPrefix,
  uniqueSlug,
  type ConnectorIconMime,
  type CreateLibraryConnectorBody,
  type LibraryGrants,
  type LibraryGrantsInput,
  type UpdateLibraryConnectorBody,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { HttpError } from "../../platform/http/errors";
import { writeJsonAtomic } from "../../store/atomic-write";
import type { WriteQueue } from "../../store/write-queue";
import { estimateWeightTokens, toConnectorsFile, type ConnectorLimits, type ConnectorPaths, type StoredConnector } from "./store";

/**
 * O que mudou na Biblioteca (o LibraryService transforma em eventos: `library:*` para todos e
 * `connector:*` para os workspaces afetados, e em linhas da Atividade).
 * - `notify`: workspaces que têm (ou ainda têm) o conector e devem receber o conector atualizado;
 * - `dropped`: workspaces que acabaram de perder o conector.
 */
export type RegistryChange =
  | { kind: "upserted"; record: StoredConnector; notify: string[]; dropped: string[] }
  | { kind: "deleted"; id: string; name: string; notify: string[] };

export type ConnectorRegistryDeps = {
  paths: ConnectorPaths;
  /** Fila de escrita da plataforma. */
  queue: WriteQueue;
  onChange: (change: RegistryChange) => void;
  /** O workspace existe? (liberar para um que não existe = 404) */
  workspaceExists: (workspaceId: string) => boolean;
  /** O agente existe nesse workspace? (entregar a agente que não existe = 404) */
  agentExists: (workspaceId: string, agentId: string) => boolean;
  log: Pick<FastifyBaseLogger, "error">;
  now: () => Date;
};

/** O que mudou num conector (o gateway refaz o cliente e testa de novo quando a conexão mudou). */
export type ConnectorChange = { connectionChanged: boolean };

/** Assinatura PNG / WebP (o tipo declarado precisa bater com os bytes). */
function imageMatches(mime: ConnectorIconMime, bytes: Buffer): boolean {
  if (mime === "image/png") return bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return bytes.length > 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
}

/** Segredos do PATCH: valor = define, null = apaga, ausente = fica. */
function applySecrets(current: Record<string, string>, change: Record<string, string | null> | undefined): Record<string, string> {
  if (!change) return current;
  const next = { ...current };
  for (const [name, value] of Object.entries(change)) {
    // Nome de cabeçalho não diferencia maiúsculas: troca o que já existe com outra grafia.
    for (const existing of Object.keys(next)) if (existing.toLowerCase() === name.toLowerCase() && existing !== name) delete next[existing];
    if (value === null) delete next[name];
    else next[name] = value;
  }
  return next;
}

/**
 * Conectores da plataforma (`data/platform/library/connectors.json`, modo 0600, escrita atômica pela
 * fila da plataforma; ícones próprios em `connectors/<id>/icon.bin`). Cada conector guarda as
 * liberações (`grants`: workspace -> agentes). Toda mudança avisa `onChange` (sem segredos: quem
 * transforma em evento usa a visão pública). Agente ou workspace removido sai das liberações.
 */
export class ConnectorRegistry {
  private readonly records: StoredConnector[];

  constructor(
    records: StoredConnector[],
    private readonly deps: ConnectorRegistryDeps,
  ) {
    this.records = structuredClone(records);
  }

  /** Cópias dos registros (com segredos: só o server usa). */
  all(): StoredConnector[] {
    return structuredClone(this.records);
  }

  get(id: string): StoredConnector {
    return structuredClone(this.require(id));
  }

  record(id: string): StoredConnector | undefined {
    const found = this.records.find((record) => record.id === id);
    return found ? structuredClone(found) : undefined;
  }

  /** Conectores ligados que o agente recebeu neste workspace (para o gateway montar as ferramentas dele). */
  attachedTo(workspaceId: string, agentId: string): StoredConnector[] {
    return this.records.filter((record) => record.enabled && record.grants[workspaceId]?.agentIds.includes(agentId)).map((record) => structuredClone(record));
  }

  /** Conectores liberados ao workspace (os agentes de cada um em `grants`). */
  grantedTo(workspaceId: string): StoredConnector[] {
    return this.records.filter((record) => workspaceId in record.grants).map((record) => structuredClone(record));
  }

  async create(body: Omit<CreateLibraryConnectorBody, "origin"> & { origin?: StoredConnector["origin"]; appId?: string; warnings?: string[]; limits?: ConnectorLimits }, grants?: LibraryGrantsInput): Promise<StoredConnector> {
    const now = this.deps.now().toISOString();
    const id = uniqueSlug(body.name, this.records.map((record) => record.id));
    const prefixes = new Set(this.records.map((record) => record.toolPrefix));
    let toolPrefix = connectorToolPrefix(id);
    for (let n = 2; prefixes.has(toolPrefix); n++) toolPrefix = `${connectorToolPrefix(id).slice(0, 17)}-${n}`;
    const nextGrants = this.buildGrants({}, grants ?? body.grants ?? {});
    const enabled = body.enabled ?? true;
    const record: StoredConnector = {
      id,
      name: body.name.trim(),
      kind: body.kind,
      ...(body.kind === "http" ? { url: body.url } : { command: body.command, args: body.args ?? [] }),
      headers: body.kind === "http" ? { ...body.headers } : {},
      env: body.kind === "stdio" ? { ...body.env } : {},
      icon: body.icon ?? { kind: "monogram" },
      ...(body.color ? { color: body.color.toLowerCase() } : {}),
      enabled,
      toolPrefix,
      origin: body.origin ?? "manual",
      description: body.description?.trim() ?? "",
      warnings: body.warnings ? [...body.warnings] : [],
      ...(body.appId ? { appId: body.appId } : {}),
      ...(body.limits ? { limits: { ...body.limits } } : {}),
      weightTokens: 0,
      grants: nextGrants,
      status: { state: enabled ? "unknown" : "disabled", tools: [] },
      createdAt: now,
      updatedAt: now,
    };
    this.records.push(record);
    await this.commit(record, []);
    return structuredClone(record);
  }

  async update(id: string, body: UpdateLibraryConnectorBody): Promise<{ record: StoredConnector; change: ConnectorChange }> {
    const record = this.require(id);
    const before = JSON.stringify([record.url, record.command, record.args, record.headers, record.env, record.enabled]);
    if (body.name !== undefined) record.name = body.name.trim();
    if (body.description !== undefined) record.description = body.description.trim();
    if (record.kind === "http") {
      if (body.url !== undefined) record.url = body.url;
      record.headers = applySecrets(record.headers, body.headers);
    } else {
      if (body.command !== undefined) record.command = body.command;
      if (body.args !== undefined) record.args = [...body.args];
      record.env = applySecrets(record.env, body.env);
    }
    if (body.icon !== undefined) {
      if (record.icon.kind === "custom") await this.removeIconFile(id);
      record.icon = body.icon;
    }
    if (body.color === null) delete record.color;
    else if (body.color !== undefined) record.color = body.color.toLowerCase();
    if (body.enabled !== undefined) {
      record.enabled = body.enabled;
      if (!body.enabled) record.status = { ...record.status, state: "disabled", reason: undefined };
      else if (record.status.state === "disabled") record.status = { ...record.status, state: "unknown" };
    }
    const connectionChanged = before !== JSON.stringify([record.url, record.command, record.args, record.headers, record.env, record.enabled]);
    if (connectionChanged && record.enabled) record.status = { ...record.status, state: "unknown", reason: undefined };
    record.updatedAt = this.deps.now().toISOString();
    await this.commit(record, []);
    return { record: structuredClone(record), change: { connectionChanged } };
  }

  /** Conector que veio de um app instalado (o `appId` é o dono: some junto com ele). */
  findByApp(appId: string): StoredConnector[] {
    return this.records.filter((record) => record.appId === appId).map((record) => structuredClone(record));
  }

  /** Conector `app` (sem processo próprio: as ferramentas rodam pelo AppToolRunner). Sem liberação a ninguém. */
  async createApp(input: { name: string; description: string; appId: string; warnings: string[] }): Promise<StoredConnector> {
    const now = this.deps.now().toISOString();
    const id = uniqueSlug(input.name, this.records.map((record) => record.id));
    const prefixes = new Set(this.records.map((record) => record.toolPrefix));
    let toolPrefix = connectorToolPrefix(id);
    for (let n = 2; prefixes.has(toolPrefix); n++) toolPrefix = `${connectorToolPrefix(id).slice(0, 17)}-${n}`;
    const record: StoredConnector = {
      id,
      name: input.name.trim(),
      kind: "app",
      headers: {},
      env: {},
      icon: { kind: "monogram" },
      enabled: true,
      toolPrefix,
      origin: "app",
      description: input.description.trim(),
      warnings: [...input.warnings],
      appId: input.appId,
      weightTokens: 0,
      grants: {},
      status: { state: "unknown", tools: [] },
      createdAt: now,
      updatedAt: now,
    };
    this.records.push(record);
    await this.commit(record, []);
    return structuredClone(record);
  }

  /** O app trouxe comando novo (atualização) ou voltou a funcionar: troca a conexão e mantém id, liberações e ícone. */
  async updateApp(id: string, input: { description: string; command?: string; args?: string[]; env?: Record<string, string>; warnings: string[]; limits?: ConnectorLimits }): Promise<StoredConnector> {
    const record = this.require(id);
    record.description = input.description;
    if (record.kind !== "app") {
      record.command = input.command;
      record.args = [...(input.args ?? [])];
      record.env = { ...input.env };
    }
    record.warnings = [...input.warnings];
    if (input.limits) record.limits = { ...input.limits };
    else delete record.limits;
    record.enabled = true;
    record.status = { ...record.status, state: "unknown", reason: undefined };
    record.updatedAt = this.deps.now().toISOString();
    await this.commit(record, []);
    return structuredClone(record);
  }

  async remove(id: string): Promise<StoredConnector> {
    const index = this.records.findIndex((record) => record.id === id);
    if (index === -1) throw new HttpError(404, `Conector "${id}" não encontrado`);
    const [removed] = this.records.splice(index, 1);
    const saved = this.save();
    this.deps.onChange({ kind: "deleted", id, name: removed!.name, notify: Object.keys(removed!.grants) });
    await saved;
    await rm(this.deps.paths.dir(id), { recursive: true, force: true }).catch((error: unknown) => this.deps.log.error({ err: error, connectorId: id }, "não foi possível apagar a pasta do conector"));
    return removed!;
  }

  /** As liberações do conector, o mapa inteiro: o que não está nele é retirado. */
  async setGrants(id: string, grants: LibraryGrantsInput): Promise<{ record: StoredConnector; before: LibraryGrants }> {
    const record = this.require(id);
    const before = structuredClone(record.grants);
    record.grants = this.buildGrants(record.grants, grants);
    record.updatedAt = this.deps.now().toISOString();
    await this.commit(record, Object.keys(before).filter((ws) => !(ws in record.grants)));
    return { record: structuredClone(record), before };
  }

  /** Libera o conector a um workspace (e a estes agentes). `agentIds` ausente = só o workspace, mantendo os agentes que já tinha. */
  async grantWorkspace(id: string, workspaceId: string, agentIds?: readonly string[]): Promise<StoredConnector> {
    const record = this.require(id);
    const next: LibraryGrantsInput = {};
    for (const [ws, grant] of Object.entries(record.grants)) next[ws] = { agentIds: grant.agentIds };
    next[workspaceId] = { agentIds: agentIds ? [...agentIds] : (record.grants[workspaceId]?.agentIds ?? []) };
    return (await this.setGrants(id, next)).record;
  }

  /** Retira o conector de um workspace (os agentes dele perdem junto). */
  async revokeWorkspace(id: string, workspaceId: string): Promise<StoredConnector> {
    const record = this.require(id);
    if (!(workspaceId in record.grants)) throw new HttpError(404, `O conector "${id}" não está liberado para o workspace "${workspaceId}"`);
    const next: LibraryGrantsInput = {};
    for (const [ws, grant] of Object.entries(record.grants)) if (ws !== workspaceId) next[ws] = { agentIds: grant.agentIds };
    return (await this.setGrants(id, next)).record;
  }

  /**
   * Conectores de um agente num workspace (lista inteira): entrega os da lista e retira os outros.
   * Só vale para o que foi liberado ao workspace (senão 404).
   */
  async setAgentConnectors(workspaceId: string, agentId: string, connectorIds: readonly string[]): Promise<StoredConnector[]> {
    if (!this.deps.agentExists(workspaceId, agentId)) throw new HttpError(404, `Agente "${agentId}" não encontrado`);
    const wanted = new Set(connectorIds);
    for (const id of wanted) {
      const record = this.require(id);
      if (!(workspaceId in record.grants)) throw new HttpError(404, `Conector "${id}" não encontrado`);
    }
    const changed: StoredConnector[] = [];
    for (const record of this.records) {
      const grant = record.grants[workspaceId];
      if (!grant) continue;
      const has = grant.agentIds.includes(agentId);
      if (has === wanted.has(record.id)) continue;
      grant.agentIds = has ? grant.agentIds.filter((other) => other !== agentId) : [...grant.agentIds, agentId];
      record.updatedAt = this.deps.now().toISOString();
      changed.push(record);
    }
    if (changed.length > 0) {
      const saved = this.save();
      for (const record of changed) this.deps.onChange({ kind: "upserted", record: structuredClone(record), notify: Object.keys(record.grants), dropped: [] });
      await saved;
    }
    return this.records.filter((record) => record.grants[workspaceId]?.agentIds.includes(agentId)).map((record) => structuredClone(record));
  }

  /** Agente removido de um workspace: sai das liberações de lá. */
  async forgetAgent(workspaceId: string, agentId: string): Promise<void> {
    const changed = this.records.filter((record) => record.grants[workspaceId]?.agentIds.includes(agentId));
    if (changed.length === 0) return;
    for (const record of changed) record.grants[workspaceId]!.agentIds = record.grants[workspaceId]!.agentIds.filter((other) => other !== agentId);
    const saved = this.save();
    for (const record of changed) this.deps.onChange({ kind: "upserted", record: structuredClone(record), notify: Object.keys(record.grants), dropped: [] });
    await saved;
  }

  /** Workspace excluído: sai de todas as liberações. */
  async forgetWorkspace(workspaceId: string): Promise<void> {
    const changed = this.records.filter((record) => workspaceId in record.grants);
    if (changed.length === 0) return;
    for (const record of changed) delete record.grants[workspaceId];
    const saved = this.save();
    // O workspace já se foi: ninguém lá para avisar (`dropped` vazio), só os outros e a Biblioteca.
    for (const record of changed) this.deps.onChange({ kind: "upserted", record: structuredClone(record), notify: Object.keys(record.grants), dropped: [] });
    await saved;
  }

  /** Resultado de um teste ou de uma chamada (o gateway chama). Ferramentas ausentes = mantém o cache. */
  async setStatus(id: string, status: Partial<StoredConnector["status"]> & { state: StoredConnector["status"]["state"] }): Promise<StoredConnector | undefined> {
    const record = this.records.find((candidate) => candidate.id === id);
    if (!record) return undefined;
    const tools = status.tools ?? record.status.tools;
    const next: StoredConnector["status"] = { state: status.state, tools, ...(status.reason ? { reason: status.reason } : {}), checkedAt: status.checkedAt ?? this.deps.now().toISOString() };
    const same = record.status.state === next.state && record.status.reason === next.reason && JSON.stringify(record.status.tools) === JSON.stringify(next.tools);
    record.status = next;
    record.weightTokens = estimateWeightTokens(tools);
    if (same) {
      // Só a hora do teste mudou: avisa a tela, mas não precisa regravar o arquivo agora.
      this.deps.onChange({ kind: "upserted", record: structuredClone(record), notify: Object.keys(record.grants), dropped: [] });
      return structuredClone(record);
    }
    await this.commit(record, []);
    return structuredClone(record);
  }

  /** Ícone próprio (PNG/WebP, conferido pelos bytes). */
  async setIcon(id: string, mime: ConnectorIconMime, bytes: Buffer): Promise<StoredConnector> {
    const record = this.require(id);
    if (!imageMatches(mime, bytes)) throw new HttpError(400, "A imagem não é um PNG/WebP válido");
    const dir = this.deps.paths.dir(id);
    await mkdir(dir, { recursive: true });
    // Primeiro byte = tipo (0 PNG, 1 WebP); o resto é a imagem.
    await writeFile(this.deps.paths.iconFile(id), Buffer.concat([Buffer.from([mime === "image/png" ? 0 : 1]), bytes]));
    record.icon = { kind: "custom", version: record.icon.kind === "custom" ? record.icon.version + 1 : 1 };
    record.updatedAt = this.deps.now().toISOString();
    await this.commit(record, []);
    return structuredClone(record);
  }

  /** O ícone próprio guardado (ou undefined). */
  async readIcon(id: string): Promise<{ mime: ConnectorIconMime; bytes: Buffer } | undefined> {
    const record = this.require(id);
    if (record.icon.kind !== "custom") return undefined;
    try {
      const raw = await readFile(this.deps.paths.iconFile(id));
      if (raw.length < 2) return undefined;
      return { mime: raw[0] === 0 ? "image/png" : "image/webp", bytes: raw.subarray(1) };
    } catch {
      return undefined;
    }
  }

  /** Grava agora (testes e boot). */
  save(): Promise<void> {
    const snapshot = toConnectorsFile(structuredClone(this.records));
    const file = this.deps.paths.file;
    return this.deps.queue.enqueue(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeJsonAtomic(file, snapshot, 0o600);
    });
  }

  // ---------- Infra ----------

  private require(id: string): StoredConnector {
    const record = this.records.find((candidate) => candidate.id === id);
    if (!record) throw new HttpError(404, `Conector "${id}" não encontrado`);
    return record;
  }

  /** Valida (workspace e agentes existem) e monta o mapa; `grantedAt` de quem já tinha é mantido. */
  private buildGrants(current: LibraryGrants, input: LibraryGrantsInput): LibraryGrants {
    const now = this.deps.now().toISOString();
    const out: LibraryGrants = {};
    for (const [workspaceId, grant] of Object.entries(input)) {
      if (!this.deps.workspaceExists(workspaceId)) throw new HttpError(404, `Workspace "${workspaceId}" não encontrado`);
      const agentIds = [...new Set(grant.agentIds ?? [])];
      for (const agentId of agentIds) if (!this.deps.agentExists(workspaceId, agentId)) throw new HttpError(404, `Agente "${agentId}" não encontrado no workspace "${workspaceId}"`);
      out[workspaceId] = { agentIds, grantedAt: current[workspaceId]?.grantedAt ?? now };
    }
    return out;
  }

  private async removeIconFile(id: string): Promise<void> {
    await rm(this.deps.paths.iconFile(id), { force: true }).catch(() => undefined);
  }

  private async commit(record: StoredConnector, dropped: string[]): Promise<void> {
    const saved = this.save();
    this.deps.onChange({ kind: "upserted", record: structuredClone(record), notify: Object.keys(record.grants), dropped });
    await saved;
  }
}
