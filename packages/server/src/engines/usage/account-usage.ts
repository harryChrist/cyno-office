import type { UsageWindow } from "@cyno/shared";

/**
 * Leitura da resposta de `GET https://api.anthropic.com/api/oauth/usage` — o uso da CONTA Claude
 * (o mesmo que o /usage do Claude Code mostra). O endpoint NÃO é documentado: o formato pode
 * mudar sem aviso, então tudo aqui é defensivo (formato desconhecido = ignorado, nunca lança).
 *
 * Dois formatos conhecidos (às vezes os dois na mesma resposta):
 * - `limits: [{ kind, percent, severity, resets_at, scope, ... }]` (o mais novo; preferido);
 * - chaves soltas `five_hour`, `seven_day`, `seven_day_opus`… com `{ utilization, resets_at }`.
 * Nos dois, o uso vem em PORCENTAGEM (0–100); aqui vira 0..1 como o resto do app.
 */

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

const WINDOW_ID = /^[a-z0-9_]{1,40}$/;
/** Chaves soltas aceitas como janela (as outras, inclusive codinomes internos, são ignoradas). */
const FLAT_WINDOW_KEY = /^(five_hour|seven_day)(_[a-z0-9]+)*$/;

/** Porcentagem 0–100 -> 0..1 (inválido = undefined). */
function fromPercent(value: unknown): number | undefined {
  const n = num(value);
  if (n === undefined || n < 0) return undefined;
  return Math.min(1, n / 100);
}

/** ISO aceito (ou epoch em segundos/ms); inválido = undefined. */
function isoTime(value: unknown): string | undefined {
  const n = num(value);
  const date = n !== undefined ? new Date(n < 1e12 ? n * 1000 : n) : typeof value === "string" ? new Date(value) : undefined;
  if (!date || Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

/** "Opus 4" -> "opus_4" (só [a-z0-9_]). */
function slug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
}

/**
 * Nome do escopo de um limite: string ("opus") ou objeto, inclusive aninhado
 * ({ model: "opus" }, { model: { id: null, display_name: "Fable" }, surface: null }…).
 */
function scopeName(scope: unknown, depth = 0): string | undefined {
  if (typeof scope === "string") return slug(scope) || undefined;
  if (!isObject(scope) || depth > 2) return undefined;
  for (const key of ["model", "model_family", "surface", "name", "label", "display_name", "id"]) {
    const value = scope[key];
    const name = typeof value === "string" ? str(value) && slug(value) : isObject(value) ? scopeName(value, depth + 1) : undefined;
    if (name) return name;
  }
  return undefined;
}

/** Id da janela de um item de `limits` (o mesmo id das chaves soltas e do rate_limit_event). */
function limitWindowId(kind: string, scope: string | undefined): string | undefined {
  const k = slug(kind);
  let id: string;
  if (k === "session" || k === "five_hour") id = scope ? `five_hour_${scope}` : "five_hour";
  else if (k === "weekly_all" || k === "weekly" || k === "seven_day") id = scope ? `seven_day_${scope}` : "seven_day";
  else if (k.startsWith("weekly")) id = scope ? `seven_day_${scope}` : `seven_day_${k.slice("weekly_".length) || "scoped"}`;
  else id = scope ? `${k}_${scope}` : k;
  return WINDOW_ID.test(id) ? id : undefined;
}

const severityOf = (value: unknown) => str(value)?.toLowerCase().slice(0, 40);

function fromLimits(limits: unknown[]): UsageWindow[] {
  const byId = new Map<string, UsageWindow>();
  for (const item of limits) {
    if (!isObject(item)) continue;
    const kind = str(item.kind) ?? str(item.group);
    const utilization = fromPercent(item.percent ?? item.utilization);
    if (!kind || utilization === undefined) continue;
    const id = limitWindowId(kind, scopeName(item.scope));
    if (!id) continue;
    const resetsAt = isoTime(item.resets_at ?? item.resetsAt);
    const severity = severityOf(item.severity);
    const window: UsageWindow = { id, utilization, ...(resetsAt ? { resetsAt } : {}), ...(severity ? { severity } : {}) };
    const existing = byId.get(id);
    if (!existing || existing.utilization < utilization) byId.set(id, window);
  }
  return [...byId.values()];
}

function fromFlatKeys(data: Json): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!FLAT_WINDOW_KEY.test(key) || key.length > 40 || !isObject(value)) continue;
    const utilization = fromPercent(value.utilization ?? value.percent);
    if (utilization === undefined) continue;
    const resetsAt = isoTime(value.resets_at ?? value.resetsAt);
    const severity = severityOf(value.severity);
    windows.push({ id: key, utilization, ...(resetsAt ? { resetsAt } : {}), ...(severity ? { severity } : {}) });
  }
  return windows;
}

/**
 * Janelas de uso da resposta do endpoint da conta. `limits` manda; as chaves soltas só completam
 * as janelas que `limits` não trouxe (ou tudo, quando não há `limits`). Nada reconhecível = null.
 */
export function parseAccountUsage(data: unknown): UsageWindow[] | null {
  if (!isObject(data)) return null;
  const windows = Array.isArray(data.limits) ? fromLimits(data.limits) : [];
  const known = new Set(windows.map((window) => window.id));
  for (const window of fromFlatKeys(data)) if (!known.has(window.id)) windows.push(window);
  return windows.length > 0 ? windows : null;
}
