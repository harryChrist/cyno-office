import { z } from "zod";
import { localDayKey, routineIdSchema, type FieldDef, type RoutineRunChange, type TrackedItem, type TrackingSpec, type TrackingStatus, type TrackingSummary } from "./routines";

/*
 * Acompanhamento (R2): regras puras dos itens acompanhados. Nada aqui lê disco nem relógio; o servidor
 * (RoutineTracking) e a tela usam as mesmas contas: valores contra o esquema, status, quando conferir,
 * quando vence e o resumo das mudanças de uma execução.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Tamanho máximo de um valor de texto de item. */
export const TRACKING_TEXT_MAX = 500;

/** Status pelo nome (sem diferenciar maiúsculas), devolvido como está no esquema. */
export function findStatus(spec: Pick<TrackingSpec, "statuses">, name: string): TrackingStatus | undefined {
  const wanted = name.trim().toLocaleLowerCase("pt-BR");
  return spec.statuses.find((status) => status.name.toLocaleLowerCase("pt-BR") === wanted);
}

/** Status inicial (o primeiro do esquema). */
export const initialStatus = (spec: Pick<TrackingSpec, "statuses">): TrackingStatus => spec.statuses[0] ?? { name: "Ativo" };

/** Nome curto do item: o primeiro campo com valor (ex.: a empresa), ou o id. */
export function itemLabel(spec: Pick<TrackingSpec, "fields">, item: Pick<TrackedItem, "id" | "values">): string {
  for (const field of spec.fields) {
    const value = item.values[field.key];
    if (value !== undefined && String(value).trim() !== "") return String(value).trim();
  }
  return item.id;
}

type Normalized = { ok: true; value: string | number } | { ok: false; error: string };

/** Confere UM valor contra a definição do campo (e arruma o que dá: número em texto, data com hora). */
export function normalizeFieldValue(def: FieldDef, raw: unknown): Normalized {
  const bad = (why: string): Normalized => ({ ok: false, error: `Field "${def.key}" (${def.type}): ${why}` });
  if (raw === null || raw === undefined) return bad("value is missing");
  switch (def.type) {
    case "numero": {
      const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim().replace(",", ".")) : Number.NaN;
      return Number.isFinite(value) ? { ok: true, value } : bad("expected a number");
    }
    case "data": {
      if (typeof raw !== "string") return bad("expected a date string (YYYY-MM-DD)");
      const text = raw.trim();
      if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(text) || Number.isNaN(Date.parse(text))) return bad("expected a date as YYYY-MM-DD");
      return { ok: true, value: text.slice(0, 10) };
    }
    case "link": {
      if (typeof raw !== "string") return bad("expected an http(s) link");
      const text = raw.trim();
      if (!/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(text)) return bad("expected an http(s) link");
      return text.length <= 2000 ? { ok: true, value: text } : bad("link is too long");
    }
    case "opcao": {
      if (typeof raw !== "string") return bad("expected one of the options");
      const option = (def.options ?? []).find((candidate) => candidate.toLocaleLowerCase("pt-BR") === raw.trim().toLocaleLowerCase("pt-BR"));
      return option ? { ok: true, value: option } : bad(`must be one of: ${(def.options ?? []).join(", ") || "(no options defined)"}`);
    }
    default: {
      if (typeof raw !== "string" && typeof raw !== "number") return bad("expected text");
      const text = String(raw).trim();
      return text.length <= TRACKING_TEXT_MAX ? { ok: true, value: text } : bad(`text is too long (max ${TRACKING_TEXT_MAX})`);
    }
  }
}

/**
 * Valida os valores contra os campos da rotina. Chave desconhecida é erro (lista as válidas); em `full`
 * (item novo) os campos obrigatórios têm de vir. Devolve os valores arrumados ou a lista de erros.
 */
export function validateValues(spec: Pick<TrackingSpec, "fields">, values: Record<string, unknown>, options: { full: boolean }): { values: Record<string, string | number>; errors: string[] } {
  const errors: string[] = [];
  const out: Record<string, string | number> = {};
  const known = new Map(spec.fields.map((field) => [field.key, field]));
  for (const [key, raw] of Object.entries(values)) {
    const def = known.get(key);
    if (!def) {
      errors.push(`Unknown field "${key}". Valid fields: ${[...known.keys()].join(", ") || "(none)"}.`);
      continue;
    }
    if (raw === "" && !def.required) continue;
    const result = normalizeFieldValue(def, raw);
    if (result.ok) out[key] = result.value;
    else errors.push(result.error);
  }
  if (options.full) {
    for (const def of spec.fields) {
      if (def.required && out[def.key] === undefined && !errors.some((error) => error.includes(`"${def.key}"`))) errors.push(`Required field "${def.key}" (${def.label}) is missing.`);
    }
  }
  return { values: out, errors };
}

