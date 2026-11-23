import {
  DEFAULT_ACCOUNT_ID,
  PTY_SIZE_LIMITS,
  engineAccountLoginPath,
  engineLoginClientMessageSchema,
  engineLoginServerMessageSchema,
  type AccountEngine,
  type ApiErrorBody,
  type EngineLoginClientMessage,
  type EngineLoginServerMessage,
} from "@cyno/shared";
import type { SocketLike } from "../../agentWork/maestroTerminalClient";

/** Limite do buffer em memória usado apenas para extrair o último link https (nunca gravado em storage nem em log). */
export const URL_SCAN_BUFFER_CHARS = 64_000;

/** Limite de caracteres aceitos pelo protocolo de entrada (`engineLoginClientMessageSchema`). */
const MAX_INPUT_CHARS = 64_000;

export type LoginTerminalPhase = "connecting" | "open" | "logged_in" | "exited" | "error";

export type LoginTerminalState = {
  phase: LoginTerminalPhase;
  exitCode: number | null;
  error: string | null;
  errorStatus: number | null;
  lastUrl: string | null;
  serverLabel: string | null;
};

export type LoginTerminalAction =
  | { type: "connecting" }
  | { type: "open" }
  | { type: "hello"; label: string }
  | { type: "url"; url: string | null }
  | { type: "logged_in" }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string; status?: number | null };

export const INITIAL_LOGIN_TERMINAL_STATE: LoginTerminalState = {
  phase: "connecting",
  exitCode: null,
  error: null,
  errorStatus: null,
  lastUrl: null,
  serverLabel: null,
};

/** Caminho HTTP/WS do mini terminal de login (`?engine=...` apenas para a conta padrão). */
export function loginHttpPath(accountId: string, engine: AccountEngine): string {
  return engineAccountLoginPath(accountId, accountId === DEFAULT_ACCOUNT_ID ? engine : undefined);
}

