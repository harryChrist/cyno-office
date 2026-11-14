import type { EngineBlock } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { CONVERSATION_SEPARATOR, ConversationSession, type ConversationHooks } from "./conversation-session";
import type { TerminalAgent, TerminalEvent } from "./types";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

type Sent = { message: string; tag?: string; options?: { freshSession?: boolean; sessionKey?: string } };

function fakeTerminal(history = true) {
  const sent: Sent[] = [];
  let listener: ((event: TerminalEvent) => void) | undefined;
  const terminal = {
    agentId: "dono",
    send: (message: string, tag?: string, options?: Sent["options"]) => void sent.push({ message, ...(tag ? { tag } : {}), ...(options ? { options } : {}) }),
    onEvent: (fn: (event: TerminalEvent) => void) => {
      listener = fn;
      return () => undefined;
    },
    hasHistory: async () => history,
  } as unknown as TerminalAgent;
  return { terminal, sent, emit: (event: TerminalEvent) => listener?.(event) };
}

function setup(options: { block?: () => EngineBlock | undefined; rotateTokens?: number; primer?: boolean; history?: boolean; seed?: () => string } = {}) {
  const fake = fakeTerminal(options.history ?? true);
  const events: TerminalEvent[] = [];
  const log = { info: vi.fn(), error: vi.fn() };
  let stopped = false;
  const hooks: ConversationHooks = {
    label: "Teste",
    sessionKeyPrefix: "teste",
    log,
    isStopped: () => stopped,
    locate: () => ({ id: "dono", terminal: fake.terminal }),
    onTerminalEvent: (_id, _terminal, event) => void events.push(event),
    blocked: () => options.block?.(),
    rotateTokens: () => options.rotateTokens ?? 0,
    ...(options.primer ? { primer: async () => "CONTEXTO", framePrimer: (primer: string, message: string) => `(abertura) ${primer}${CONVERSATION_SEPARATOR}${message}` } : {}),
    seed: options.seed ?? (() => "RESUMO"),
    onHold: vi.fn(),
    onResume: vi.fn(() => true),
    onQueued: vi.fn(),
    onUnavailable: vi.fn(),
  };
  const session = new ConversationSession(hooks);
  return { session, fake, hooks, events, log, stop: () => (stopped = true) };
}

