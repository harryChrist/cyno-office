import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  ACTIVITY_SYSTEM,
  ACTIVITY_USER,
  estimateTokens,
  SKILL_LIMITS,
  uniqueSlug,
  type CreateLibrarySkillBody,
  type LibraryGrants,
  type LibraryGrantsInput,
  type SkillCeiling,
  type SkillImportCandidate,
  type UpdateLibrarySkillBody,
  type UploadLibrarySkillBody,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { HttpError } from "../../platform/http/errors";
import { writeJsonAtomic } from "../../store/atomic-write";
import type { WriteQueue } from "../../store/write-queue";
import { activity } from "../../workspace/activity/log";
import { skillIndexTokens, type AgentSkill } from "./agent-skills";
import { copyLocalSkill, localSkillCandidates, type LocalSkillSource } from "./import-local";
import { readSkillFiles, readSkillsFile, swapSkillDir, toSkillsFile, type SkillPaths, type StoredSkill } from "./store";
import { validateSkillFiles, type SkillFile, type ValidatedSkill } from "./validate";
import { readZip } from "./zip";

/** O que mudou no cadastro (a Biblioteca avisa a todos e os workspaces afetados). */
export type SkillChange = { kind: "upserted"; record: StoredSkill; notify: string[]; dropped: string[] } | { kind: "deleted"; id: string; name: string; notify: string[] };

export type SkillLibraryDeps = {
  paths: SkillPaths;
  queue: WriteQueue;
  workspaceExists: (workspaceId: string) => boolean;
  agentExists: (workspaceId: string, agentId: string) => boolean;
  /** Nomes para a Atividade (o workspace e o agente). */
  workspaceName: (workspaceId: string) => string;
  agentName: (workspaceId: string, agentId: string) => string;
  onChange: (change: SkillChange) => void;
  /** Onde procurar `~/.claude` para importar (padrão: o home do usuário do servidor; os testes passam uma pasta falsa). */
  local?: LocalSkillSource;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
  now: () => Date;
};

type Origin = StoredSkill["origin"];
type AddOptions = { id?: string; origin: Origin; readonly?: boolean; requires?: string[]; actor?: string; action?: string };

/**
 * As skills da plataforma: cada uma é uma pasta em `data/platform/library/skills/<id>/` (o `SKILL.md`
 * e arquivos de apoio), com o registro em `skills.json`. Atualizar substitui e guarda a versão
 * anterior (uma só, em `skill-versions/<id>/`). Liberação igual à dos conectores: skill -> workspace
 * -> agente (`grants`). Nada aqui lê a configuração pessoal do dono, a não ser quando ele marca uma
 * candidata para COPIAR (import-local.ts).
 */
export class SkillLibrary {
  private constructor(
    private records: StoredSkill[],
    private readonly deps: SkillLibraryDeps,
  ) {}

  static async open(deps: SkillLibraryDeps): Promise<SkillLibrary> {
    return new SkillLibrary(await readSkillsFile(deps.paths.file), deps);
  }

  // ---------- Leitura ----------

  all(): StoredSkill[] {
    return this.records.map((record) => structuredClone(record));
  }

  get(id: string): StoredSkill {
    return structuredClone(this.require(id));
  }

  /** O que a tela do editor precisa: o SKILL.md e a lista de arquivos da skill. */
  async detail(id: string): Promise<{ record: StoredSkill; content: string; files: { path: string; bytes: number }[] }> {
    const record = this.require(id);
    const files = await readSkillFiles(this.deps.paths.dir(id));
    const skillMd = files.find((file) => file.path === "SKILL.md");
    return { record: structuredClone(record), content: skillMd?.data.toString("utf8") ?? "", files: files.map((file) => ({ path: file.path, bytes: file.data.length })) };
  }

  /** As skills liberadas a um workspace. */
  grantedTo(workspaceId: string): StoredSkill[] {
    return this.records.filter((record) => workspaceId in record.grants).map((record) => structuredClone(record));
  }

