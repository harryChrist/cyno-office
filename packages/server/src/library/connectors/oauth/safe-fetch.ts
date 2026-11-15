import { ConnectorError } from "../mcp-client";

/**
 * Pedidos HTTP do login OAuth (descoberta, cadastro, token): só https (http só para localhost, útil
 * em testes), com limite de tempo, de tamanho da resposta e de redirecionamentos. Cada
 * redirecionamento passa pela mesma regra de endereço.
 */

export type LimitedResponse = { status: number; headers: Headers; text: string; url: string };

export type LimitedFetchOptions = {
  fetch?: typeof fetch;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** POST de token e cadastro não seguem redirecionamento (0). */
  maxRedirects?: number;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** https sempre; http só para localhost. Devolve a URL ou lança. */
export function assertAllowedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConnectorError(`endereço inválido: ${raw.slice(0, 120)}`);
  }
  if (url.username || url.password) throw new ConnectorError("endereço com usuário e senha não é aceito");
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) return url;
  throw new ConnectorError(`só https é aceito no login OAuth (recebi ${url.protocol}//${url.host})`);
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw new ConnectorError(`a resposta passou de ${Math.round(maxBytes / 1024)} KB`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function limitedFetch(raw: string, options: LimitedFetchOptions = {}): Promise<LimitedResponse> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 256 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  const signal = AbortSignal.timeout(timeoutMs);
  let current = assertAllowedUrl(raw);
  for (let hop = 0; ; hop++) {
    let response: Response;
    try {
      response = await doFetch(current, { method: options.method ?? "GET", headers: options.headers, body: options.body, redirect: "manual", signal });
    } catch (error) {
      const name = (error as Error).name;
      if (name === "TimeoutError" || name === "AbortError") throw new ConnectorError(`sem resposta em ${Math.round(timeoutMs / 1000)} s (${current.host})`);
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      throw new ConnectorError(`não conectou em ${current.host}${cause ? ` (${cause})` : ""}`);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel().catch(() => undefined);
      if (hop >= maxRedirects) throw new ConnectorError(maxRedirects === 0 ? `${current.host} redirecionou (não é aceito aqui)` : "redirecionamentos demais");
      current = assertAllowedUrl(new URL(response.headers.get("location")!, current).toString());
      continue;
    }
    return { status: response.status, headers: response.headers, text: await readLimited(response, maxBytes), url: current.toString() };
  }
}

/** JSON de uma resposta 200 (ou undefined se não for objeto JSON). */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