describe("ConversationSession", () => {
  it("manda as mensagens na ordem, com a etiqueta, e avisa o dono de cada uma na fila", async () => {
    const { session, fake, hooks } = setup();
    session.push("a", "primeira");
    session.push("b", () => "segunda");
    await flush();
    expect(fake.sent.map((item) => [item.tag, item.message])).toEqual([["a", "primeira"], ["b", "segunda"]]);
    expect(hooks.onQueued).toHaveBeenCalledTimes(2);
  });

  it("segura a mensagem sem cota e monta o texto só quando o motor volta, na ordem", async () => {
    let block: EngineBlock | undefined = { reason: "quota" };
    const { session, fake, hooks } = setup({ block: () => block });
    const build = vi.fn(() => "montada na hora");
    session.push("a", build);
    session.push("a", "de novo na mesma tag");
    expect(build).not.toHaveBeenCalled();
    expect(hooks.onHold).toHaveBeenNthCalledWith(1, "a", true, { reason: "quota" });
    expect(hooks.onHold).toHaveBeenNthCalledWith(2, "a", false, { reason: "quota" });
    session.flushHeld();
    expect(fake.sent).toHaveLength(0);
    block = undefined;
    session.flushHeld();
    await flush();
    expect(fake.sent.map((item) => item.message)).toEqual(["montada na hora", "de novo na mesma tag"]);
    expect(hooks.onResume).toHaveBeenCalledTimes(2);
  });

  it("onResume falso descarta a mensagem segura; dropHeld também", async () => {
    let block: EngineBlock | undefined = { reason: "quota" };
    const { session, fake, hooks } = setup({ block: () => block });
    (hooks.onResume as ReturnType<typeof vi.fn>).mockImplementation((tag: string) => tag !== "fechado");
    session.push("fechado", "x");
    session.push("tirado", "y");
    session.push("fica", "z");
    session.dropHeld("tirado");
    block = undefined;
    session.flushHeld();
    await flush();
    expect(fake.sent.map((item) => item.tag)).toEqual(["fica"]);
  });

  it("o contexto de abertura vai antes da 1ª mensagem de uma conversa nova, uma vez só", async () => {
    const { session, fake, log } = setup({ primer: true, history: false });
    session.push("a", "primeira");
    session.push("b", "segunda");
    await flush();
    await flush();
    expect(fake.sent[0]!.message).toBe(`(abertura) CONTEXTO${CONVERSATION_SEPARATOR}primeira`);
    expect(fake.sent[1]!.message).toBe("segunda");
    expect(log.info).toHaveBeenCalled();
  });

  it("sem `primer`, a mensagem vai direto, mesmo numa conversa nova", async () => {
    const { session, fake } = setup({ history: false });
    session.push("a", "oi");
    await flush();
    expect(fake.sent.map((item) => item.message)).toEqual(["oi"]);
  });

  it("os avisos do servidor vão no fim da próxima mensagem que sai", async () => {
    const { session, fake } = setup();
    session.addNotice("Algo mudou.");
    session.push("a", "oi");
    session.push("b", "de novo");
    await flush();
    expect(fake.sent.map((item) => item.message)).toEqual(["oi\n\n(Aviso do servidor: Algo mudou.)", "de novo"]);
  });

  it("nunca renova a conversa sozinha com rotateTokens 0, por maior que ela fique", async () => {
    const { session, fake } = setup({ rotateTokens: 0 });
    session.trackSize(10_000_000);
    expect(session.newConversationDue).toBe(false);
    session.push("a", "oi");
    await flush();
    expect(fake.sent[0]!.options).toBeUndefined();
    expect(session.rotations).toBe(0);
  });

  it("com rotateTokens ligado, a conversa grande abre outra com o resumo na frente", async () => {
    const { session, fake } = setup({ rotateTokens: 100 });
    session.trackSize(50);
    expect(session.newConversationDue).toBe(false);
    session.trackSize(500);
    expect(session.newConversationDue).toBe(true);
    session.push("a", "oi");
    await flush();
    expect(fake.sent[0]!.message).toBe(`RESUMO${CONVERSATION_SEPARATOR}oi`);
    expect(fake.sent[0]!.options?.freshSession).toBe(true);
    expect(fake.sent[0]!.options?.sessionKey).toMatch(/^teste-/);
    expect(session.rotations).toBe(1);
    expect(session.newConversationDue).toBe(false);
  });

  it("startNewConversation (o botão do dono) abre sessão nova sem resumo quando o seed é vazio", async () => {
    const { session, fake } = setup({ seed: () => "" });
    session.startNewConversation();
    expect(session.newConversationDue).toBe(true);
    session.push("a", "olá do zero");
    await flush();
    expect(fake.sent[0]!.message).toBe("olá do zero");
    expect(fake.sent[0]!.options?.freshSession).toBe(true);
    // Só a primeira mensagem abre a sessão nova; as seguintes continuam nela.
    session.push("b", "continua");
    await flush();
    expect(fake.sent[1]!.options).toBeUndefined();
  });

  it("se a conversa nova não abrir (dropped), a mensagem volta para a antiga, uma vez, e o evento é engolido", async () => {
    const { session, fake, events } = setup({ seed: () => "" });
    session.startNewConversation();
    session.push("a", "oi");
    await flush();
    expect(fake.sent).toHaveLength(1);
    fake.emit({ type: "dropped", tag: "a", reason: "parou" });
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]).toEqual({ message: "oi", tag: "a" });
    expect(events).toHaveLength(0);
    expect(session.newConversationDue).toBe(true);
  });

  it("o turn_start confirma a conversa nova e os eventos chegam ao dono", async () => {
    const { session, fake, events } = setup({ seed: () => "" });
    session.startNewConversation();
    session.push("a", "oi");
    await flush();
    fake.emit({ type: "turn_start", tag: "a" });
    fake.emit({ type: "dropped", tag: "a", reason: "depois de confirmar" });
    expect(events.map((event) => event.type)).toEqual(["turn_start", "dropped"]);
  });

  it("terminal indisponível: avisa o dono e não manda nada", async () => {
    const { session, hooks, fake } = setup();
    (hooks as { locate: ConversationHooks["locate"] }).locate = () => {
      throw new Error("sem terminal");
    };
    session.push("a", "oi");
    expect(hooks.onUnavailable).toHaveBeenCalledWith("a", expect.any(Error));
    expect(fake.sent).toHaveLength(0);
  });

  it("depois de desligada (stopped), nada mais sai", async () => {
    const { session, fake, stop } = setup();
    stop();
    session.push("a", "oi");
    await flush();
    expect(fake.sent).toHaveLength(0);
  });
});
