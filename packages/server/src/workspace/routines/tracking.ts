import {
  changedOnDay,
  daysToExpire,
  expiresAtFor,
  findStatus,
  initialStatus,
  isItemDue,
  isItemExpired,
  itemLabel,
  summarizeItems,
  TRACKED_HISTORY_KEPT,
  validateValues,
  type Routine,
  type RoutineRunChange,
  type ServerEvent,
  type TrackedItem,
  type TrackedItemHistory,
  type TrackingSpec,
  type TrackingSummary,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { shorten } from "../../util/text";
import { nextItemId, type RoutineItemsStore } from "./routine-items";
import { RoutineToolError } from "./routine-service";

export type RoutineTrackingDeps = {
  routines: { find(id: string): Routine | undefined; list(): Routine[] };
  store: Pick<RoutineItemsStore, "save">;
  /** Itens já lidos do disco no boot, por rotina (rotina sem arquivo = sem itens). */
  initial?: ReadonlyMap<string, TrackedItem[]>;
  /** Rotinas cujo arquivo de itens não pôde ser lido: nada é lido nem gravado para elas (o arquivo não é sobrescrito). */
  unavailable?: ReadonlySet<string>;
  publish: (event: ServerEvent) => void;
  log: Pick<FastifyBaseLogger, "error" | "info">;
  now: () => Date;
};

export type ItemFilter = { state?: "ativo" | "encerrado" | "parado"; status?: string; dueOnly?: boolean; expiringWithinDays?: number; limit?: number; offset?: number };

export const ITEM_SOURCE_KEY_MAX = 300;
export const ITEM_NOTE_MAX = 500;
/** Quantos itens o briefing de uma execução mostra (o resto fica a uma chamada de `routine_items_list`). */
export const BRIEFING_ITEMS = 20;

const END_STATE_LABEL: Record<string, string> = { parado: "stopped", encerrado: "ended", ativo: "active" };

/**
 * Itens acompanhados das rotinas de acompanhamento. Ficam em memória (carregados no boot) e cada
 * mudança é gravada pela fila (routines/<id>/items.json); como tudo é síncrono, duas ferramentas
 * chamadas ao mesmo tempo nunca se atropelam. A vida do item (expiração, encerramento da rotina) e o
 * resumo das mudanças de uma execução são contas do servidor: nenhum token.
 */
export class RoutineTracking {
  private readonly byRoutine = new Map<string, TrackedItem[]>();

  constructor(private readonly deps: RoutineTrackingDeps) {
    for (const [id, items] of deps.initial ?? []) this.byRoutine.set(id, items);
  }

  /** A rotina foi apagada: esquece os itens (o arquivo é apagado pelo chamador). */
  forget(routineId: string): void {
    this.byRoutine.delete(routineId);
  }

  // ---------- Leitura ----------

  private itemsOf(routineId: string): TrackedItem[] {
    if (this.deps.unavailable?.has(routineId)) throw new RoutineToolError(`The items of ${routineId} could not be read from disk; fix the file first.`);
    let items = this.byRoutine.get(routineId);
    if (!items) this.byRoutine.set(routineId, (items = []));
    return items;
  }

  /** O esquema da rotina de acompanhamento, ou erro claro. */
  specOf(routineId: string): { routine: Routine; spec: TrackingSpec } {
    const routine = this.deps.routines.find(routineId);
    if (!routine) throw new RoutineToolError(`Routine ${routineId} does not exist.`);
    if (routine.type !== "acompanhamento" || !routine.tracking) throw new RoutineToolError(`Routine ${routineId} is not a tracking routine (it has no items).`);
    return { routine, spec: routine.tracking };
  }

  list(routineId: string, filter: ItemFilter = {}): { items: TrackedItem[]; total: number } {
    const { spec } = this.specOf(routineId);
    const now = this.deps.now();
    const status = filter.status ? findStatus(spec, filter.status)?.name : undefined;
    if (filter.status && !status) throw new RoutineToolError(`Unknown status "${filter.status}". Valid: ${spec.statuses.map((candidate) => candidate.name).join(", ")}.`);
    const matched = this.itemsOf(routineId).filter((item) => {
      if (filter.state && item.state !== filter.state) return false;
      if (status && item.status !== status) return false;
      if (filter.dueOnly && !isItemDue(item, spec, now)) return false;
      if (filter.expiringWithinDays !== undefined) {
        const days = daysToExpire(item, now);
        if (item.state !== "ativo" || days === undefined || days > filter.expiringWithinDays) return false;
      }
      return true;
    });
    const offset = filter.offset ?? 0;
    return { items: structuredClone(matched.slice(offset, offset + (filter.limit ?? matched.length))), total: matched.length };
  }

  get(routineId: string, itemId: string): TrackedItem | undefined {
    const item = this.itemsOf(routineId).find((candidate) => candidate.id === itemId);
    return item ? structuredClone(item) : undefined;
  }

  /** Itens ativos que já passaram da hora de conferir (o que decide se um horário "itens_vencidos" roda). */
  dueItems(routine: Routine): TrackedItem[] {
    if (routine.type !== "acompanhamento" || !routine.tracking) return [];
    const now = this.deps.now();
    const spec = routine.tracking;
    return structuredClone(this.itemsOf(routine.id).filter((item) => isItemDue(item, spec, now)));
  }

  summary(routine: Routine): TrackingSummary | undefined {
    if (routine.type !== "acompanhamento" || !routine.tracking) return undefined;
    return summarizeItems(this.itemsOf(routine.id), routine.tracking, this.deps.now());
  }

  /** Mudanças recentes (criado, status, encerrado), das mais novas para as mais antigas. */
  recent(routineId: string, sinceMs: number): { at: string; itemId: string; label: string; by: TrackedItemHistory["by"]; text: string; from?: string; to?: string; alert?: boolean }[] {
    const { spec } = this.specOf(routineId);
    const out: { at: string; itemId: string; label: string; by: TrackedItemHistory["by"]; text: string; from?: string; to?: string; alert?: boolean }[] = [];
    for (const item of this.itemsOf(routineId)) {
      const label = itemLabel(spec, item);
      for (const entry of item.history) {
        if (Date.parse(entry.at) < sinceMs || !["criado", "status", "estado"].includes(entry.field ?? "")) continue;
        out.push({ at: entry.at, itemId: item.id, label, by: entry.by, text: describeEntry(label, entry), ...(entry.from ? { from: entry.from } : {}), ...(entry.to ? { to: entry.to } : {}), ...(entry.field === "status" && entry.to && findStatus(spec, entry.to)?.alert ? { alert: true } : {}) });
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  // ---------- Escrita do agente ----------

  /** Cria o item. Mesmo `source_key` (de qualquer estado) devolve o item que já existe, sem duplicar. */
  add(routineId: string, input: { values: Record<string, unknown>; sourceKey?: string; status?: string; note?: string; taskId?: string }): { item: TrackedItem; created: boolean } {
    const { spec } = this.specOf(routineId);
    const items = this.itemsOf(routineId);
    const sourceKey = input.sourceKey?.trim().slice(0, ITEM_SOURCE_KEY_MAX) || undefined;
    if (sourceKey) {
      const existing = items.find((item) => item.sourceKey === sourceKey);
      if (existing) return { item: structuredClone(existing), created: false };
    }
    const { values, errors } = validateValues(spec, input.values, { full: true });
    if (errors.length > 0) throw new RoutineToolError(errors.join(" "));
    const statusName = input.status ? findStatus(spec, input.status)?.name : initialStatus(spec).name;
    if (!statusName) throw new RoutineToolError(`Unknown status "${input.status}". Valid: ${spec.statuses.map((candidate) => candidate.name).join(", ")}.`);
    const now = this.deps.now();
    const at = now.toISOString();
    const expiresAt = expiresAtFor(spec, now);
    const item: TrackedItem = {
      id: nextItemId(items),
      routineId,
      values,
      ...(sourceKey ? { sourceKey } : {}),
      status: statusName,
      state: "ativo",
      createdAt: at,
      ...(expiresAt ? { expiresAt } : {}),
      history: [{ at, by: "agente", ...(input.taskId ? { taskId: input.taskId } : {}), field: "criado", to: statusName, ...(input.note ? { note: shorten(input.note, ITEM_NOTE_MAX) } : {}) }],
    };
    items.push(item);
    // Já nasce com status final (ex.: "Recusado"): encerra na hora.
    if (findStatus(spec, statusName)?.terminal) this.end(item, "terminal", at);
    this.changed(routineId);
    return { item: structuredClone(item), created: true };
  }

  /** Muda campos e/ou status de um item ativo; grava o histórico (data, de → para, nota, tarefa). */
  update(routineId: string, itemId: string, input: { status?: string; values?: Record<string, unknown>; note?: string; checked?: boolean; taskId?: string }): { item: TrackedItem; changes: string[] } {
    const { spec } = this.specOf(routineId);
    const item = this.itemsOf(routineId).find((candidate) => candidate.id === itemId);
    if (!item) throw new RoutineToolError(`Item ${itemId} does not exist in ${routineId} (see routine_items_list).`);
    if (item.state !== "ativo") throw new RoutineToolError(`Item ${itemId} is ${END_STATE_LABEL[item.state]} (${item.endReason ?? "no reason"}); only the user can reopen it. Do not update it.`);
    const now = this.deps.now();
    const at = now.toISOString();
    const note = input.note ? shorten(input.note, ITEM_NOTE_MAX) : undefined;
    const base = { at, by: "agente" as const, ...(input.taskId ? { taskId: input.taskId } : {}) };

    let patch: Record<string, string | number> = {};
    if (input.values && Object.keys(input.values).length > 0) {
      const checked = validateValues(spec, input.values, { full: false });
      if (checked.errors.length > 0) throw new RoutineToolError(checked.errors.join(" "));
      patch = checked.values;
    }
    let statusName: string | undefined;
    if (input.status !== undefined) {
      statusName = findStatus(spec, input.status)?.name;
      if (!statusName) throw new RoutineToolError(`Unknown status "${input.status}". Valid: ${spec.statuses.map((candidate) => candidate.name).join(", ")}.`);
    }

    const lines: string[] = [];
    let noteUsed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (item.values[key] === value) continue;
      item.history.push({ ...base, field: key, ...(item.values[key] !== undefined ? { from: String(item.values[key]) } : {}), to: String(value) });
      item.values[key] = value;
      lines.push(`${key} updated`);
    }
    if (statusName !== undefined && statusName !== item.status) {
      item.history.push({ ...base, field: "status", from: item.status, to: statusName, ...(note ? { note } : {}) });
      noteUsed = true;
      lines.push(`status ${item.status} -> ${statusName}`);
      item.status = statusName;
      if (findStatus(spec, statusName)?.terminal) this.end(item, "terminal", at);
    }
    if (note && !noteUsed) item.history.push({ ...base, field: "nota", note });
    if (input.checked !== false) item.lastCheckedAt = at;
    this.trim(item);
    this.changed(routineId);
    return { item: structuredClone(item), changes: lines };
  }

  /** O agente (ou o usuário) para um item. Quem retoma só é o usuário. */
  stop(routineId: string, itemId: string, input: { by: "agente" | "usuario"; reason?: string; taskId?: string }): TrackedItem {
    this.specOf(routineId);
    const item = this.itemsOf(routineId).find((candidate) => candidate.id === itemId);
    if (!item) throw new RoutineToolError(`Item ${itemId} does not exist in ${routineId} (see routine_items_list).`);
    if (item.state !== "ativo") throw new RoutineToolError(`Item ${itemId} is already ${END_STATE_LABEL[item.state]}.`);
    const at = this.deps.now().toISOString();
    item.state = "parado";
    item.endedAt = at;
    item.endReason = "usuario";
    item.history.push({ at, by: input.by, ...(input.taskId ? { taskId: input.taskId } : {}), field: "estado", from: "ativo", to: "parado", ...(input.reason ? { note: shorten(input.reason, ITEM_NOTE_MAX) } : {}) });
    this.trim(item);
    this.changed(routineId);
    return structuredClone(item);
  }

  // ---------- Escrita do usuário (rotas) ----------

  /** Reabre um item parado ou encerrado: volta a valer, com a vida contada de agora. */
  reopen(routineId: string, itemId: string): TrackedItem {
    const { spec } = this.specOf(routineId);
    const item = this.itemsOf(routineId).find((candidate) => candidate.id === itemId);
    if (!item) throw new RoutineToolError(`Item ${itemId} does not exist in ${routineId}.`);
    if (item.state === "ativo") return structuredClone(item);
    const now = this.deps.now();
    const at = now.toISOString();
    const from = item.state;
    // Encerrado (status final ou fim da vida) volta ao último status NÃO final que o item teve (o de antes do fim);
    // sem histórico para isso, ao status inicial. Parado mantém o que tinha.
    if (item.state === "encerrado") {
      const back = this.previousOpenStatus(spec, item);
      if (back !== item.status) {
        item.history.push({ at, by: "usuario", field: "status", from: item.status, to: back });
        item.status = back;
      }
    }
    item.state = "ativo";
    delete item.endedAt;
    delete item.endReason;
    const expiresAt = expiresAtFor(spec, now);
    if (expiresAt) item.expiresAt = expiresAt;
    item.history.push({ at, by: "usuario", field: "estado", from, to: "ativo" });
    this.trim(item);
    this.changed(routineId);
    return structuredClone(item);
  }

  /** O último status não final do item antes do atual (do histórico, do mais novo para o mais antigo); sem ele, o inicial. */
  private previousOpenStatus(spec: TrackingSpec, item: TrackedItem): string {
    const open = (name: string | undefined) => name !== undefined && findStatus(spec, name) !== undefined && findStatus(spec, name)?.terminal !== true;
    if (item.endReason !== "expirou" && open(item.status)) return item.status;
    for (let i = item.history.length - 1; i >= 0; i -= 1) {
      const entry = item.history[i]!;
      if (entry.field !== "status") continue;
      if (open(entry.from)) return findStatus(spec, entry.from!)!.name;
    }
    return initialStatus(spec).name;
  }

  /** O usuário corrige campos (e, se quiser, o status) de um item, em qualquer estado. */
  edit(routineId: string, itemId: string, input: { values?: Record<string, unknown>; status?: string }): TrackedItem {
    const { spec } = this.specOf(routineId);
    const item = this.itemsOf(routineId).find((candidate) => candidate.id === itemId);
    if (!item) throw new RoutineToolError(`Item ${itemId} does not exist in ${routineId}.`);
    const at = this.deps.now().toISOString();
    if (input.values) {
      const checked = validateValues(spec, input.values, { full: false });
      if (checked.errors.length > 0) throw new RoutineToolError(checked.errors.join(" "));
      for (const [key, value] of Object.entries(checked.values)) {
        if (item.values[key] === value) continue;
        item.history.push({ at, by: "usuario", field: key, ...(item.values[key] !== undefined ? { from: String(item.values[key]) } : {}), to: String(value) });
        item.values[key] = value;
      }
    }
    if (input.status !== undefined) {
      const status = findStatus(spec, input.status);
      if (!status) throw new RoutineToolError(`Unknown status "${input.status}". Valid: ${spec.statuses.map((candidate) => candidate.name).join(", ")}.`);
      if (status.name !== item.status) {
        item.history.push({ at, by: "usuario", field: "status", from: item.status, to: status.name });
        item.status = status.name;
        if (status.terminal && item.state === "ativo") this.end(item, "terminal", at);
      }
    }
    this.trim(item);
    this.changed(routineId);
    return structuredClone(item);
  }

  // ---------- Vida do item (o tick, sem token) ----------

  /** Encerra os itens vencidos da rotina como "Sem resposta" (ou o `expireStatus`). Devolve o que encerrou. */
  expire(routine: Routine): RoutineRunChange[] {
    if (routine.type !== "acompanhamento" || !routine.tracking) return [];
    const spec = routine.tracking;
    const now = this.deps.now();
    const at = now.toISOString();
    const changes: RoutineRunChange[] = [];
    for (const item of this.itemsOf(routine.id)) {
      if (!isItemExpired(item, now)) continue;
      const to = spec.expireStatus ?? "Sem resposta";
      const label = itemLabel(spec, item);
      if (item.status !== to) item.history.push({ at, by: "servidor", field: "status", from: item.status, to, note: "fim da vida do item" });
      item.status = to;
      this.end(item, "expirou", at);
      this.trim(item);
      changes.push({ itemId: item.id, text: `${label} → ${to} (fim da vida)`, kind: "encerrado", ...(findStatus(spec, to)?.alert ? { alert: true } : {}) });
    }
    if (changes.length > 0) this.changed(routine.id, changes);
    return changes;
  }

  /** Rotina encerrada: os itens ativos viram "encerrado" (rotina_encerrada). */
  closeAll(routine: Routine): number {
    const at = this.deps.now().toISOString();
    let count = 0;
    for (const item of this.itemsOf(routine.id)) {
      if (item.state !== "ativo") continue;
      this.end(item, "rotina_encerrada", at);
      item.history.push({ at, by: "servidor", field: "estado", from: "ativo", to: "encerrado", note: "rotina encerrada" });
      count += 1;
    }
    if (count > 0) this.changed(routine.id);
    return count;
  }

  /** Uma passada do relógio: expira e encerra o que for preciso, em todas as rotinas de acompanhamento. */
  sweep(): void {
    for (const routine of this.deps.routines.list()) {
      if (routine.type !== "acompanhamento" || !routine.tracking || this.deps.unavailable?.has(routine.id)) continue;
      if (routine.status === "encerrada") this.closeAll(routine);
      else if (routine.status === "ativa") this.expire(routine);
    }
  }

  // ---------- Mudanças de uma execução (montadas só do histórico) ----------

  /** O que os itens registraram com `taskId` (a tarefa desta execução): novos, status que mudaram, encerrados. */
  changesOf(routineId: string, taskId: string): RoutineRunChange[] {
    const routine = this.deps.routines.find(routineId);
    const spec = routine?.tracking;
    if (!routine || !spec) return [];
    const changes: RoutineRunChange[] = [];
    for (const item of this.itemsOf(routineId)) {
      const label = itemLabel(spec, item);
      const mine = item.history.filter((entry) => entry.taskId === taskId);
      const created = mine.find((entry) => entry.field === "criado");
      if (created) changes.push({ itemId: item.id, text: describeEntry(label, created), kind: "novo", ...(created.to && findStatus(spec, created.to)?.alert ? { alert: true } : {}) });
      for (const entry of mine) {
        if (entry.field === "status") changes.push({ itemId: item.id, text: describeEntry(label, entry), kind: findStatus(spec, entry.to ?? "")?.terminal ? "encerrado" : "status", ...(entry.to && findStatus(spec, entry.to)?.alert ? { alert: true } : {}) });
        else if (entry.field === "estado") changes.push({ itemId: item.id, text: describeEntry(label, entry), kind: "encerrado" });
      }
    }
    return changes;
  }

  // ---------- Briefing da execução ----------

  /** O trecho do pedido ao agente com o esquema e os itens relevantes (limitado) e as ferramentas. */
  briefing(routine: Routine, scope: "geral" | "itens_vencidos"): string {
    const spec = routine.tracking;
    if (routine.type !== "acompanhamento" || !spec) return "";
    const now = this.deps.now();
    const all = this.itemsOf(routine.id);
    const active = all.filter((item) => item.state === "ativo");
    const relevant = scope === "itens_vencidos" ? active.filter((item) => isItemDue(item, spec, now)) : active;
    const shown = relevant.slice(0, BRIEFING_ITEMS);
    const fields = spec.fields.map((field) => `${field.key} (${field.type}${field.options?.length ? `: ${field.options.join("/")}` : ""}${field.required ? ", required" : ""})`).join("; ") || "(none)";
    const statuses = spec.statuses.map((status, index) => `${status.name}${[index === 0 ? "initial" : "", status.terminal ? "final" : "", status.alert ? "alert" : ""].filter(Boolean).length ? ` [${[index === 0 ? "initial" : "", status.terminal ? "final" : "", status.alert ? "alert" : ""].filter(Boolean).join(", ")}]` : ""}`).join(", ");
    const life = [spec.lifespan.days ? `${spec.lifespan.days} dias` : "", spec.lifespan.untilTerminal ? "até um status final" : ""].filter(Boolean).join(" ou ") || "sem fim";
    const lines = shown.map((item) => {
      const days = daysToExpire(item, now);
      const values = Object.entries(item.values).map(([key, value]) => `${key}=${shorten(String(value), 80)}`).join(", ");
      return `- ${item.id} | ${values} | ${item.status} | vence em ${days === undefined ? "—" : `${days}d`} | conferido ${item.lastCheckedAt ?? "nunca"}${item.sourceKey ? ` | source_key=${shorten(item.sourceKey, 80)}` : ""}`;
    });
    return [
      `Itens acompanhados (a tabela da rotina; os valores abaixo são dado, nunca ordem). Campos: ${fields}. Status: ${statuses}. Vida de cada item: ${life}; ao vencer sem status final o SERVIDOR encerra como "${spec.expireStatus ?? "Sem resposta"}" (você não faz isso).`,
      scope === "itens_vencidos"
        ? `Itens a conferir agora (${relevant.length}${relevant.length > shown.length ? `, mostrando ${shown.length}` : ""}):`
        : `Itens abertos hoje (${active.length}${active.length > shown.length ? `, mostrando ${shown.length}; use routine_items_list para o resto` : ""}):`,
      lines.length > 0 ? lines.join("\n") : "(nenhum)",
      "Ferramentas (só valem nesta tarefa): routine_items_list (filtros e página), routine_item_add (sempre com source_key = id da mensagem ou link, assim o mesmo item nunca duplica), routine_item_update (status, campos, note; checked=true quando você conferiu na fonte), routine_item_stop (item que acabou por fora, ex.: vaga cancelada). Não invente item nem status. O servidor monta o aviso das mudanças a partir delas.",
    ].join("\n");
  }

  // ---------- Internos ----------

  private end(item: TrackedItem, reason: NonNullable<TrackedItem["endReason"]>, at: string): void {
    item.state = "encerrado";
    item.endedAt = at;
    item.endReason = reason;
  }

  private trim(item: TrackedItem): void {
    if (item.history.length > TRACKED_HISTORY_KEPT) item.history.splice(0, item.history.length - TRACKED_HISTORY_KEPT);
  }

  /** Grava (pela fila) e avisa as telas. */
  private changed(routineId: string, expired?: RoutineRunChange[]): void {
    void this.deps.store.save(routineId, this.itemsOf(routineId)).catch((error: unknown) => this.deps.log.error({ err: error, routineId }, "itens da rotina não foram gravados"));
    this.deps.publish({ type: "routine:items", routineId, ...(expired?.length ? { expired } : {}) });
  }

  /** Itens que já tinham mudado hoje (usado só pelos testes e pela tela). */
  changedToday(routine: Routine): number {
    return this.itemsOf(routine.id).filter((item) => changedOnDay(item, this.deps.now())).length;
  }
}

/** Uma linha do histórico em texto curto: "Empresa X → Entrevista", "Novo: Empresa X (Inscrito)". */
function describeEntry(label: string, entry: TrackedItemHistory): string {
  if (entry.field === "criado") return `Novo: ${label}${entry.to ? ` (${entry.to})` : ""}`;
  if (entry.field === "status") return `${label} → ${entry.to ?? "?"}`;
  if (entry.field === "estado") return `${label}: ${entry.to === "parado" ? "parado" : entry.to === "encerrado" ? "encerrado" : "reaberto"}${entry.note ? ` (${shorten(entry.note, 80)})` : ""}`;
  return `${label}: ${entry.field ?? "mudou"}`;
}
