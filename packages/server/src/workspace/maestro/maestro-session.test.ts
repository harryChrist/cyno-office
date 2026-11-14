import type { EngineBlock, OfficeState, Task } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import type { TerminalAgent, TerminalEvent } from "../../engines/terminals/types";
import { MAESTRO_SEED_HEADER, MAESTRO_SEED_SEPARATOR, MaestroSession } from "./maestro-session";

const AT = "2026-11-11T12:00:00.000Z";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

type Sent = { message: string; tag?: string; options?: { freshSession?: boolean; sessionKey?: string } };

/** Terminal falso: guarda o que foi enviado e deixa o teste emitir eventos. */
function fakeTerminal() {
  const sent: Sent[] = [];
  let listener: ((event: TerminalEvent) => void) | undefined;
  const terminal = {
    agentId: "maestro",
    send: (message: string, tag?: string, options?: Sent["options"]) => void sent.push({ message, ...(tag ? { tag } : {}), ...(options ? { options } : {}) }),
    onEvent: (fn: (event: TerminalEvent) => void) => {
      listener = fn;
      return () => undefined;
    },
    hasHistory: async () => true,
  } as unknown as TerminalAgent;
  return { terminal, sent, emit: (event: TerminalEvent) => listener?.(event) };
}

function setup(options: { block?: () => EngineBlock | undefined; brainFails?: boolean } = {}) {
  const fake = fakeTerminal();
  const request: Task = { id: "req1", roomId: "ger", teamId: "ger-time", agentId: "maestro", role: "request", prompt: "Pedido", status: "in_progress", createdAt: AT, updatedAt: AT };
  const state = { rooms: [{ id: "ger", kind: "maestro" }], teams: [{ id: "ger-time", roomId: "ger" }], agents: [{ id: "maestro", teamId: "ger-time" }], tasks: [request] } as unknown as OfficeState;
  const turnEvents: TerminalEvent[] = [];
  const core = {
    deps: {
      state: { read: () => state },
      terminals: { get: () => fake.terminal },
      availability: () => options.block?.(),
      brain: { buildContext: async () => { if (options.brainFails) throw new Error("sem cérebro"); return { text: "BRIEFING" }; } },
      log: { info: vi.fn(), error: vi.fn() },
      rotateTokens: 100,
    },
    turn: { queued: new Map<string, number>() },
    now: () => new Date(AT),
    isStopped: () => false,
    isOpen: () => true,
    owns: () => true,
    agentName: () => "Maestro",
    finish: vi.fn(),
    logEntry: vi.fn(),
    chatEntry: vi.fn(),
    setProgress: vi.fn(),
  };
  const session = new MaestroSession(core as never, (_id, _terminal, event) => void turnEvents.push(event));
  return { session, fake, core, turnEvents };
}

describe("MaestroSession: texto montado na hora de sair", () => {
  it("segura a mensagem (motor sem cota) e monta o texto só quando o motor volta, com o estado de então", async () => {
    let block: EngineBlock | undefined = { reason: "quota", provider: "claude" } as unknown as EngineBlock;
    const { session, fake } = setup({ block: () => block });
    let estado = "tarefa falhou";
    const build = vi.fn(() => `Pedido req1: ${estado}`);
    session.push("req1", build);
    await flush();
    expect(build).not.toHaveBeenCalled();
    expect(fake.sent).toHaveLength(0);
    // Enquanto esperava, o estado mudou.
    estado = "tarefa foi pulada";
    block = undefined;
    session.flushHeld();
    await flush();
    expect(build).toHaveBeenCalledTimes(1);
    expect(fake.sent.map((item) => item.message)).toEqual(["Pedido req1: tarefa foi pulada"]);
  });

  it("os avisos do servidor vão no fim da mensagem que de fato sai", async () => {
    const { session, fake } = setup();
    session.addNotice("O usuário descartou A-0001.");
    session.push("req1", () => "Olá");
    await flush();
    expect(fake.sent[0]!.message).toBe("Olá\n\n(Aviso do servidor: O usuário descartou A-0001.)");
  });
});

describe("MaestroSession: rotação de conversa (desligada por padrão) com fila durável", () => {
  it("a rotação está desligada por padrão: com rotateTokens 0 nunca marca a conversa para renovar", async () => {
    const { session, fake, core } = setup();
    core.deps.rotateTokens = 0;
    session.push("req1", "um");
    await flush();
    session.trackSize(999_999);
    session.push("req1", "dois");
    await flush();
    expect(fake.sent.every((item) => !item.options?.freshSession)).toBe(true);
  });

  it("acima do teto, a mensagem seguinte abre conversa nova com resumo e fica no outbox até o turno começar", async () => {
    const { session, fake } = setup();
    session.push("req1", "primeira");
    await flush();
    session.trackSize(5000);
    session.push("req1", "segunda");
    await flush();
    const fresh = fake.sent.at(-1)!;
    expect(fresh.options?.freshSession).toBe(true);
    expect(fresh.message.startsWith(MAESTRO_SEED_HEADER)).toBe(true);
    expect(fresh.message.endsWith(`${MAESTRO_SEED_SEPARATOR}segunda`)).toBe(true);
    expect(session.rotations).toBe(1);
    // O terminal confirma: sai do outbox (um `dropped` tardio já não reenvia nada).
    fake.emit({ type: "turn_start", tag: "req1" });
    const before = fake.sent.length;
    fake.emit({ type: "dropped", tag: "req1", reason: "tarde demais" });
    expect(fake.sent).toHaveLength(before);
  });

  it("se o terminal descarta a mensagem da conversa nova, ela volta para a conversa antiga (uma vez) e o pedido não falha", async () => {
    const { session, fake, turnEvents } = setup();
    session.push("req1", "primeira");
    await flush();
    session.trackSize(5000);
    session.push("req1", "segunda");
    await flush();
    const before = fake.sent.length;
    fake.emit({ type: "dropped", tag: "req1", reason: "terminal parou" });
    expect(fake.sent).toHaveLength(before + 1);
    expect(fake.sent.at(-1)).toEqual({ message: "segunda", tag: "req1" });
    expect(session.rotations).toBe(0);
    // O evento foi engolido: os turnos não falham o pedido por causa dele.
    expect(turnEvents.some((event) => event.type === "dropped")).toBe(false);
  });

  it("se o resumo da conversa nova não pode ser montado, a conversa e a mensagem antigas ficam como estão", async () => {
    const { session, fake, core } = setup();
    session.push("req1", "primeira");
    await flush();
    // O resumo (Cérebro) é montado dentro de seed(); se estourar, nada de sessão nova.
    vi.spyOn(session as unknown as { seed: () => string }, "seed").mockImplementation(() => {
      throw new Error("falhou o resumo");
    });
    session.trackSize(5000);
    session.push("req1", "segunda");
    await flush();
    expect(fake.sent.at(-1)).toEqual({ message: "segunda", tag: "req1" });
    expect(session.rotations).toBe(0);
    expect(core.deps.log.error).toHaveBeenCalled();
    // Tenta de novo na próxima mensagem.
    vi.restoreAllMocks();
    session.push("req1", "terceira");
    await flush();
    expect(fake.sent.at(-1)!.options?.freshSession).toBe(true);
  });
});
