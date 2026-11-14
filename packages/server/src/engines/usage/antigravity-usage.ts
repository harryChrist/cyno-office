import type { UsageWindow } from "@cyno/shared";

/**
 * Leitura da cota da conta Google no Antigravity: a saída de `agy -p /usage --output-format json`
 * (agy 1.5.3; o comando responde sem rodar turno, sem gastar cota e sem criar conversa). O payload
 * fica em `command.data`:
 *
 *   { groups: [{ name: "Gemini Models", description: "Models within this group: Gemini Flash, Gemini Pro",
 *       buckets: [{ id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h",
 *                   remaining_fraction: 0.99, reset_time: "2026-11-09T08:43:56Z" }, …] }, …] }
 *
 * Cada grupo divide uma cota de 5 h e uma da semana entre os modelos dele ("Gemini Models",
 * "Claude and GPT models", "Gemini 4 Argon"). Aqui cada bucket vira uma janela: o grupo dos Gemini
 * é o principal (`five_hour`, `seven_day`, como as do Claude, para o anel); os outros ganham o
 * sufixo do grupo (`five_hour_claude_gpt`, `seven_day_gemini_4_argon`). `remaining_fraction` é o que
 * SOBRA (0..1): o uso é 1 − isso. Tudo defensivo: formato desconhecido = null, nunca lança.
 */

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

const WINDOW_ID = /^[a-z0-9_]{1,40}$/;

/** "Claude and GPT models" -> "claude_gpt"; "Gemini 4 Argon" -> "gemini_4_argon". */
function groupSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word && !["and", "models", "model", "e"].includes(word))
    .join("_")
    .slice(0, 28);
}

/** Nome do grupo em pt-BR: "Gemini Models" -> "Modelos Gemini", "Claude and GPT models" -> "Claude e GPT". */
function groupLabel(name: string): string {
  const plain = name.replace(/\s+models?$/i, "").replace(/\s+and\s+/gi, " e ").trim();
  if (/^gemini$/i.test(plain)) return "Modelos Gemini";
  return plain.slice(0, 60) || name.slice(0, 60);
}

/**
 * Palavras dos modelos do grupo (para `appliesTo`): da descrição "Models within this group: Claude
 * Opus, Claude Sonnet, GPT-OSS" sai ["claude", "gpt"] (a primeira palavra de cada um); sem essa
 * descrição, o nome inteiro ("gemini 4 argon").
 */
function groupModels(name: string, description: string | undefined): string[] {
  const listed = description ? /models within this group:\s*(.+)$/i.exec(description)?.[1] : undefined;
  if (listed) {
    const words = listed
      .split(",")
      .map((model) => /^[a-z0-9]+/i.exec(model.trim())?.[0]?.toLowerCase())
      .filter((word): word is string => Boolean(word));
    if (words.length > 0) return [...new Set(words)];
  }
  const whole = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\bmodels?\b/g, "").trim();
  return whole ? [whole.slice(0, 40)] : [];
}

/** "5h" -> five_hour, "weekly" -> seven_day; outro texto vira slug; vazio = undefined. */
function windowKind(bucket: Json): "five_hour" | "seven_day" | string | undefined {
  const raw = (str(bucket.window) ?? str(bucket.id) ?? "").toLowerCase();
  if (/(^|[^0-9])5h|five.?hour/.test(raw)) return "five_hour";
  if (/week|7d|seven.?day/.test(raw)) return "seven_day";
  const slug = raw.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || undefined;
}

const KIND_LABELS: Record<string, string> = { five_hour: "Sessão 5h", seven_day: "Semana" };

function isoTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/** O payload do /usage: aceita a resposta inteira do agy (`command.data`) ou só o `data`. */
function payloadOf(data: unknown): Json | undefined {
  if (!isObject(data)) return undefined;
  if (Array.isArray(data.groups)) return data;
  if (isObject(data.command) && isObject(data.command.data)) return payloadOf(data.command.data);
  if (isObject(data.data)) return payloadOf(data.data);
  return undefined;
}

/** O grupo principal: o dos Gemini (bucket "gemini-5h"/"gemini-weekly" ou nome "Gemini Models"); senão o primeiro. */
function primaryGroupIndex(groups: Json[]): number {
  const index = groups.findIndex(
    (group) =>
      /^gemini models?$/i.test(str(group.name) ?? "") ||
      (Array.isArray(group.buckets) && group.buckets.some((bucket) => isObject(bucket) && /^gemini-(5h|weekly)$/.test(str(bucket.id) ?? ""))),
  );
  return index === -1 ? 0 : index;
}

/** Janelas da cota do Antigravity; nada reconhecível = null. */
export function parseAntigravityUsage(data: unknown): UsageWindow[] | null {
  const payload = payloadOf(data);
  if (!payload) return null;
  const groups = (payload.groups as unknown[]).filter(isObject);
  const primary = primaryGroupIndex(groups);
  const byId = new Map<string, UsageWindow>();
  groups.forEach((group, index) => {
    const name = str(group.name) ?? `grupo ${index + 1}`;
    const suffix = index === primary ? "" : groupSlug(name);
    const label = groupLabel(name);
    const appliesTo = groupModels(name, str(group.description));
    const buckets = Array.isArray(group.buckets) ? group.buckets.filter(isObject) : [];
    for (const bucket of buckets) {
      if (bucket.disabled === true || str(bucket.status)?.toLowerCase() === "disabled") continue;
      const remaining = num(bucket.remaining_fraction ?? bucket.remainingFraction);
      if (remaining === undefined) continue;
      const kind = windowKind(bucket);
      if (!kind) continue;
      const id = suffix ? `${kind}_${suffix}` : kind;
      if (!WINDOW_ID.test(id) || byId.has(id)) continue;
      const resetsAt = isoTime(bucket.reset_time ?? bucket.resetTime);
      byId.set(id, {
        id,
        utilization: Math.min(1, Math.max(0, 1 - remaining)),
        ...(resetsAt ? { resetsAt } : {}),
        label: KIND_LABELS[kind] ?? (str(bucket.name) ?? kind).slice(0, 60),
        group: label,
        ...(appliesTo.length > 0 ? { appliesTo } : {}),
      });
    }
  });
  return byId.size > 0 ? [...byId.values()] : null;
}