/** URL WebSocket do mini terminal de login seguindo o protocolo da página (`ws:` / `wss:`). */
export function loginSocketUrl(
  location: Pick<Location, "protocol" | "host">,
  accountId: string,
  engine: AccountEngine,
): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${loginHttpPath(accountId, engine)}`;
}

/** Valida e lê uma mensagem do servidor segundo `engineLoginServerMessageSchema` (nunca lança). */
export function parseLoginServerMessage(raw: string): EngineLoginServerMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = engineLoginServerMessageSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** Limita colunas e linhas aos limites seguros do PTY antes de enviar `resize`. */
export function clampLoginPtySize(cols: number, rows: number): { cols: number; rows: number } {
  const safeCols = Number.isFinite(cols) ? Math.round(cols) : PTY_SIZE_LIMITS.minCols;
  const safeRows = Number.isFinite(rows) ? Math.round(rows) : PTY_SIZE_LIMITS.minRows;
  return {
    cols: Math.max(PTY_SIZE_LIMITS.minCols, Math.min(PTY_SIZE_LIMITS.maxCols, safeCols)),
    rows: Math.max(PTY_SIZE_LIMITS.minRows, Math.min(PTY_SIZE_LIMITS.maxRows, safeRows)),
  };
}

/** Serializa uma mensagem do cliente validando contra `engineLoginClientMessageSchema`. */
export function serializeLoginClientMessage(message: EngineLoginClientMessage): string | null {
  const parsed = engineLoginClientMessageSchema.safeParse(message);
  return parsed.success ? JSON.stringify(parsed.data) : null;
}

/**
 * Monta a mensagem `in` do campo "Colar código" (remove quebras de linha acidentais,
 * descarta texto vazio e acrescenta Enter `\r` para o PTY).
 */
export function buildPasteCodeMessage(rawCode: string): EngineLoginClientMessage | null {
  const cleaned = rawCode.replace(/[\r\n]+/g, "").trim();
  if (!cleaned) return null;
  const data = `${cleaned}\r`;
  if (data.length > MAX_INPUT_CHARS) return null;
  return { type: "in", data };
}

/** Remove sequências ANSI (CSI, OSC e ESC simples) e controles da saída do terminal para leitura limpa de URLs. */
export function stripAnsi(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x1b) {
      const next = text[i + 1];
      if (next === "[") {
        // CSI: ESC [ ... <0x40..0x7e>
        i += 2;
        while (i < text.length) {
          const byte = text.charCodeAt(i);
          i += 1;
          if (byte >= 0x40 && byte <= 0x7e) break;
        }
        continue;
      }
      if (next === "]") {
        // OSC: ESC ] ... (BEL ou ESC \)
        i += 2;
        while (i < text.length) {
          const byte = text.charCodeAt(i);
          if (byte === 0x07) {
            i += 1;
            break;
          }
          if (byte === 0x1b && text[i + 1] === "\\") {
            i += 2;
            break;
          }
          i += 1;
        }
        out += " ";
        continue;
      }
      i += next !== undefined ? 2 : 1;
      continue;
    }
    if (code === 0x0d) {
      i += 1;
      continue;
    }
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f) {
      out += " ";
      i += 1;
      continue;
    }
    out += text[i]!;
    i += 1;
  }
  return out;
}

function trimTrailingUrlPunctuation(raw: string): string {
  let candidate = raw;
  while (candidate.length > 0) {
    const last = candidate[candidate.length - 1]!;
    if (/[.,;:!?'"`]/.test(last)) {
      candidate = candidate.slice(0, -1);
      continue;
    }
    if (last === ")") {
      const opens = (candidate.match(/\(/g) ?? []).length;
      const closes = (candidate.match(/\)/g) ?? []).length;
      if (closes > opens) {
        candidate = candidate.slice(0, -1);
        continue;
      }
    }
    if (last === "]") {
      const opens = (candidate.match(/\[/g) ?? []).length;
      const closes = (candidate.match(/\]/g) ?? []).length;
      if (closes > opens) {
        candidate = candidate.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return candidate;
}

/** Extrai a última URL `https://` válida impressa no texto do terminal (ou `null` se não houver). */
export function extractLastHttpsUrl(text: string): string | null {
  if (!text) return null;
  const clean = stripAnsi(text);
  const pattern = /https:\/\/[^\s<>"'`]+/g;
  let lastValid: string | null = null;
  for (const match of clean.matchAll(pattern)) {
    const candidate = trimTrailingUrlPunctuation(match[0]);
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "https:" && parsed.hostname.length > 0) {
        lastValid = candidate;
      }
    } catch {
      // ignora URLs malformadas
    }
  }
  return lastValid;
}

/** Mantém um buffer deslizante em memória (até `URL_SCAN_BUFFER_CHARS`) para detectar URLs quebradas entre pacotes. */
export function appendUrlBuffer(previous: string, chunk: string, maxChars = URL_SCAN_BUFFER_CHARS): string {
  const combined = previous + chunk;
  return combined.length <= maxChars ? combined : combined.slice(combined.length - maxChars);
}

/** Reducer puro do estado do modal de login. */
export function loginTerminalReducer(
  state: LoginTerminalState,
  action: LoginTerminalAction,
): LoginTerminalState {
  switch (action.type) {
    case "connecting":
      return {
        ...state,
        phase: "connecting",
        exitCode: null,
        error: null,
        errorStatus: null,
      };
    case "open":
      if (state.phase === "logged_in") return state;
      return {
        ...state,
        phase: "open",
        error: null,
        errorStatus: null,
      };
    case "hello":
      return {
        ...state,
        phase: state.phase === "connecting" ? "open" : state.phase,
        serverLabel: action.label,
      };
    case "url":
      return action.url === state.lastUrl ? state : { ...state, lastUrl: action.url };
    case "logged_in":
      return {
        ...state,
        phase: "logged_in",
        error: null,
        errorStatus: null,
      };
    case "exit":
      if (state.phase === "logged_in") return state;
      return {
        ...state,
        phase: "exited",
        exitCode: action.code,
      };
    case "error":
      if (state.phase === "logged_in") return state;
      return {
        ...state,
        phase: "error",
        error: action.message,
        errorStatus: action.status ?? null,
      };
  }
}

export type UpgradeErrorProbeResult = {
  status: number;
  message: string;
  expired?: boolean;
};

