import { randomInt, timingSafeEqual } from "node:crypto";
import {
  AUTH_2FA_DISABLE_PATH,
  AUTH_2FA_ENABLE_PATH,
  AUTH_2FA_SETUP_PATH,
  AUTH_COOKIE,
  AUTH_LOGIN_2FA_PATH,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_ALL_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_PASSWORD_PATH,
  AUTH_SECURITY_PATH,
  AUTH_SETUP_PATH,
  AUTH_STATUS_PATH,
  AUTH_UNBLOCK_PATH,
  changePasswordBodySchema,
  login2faBodySchema,
  loginBodySchema,
  OFFICE_MCP_PATH,
  setupBodySchema,
  twoFactorCodeBodySchema,
  twoFactorDisableBodySchema,
  unblockBodySchema,
  type AuthStatus,
  type LoginResult,
  type SecurityState,
  type TwoFactorEnabled,
  type TwoFactorSetup,
} from "@cyno/shared";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { resolveClientIp } from "./client-ip";
import { IpGuard } from "./ip-guard";
import { SESSION_TTL_MS, type AuthStore } from "./store";

/** Arquivo (0600) com o código de configuração atual, para `npm run auth:code` mostrar sem caçar no log. */
export const SETUP_CODE_FILE = "auth-setup-code.txt";

/** Caminhos que o portão nunca barra: o estado/login/configuração inicial, a saúde e o MCP (que tem o token próprio de cada agente). */
export function isAuthExempt(method: string, pathname: string): boolean {
  if (pathname === AUTH_STATUS_PATH && method === "GET") return true;
  if (pathname === AUTH_LOGIN_PATH && method === "POST") return true;
  if (pathname === AUTH_LOGIN_2FA_PATH && method === "POST") return true;
  if (pathname === AUTH_SETUP_PATH && method === "POST") return true;
  if (pathname === "/api/health" && (method === "GET" || method === "HEAD")) return true;
  // O MCP continua só com o token do agente (e só de 127.0.0.1): veja mcp/route.ts.
  return pathname === OFFICE_MCP_PATH;
}

function pathnameOf(url: string): string {
  const raw = url.split("?")[0] ?? "";
  // Barras repetidas ou o caminho em outra caixa não podem escapar da comparação exata.
  return raw.replace(/\/{2,}/g, "/");
}

function cookieValue(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

const firstHop = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim() || undefined;

/** O IP real do cliente (só confia em proxies de loopback: veja client-ip.ts). */
export function clientIp(request: FastifyRequest): string {
  return resolveClientIp({ socket: request.socket.remoteAddress, xForwardedFor: request.headers["x-forwarded-for"], cfConnectingIp: request.headers["cf-connecting-ip"] });
}

/** Alfabeto do código de configuração: sem 0/O, 1/I/L (ambíguos). */
const SETUP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function generateSetupCode(): string {
  const group = () => Array.from({ length: 4 }, () => SETUP_ALPHABET[randomInt(SETUP_ALPHABET.length)]).join("");
  return `${group()}-${group()}-${group()}`;
}
const normalizeSetupCode = (input: string) => input.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** A requisição chegou por https? (o túnel e o proxy do Vite ficam na frente.) */
export function viaHttps(request: FastifyRequest): boolean {
  const proto = firstHop(request.headers["x-forwarded-proto"]);
  if (proto) return proto.toLowerCase() === "https";
  const visitor = request.headers["cf-visitor"];
  if (typeof visitor === "string") {
    try {
      return (JSON.parse(visitor) as { scheme?: string }).scheme === "https";
    } catch {
      return /"scheme"\s*:\s*"https"/.test(visitor);
    }
  }
  return false;
}

function setSessionCookie(request: FastifyRequest, reply: FastifyReply, token: string): void {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  reply.header("set-cookie", `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${viaHttps(request) ? "; Secure" : ""}`);
}

function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  reply.header("set-cookie", `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${viaHttps(request) ? "; Secure" : ""}`);
}

