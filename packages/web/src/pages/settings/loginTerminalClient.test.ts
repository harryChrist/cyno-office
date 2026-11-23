import { describe, expect, it } from "vitest";
import type { SocketLike } from "../../agentWork/maestroTerminalClient";
import {
  INITIAL_LOGIN_TERMINAL_STATE,
  LoginSocket,
  appendUrlBuffer,
  buildPasteCodeMessage,
  clampLoginPtySize,
  extractLastHttpsUrl,
  loginExitMessage,
  loginHttpPath,
  loginPhaseBadge,
  loginSocketUrl,
  loginTerminalReducer,
  parseLoginServerMessage,
  probeLoginUpgradeError,
  serializeLoginClientMessage,
  stripAnsi,
} from "./loginTerminalClient";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

describe("loginTerminalClient: URLs, protocolo e extração de link", () => {
  it("monta caminho e URL WebSocket para conta padrão (?engine) e conta extra", () => {
    expect(loginHttpPath("padrao", "claude")).toBe("/api/engines/accounts/padrao/login?engine=claude");
    expect(loginHttpPath("padrao", "gemini")).toBe("/api/engines/accounts/padrao/login?engine=gemini");
    expect(loginHttpPath("trabalho", "claude")).toBe("/api/engines/accounts/trabalho/login");

    expect(loginSocketUrl({ protocol: "http:", host: "127.0.0.1:3067" }, "padrao", "gemini")).toBe(
      "ws://127.0.0.1:3067/api/engines/accounts/padrao/login?engine=gemini",
    );
    expect(loginSocketUrl({ protocol: "https:", host: "cyno.exemplo.com" }, "conta-1", "claude")).toBe(
      "wss://cyno.exemplo.com/api/engines/accounts/conta-1/login",
    );
  });

  it("extrai a última URL https do terminal mesmo com cores ANSI, pontuação e texto ao redor", () => {
    expect(extractLastHttpsUrl("")).toBeNull();
    expect(extractLastHttpsUrl("Sem link nenhum aqui, só http://insecure.local")).toBeNull();

    const first =
      "\u001b[36mVisit:\u001b[0m https://claude.ai/oauth/authorize?code_challenge=AAA_111.\r\nPaste code: ";
    expect(extractLastHttpsUrl(first)).toBe("https://claude.ai/oauth/authorize?code_challenge=AAA_111");

    const multiple = [
      "Docs: (https://docs.anthropic.com/login).",
      "Now open: \u001b[1;34mhttps://accounts.google.com/o/oauth2/auth?client_id=abc&scope=email\u001b[0m!",
    ].join("\n");
    expect(extractLastHttpsUrl(multiple)).toBe(
      "https://accounts.google.com/o/oauth2/auth?client_id=abc&scope=email",
    );
  });

  it("extrai URL dividida em múltiplos pacotes usando appendUrlBuffer e stripAnsi", () => {
    let buffer = "";
    buffer = appendUrlBuffer(buffer, "Open https://claude.ai/oauth/");
    buffer = appendUrlBuffer(buffer, "authorize?state=xyz&code_challenge=123\n");
    expect(extractLastHttpsUrl(buffer)).toBe("https://claude.ai/oauth/authorize?state=xyz&code_challenge=123");
    expect(stripAnsi("\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007")).toContain("link");
    expect(appendUrlBuffer("abcdef", "ghij", 6)).toBe("efghij");
  });

  it("monta a mensagem do campo Colar código (limpa quebras, recusa vazio e adiciona Enter)", () => {
    expect(buildPasteCodeMessage("")).toBeNull();
    expect(buildPasteCodeMessage("   \n\r  ")).toBeNull();
    expect(buildPasteCodeMessage("  ABC-123-XYZ \n")).toEqual({ type: "in", data: "ABC-123-XYZ\r" });
    expect(buildPasteCodeMessage("PARTE1\r\nPARTE2")).toEqual({ type: "in", data: "PARTE1PARTE2\r" });
    expect(buildPasteCodeMessage("x".repeat(64_001))).toBeNull();
  });

  it("valida e serializa mensagens do protocolo engine-login.ts", () => {
    expect(parseLoginServerMessage(JSON.stringify({ type: "hello", engine: "claude", label: "Trabalho" }))).toEqual({
      type: "hello",
      engine: "claude",
      label: "Trabalho",
    });
    expect(parseLoginServerMessage(JSON.stringify({ type: "login", loggedIn: true }))).toEqual({
      type: "login",
      loggedIn: true,
    });
    expect(parseLoginServerMessage(JSON.stringify({ type: "exit", code: 0 }))).toEqual({
      type: "exit",
      code: 0,
    });
    expect(parseLoginServerMessage(JSON.stringify({ type: "hello", engine: "freebuff", label: "X" }))).toBeNull();
    expect(parseLoginServerMessage("{invalido")).toBeNull();

    expect(clampLoginPtySize(5, 999)).toEqual({ cols: 20, rows: 200 });
    expect(serializeLoginClientMessage({ type: "resize", cols: 100, rows: 30 })).toBe(
      JSON.stringify({ type: "resize", cols: 100, rows: 30 }),
    );
    expect(serializeLoginClientMessage({ type: "resize", cols: 2, rows: 30 })).toBeNull();
  });
});

