import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { MCP_PROTOCOL_VERSIONS } from "../../mcp/protocol";
import type { StoredConnectorTool } from "./store";

/**
 * Cliente MCP mínimo do gateway (o lado "cliente" do nosso server, falando com os conectores):
 * initialize + notifications/initialized, tools/list (com paginação) e tools/call.
 * - HTTP: transporte "Streamable HTTP" (POST com JSON-RPC; resposta em JSON ou em SSE; guarda o
 *   Mcp-Session-Id). O transporte antigo "HTTP+SSE" (GET /sse + POST /messages) não é suportado.
 * - stdio: um processo por conector (sem shell), JSON-RPC em linhas no stdin/stdout; para sozinho
 *   depois de um tempo ocioso e sobe de novo na próxima chamada.
 * 401 vira ConnectorAuthError (o estado "precisa de login"); 403 vira ConnectorError com o motivo que o servidor deu.
 */

export class ConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorError";
  }
}

/** O servidor pediu login/credencial (HTTP 401). */
export class ConnectorAuthError extends ConnectorError {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorAuthError";
  }
}

/** Resultado de tools/call como o servidor mandou (o gateway repassa ao agente). */
export type ConnectorCallResult = { content: unknown[]; isError: boolean };

export interface McpClient {
  listTools(): Promise<StoredConnectorTool[]>;
  /** Chamada real e barata que o "Testar" faz além de listar as ferramentas (só os clientes que têm uma). Lança se o uso está barrado. */
  probe?(): Promise<void>;
  callTool(name: string, args: Record<string, unknown>): Promise<ConnectorCallResult>;
  close(): Promise<void>;
}

export const CLIENT_INFO = { name: "cyno-gateway", version: "0.1.0" };
const PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[1] ?? "2025-06-18";
const MAX_TOOL_PAGES = 20;
const MAX_TOOLS = 500;

type JsonRpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Lê as ferramentas de um resultado de tools/list (ignora entradas sem nome). */
function readTools(result: unknown): { tools: StoredConnectorTool[]; nextCursor?: string } {
  if (!isObject(result) || !Array.isArray(result.tools)) throw new ConnectorError("tools/list sem a lista de ferramentas");
  const tools: StoredConnectorTool[] = [];
  for (const raw of result.tools) {
    if (!isObject(raw) || typeof raw.name !== "string" || raw.name.length === 0 || raw.name.length > 200) continue;
    const description = typeof raw.description === "string" ? raw.description.slice(0, 4000) : undefined;
    const inputSchema = isObject(raw.inputSchema) ? raw.inputSchema : undefined;
    const hints = isObject(raw.annotations) ? Object.fromEntries(Object.entries(raw.annotations).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean" && /Hint$/.test(entry[0]))) : {};
    tools.push({ name: raw.name, ...(description ? { description } : {}), ...(inputSchema ? { inputSchema } : {}), ...(Object.keys(hints).length > 0 ? { annotations: hints } : {}) });
  }
  return { tools, ...(typeof result.nextCursor === "string" && result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
}

function readCallResult(result: unknown): ConnectorCallResult {
  if (!isObject(result)) return { content: [{ type: "text", text: JSON.stringify(result ?? null) }], isError: false };
  const content = Array.isArray(result.content) ? result.content : [];
  if (content.length === 0 && result.structuredContent !== undefined) {
    return { content: [{ type: "text", text: JSON.stringify(result.structuredContent) }], isError: result.isError === true };
  }
  return { content, isError: result.isError === true };
}

/** Pagina o tools/list até acabar (com limites para um servidor que nunca para). */
async function listAllTools(rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>): Promise<StoredConnectorTool[]> {
  const out: StoredConnectorTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const { tools, nextCursor } = readTools(await rpc("tools/list", cursor ? { cursor } : {}));
    out.push(...tools);
    if (!nextCursor || out.length >= MAX_TOOLS) break;
    cursor = nextCursor;
  }
  return out.slice(0, MAX_TOOLS);
}

function rpcError(message: JsonRpcMessage): ConnectorError {
  const text = message.error?.message ?? "erro desconhecido";
  return new ConnectorError(`o servidor respondeu erro${message.error?.code !== undefined ? ` ${message.error.code}` : ""}: ${text.slice(0, 300)}`);
}

const FORBIDDEN_BODY_BYTES = 16 * 1024;
const FORBIDDEN_MESSAGE_CHARS = 300;
/** Só estes endereços do servidor entram no texto do motivo (onde o Google manda ativar a API). */
const ACTIVATION_HOSTS = new Set(["console.developers.google.com", "console.cloud.google.com"]);

/** Lê no máximo `limit` bytes do corpo (o resto é descartado). */
export async function readLimitedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // corpo interrompido: usa o que veio
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text.slice(0, limit);
}

/** Texto de erro dentro de um objeto JSON: JSON-RPC (`error.message`), Google (`error.message`) ou resultado de ferramenta com `isError`. */
function messageFromJson(value: unknown): string | undefined {
  for (const item of Array.isArray(value) ? value : [value]) {
    if (!isObject(item)) continue;
    if (isObject(item.error) && typeof item.error.message === "string" && item.error.message.trim()) return item.error.message;
    if (typeof item.error === "string" && item.error.trim()) return item.error;
    if (isObject(item.result) && item.result.isError === true && Array.isArray(item.result.content)) {
      const text = item.result.content
        .map((part) => (isObject(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join(" ");
      if (text.trim()) return text;
    }
  }
  return undefined;
}

/** Mensagem legível do corpo de um 403 (JSON ou SSE); undefined quando não há. Dado não confiável: só vira texto. */
export function extractForbiddenMessage(body: string): string | undefined {
  const candidates = [body.trim(), ...body.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())];
  for (const candidate of candidates) {
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
    try {
      const found = messageFromJson(JSON.parse(candidate));
      if (found) return found.replace(/\s+/g, " ").trim();
    } catch {
      // não é JSON
    }
  }
  return undefined;
}

/** O motivo (em português) de um 403, a partir do corpo da resposta. */
export function forbiddenReason(body: string): string {
  const message = extractForbiddenMessage(body);
  if (!message) return "o servidor recusou o acesso (HTTP 403)";
  if (/has not been used in project .*(before )?or it is disabled/i.test(message)) {
    const found = /https:\/\/[^\s"'<>)\]]+/i.exec(message)?.[0].replace(/[.,;]+$/, "");
    let url: string | undefined;
    try {
      const parsed = found ? new URL(found) : undefined;
      if (parsed && parsed.protocol === "https:" && ACTIVATION_HOSTS.has(parsed.hostname) && !parsed.username && !parsed.password) url = parsed.href;
    } catch {
      // endereço inválido: fica de fora
    }
    return `a API deste servidor não está ativada no projeto do Google Cloud. Ative-a${url ? ` em ${url}` : ""} e teste de novo em alguns minutos (HTTP 403)`;
  }
  return `o servidor recusou a chamada (HTTP 403): ${message.slice(0, FORBIDDEN_MESSAGE_CHARS)}`;
}

// ---------- HTTP ----------

/**
 * Login OAuth do conector: o cliente pede o token a cada requisição (renovado antes de vencer) e,
 * num 401, pede renovação e tenta uma vez de novo. `refresh` lança erro de "precisa entrar de novo"
 * quando a autorização acabou.
 */
export interface HttpAuthProvider {
  /** Valor do cabeçalho Authorization (ex.: "Bearer …"), ou undefined se ainda não entrou. */
  header(): Promise<string | undefined>;
  /** O servidor recusou `usedHeader`: renova. Devolve true se há token novo para tentar. */
  refresh(usedHeader: string | undefined, rejectedAfterRefresh?: boolean): Promise<boolean>;
}

export type HttpClientOptions = {
  url: string;
  /** Cabeçalhos secretos (ex.: Authorization), só no pedido; nunca no log. */
  headers: Record<string, string>;
  /** Login OAuth (no lugar do Authorization fixo quando há token). */
  auth?: HttpAuthProvider;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Tempo de uma chamada de ferramenta (padrão: 2 min). */
  callTimeoutMs?: number;
};

/** Lê um corpo SSE e devolve a primeira mensagem JSON-RPC com o id pedido. */
async function readSse(body: ReadableStream<Uint8Array>, id: number): Promise<JsonRpcMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let at: number;
      while ((at = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        let message: unknown;
        try {
          message = JSON.parse(data);
        } catch {
          continue;
        }
        for (const candidate of Array.isArray(message) ? message : [message]) {
          if (isObject(candidate) && candidate.id === id && ("result" in candidate || "error" in candidate)) return candidate as JsonRpcMessage;
        }
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new ConnectorError("a resposta (SSE) terminou sem o resultado");
}

export class HttpMcpClient implements McpClient {
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;
  private initializing: Promise<void> | undefined;
  private nextId = 1;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: HttpClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async listTools(): Promise<StoredConnectorTool[]> {
    await this.ensureInitialized();
    return listAllTools((method, params) => this.request(method, params));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ConnectorCallResult> {
    await this.ensureInitialized();
    return readCallResult(await this.request("tools/call", { name, arguments: args }, this.options.callTimeoutMs ?? 120_000, true));
  }

  async close(): Promise<void> {
    const sessionId = this.sessionId;
    this.reset();
    if (!sessionId) return;
    // Fim de sessão educado (o servidor pode recusar com 405; tanto faz).
    await this.fetch(this.options.url, { method: "DELETE", headers: { ...this.options.headers, "mcp-session-id": sessionId }, signal: AbortSignal.timeout(3000) }).catch(() => undefined);
  }

  private reset(): void {
    this.sessionId = undefined;
    this.protocolVersion = undefined;
    this.initializing = undefined;
  }

  private ensureInitialized(): Promise<void> {
    this.initializing ??= this.initialize().catch((error: unknown) => {
      this.initializing = undefined;
      throw error;
    });
    return this.initializing;
  }

  private async initialize(): Promise<void> {
    const result = await this.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
    const version = isObject(result) && typeof result.protocolVersion === "string" ? result.protocolVersion : PROTOCOL_VERSION;
    this.protocolVersion = version;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, this.options.timeoutMs ?? 15_000);
  }

  private headers(authorization?: string): Record<string, string> {
    return {
      ...this.options.headers,
      ...(authorization ? { authorization } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...(this.protocolVersion ? { "mcp-protocol-version": this.protocolVersion } : {}),
    };
  }

  private async post(body: unknown, timeoutMs: number, retried = false): Promise<Response> {
    let response: Response;
    const authorization = await this.options.auth?.header();
    try {
      response = await this.fetch(this.options.url, { method: "POST", headers: this.headers(authorization), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    } catch (error) {
      const name = (error as Error).name;
      if (name === "TimeoutError" || name === "AbortError") throw new ConnectorError(`sem resposta em ${Math.round(timeoutMs / 1000)} s`);
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      throw new ConnectorError(cause ? `não conectou (${cause})` : "não conectou ao servidor");
    }
    if (response.status === 401 && this.options.auth) {
      await response.body?.cancel().catch(() => undefined);
      // Renova (lança "precisa entrar de novo" se não der) e repete uma vez com o token novo; recusado de novo = entrar de novo.
      if (await this.options.auth.refresh(authorization, retried)) return this.post(body, timeoutMs, true);
    }
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      throw new ConnectorAuthError(`o servidor pediu login/credencial (HTTP ${response.status})`);
    }
    if (response.status === 403) {
      // 403 não é "entre de novo": o login pode estar certo e o servidor recusar por outro motivo (ex.: API não ativada no projeto). Vira erro comum, com o motivo do servidor.
      throw new ConnectorError(forbiddenReason(await readLimitedText(response, FORBIDDEN_BODY_BYTES)));
    }
    return response;
  }

  /** Um pedido JSON-RPC; sessão vencida (404 com sessão) = inicia de novo e tenta uma vez. */
  private async request(method: string, params?: Record<string, unknown>, timeoutMs = this.options.timeoutMs ?? 15_000, retry = method !== "initialize"): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }, timeoutMs);
    if (response.status === 404 && this.sessionId && retry) {
      await response.body?.cancel().catch(() => undefined);
      this.reset();
      await this.ensureInitialized();
      return this.request(method, params, timeoutMs, false);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ConnectorError(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
    }
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    const type = response.headers.get("content-type") ?? "";
    let message: JsonRpcMessage | undefined;
    if (type.includes("text/event-stream")) {
      if (!response.body) throw new ConnectorError("resposta SSE sem corpo");
      message = await readSse(response.body, id);
    } else {
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new ConnectorError("resposta que não é JSON (é mesmo um servidor MCP?)");
      }
      const found = (Array.isArray(data) ? data : [data]).find((candidate) => isObject(candidate) && candidate.id === id);
      message = found as JsonRpcMessage | undefined;
    }
    if (!message) throw new ConnectorError("o servidor não respondeu o pedido");
    if (message.error) throw rpcError(message);
    return message.result;
  }
}

// ---------- stdio ----------

export type SpawnLike = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;

export type StdioClientOptions = {
  command: string;
  args: string[];
  cwd: string;
  /** Ambiente completo do processo (já com as variáveis secretas). */
  env: NodeJS.ProcessEnv;
  spawn?: SpawnLike;
  timeoutMs?: number;
  callTimeoutMs?: number;
  /** Ocioso por tanto tempo = processo parado (sobe de novo na próxima chamada). Padrão: 10 min. */
  idleMs?: number;
};

const defaultSpawn: SpawnLike = (command, args, options) => nodeSpawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });

type Pending = { resolve: (message: JsonRpcMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class StdioMcpClient implements McpClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private initializing: Promise<void> | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrTail = "";
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: StdioClientOptions) {}

  async listTools(): Promise<StoredConnectorTool[]> {
    await this.ensureInitialized();
    try {
      return await listAllTools((method, params) => this.request(method, params));
    } finally {
      this.touch();
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ConnectorCallResult> {
    await this.ensureInitialized();
    try {
      return readCallResult(await this.request("tools/call", { name, arguments: args }, this.options.callTimeoutMs ?? 120_000));
    } finally {
      this.touch();
    }
  }

  async close(): Promise<void> {
    clearTimeout(this.idleTimer);
    const child = this.child;
    this.child = undefined;
    this.initializing = undefined;
    this.failAll(new ConnectorError("conector fechado"));
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
      child.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      child.stdin.end();
      child.kill("SIGTERM");
    });
  }

  /** Últimas linhas do stderr (para o motivo de uma falha; o gateway apaga os segredos). */
  stderr(): string {
    return this.stderrTail.trim();
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    const idleMs = this.options.idleMs ?? 10 * 60_000;
    if (idleMs <= 0 || this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => void this.close(), idleMs);
    this.idleTimer.unref?.();
  }

  private ensureInitialized(): Promise<void> {
    this.initializing ??= this.initialize().catch(async (error: unknown) => {
      await this.close();
      throw error;
    });
    return this.initializing;
  }

  private async initialize(): Promise<void> {
    this.start();
    await this.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
    this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  private start(): void {
    const spawn = this.options.spawn ?? defaultSpawn;
    this.stdoutBuffer = "";
    this.stderrTail = "";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.command, this.options.args, { cwd: this.options.cwd, env: this.options.env });
    } catch (error) {
      throw new ConnectorError(`não foi possível rodar o comando: ${(error as Error).message}`);
    }
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    child.stdin.on("error", () => undefined);
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.initializing = undefined;
      this.failAll(new ConnectorError(error.code === "ENOENT" ? `comando não encontrado: ${this.options.command}` : `o processo falhou: ${error.message}`));
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.initializing = undefined;
      const tail = this.stderr().split("\n").slice(-3).join(" ").slice(0, 300);
      this.failAll(new ConnectorError(`o processo saiu (${signal ?? `código ${code}`})${tail ? `: ${tail}` : ""}`));
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let at: number;
    while ((at = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, at).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(at + 1);
      if (line) this.onLine(line);
    }
    if (this.stdoutBuffer.length > 8 * 1024 * 1024) this.stdoutBuffer = "";
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // log solto do servidor no stdout: ignora
    }
    if (!isObject(message)) return;
    const msg = message as JsonRpcMessage;
    if (typeof msg.method === "string") {
      // Pedido do servidor para nós: só respondemos ping e roots/list (sem raízes).
      if (msg.id === undefined || msg.id === null) return;
      if (msg.method === "ping") this.write({ jsonrpc: "2.0", id: msg.id, result: {} });
      else if (msg.method === "roots/list") this.write({ jsonrpc: "2.0", id: msg.id, result: { roots: [] } });
      else this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Método não suportado pelo gateway" } });
      return;
    }
    if (typeof msg.id !== "number") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    pending.resolve(msg);
  }

  private write(message: unknown): void {
    if (!this.child) throw new ConnectorError("o processo do conector não está rodando");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async request(method: string, params?: Record<string, unknown>, timeoutMs = this.options.timeoutMs ?? 30_000): Promise<unknown> {
    clearTimeout(this.idleTimer);
    const id = this.nextId++;
    const message = await new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ConnectorError(`sem resposta em ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error as Error);
      }
    });
    if (message.error) throw rpcError(message);
    return message.result;
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