/** Quando o item vence: criação + dias da vida (ausente = sem fim). */
export function expiresAtFor(spec: Pick<TrackingSpec, "lifespan">, from: Date): string | undefined {
  return spec.lifespan.days ? new Date(from.getTime() + spec.lifespan.days * DAY_MS).toISOString() : undefined;
}

/** O item ativo está na hora de ser conferido? Nunca conferido conta como vencido; sem `checkEveryHours`, todo ativo está. */
export function isItemDue(item: Pick<TrackedItem, "state" | "lastCheckedAt">, spec: Pick<TrackingSpec, "checkEveryHours">, now: Date): boolean {
  if (item.state !== "ativo") return false;
  if (!item.lastCheckedAt || !spec.checkEveryHours) return true;
  return now.getTime() - Date.parse(item.lastCheckedAt) >= spec.checkEveryHours * HOUR_MS;
}

/** O item ativo passou do fim da vida? */
export const isItemExpired = (item: Pick<TrackedItem, "state" | "expiresAt">, now: Date): boolean => item.state === "ativo" && item.expiresAt !== undefined && Date.parse(item.expiresAt) <= now.getTime();

/** Dias que faltam para vencer (arredondado para cima; ausente = sem fim; 0 = vence hoje). */
export function daysToExpire(item: Pick<TrackedItem, "expiresAt">, now: Date): number | undefined {
  if (!item.expiresAt) return undefined;
  return Math.max(0, Math.ceil((Date.parse(item.expiresAt) - now.getTime()) / DAY_MS));
}

/** O item teve alguma mudança (criado, status, encerrado) no dia local de `now`? */
export function changedOnDay(item: Pick<TrackedItem, "history">, now: Date): boolean {
  const day = localDayKey(now);
  return item.history.some((entry) => (entry.field === "criado" || entry.field === "status" || entry.field === "estado") && localDayKey(new Date(entry.at)) === day);
}

export function summarizeItems(items: readonly TrackedItem[], spec: Pick<TrackingSpec, "checkEveryHours">, now: Date): TrackingSummary {
  const summary: TrackingSummary = { active: 0, ended: 0, stopped: 0, changedToday: 0, due: 0 };
  for (const item of items) {
    if (item.state === "ativo") summary.active += 1;
    else if (item.state === "parado") summary.stopped += 1;
    else summary.ended += 1;
    if (isItemDue(item, spec, now)) summary.due += 1;
    if (changedOnDay(item, now)) summary.changedToday += 1;
  }
  return summary;
}

/** O texto curto do aviso de uma execução: "2 novos; Empresa X → Entrevista" (limitado). */
export function summarizeChanges(changes: readonly RoutineRunChange[], maxLength = 180): string {
  const news = changes.filter((change) => change.kind === "novo").length;
  const parts = [...(news > 0 ? [`${news} ${news === 1 ? "novo" : "novos"}`] : []), ...changes.filter((change) => change.kind !== "novo").map((change) => change.text)];
  let text = "";
  for (const [index, part] of parts.entries()) {
    const next = text ? `${text}; ${part}` : part;
    if (next.length > maxLength && text) return `${text}; +${parts.length - index}`;
    text = next;
  }
  return text;
}

// ---------- API HTTP dos itens (o usuário) ----------

export const trackedItemParamsSchema = z.object({ id: routineIdSchema, itemId: z.string().regex(/^I-\d{4,}$/, "id de item inválido") });
export const trackedItemsQuerySchema = z.object({
  state: z.enum(["ativo", "encerrado", "parado"]).optional(),
  status: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});
export const trackedItemChangesQuerySchema = z.object({ hours: z.coerce.number().int().min(1).max(24 * 90).default(48) });
export const stopTrackedItemBodySchema = z.object({ reason: z.string().trim().max(500).optional() }).default({});
export const editTrackedItemBodySchema = z.strictObject({ values: z.record(z.string(), z.union([z.string(), z.number()])).optional(), status: z.string().trim().min(1).max(60).optional() }).refine((body) => body.values !== undefined || body.status !== undefined, "informe valores ou status");

/** GET /routines/:id/items */
export type TrackedItemsResponse = { items: TrackedItem[]; total: number; summary: TrackingSummary; fields: FieldDef[]; statuses: TrackingStatus[] };
/** GET /routines/:id/changes: mudanças recentes dos itens (novo, status, estado), das mais novas para as mais antigas. */
export type TrackedItemChange = { at: string; itemId: string; label: string; by: "agente" | "servidor" | "usuario"; text: string; from?: string; to?: string; alert?: boolean };