describe("loginTerminalClient: reducer, sonda de erro no upgrade e LoginSocket", () => {
  it("reducer percorre conectando -> aberto -> URL -> login concluído / saída / erro", () => {
    let state = loginTerminalReducer(INITIAL_LOGIN_TERMINAL_STATE, { type: "open" });
    expect(state.phase).toBe("open");

    state = loginTerminalReducer(state, { type: "hello", label: "Trabalho" });
    expect(state.serverLabel).toBe("Trabalho");

    state = loginTerminalReducer(state, { type: "url", url: "https://claude.ai/oauth/authorize?x=1" });
    expect(state.lastUrl).toBe("https://claude.ai/oauth/authorize?x=1");

    const exited = loginTerminalReducer(state, { type: "exit", code: 1 });
    expect(exited.phase).toBe("exited");
    expect(exited.exitCode).toBe(1);
    expect(loginExitMessage(1)).toBe("O processo de login terminou (código 1).");
    expect(loginExitMessage(null)).toBe("O processo de login foi encerrado.");

    const logged = loginTerminalReducer(state, { type: "logged_in" });
    expect(logged.phase).toBe("logged_in");
    // Depois de login concluído, exit ou erro tardio não sobrescrevem o sucesso.
    expect(loginTerminalReducer(logged, { type: "exit", code: 0 }).phase).toBe("logged_in");
    expect(loginPhaseBadge("logged_in")).toEqual({ label: "Conectada", tone: "success" });
    expect(loginPhaseBadge("error")).toEqual({ label: "Indisponível", tone: "danger" });
  });

  it("probeLoginUpgradeError lê a mensagem pt-BR do servidor para 403/404/409 e marca expiração no 401", async () => {
    const fakeFetch =
      (status: number, body: string): typeof fetch =>
      async () =>
        ({
          status,
          text: async () => body,
        }) as unknown as Response;

    const r403 = await probeLoginUpgradeError(
      "/api/engines/accounts/padrao/login?engine=claude",
      fakeFetch(403, JSON.stringify({ error: "O login pelo navegador exige senha de acesso configurada." })),
    );
    expect(r403).toEqual({
      status: 403,
      message: "O login pelo navegador exige senha de acesso configurada.",
    });

    const r409 = await probeLoginUpgradeError(
      "/api/engines/accounts/trabalho/login",
      fakeFetch(409, JSON.stringify({ error: "Já há uma sessão de login aberta para Claude Code / Padrão." })),
    );
    expect(r409).toEqual({
      status: 409,
      message: "Já há uma sessão de login aberta para Claude Code / Padrão.",
    });

    const r404 = await probeLoginUpgradeError("/api/engines/accounts/sumiu/login", fakeFetch(404, ""));
    expect(r404.status).toBe(404);
    expect(r404.message).toMatch(/não foi encontrada/i);

    const r401 = await probeLoginUpgradeError("/api/engines/accounts/trabalho/login", fakeFetch(401, ""));
    expect(r401.expired).toBe(true);
  });

  it("LoginSocket diferencia falha no handshake (antes de abrir) de queda após aberto e fecha limpo", () => {
    let created!: FakeSocket;
    let handshakeFailures = 0;
    let unexpectedCloses = 0;
    const received: unknown[] = [];

    const conn1 = new LoginSocket({
      url: "ws://localhost/api/engines/accounts/trabalho/login",
      createSocket: (url) => {
        created = new FakeSocket(url);
        return created;
      },
      onOpen: () => undefined,
      onMessage: (m) => received.push(m),
      onHandshakeFailure: () => {
        handshakeFailures += 1;
      },
      onUnexpectedClose: () => {
        unexpectedCloses += 1;
      },
    });
    expect(conn1.send({ type: "in", data: "oi" })).toBe(false);
    created.drop(1006);
    expect(handshakeFailures).toBe(1);
    expect(unexpectedCloses).toBe(0);

    const conn2 = new LoginSocket({
      url: "ws://localhost/api/engines/accounts/trabalho/login",
      createSocket: (url) => {
        created = new FakeSocket(url);
        return created;
      },
      onOpen: () => undefined,
      onMessage: (m) => received.push(m),
      onHandshakeFailure: () => {
        handshakeFailures += 1;
      },
      onUnexpectedClose: () => {
        unexpectedCloses += 1;
      },
    });
    created.open();
    expect(conn2.send({ type: "in", data: "codigo\r" })).toBe(true);
    expect(JSON.parse(created.sent[0]!)).toEqual({ type: "in", data: "codigo\r" });
    created.receive({ type: "out", data: "ok" });
    expect(received).toEqual([{ type: "out", data: "ok" }]);
    conn2.close();
    expect(created.closed).toBe(true);
    expect(unexpectedCloses).toBe(0);
  });
});
