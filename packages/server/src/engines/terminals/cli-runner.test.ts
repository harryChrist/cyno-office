import type { Agent, BrainContext, Room, Task, Team } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalDecision, RunHooks, RunInput } from "../runner/types";
import { CliAgentRunner, noteMessage } from "./cli-runner";
import type { SendOptions, TerminalAgent, TerminalEvent, TerminalListener } from "./types";

const TASK_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** Terminal falso com fila: o teste abre e fecha os turnos (turn_start tira a primeira mensagem da fila). */
class QueueTerminal implements Partial<TerminalAgent> {
  readonly queue: { text: string; tag?: string; options?: SendOptions }[] = [];
  readonly sent: string[] = [];
  private readonly listeners = new Set<TerminalListener>();
  send(text: string, tag?: string, options?: SendOptions) {
    this.queue.push({ text, tag, options });
    this.sent.push(text);
  }
  cancel(tag: string) {
    const removed = this.queue.filter((message) => message.tag === tag).map((message) => message.text);
    this.queue.splice(0, this.queue.length, ...this.queue.filter((message) => message.tag !== tag));
    return removed;
  }
  interrupt() {}
  onEvent(listener: TerminalListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Próximo turno: a primeira mensagem da fila vira o turno em curso. */
  startTurn() {
    const next = this.queue.shift();
    this.emit({ type: "turn_start", tag: next?.tag });
    return next;
  }
  endTurn(result = "") {
    this.emit({ type: "turn_end", tag: TASK_ID, ok: true, result } as TerminalEvent);
  }
  emit(event: TerminalEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

function setup(options: { decision?: ApprovalDecision; resumedDecision?: ApprovalDecision; neverDecides?: boolean } = {}) {
  const terminal = new QueueTerminal();
  const runner = new CliAgentRunner({ get: () => terminal as unknown as TerminalAgent }, 60_000);
  const logged: string[] = [];
  const hooks = {
    log: (body: { kind: string; text?: string }) => {
      if (body.kind === "text" && body.text) logged.push(body.text);
    },
    toolResult: () => {},
    onProgress: () => {},
    requestApproval: () => (options.neverDecides ? new Promise<ApprovalDecision>(() => {}) : Promise.resolve(options.decision ?? { approved: true, response: "1. Qual ângulo?\n   → Ângulo 2" })),
    subagent: () => ({ log: () => {}, toolResult: () => {}, finish: () => {} }),
  } as unknown as RunHooks;
  const input = {
    task: { id: TASK_ID, prompt: "Escrever 3 legendas" } as Task,
    agent: { id: "gabi", engine: "gemini" } as Agent,
    team: { id: "t1" } as Team,
    room: { id: "r1" } as Room,
    context: { text: "", sources: [] } as unknown as BrainContext,
    ...(options.resumedDecision ? { resumedDecision: options.resumedDecision } : {}),
    signal: new AbortController().signal,
  } satisfies RunInput;
  const outcome = runner.run(input, hooks);
  return { terminal, runner, logged, outcome };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CliAgentRunner: notas e mensagens na fila", () => {
  it("nota que já virou turno não é dada como perdida; a resposta que sobrou na fila é avisada e cancelada", async () => {
    const { terminal, runner, logged, outcome } = setup();
    terminal.startTurn(); // a tarefa
    expect(runner.note("gabi", "cite que segunda fecha")).toEqual({ taskId: TASK_ID, live: false });
    runner.requestInformation("gabi", "Ângulo", [{ id: "q1", text: "Qual ângulo?" }]);
    await flush(); // a resposta chega e entra na fila, depois da nota
    terminal.endTurn("Perguntei ao usuário.");
    expect(terminal.startTurn()?.text).toBe(noteMessage("cite que segunda fecha"));
    runner.deliver("gabi", "3 legendas");
    terminal.endTurn("Entreguei.");
    await expect(outcome).resolves.toEqual({ status: "done", result: "3 legendas" });
    expect(terminal.queue).toEqual([]); // a resposta que sobrou não roda solta
    expect(logged.some((text) => text.includes("A nota do usuário chegou depois"))).toBe(false);
    expect(logged.some((text) => text.includes("ficou na fila depois do fim do trabalho"))).toBe(true);
  });

  it("nota que ficou na fila quando a tarefa acabou é avisada como não enviada", async () => {
    const { terminal, runner, logged, outcome } = setup();
    terminal.startTurn();
    runner.note("gabi", "troque o título");
    runner.deliver("gabi", "pronto");
    terminal.endTurn("Entreguei.");
    await expect(outcome).resolves.toMatchObject({ status: "done" });
    expect(terminal.queue).toEqual([]);
    expect(logged.filter((text) => text.includes("A nota do usuário chegou depois"))).toHaveLength(1);
    expect(logged.some((text) => text.includes("ficou na fila depois do fim do trabalho"))).toBe(false);
  });

  it("com onLateNotes, a nota que ficou na fila vai para ele (vira conversa) depois do fim da tarefa", async () => {
    const { terminal, runner, logged, outcome } = setup();
    const late: [string, string, string[]][] = [];
    runner.onLateNotes = (agentId, taskId, notes) => late.push([agentId, taskId, notes]);
    terminal.startTurn();
    runner.note("gabi", "  troque o título  ");
    runner.deliver("gabi", "pronto");
    terminal.endTurn("Entreguei.");
    await expect(outcome).resolves.toMatchObject({ status: "done" });
    expect(late).toEqual([]); // só depois do fim (fora da tarefa)
    await flush();
    expect(late).toEqual([["gabi", TASK_ID, ["troque o título"]]]);
    expect(logged.filter((text) => text.includes("vai para o agente como conversa"))).toHaveLength(1);
  });
});

describe("CliAgentRunner: tarefa que recomeça já decidida", () => {
  it("manda a decisão do usuário junto com a tarefa (o agente não precisa perguntar de novo)", () => {
    const { terminal } = setup({ resumedDecision: { approved: true, response: "1. Qual ângulo?\n   → Ângulo 2: Café de pausa" } });
    expect(terminal.sent).toHaveLength(1);
    expect(terminal.sent[0]).toContain("Tarefa " + TASK_ID);
    expect(terminal.sent[0]).toContain("Já decidido pelo usuário");
    expect(terminal.sent[0]).toContain("Ângulo 2: Café de pausa");
    expect(terminal.sent[0]).toContain("NÃO pergunte de novo");
  });

  it("sem decisão anterior, a primeira mensagem é só a tarefa", () => {
    const { terminal } = setup();
    expect(terminal.sent[0]).not.toContain("Já decidido pelo usuário");
  });
});

describe("CliAgentRunner: aprovação de uma ação do navegador", () => {
  it("aprovada: o gancho libera a ação antes da mensagem de APROVADO", async () => {
    const { terminal, runner } = setup({ decision: { approved: true } });
    terminal.startTurn();
    const order: string[] = [];
    const sentBefore = terminal.sent.length;
    runner.requestApproval("gabi", "Navegador: Gabi quer clicar em “Publicar” em linkedin.com. Pode?", undefined, () => order.push(`liberou (mensagens: ${terminal.sent.length - sentBefore})`));
    await flush();
    expect(order).toEqual(["liberou (mensagens: 0)"]);
    expect(terminal.sent.at(-1)).toContain("APROVADO");
  });

  it("tarefa que acaba com o pedido pendente: libera o gancho e avisa o runtime (cartão não fica órfão)", async () => {
    const { terminal, runner, outcome } = setup({ neverDecides: true });
    terminal.startTurn();
    const dropped = vi.fn();
    const abandoned = vi.fn();
    runner.onApprovalAbandoned = abandoned;
    runner.requestApproval("gabi", "Navegador: pode publicar?", undefined, undefined, undefined, dropped);
    runner.deliver("gabi", "pronto");
    terminal.endTurn("pronto");
    await expect(outcome).resolves.toMatchObject({ status: "done" });
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(abandoned).toHaveBeenCalledWith("gabi", TASK_ID);
  });

  it("recusada: nada é liberado", async () => {
    const { terminal, runner } = setup({ decision: { approved: false } });
    terminal.startTurn();
    const released = vi.fn();
    const dropped = vi.fn();
    runner.requestApproval("gabi", "Navegador: pode publicar?", undefined, released, undefined, dropped);
    await flush();
    expect(released).not.toHaveBeenCalled();
    expect(dropped).toHaveBeenCalledTimes(1);
  });
});

describe("CliAgentRunner: lote de aprovações e retrabalho", () => {
  const drafts = [
    { question: "Comentário 1?", draft: { text: "Texto 1", type: "comentario" } },
    { question: "Comentário 2?", draft: { text: "Texto 2", type: "comentario" } },
    { question: "Comentário 3?", draft: { text: "Texto 3", type: "comentario" } },
  ];

  it("a decisão do lote vira UMA mensagem: aprovado com o texto final, recusado com o motivo, cancelado sem resposta", async () => {
    const decision: ApprovalDecision = {
      approved: true,
      retry: true,
      rework: { count: 1, max: 2 },
      items: [
        { itemId: "A-0001", question: "Comentário 1?", status: "approved", text: "Texto 1 editado" },
        { itemId: "A-0002", question: "Comentário 2?", status: "rejected", reason: "muito longo" },
        { itemId: "A-0003", question: "Comentário 3?", status: "cancelled", cancelled: { by: "usuario", reason: "repetido" } },
      ],
    };
    const { terminal, runner } = setup({ decision });
    terminal.startTurn();
    const before = terminal.sent.length;
    const reply = runner.requestApproval("gabi", "Lote", undefined, undefined, drafts);
    expect(reply).toContain("3 approval items");
    await flush();
    expect(terminal.sent.length - before).toBe(1);
    const message = terminal.sent.at(-1)!;
    expect(message).toContain("[A-0001]");
    expect(message).toContain("APROVADO");
    expect(message).toContain("Texto 1 editado");
    expect(message).toContain("RECUSADO. Motivo: muito longo");
    expect(message).toContain("SEM RESPOSTA — o usuário descartou este item. Motivo: repetido");
    expect(message).toContain("retrabalho 1 de 2");
  });

  it("recusa com motivo (retry) volta ao agente com o motivo; sem retry, nada é enviado (a tarefa falha)", async () => {
    const retry = setup({ decision: { approved: false, retry: true, reason: "sem emojis", rework: { count: 2, max: 2 } } });
    retry.terminal.startTurn();
    retry.runner.requestApproval("gabi", "Posso publicar?");
    await flush();
    expect(retry.terminal.sent.at(-1)).toContain("RECUSADO (retrabalho 2 de 2)");
    expect(retry.terminal.sent.at(-1)).toContain("Motivo da recusa: sem emojis");
    const refused = setup({ decision: { approved: false, reason: "não" } });
    refused.terminal.startTurn();
    const before = refused.terminal.sent.length;
    refused.runner.requestApproval("gabi", "Posso publicar?");
    await flush();
    expect(refused.terminal.sent.length).toBe(before);
  });

  it("mais de 10 itens no lote é recusado", () => {
    const { terminal, runner } = setup();
    terminal.startTurn();
    expect(() => runner.requestApproval("gabi", "Lote", undefined, undefined, Array.from({ length: 11 }, () => drafts[0]!))).toThrow(/At most 10/);
  });
});

describe("CliAgentRunner: parado pelo usuário", () => {
  it("'Parado por você' (dropped) termina como cancelada, não como falha; outro motivo continua falha", async () => {
    const user = setup();
    user.terminal.emit({ type: "dropped", tag: TASK_ID, reason: "Parado por você" });
    expect(await user.outcome).toEqual({ status: "failed", result: "Parado por você", kind: "cancelada", cancelled: true });
    const crash = setup();
    crash.terminal.emit({ type: "dropped", tag: TASK_ID, reason: "A CLI caiu várias vezes" });
    expect(await crash.outcome).toEqual({ status: "failed", result: "A CLI caiu várias vezes", kind: "motor" });
  });
});

describe("CliAgentRunner: de onde veio a falha (failureKind)", () => {
  it("o turno acabou sem entregar nada = falha do agente; o turno com erro da CLI = falha do motor", async () => {
    const silent = setup();
    silent.terminal.startTurn();
    silent.terminal.endTurn("");
    expect(await silent.outcome).toMatchObject({ status: "failed", kind: "agente" });
    const broken = setup();
    broken.terminal.startTurn();
    broken.terminal.emit({ type: "turn_end", tag: TASK_ID, ok: false, result: "erro da CLI" } as TerminalEvent);
    expect(await broken.outcome).toMatchObject({ status: "failed", result: "erro da CLI", kind: "motor" });
  });
});

describe("CliAgentRunner: request_help espera o Maestro", () => {
  it("o fim do turno não fecha a tarefa; a nota (resposta do Maestro) solta a espera e vira um novo turno", async () => {
    const { terminal, runner, outcome } = setup();
    const released: string[] = [];
    terminal.startTurn();
    runner.holdForHelp("gabi", 60_000, (why) => released.push(why));
    terminal.endTurn("Pedi ajuda ao Maestro.");
    await flush();
    let settled = false;
    void outcome.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    expect(runner.note("gabi", "Use o perfil da Clara")).toEqual({ taskId: TASK_ID, live: false });
    expect(released).toEqual(["answered"]);
    expect(terminal.startTurn()?.text).toBe(noteMessage("Use o perfil da Clara"));
    runner.deliver("gabi", "feito");
    terminal.endTurn("ok");
    await expect(outcome).resolves.toMatchObject({ status: "done", result: "feito" });
  });

  it("sem resposta a tempo: libera, avisa o agente para seguir sem ela e a tarefa pode fechar", async () => {
    const { terminal, runner, outcome } = setup();
    const released: string[] = [];
    terminal.startTurn();
    runner.holdForHelp("gabi", 20, (why) => released.push(why));
    terminal.endTurn("Pedi ajuda.");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(released).toEqual(["timeout"]);
    expect(terminal.queue.map((message) => message.text).join("\n")).toContain("O Maestro não respondeu");
    terminal.startTurn();
    runner.deliver("gabi", "sem a ajuda");
    terminal.endTurn("ok");
    await expect(outcome).resolves.toMatchObject({ status: "done", result: "sem a ajuda" });
  });

  it("entregar enquanto espera encerra a espera (avisa quem marcou)", async () => {
    const { terminal, runner, outcome } = setup();
    const released: string[] = [];
    terminal.startTurn();
    runner.holdForHelp("gabi", 60_000, (why) => released.push(why));
    runner.deliver("gabi", "entreguei assim mesmo");
    terminal.endTurn("ok");
    await expect(outcome).resolves.toMatchObject({ status: "done" });
    expect(released).toEqual(["ended"]);
  });
});
