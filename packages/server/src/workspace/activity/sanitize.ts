/**
 * Limpeza dos dados de um evento da Atividade: corta textos, limita listas e profundidade e nunca deixa
 * passar segredo (tokens, cookies, cabeçalhos de autenticação, chaves de API). Nunca lança.
 */

/** Tamanho máximo de um texto guardado. */
export const MAX_STRING = 500;
const MAX_ARRAY = 50;
const MAX_KEYS = 40;
const MAX_DEPTH = 4;

export const REDACTED = "[redacted]";

/** Campos cujo valor nunca é guardado (o nome fica, o valor vira "[redacted]"). */
const SECRET_KEY = /(token|secret|password|passwd|cookie|authorization|^auth$|auth[-_]?header|api[-_]?key|bearer|credential|session[-_]?key|private[-_]?key)/i;

/** Contagens ("inputTokens", "tokens") não são segredo. */
const COUNT_KEY = /tokens$/i;

/** Padrões de segredo dentro de textos (mensagens de erro, URLs). */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  // Tokens do MCP (32 bytes em hex) e afins: hex comprido.
  [/\b[a-f0-9]{40,}\b/gi, REDACTED],
  // Parâmetros de URL com cara de segredo.
  [/([?&](?:token|access_token|key|api_key|apikey|auth|code|session|sig|signature)=)[^&#\s]+/gi, `$1${REDACTED}`],
  [/((?:cookie|set-cookie|authorization)\s*[:=]\s*)[^\n;]+/gi, `$1${REDACTED}`],
];

/** Tira segredos conhecidos de um texto e corta em `max` caracteres. */
export function cleanString(value: string, max = MAX_STRING): string {
  let text = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function cleanValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return cleanString(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) return cleanString(value.message);
  if (typeof value !== "object") return undefined; // funções, símbolos
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((item) => cleanValue(item, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`(+${value.length - MAX_ARRAY})`);
    return out;
  }
  return cleanObject(value as Record<string, unknown>, depth + 1);
}

function cleanObject(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (count >= MAX_KEYS) break;
    if (item === undefined) continue;
    count += 1;
    if (SECRET_KEY.test(key) && !COUNT_KEY.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    const cleaned = cleanValue(item, depth);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

/** `data` pronto para gravar (ou undefined se vazio ou impossível de limpar). */
export function sanitizeData(data: unknown): Record<string, unknown> | undefined {
  try {
    if (data === undefined || data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
    const out = cleanObject(data as Record<string, unknown>, 0);
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
