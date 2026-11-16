import { describe, expect, it } from "vitest";
import { clipboardKey, parseTerminalMessage, TerminalSocket, terminalSocketUrl, terminalStatusLabel, type SocketLike, type TerminalConnection } from "./maestroTerminalClient";
import { remoteControlView, remoteSessionView } from "./remoteControl";

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
  receive(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const states: TerminalConnection[] = [];
  const messages: unknown[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let opened = 0;
  const socket = new TerminalSocket({
    url: "ws://x/api/w/principal/maestro/terminal",
    createSocket: (url) => {
      const fake = new FakeSocket(url);
      sockets.push(fake);
      return fake;
    },
    onConnection: (state) => states.push(state),
    onMessage: (message) => messages.push(message),
    onOpen: () => opened++,
    delay: (attempt) => 100 * (attempt + 1),
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => undefined,
  });
  return { socket, sockets, states, messages, timers, opened: () => opened };
}

describe("TerminalSocket", () => {
  it("abre, repassa as mensagens válidas, manda só com o socket aberto e reconecta com espera crescente", () => {
    const h = harness();
    expect(h.socket.send({ t: "in", d: "x" })).toBe(false);
    h.sockets[0]!.open();
    expect(h.opened()).toBe(1);
    expect(h.socket.send({ t: "resize", cols: 100, rows: 30 })).toBe(true);
    expect(JSON.parse(h.sockets[0]!.sent[0]!)).toEqual({ t: "resize", cols: 100, rows: 30 });
    h.sockets[0]!.receive({ t: "out", d: "oi" });
    h.sockets[0]!.receive({ t: "desconhecida" });
    h.sockets[0]!.onmessage?.({ data: "{quebrado" });
    expect(h.messages).toEqual([{ t: "out", d: "oi" }]);
    h.sockets[0]!.drop();
    expect(h.timers.map((timer) => timer.ms)).toEqual([100]);
    h.timers[0]!.fn();
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.drop();
    expect(h.timers.map((timer) => timer.ms)).toEqual([100, 200]);
    expect(h.states).toEqual(["connecting", "open", "reconnecting", "reconnecting", "reconnecting"]);
  });

  it("4409 (o Maestro não tem terminal): para de tentar; close fecha sem reconectar", () => {
    const h = harness();
    h.sockets[0]!.drop(4409);
    expect(h.states.at(-1)).toBe("unavailable");
    expect(h.timers).toHaveLength(0);
    const other = harness();
    other.sockets[0]!.open();
    other.socket.close();
    expect(other.sockets[0]!.closed).toBe(true);
    expect(other.timers).toHaveLength(0);
  });
});

describe("mensagens e ajudas do terminal", () => {
  it("parseTerminalMessage aceita só o formato conhecido", () => {
    expect(parseTerminalMessage(JSON.stringify({ t: "hello", status: "idle", cols: 120, rows: 36, remote: { active: true, name: "Maestro · X", url: "https://claude.ai/code/session_1" } }))).toEqual({
      t: "hello",
      status: "idle",
      cols: 120,
      rows: 36,
      remote: { active: true, name: "Maestro · X", url: "https://claude.ai/code/session_1" },
    });
    expect(parseTerminalMessage(JSON.stringify({ t: "remote", remote: { active: false, url: "javascript:alert(1)" } }))).toEqual({ t: "remote", remote: { active: false } });
    expect(parseTerminalMessage(JSON.stringify({ t: "status", status: "voando" }))).toBeNull();
    expect(parseTerminalMessage(JSON.stringify({ t: "exit" }))).toEqual({ t: "exit", code: null });
    expect(parseTerminalMessage("nada")).toBeNull();
  });

  it("URL do WebSocket segue o protocolo da página", () => {
    expect(terminalSocketUrl({ protocol: "http:", host: "192.168.1.20:3067" }, "principal")).toBe("ws://192.168.1.20:3067/api/w/principal/maestro/terminal");
    expect(terminalSocketUrl({ protocol: "https:", host: "dev.x" }, "a b")).toBe("wss://dev.x/api/w/a%20b/maestro/terminal");
  });

  it("Ctrl+C copia só com seleção (sem seleção vai para a CLI); Ctrl+Shift+C sempre copia; Ctrl+V cola", () => {
    const key = (k: string, extra: Partial<KeyboardEvent> = {}) => ({ type: "keydown", key: k, ctrlKey: true, metaKey: false, shiftKey: false, ...extra });
    expect(clipboardKey(key("c"), true)).toBe("copy");
    expect(clipboardKey(key("c"), false)).toBeNull();
    expect(clipboardKey(key("C", { shiftKey: true }), false)).toBe("copy");
    expect(clipboardKey(key("v"), false)).toBe("paste");
    expect(clipboardKey(key("v", { type: "keyup" }), false)).toBeNull();
    expect(clipboardKey(key("c", { ctrlKey: false }), true)).toBeNull();
  });

  it("rótulo do estado considera a conexão primeiro", () => {
    expect(terminalStatusLabel("idle", "open")).toEqual({ label: "Pronto", tone: "success" });
    expect(terminalStatusLabel("busy", "open").label).toBe("Trabalhando");
    expect(terminalStatusLabel("idle", "reconnecting").label).toBe("Reconectando…");
    expect(terminalStatusLabel(undefined, "unavailable").label).toBe("Sem terminal");
  });

  it("selo do Remote Control: ativo com nome e link; conectando; fora; nada sem terminal interativo", () => {
    const base = { agentId: "maestro", engine: "claude" as const, mode: "pty" as const, updatedAt: "2026-11-08T00:00:00Z" };
    expect(remoteControlView({ ...base, status: "idle", remote: { active: true, name: "Maestro · P", url: "https://claude.ai/code/session_1" } })).toMatchObject({
      state: "active",
      label: "Remote Control: ativo",
      name: "Maestro · P",
      href: "https://claude.ai/code/session_1",
    });
    expect(remoteControlView({ ...base, status: "starting", remote: { active: false, name: "Maestro · P" } })).toMatchObject({ state: "waiting", label: "Remote Control: conectando…", href: "https://claude.ai/code" });
    expect(remoteControlView({ ...base, status: "stopped", remote: { active: true, name: "M" } })?.state).toBe("waiting");
    expect(remoteControlView({ ...base, status: "idle" })?.state).toBe("off");
    expect(remoteControlView({ agentId: "maestro", engine: "claude", status: "idle", updatedAt: "x" })).toBeNull();
    expect(remoteControlView(undefined)).toBeNull();
  });

  it("nome da sessão do Remote Control: o da sessão viva, senão o configurado; pendente enquanto o Maestro está ocupado", () => {
    const base = { agentId: "maestro", engine: "claude" as const, mode: "pty" as const, updatedAt: "2026-11-08T00:00:00Z" };
    const ws = { name: "Principal", maestro: { sessionName: "Meu Maestro" } };
    expect(remoteSessionView({ ...base, status: "idle", remote: { active: true, name: "Meu Maestro", url: "https://claude.ai/code/session_1" } }, ws)).toEqual({
      state: "active",
      stateLabel: "ligado",
      name: "Meu Maestro",
      href: "https://claude.ai/code/session_1",
      hint: expect.stringContaining("Meu Maestro") as unknown as string,
    });
    expect(remoteSessionView({ ...base, status: "busy", remote: { active: true, name: "Velho", pendingName: "Meu Maestro" } }, ws)).toMatchObject({ name: "Velho", pending: "Meu Maestro" });
    expect(remoteSessionView({ ...base, status: "idle" }, { name: "Loja" })).toMatchObject({ state: "off", stateLabel: "desligado", name: "Maestro · Loja" });
    expect(remoteSessionView({ ...base, status: "starting", remote: { active: false, name: "X" } }, ws)?.stateLabel).toBe("conectando…");
    expect(remoteSessionView(undefined, ws)).toBeNull();
  });
});