function defaultUpgradeErrorMessage(status: number): string {
  switch (status) {
    case 401:
      return "Sua sessão expirou. Entre novamente no app.";
    case 403:
      return "O login pelo navegador está bloqueado neste servidor (exige senha de acesso configurada).";
    case 404:
      return "Esta conta não foi encontrada no servidor.";
    case 409:
      return "Não foi possível abrir o login agora (motor não instalado ou outra sessão de login já está aberta).";
    default:
      return "Não foi possível abrir o terminal de login. Tente novamente.";
  }
}

/**
 * Consulta a mesma rota via GET comum quando o handshake do WebSocket falha antes de abrir:
 * o `preValidation` do servidor devolve o status exato (401/403/404/409) e a mensagem em pt-BR
 * sem iniciar nenhum processo de PTY.
 */
export async function probeLoginUpgradeError(
  httpPath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UpgradeErrorProbeResult> {
  try {
    const response = await fetchImpl(httpPath, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    const text = await response.text().catch(() => "");
    let serverError: string | undefined;
    if (text) {
      try {
        const body = JSON.parse(text) as ApiErrorBody;
        if (typeof body.error === "string" && body.error.trim()) {
          serverError = body.error.trim();
        }
      } catch {
        // corpo não-JSON: cai na mensagem padrão do status
      }
    }
    const status = response.status;
    return {
      status,
      message: serverError ?? defaultUpgradeErrorMessage(status),
      ...(status === 401 ? { expired: true } : {}),
    };
  } catch {
    return {
      status: 0,
      message: "Não foi possível conectar ao servidor para abrir o terminal de login.",
    };
  }
}

/** Mensagem curta para o código de saída do processo de login. */
export function loginExitMessage(code: number | null): string {
  if (code === null) return "O processo de login foi encerrado.";
  return `O processo de login terminou (código ${code}).`;
}

/** Rótulo e tom do selo no cabeçalho do mini terminal. */
export function loginPhaseBadge(phase: LoginTerminalPhase): {
  label: string;
  tone: "attention" | "success" | "danger" | "neutral";
} {
  switch (phase) {
    case "connecting":
      return { label: "Conectando…", tone: "attention" };
    case "open":
      return { label: "Conectado", tone: "success" };
    case "logged_in":
      return { label: "Conectada", tone: "success" };
    case "exited":
      return { label: "Encerrado", tone: "neutral" };
    case "error":
      return { label: "Indisponível", tone: "danger" };
  }
}

const WS_OPEN = 1;

export type LoginSocketOptions = {
  url: string;
  onOpen: () => void;
  onMessage: (message: EngineLoginServerMessage) => void;
  /** Disparado quando o socket fecha antes de abrir (ex.: 403/404/409 no upgrade). */
  onHandshakeFailure: (code: number) => void;
  /** Disparado quando o socket fecha depois de já ter aberto sem ter sido encerrado pelo cliente. */
  onUnexpectedClose: (code: number) => void;
  createSocket?: (url: string) => SocketLike;
};

/**
 * Cliente WebSocket simples do mini terminal de login:
 * não reconecta sozinho em loop (o servidor permite apenas uma sessão e responde 403/404/409 no upgrade);
 * ao fechar pelo cliente, encerra o socket e o servidor mantém o PTY vivo por 60 s para reconexão manual.
 */
export class LoginSocket {
  private socket: SocketLike | undefined;
  private opened = false;
  private closed = false;

  constructor(private readonly options: LoginSocketOptions) {
    const socket = (options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike))(options.url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.closed || this.socket !== socket) return;
      this.opened = true;
      this.options.onOpen();
    };
    socket.onmessage = (event) => {
      if (this.closed || typeof event.data !== "string") return;
      const message = parseLoginServerMessage(event.data);
      if (message) this.options.onMessage(message);
    };
    socket.onerror = () => undefined;
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (this.closed) return;
      if (!this.opened) {
        this.options.onHandshakeFailure(event.code);
      } else {
        this.options.onUnexpectedClose(event.code);
      }
    };
  }

  send(message: EngineLoginClientMessage): boolean {
    if (this.closed || !this.socket || this.socket.readyState !== WS_OPEN) return false;
    const payload = serializeLoginClientMessage(message);
    if (!payload) return false;
    this.socket.send(payload);
    return true;
  }

  close(): void {
    this.closed = true;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
  }
}