  /** As skills que um agente recebe (liberadas ao workspace dele E entregues a ele), ordenadas por id. */
  attachedTo(workspaceId: string, agentId: string): StoredSkill[] {
    return this.records
      .filter((record) => record.grants[workspaceId]?.agentIds.includes(agentId))
      .map((record) => structuredClone(record))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** A entrega de um agente na forma que o terminal usa (pasta de origem, revisão, linha do índice). */
  agentSkills(workspaceId: string, agentId: string): AgentSkill[] {
    return this.attachedTo(workspaceId, agentId).map((record) => ({ id: record.id, name: record.name, description: record.description, sourceDir: this.deps.paths.dir(record.id), revision: `${record.id}@${record.version}` }));
  }

  /** O teto técnico das skills (o padrão de `SKILL_LIMITS`; os testes injetam um menor). */
  private get ceiling(): SkillCeiling {
    return this.deps.local?.ceiling ?? SKILL_LIMITS;
  }

  indexTokensOf(record: Pick<StoredSkill, "id" | "name" | "description">): number {
    return skillIndexTokens(record);
  }

  // ---------- Criar ----------

  /** Cria a partir do texto escrito na tela (o SKILL.md inteiro). */
  async create(body: CreateLibrarySkillBody, actor: string = ACTIVITY_USER): Promise<StoredSkill> {
    const validated = validateSkillFiles([{ path: "SKILL.md", data: Buffer.from(body.content, "utf8") }], this.ceiling);
    return this.add(validated, { ...(body.id ? { id: body.id } : {}), origin: { kind: "manual" }, ...(body.requires ? { requires: body.requires } : {}), actor });
  }

  /** Cria (ou, com `id` de uma skill existente, substitui) a partir de uma pasta ou de um .zip. */
  async upload(body: UploadLibrarySkillBody, actor: string = ACTIVITY_USER): Promise<StoredSkill> {
    const files: SkillFile[] = body.zipBase64 ? readZip(Buffer.from(body.zipBase64, "base64"), this.ceiling) : (body.files ?? []).map((file) => ({ path: file.path, data: Buffer.from(file.dataBase64, "base64") }));
    const validated = validateSkillFiles(files, this.ceiling);
    if (body.id && this.records.some((record) => record.id === body.id)) return this.replaceFiles(body.id, validated, actor);
    return this.add(validated, { ...(body.id ? { id: body.id } : {}), origin: { kind: "upload", at: this.deps.now().toISOString() }, actor });
  }

  /** Cria uma skill vinda de um app instalado (só leitura; some junto com o app). */
  addFromApp(files: SkillFile[], appId: string, appPath: string, options: { id?: string; requires?: string[] } = {}): Promise<StoredSkill> {
    return this.add(validateSkillFiles(files, this.ceiling), { ...options, origin: { kind: "app", appId, path: appPath }, readonly: true, actor: ACTIVITY_SYSTEM });
  }

  /**
   * O instalador de apps registra uma skill que o app entrega: lê a pasta (dentro de data/platform/apps/<id>/),
   * guarda uma CÓPIA na Biblioteca (só leitura, `origin: app`) e, se este app já tinha uma skill do mesmo caminho,
   * substitui mantendo as liberações. Nada é liberado a ninguém.
   */
  async registerAppSkill(appId: string, appPath: string, dir: string, options: { requires?: string[] } = {}): Promise<StoredSkill> {
    const files = await readSkillFiles(dir);
    const validated = validateSkillFiles(files, this.ceiling);
    const existing = this.records.find((record) => record.origin.kind === "app" && record.origin.appId === appId && record.origin.path === appPath);
    if (!existing) return this.addFromApp(files, appId, appPath, options);
    const grants = existing.grants;
    await this.remove(existing.id, ACTIVITY_SYSTEM);
    const created = await this.add(validated, { id: existing.id, origin: { kind: "app", appId, path: appPath }, readonly: true, ...(options.requires ? { requires: options.requires } : {}), actor: ACTIVITY_SYSTEM });
    if (Object.keys(grants).length === 0) return created;
    return this.setGrants(created.id, Object.fromEntries(Object.entries(grants).map(([ws, g]) => [ws, { agentIds: g.agentIds }])), ACTIVITY_SYSTEM);
  }

  /** Desinstalar o app: remove as skills dele (as liberações vão junto). Devolve os ids removidos. */
  async removeAppSkills(appId: string): Promise<string[]> {
    const ids = this.records.filter((record) => record.origin.kind === "app" && record.origin.appId === appId).map((record) => record.id);
    for (const id of ids) await this.remove(id, ACTIVITY_SYSTEM);
    return ids;
  }

  /** Copia uma skill existente para editar (a cópia é manual e editável). */
  async duplicate(id: string, actor: string = ACTIVITY_USER): Promise<StoredSkill> {
    const source = this.require(id);
    const files = await readSkillFiles(this.deps.paths.dir(id));
    const validated = validateSkillFiles(files, this.ceiling);
    const skillMd = validated.skillMd.replace(/^(---[ \t]*\n[\s\S]*?\bname:[ \t]*)(["']?)(.*?)\2([ \t]*\n)/, (_all, head: string, _q: string, value: string, tail: string) => `${head}${JSON.stringify(`${value} (cópia)`)}${tail}`);
    const copy = validateSkillFiles(validated.files.map((file) => (file.path === "SKILL.md" ? { path: file.path, data: Buffer.from(skillMd, "utf8") } : file)), this.ceiling);
    return this.add(copy, { origin: { kind: "manual" }, requires: source.requires, actor });
  }

  /** Candidatas em `~/.claude/skills` e nos plugins do dono (só nomes e descrições). */
  async importCandidates(): Promise<{ available: boolean; reason?: string; candidates: SkillImportCandidate[] }> {
    try {
      const candidates = await localSkillCandidates(this.deps.local ?? {}, new Set(this.records.map((record) => record.name.toLowerCase())));
      if (candidates.length === 0) return { available: true, reason: "Não achei skills em ~/.claude/skills nem nos plugins instalados.", candidates };
      return { available: true, candidates };
    } catch (error) {
      return { available: false, reason: `Não consegui ler as skills do computador: ${error instanceof Error ? error.message : String(error)}`, candidates: [] };
    }
  }

  /** Copia as candidatas marcadas para a Biblioteca (cada uma vira uma skill própria; o original não é tocado). */
  async importLocal(keys: readonly string[], actor: string = ACTIVITY_USER): Promise<{ imported: StoredSkill[]; failed: { key: string; reason: string }[] }> {
    const imported: StoredSkill[] = [];
    const failed: { key: string; reason: string }[] = [];
    for (const key of [...new Set(keys)]) {
      try {
        const { files, from } = await copyLocalSkill(this.deps.local ?? {}, key);
        const validated = validateSkillFiles(files, this.ceiling);
        imported.push(await this.add(validated, { origin: { kind: "folder", from, copiedAt: this.deps.now().toISOString() }, actor, action: "skill-importada" }));
      } catch (error) {
        failed.push({ key, reason: error instanceof HttpError || error instanceof Error ? error.message : String(error) });
      }
    }
    return { imported, failed };
  }

  // ---------- Atualizar e remover ----------

  /** Troca o SKILL.md (e/ou os requisitos); a versão atual vira a anterior. Os arquivos de apoio ficam. */
  async update(id: string, body: UpdateLibrarySkillBody, actor: string = ACTIVITY_USER): Promise<StoredSkill> {
    const record = this.require(id);
    if (record.readonly) throw new HttpError(409, `A skill "${record.name}" vem de um app e é só leitura. Duplique para editar.`);
    if (body.content === undefined) {
      if (body.requires === undefined) return structuredClone(record);
      record.requires = [...body.requires];
      record.updatedAt = this.deps.now().toISOString();
      await this.commit(record, []);
      return structuredClone(record);
    }
    const files = await readSkillFiles(this.deps.paths.dir(id));
    const next = files.filter((file) => file.path !== "SKILL.md");
    next.push({ path: "SKILL.md", data: Buffer.from(body.content, "utf8") });
    return this.replaceFiles(id, validateSkillFiles(next, this.ceiling), actor, body.requires);
  }

  /** Volta para a versão anterior (a atual passa a ser a anterior: dá para desfazer de novo). */
  async restore(id: string, actor: string = ACTIVITY_USER): Promise<StoredSkill> {
    const record = this.require(id);
    if (record.previousVersion === undefined) throw new HttpError(409, "Esta skill não tem versão anterior guardada.");
    if (record.readonly) throw new HttpError(409, `A skill "${record.name}" vem de um app e é só leitura.`);
    const previous = await readSkillFiles(this.deps.paths.previousDir(id));
    if (previous.length === 0) throw new HttpError(409, "A versão anterior não está mais no disco.");
    const validated = validateSkillFiles(previous, this.ceiling);
    const restoredFrom = record.previousVersion;
    const saved = await this.replaceFiles(id, validated, actor, undefined, "skill-restaurada", `Skill ${record.name} voltou à versão ${restoredFrom}`);
    return saved;
  }

  async remove(id: string, actor: string = ACTIVITY_USER): Promise<StoredSkill> {
    const index = this.records.findIndex((record) => record.id === id);
    if (index === -1) throw new HttpError(404, `Skill "${id}" não encontrada`);
    const [removed] = this.records.splice(index, 1);
    const saved = this.save();
    this.deps.onChange({ kind: "deleted", id, name: removed!.name, notify: Object.keys(removed!.grants) });
    await saved;
    await rm(this.deps.paths.dir(id), { recursive: true, force: true }).catch((error: unknown) => this.deps.log.error({ err: error, skillId: id }, "não foi possível apagar a pasta da skill"));
    await rm(this.deps.paths.previousDir(id), { recursive: true, force: true }).catch(() => undefined);
    const workspaces = Object.keys(removed!.grants).length;
    this.record("skill-removida", actor, `Skill ${removed!.name} removida da Biblioteca (estava em ${workspaces} workspace${workspaces === 1 ? "" : "s"})`, removed!);
    return removed!;
  }

  // ---------- Liberações ----------

  /** As liberações da skill, o mapa inteiro: o que não está nele é retirado. */
  async setGrants(id: string, grants: LibraryGrantsInput, actor: string = ACTIVITY_USER): Promise<StoredSkill> {
    const record = this.require(id);
    const before = structuredClone(record.grants);
    record.grants = this.buildGrants(record.grants, grants);
    record.updatedAt = this.deps.now().toISOString();
    await this.commit(
      record,
      Object.keys(before).filter((ws) => !(ws in record.grants)),
    );
    this.noteGrants(record, before, actor);
    return structuredClone(record);
  }

  async grantWorkspace(id: string, workspaceId: string, agentIds?: readonly string[], actor: string = ACTIVITY_USER): Promise<StoredSkill> {
    const record = this.require(id);
    const next: LibraryGrantsInput = {};
    for (const [ws, grant] of Object.entries(record.grants)) next[ws] = { agentIds: grant.agentIds };
    next[workspaceId] = { agentIds: agentIds ? [...agentIds] : (record.grants[workspaceId]?.agentIds ?? []) };
    return this.setGrants(id, next, actor);
  }

  /**
   * As skills de um agente num workspace (lista inteira): entrega as da lista e retira as outras.
   * Só vale para o que foi liberado ao workspace (senão 404). Devolve as que ele tem agora.
   */
  async setAgentSkills(workspaceId: string, agentId: string, skillIds: readonly string[], actor: string = ACTIVITY_USER): Promise<StoredSkill[]> {
    if (!this.deps.agentExists(workspaceId, agentId)) throw new HttpError(404, `Agente "${agentId}" não encontrado`);
    const wanted = new Set(skillIds);
    for (const id of wanted) {
      const record = this.records.find((candidate) => candidate.id === id);
      if (!record || !(workspaceId in record.grants)) throw new HttpError(404, `Skill "${id}" não encontrada neste workspace`);
    }
    const changed: { record: StoredSkill; before: LibraryGrants }[] = [];
    for (const record of this.records) {
      const grant = record.grants[workspaceId];
      if (!grant) continue;
      const has = grant.agentIds.includes(agentId);
      if (has === wanted.has(record.id)) continue;
      const before = structuredClone(record.grants);
      grant.agentIds = has ? grant.agentIds.filter((other) => other !== agentId) : [...grant.agentIds, agentId];
      record.updatedAt = this.deps.now().toISOString();
      changed.push({ record, before });
    }
    if (changed.length > 0) {
      const saved = this.save();
      for (const { record } of changed) this.deps.onChange({ kind: "upserted", record: structuredClone(record), notify: Object.keys(record.grants), dropped: [] });
      await saved;
      for (const { record, before } of changed) this.noteGrants(record, before, actor);
    }
    return this.attachedTo(workspaceId, agentId);
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
    for (const record of changed) this.deps.onChange({ kind: "upserted", record: structuredClone(record), notify: Object.keys(record.grants), dropped: [] });
    await saved;
  }

  /** O agente leu o SKILL.md da skill: soma no uso (a tela mostra "usada N vezes"). */
  async recordRead(id: string, readerName: string, workspaceName: string): Promise<void> {
    const record = this.records.find((candidate) => candidate.id === id);
    if (!record) return;
    record.usage = { reads: record.usage.reads + 1, lastAt: this.deps.now().toISOString() };
    const saved = this.save();
    this.deps.onChange({ kind: "upserted", record: structuredClone(record), notify: [], dropped: [] });
    this.record("skill-usada", ACTIVITY_SYSTEM, `Skill ${record.name} lida por ${readerName} (workspace ${workspaceName})`, record, { agent: readerName });
    await saved;
  }

  /** Grava agora (testes e boot). */
  save(): Promise<void> {
    const snapshot = toSkillsFile(structuredClone(this.records));
    const file = this.deps.paths.file;
    return this.deps.queue.enqueue(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeJsonAtomic(file, snapshot);
    });
  }

  // ---------- Infra ----------

  private require(id: string): StoredSkill {
    const record = this.records.find((candidate) => candidate.id === id);
    if (!record) throw new HttpError(404, `Skill "${id}" não encontrada`);
    return record;
  }

  private async add(validated: ValidatedSkill, options: AddOptions): Promise<StoredSkill> {
    const taken = this.records.map((record) => record.id);
    if (options.id && taken.includes(options.id)) throw new HttpError(409, `Já existe uma skill com o id "${options.id}".`);
    const id = options.id ?? uniqueSlug(validated.frontmatter.name, taken);
    const now = this.deps.now().toISOString();
    await swapSkillDir(this.deps.paths, id, validated.files, false);
    const record: StoredSkill = {
      id,
      name: validated.frontmatter.name,
      description: validated.frontmatter.description,
      origin: options.origin,
      requires: options.requires ? [...options.requires] : [],
      files: validated.files.length,
      bytes: validated.bytes,
      weightTokens: estimateTokens(validated.skillMd),
      readonly: options.readonly ?? false,
      usage: { reads: 0 },
      grants: {},
      version: 1,
      createdAt: now,
      updatedAt: now,
      warnings: validated.warnings,
    };
    this.records.push(record);
    await this.commit(record, []);
    const action = options.action ?? "skill-criada";
    this.record(action, options.actor ?? ACTIVITY_USER, action === "skill-importada" ? `Skill ${record.name} importada para a Biblioteca (cópia)` : `Skill ${record.name} adicionada à Biblioteca`, record);
    return structuredClone(record);
  }

  /** Substitui os arquivos da skill por uma versão nova (a anterior é guardada). */
  private async replaceFiles(id: string, validated: ValidatedSkill, actor: string, requires?: string[], action = "skill-atualizada", summary?: string): Promise<StoredSkill> {
    const record = this.require(id);
    if (record.readonly) throw new HttpError(409, `A skill "${record.name}" vem de um app e é só leitura. Duplique para editar.`);
    await swapSkillDir(this.deps.paths, id, validated.files, true);
    record.previousVersion = record.version;
    record.version += 1;
    record.name = validated.frontmatter.name;
    record.description = validated.frontmatter.description;
    record.files = validated.files.length;
    record.bytes = validated.bytes;
    record.weightTokens = estimateTokens(validated.skillMd);
    record.warnings = validated.warnings;
    if (requires) record.requires = [...requires];
    record.updatedAt = this.deps.now().toISOString();
    await this.commit(record, []);
    this.record(action, actor, summary ?? `Skill ${record.name} atualizada (versão ${record.version}; a anterior ficou guardada)`, record, { version: record.version });
    return structuredClone(record);
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

  private async commit(record: StoredSkill, dropped: string[]): Promise<void> {
    const saved = this.save();
    this.deps.onChange({ kind: "upserted", record: structuredClone(record), notify: Object.keys(record.grants), dropped });
    await saved;
  }

  /** Atividade da plataforma: liberada, retirada e agentes que entraram ou saíram, por workspace. */
  private noteGrants(record: StoredSkill, before: LibraryGrants, actor: string): void {
    const after = record.grants;
    const names = (workspaceId: string, ids: string[]) => ids.map((id) => this.deps.agentName(workspaceId, id)).join(", ");
    for (const workspaceId of Object.keys(after)) {
      const was = before[workspaceId];
      const now = after[workspaceId]!;
      const ws = this.deps.workspaceName(workspaceId);
      if (!was) {
        this.record("skill-liberada", actor, `Skill ${record.name} liberada para o workspace ${ws}${now.agentIds.length > 0 ? ` (agentes: ${names(workspaceId, now.agentIds)})` : ""}`, record, { workspace: workspaceId, agentIds: now.agentIds });
        continue;
      }
      const added = now.agentIds.filter((id) => !was.agentIds.includes(id));
      const removed = was.agentIds.filter((id) => !now.agentIds.includes(id));
      if (added.length > 0) this.record("skill-entregue", actor, `Skill ${record.name} entregue a ${names(workspaceId, added)} (workspace ${ws})`, record, { workspace: workspaceId, agentIds: added });
      if (removed.length > 0) this.record("skill-tirada-do-agente", actor, `Skill ${record.name} tirada de ${names(workspaceId, removed)} (workspace ${ws})`, record, { workspace: workspaceId, agentIds: removed });
    }
    for (const workspaceId of Object.keys(before)) if (!(workspaceId in after)) this.record("skill-retirada", actor, `Skill ${record.name} retirada do workspace ${this.deps.workspaceName(workspaceId)}`, record, { workspace: workspaceId });
  }

  private record(action: string, actor: string, summary: string, record: Pick<StoredSkill, "id" | "name">, data: Record<string, unknown> = {}): void {
    activity({ category: "sistema", action, actor: actor || ACTIVITY_SYSTEM, summary, data: { skillId: record.id, ...data } });
  }
}