export type AuthOptions = {
  /** Pausa depois de cada senha errada (freia força bruta); os testes passam 0. */
  failDelayMs?: number;
  /** Relógio em ms (bloqueios); os testes injetam. */
  now?: () => number;
  /**
   * `CYNO_AUTH=off` (só desenvolvimento e testes): sem senha, o app fica aberto como antes. Padrão (false):
   * sem senha o app fica FECHADO até a configuração inicial (código escrito no log do server).
   */
  open?: boolean;
  /** Onde persistir os bloqueios (padrão: <dataDir>/auth-blocks.json; null = só em memória). */
  blocksFile?: string | null;
  /** Mostra o código de configuração de forma bem visível (o index.ts escreve um quadro no terminal). */
  announce?: (lines: string[]) => void;
};

/**
 * Senha única de acesso. Com `DATA_DIR/auth.json` presente, um hook onRequest barra TUDO (rotas
 * HTTP e o upgrade dos WebSockets) sem sessão válida, menos as exceções de `isAuthExempt`.
 * SEM senha o app também fica fechado (só status, configuração inicial e health respondem), até alguém
 * criar a senha com o código que o server escreve no log; `open: true` (CYNO_AUTH=off) mantém o app aberto.
 */
export function registerAuth(app: FastifyInstance, auth: AuthStore, dataDir: string, options: AuthOptions = {}): void {
  const now = options.now ?? Date.now;
  const guard = new IpGuard(
    options.blocksFile === undefined ? path.join(dataDir, "auth-blocks.json") : options.blocksFile,
    now,
    (level, data, message) => app.log[level](data, message),
  );
  const failDelayMs = options.failDelayMs ?? 400;
  const open = options.open ?? false;

  let setupCode: string | null = null;
  let setupDone = false;
  const setupCodeFile = path.join(dataDir, SETUP_CODE_FILE);
  const forgetSetupCodeFile = () => rm(setupCodeFile, { force: true }).catch(() => undefined);
  /** Gera (uma vez por subida sem senha) o código de configuração e o escreve no log. */
  const ensureSetupCode = async (): Promise<void> => {
    if (open || setupCode || setupDone) return;
    if (await auth.enabled()) {
      await forgetSetupCodeFile();
      return;
    }
    setupCode = generateSetupCode();
    // Melhor esforço: sem o arquivo, o código continua no log.
    await writeFile(setupCodeFile, `${setupCode}\n`, { mode: 0o600 }).catch(() => undefined);
    app.log.warn({ codigoDeConfiguracao: setupCode }, `Abra o Cyno e use o código ${setupCode} para criar a senha`);
    options.announce?.([
      "",
      "══════════════════════════════════════════════════════════════",
      "  CYNO: falta criar a senha de acesso",
      "",
      `  Abra o Cyno e use o código  ${setupCode}  para criar a senha.`,
      "",
      "  Para ver o código de novo:  npm run auth:code",
      "  (Alternativa no terminal: npm run auth:set-password -w @cyno/server)",
      "══════════════════════════════════════════════════════════════",
      "",
    ]);
  };
  app.addHook("onReady", async () => {
    await ensureSetupCode();
  });
  app.addHook("onClose", async () => {
    await guard.flush();
  });

  const authenticated = async (request: FastifyRequest) => auth.validate(cookieValue(request, AUTH_COOKIE));

  app.addHook("onRequest", async (request, reply) => {
    if (isAuthExempt(request.method, pathnameOf(request.url))) return;
    if (!(await auth.enabled())) {
      if (open) return;
      return reply.code(401).send({ error: "Configuração inicial pendente: crie a senha" });
    }
    if (await authenticated(request)) return;
    return reply.code(401).send({ error: "Sessão ausente ou expirada" });
  });

  const tooMany = (reply: FastifyReply, seconds: number) =>
    reply.code(429).header("retry-after", String(seconds)).send({ error: "Muitas tentativas, espere alguns minutos", retryAfterSeconds: seconds });

  /** 429 se o IP está bloqueado (antes de olhar a senha/código: um IP bloqueado não ganha nem sinal de acerto). */
  const blockedReply = (ip: string, reply: FastifyReply) => {
    const wait = guard.retryAfterSeconds(ip);
    return wait > 0 ? tooMany(reply, wait) : null;
  };

  /** Registra a falha, espera um pouco e responde: 429 se esta falha bloqueou o IP, senão `status`/`error`. */
  const failed = async (ip: string, kind: "senha" | "codigo" | "configuracao", reply: FastifyReply, status: number, error: string) => {
    const blocked = guard.fail(ip, kind);
    if (failDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, failDelayMs));
    return blocked > 0 ? tooMany(reply, blocked) : reply.code(status).send({ error });
  };

  const startSession = async (request: FastifyRequest, reply: FastifyReply): Promise<LoginResult> => {
    setSessionCookie(request, reply, await auth.createSession(request.headers["user-agent"]));
    return { enabled: true, authenticated: true };
  };

  app.get(AUTH_STATUS_PATH, async (request, reply): Promise<AuthStatus> => {
    reply.header("cache-control", "no-store");
    const enabled = await auth.enabled();
    if (!enabled && !open) {
      await ensureSetupCode();
      return { enabled: false, authenticated: false, setupRequired: true };
    }
    return { enabled, authenticated: enabled ? await authenticated(request) : true };
  });

  // Configuração inicial: o código do log + a senha nova criam o auth.json e já abrem a sessão.
  app.post(AUTH_SETUP_PATH, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const body = setupBodySchema.parse(request.body ?? {});
    if (open) return reply.code(409).send({ error: "Configuração inicial desligada (CYNO_AUTH=off)" });
    if (setupDone || (await auth.enabled())) return reply.code(409).send({ error: "A senha já foi criada" });
    const ip = clientIp(request);
    const blocked = blockedReply(ip, reply);
    if (blocked) return blocked;
    await ensureSetupCode();
    // Outra requisição acabou de usar o código enquanto esta esperava.
    if (setupDone) return reply.code(409).send({ error: "A senha já foi criada" });
    const expected = Buffer.from(setupCode ?? "");
    const given = Buffer.from(normalizeSetupCode(body.code).replace(/(.{4})(?=.)/g, "$1-"));
    if (!setupCode || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return failed(ip, "configuracao", reply, 403, "Código de configuração incorreto");
    }
    // O código vale uma vez: invalida antes de qualquer espera, para duas requisições juntas não criarem duas senhas.
    setupCode = null;
    setupDone = true;
    await forgetSetupCodeFile();
    await auth.setPassword(body.password);
    guard.success(ip);
    app.log.warn({ ip }, "senha de acesso criada pela configuração inicial");
    return startSession(request, reply);
  });

  app.post(AUTH_LOGIN_PATH, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const body = loginBodySchema.parse(request.body ?? {});
    if (!(await auth.enabled())) return reply.code(409).send({ error: "Nenhuma senha definida" });
    const ip = clientIp(request);
    const blocked = blockedReply(ip, reply);
    if (blocked) return blocked;
    if (!(await auth.checkPassword(body.password))) return failed(ip, "senha", reply, 401, "Senha incorreta");
    if (await auth.twoFactorEnabled()) {
      // Só a senha não zera as falhas: quem sabe a senha ainda precisa acertar o código (que também conta no bloqueio).
      return { enabled: true, authenticated: false, twoFactorToken: auth.issueTwoFactorToken(ip) } satisfies LoginResult;
    }
    guard.success(ip);
    return startSession(request, reply);
  });

  app.post(AUTH_LOGIN_2FA_PATH, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const body = login2faBodySchema.parse(request.body ?? {});
    if (!(await auth.enabled())) return reply.code(409).send({ error: "Nenhuma senha definida" });
    const ip = clientIp(request);
    const blocked = blockedReply(ip, reply);
    if (blocked) return blocked;
    if (!auth.checkTwoFactorToken(body.token, ip)) return reply.code(401).send({ error: "Etapa expirada: digite a senha de novo" });
    const how = await auth.verifySecondFactor(body.code);
    if (!how) {
      auth.twoFactorTokenFailed(body.token);
      return failed(ip, "codigo", reply, 401, "Código incorreto");
    }
    auth.consumeTwoFactorToken(body.token);
    guard.success(ip);
    if (how === "recovery") app.log.warn({ ip, restantes: await auth.recoveryRemaining() }, "código de recuperação do 2FA usado");
    return startSession(request, reply);
  });

  app.post(AUTH_LOGOUT_PATH, async (request, reply) => {
    await auth.revoke(cookieValue(request, AUTH_COOKIE));
    clearSessionCookie(request, reply);
    return reply.code(204).send();
  });

  app.post(AUTH_LOGOUT_ALL_PATH, async (request, reply) => {
    await auth.clearSessions();
    clearSessionCookie(request, reply);
    return reply.code(204).send();
  });

  app.post(AUTH_PASSWORD_PATH, async (request, reply) => {
    const body = changePasswordBodySchema.parse(request.body ?? {});
    if (!(await auth.enabled())) return reply.code(409).send({ error: "Nenhuma senha definida: use o comando do servidor" });
    // A senha atual conta como tentativa: sem isso, uma sessão roubada serviria para adivinhá-la.
    const ip = clientIp(request);
    const blocked = blockedReply(ip, reply);
    if (blocked) return blocked;
    if (!(await auth.checkPassword(body.current))) return failed(ip, "senha", reply, 403, "Senha atual incorreta");
    await auth.setPassword(body.next);
    // A sessão de quem trocou continua: as outras caem.
    setSessionCookie(request, reply, await auth.createSession(request.headers["user-agent"]));
    return reply.code(204).send();
  });

  // ---- Segurança (todas atrás da sessão) ----

  app.get(AUTH_SECURITY_PATH, async (request, reply): Promise<SecurityState> => {
    reply.header("cache-control", "no-store");
    return {
      twoFactor: await auth.twoFactorEnabled(),
      recoveryRemaining: await auth.recoveryRemaining(),
      blocks: guard.blocks().map((block) => ({ ip: block.ip, until: new Date(block.until).toISOString(), attempts: block.attempts })),
      failures: guard.failures(30).map((failure) => ({ ip: failure.ip, at: new Date(failure.at).toISOString(), kind: failure.kind })),
      yourIp: clientIp(request),
    };
  });

  app.post(AUTH_UNBLOCK_PATH, async (request, reply) => {
    const body = unblockBodySchema.parse(request.body ?? {});
    if (!guard.unblock(body.ip)) return reply.code(404).send({ error: "Esse IP não está bloqueado" });
    return reply.code(204).send();
  });

  app.post(AUTH_2FA_SETUP_PATH, async (_request, reply): Promise<TwoFactorSetup | void> => {
    reply.header("cache-control", "no-store");
    if (await auth.twoFactorEnabled()) return reply.code(409).send({ error: "A verificação em duas etapas já está ligada" });
    return auth.beginTotpSetup();
  });

  app.post(AUTH_2FA_ENABLE_PATH, async (request, reply): Promise<TwoFactorEnabled | void> => {
    reply.header("cache-control", "no-store");
    const body = twoFactorCodeBodySchema.parse(request.body ?? {});
    if (await auth.twoFactorEnabled()) return reply.code(409).send({ error: "A verificação em duas etapas já está ligada" });
    const recoveryCodes = await auth.confirmTotpSetup(body.code);
    if (!recoveryCodes) return reply.code(400).send({ error: "Código incorreto ou expirado: gere o QR de novo" });
    app.log.warn({ ip: clientIp(request) }, "verificação em duas etapas ligada");
    return { recoveryCodes };
  });

  app.post(AUTH_2FA_DISABLE_PATH, async (request, reply) => {
    const body = twoFactorDisableBodySchema.parse(request.body ?? {});
    if (!(await auth.twoFactorEnabled())) return reply.code(409).send({ error: "A verificação em duas etapas não está ligada" });
    const ip = clientIp(request);
    const blocked = blockedReply(ip, reply);
    if (blocked) return blocked;
    // Senha E código: uma sessão roubada não desliga o 2FA. Erros contam no bloqueio (403: um 401 mandaria para o login).
    if (!(await auth.checkPassword(body.password))) return failed(ip, "senha", reply, 403, "Senha incorreta");
    if (!(await auth.verifySecondFactor(body.code))) return failed(ip, "codigo", reply, 403, "Código incorreto");
    await auth.disableTotp();
    app.log.warn({ ip }, "verificação em duas etapas desligada");
    return reply.code(204).send();
  });
}
