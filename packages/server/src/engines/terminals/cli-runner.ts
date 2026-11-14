import { agentEngine, isCliEngine, type Agent, type AgentProvider, type ForYouQuestion, type ForYouSource } from "@cyno/shared";
import { APPROVAL_BATCH_MAX, type AgentRunner, type ApprovalCancel, type ApprovalDecision, type ApprovalDraft, type RunHooks, type RunInput, type RunOutcome } from "../runner/types";
import { NoEngineRunner } from "../runner/no-engine-runner";
import { terminalLogBridge } from "./log-bridge";
import { STOP_REASONS, type TerminalManager } from "./manager";
import { taskMessage } from "./prompts";
import type { SendOptions } from "./types";

/** Execução em curso de um agente de CLI (as ferramentas MCP dele mexem aqui). */
type ActiveRun = {
  taskId: string;
  hooks: RunHooks;
  /** Já resolveu (entregou, falhou ou foi abortada): nada mais chama os ganchos. */
  done: boolean;
  /** Pediu aprovação e espera a decisão (o fim do turno não fecha a tarefa). */
  approvalPending: boolean;
  /** Chamado se a tarefa acaba (entregue, falha, cancelada) com o pedido ainda sem decisão. */
  onDropped?: () => void;
  /** Pediu ajuda ao Maestro (`request_help`) e espera a resposta: o fim do turno não fecha a tarefa. */
  help?: { timer: NodeJS.Timeout; release: (why: "answered" | "timeout" | "ended") => void };
  /** Mensagens desta tarefa na fila do terminal, ainda sem turno. */
  queued: number;
  /** O turno em curso no terminal é desta tarefa. */
  ours: boolean;
  /** Já chamou `submit_result`: a tarefa fecha com isto no fim do turno (o log do turno fica completo). */
  delivered?: string;
  /** Notas do usuário mandadas pela fila (não entraram ao vivo): no fim, as que ainda estão na fila não foram lidas. */
  /** Notas do usuário que foram para a fila da sessão (a mensagem e o texto dele). */
  notes: { message: string; text: string }[];
  finish: (outcome: RunOutcome) => void;
  send: (message: string, options?: SendOptions) => void;
};

/** Texto padrão quando o agente fecha o turno sem entregar e sem dizer nada. */
const NO_RESULT = "O agente terminou o turno sem chamar submit_result e sem resultado";

/** Depois de `submit_result`, quanto esperar o fim do turno antes de fechar a tarefa assim mesmo. */
export const DELIVER_GRACE_MS = 30_000;

/**
 * Runner dos agentes com motor de CLI: manda a tarefa para o terminal do agente (o processo sobe
 * sozinho) e resolve quando ele chama `submit_result` pelo MCP. Cada tarefa começa numa conversa NOVA da
 * CLI (sessão por tarefa: o Cérebro e o diário são a memória, não o histórico da sessão); tudo o
 * que é da mesma tarefa (a decisão de uma aprovação, a mesma tarefa depois de um reinício) segue
 * na conversa dela. Se o turno
 * acaba sem `submit_result` (e sem aprovação pendente nem mensagem na fila), o texto final do turno
 * vira o resultado. Abortar (tarefa cancelada) tira a mensagem da fila e interrompe o turno.
 * Tudo que o processo faz vai para o log pela ponte (provider = motor do agente).
 */
export class CliAgentRunner implements AgentRunner {
  private readonly active = new Map<string, ActiveRun>();
  /**
   * Notas do usuário que ficaram na fila quando a tarefa acabou (o agente entregou antes do próximo
   * turno, comum no agy, que não aceita entrada ao vivo). O runtime manda como conversa com o agente.
   */
  onLateNotes?: (agentId: string, taskId: string, notes: string[]) => void;
  /** A tarefa acabou com um pedido de aprovação/pergunta ainda pendente: o runtime fecha o cartão órfão. */
  onApprovalAbandoned?: (agentId: string, taskId: string) => void;

  constructor(
    private readonly terminals: Pick<TerminalManager, "get">,
    private readonly deliverGraceMs = DELIVER_GRACE_MS,
  ) {}

  providerFor(agent: Agent): AgentProvider | undefined {
    const engine = agentEngine(agent);
    return isCliEngine(engine) ? engine : undefined;
  }

  run(input: RunInput, hooks: RunHooks): Promise<RunOutcome> {
    const { task, agent, signal } = input;
    if (signal.aborted) return Promise.reject(signal.reason as Error);
    const terminal = this.terminals.get(agent.id);
    return new Promise<RunOutcome>((resolve, reject) => {
      const bridge = terminalLogBridge(hooks);
      const run: ActiveRun = {
        taskId: task.id,
        hooks,
        done: false,
        approvalPending: false,
        queued: 0,
        ours: false,
        notes: [],
        finish: (outcome) => end(() => resolve(outcome), outcome.status === "done" ? "Tarefa entregue" : outcome.result),
        send: (message, options) => {
          run.queued += 1;
          terminal.send(message, task.id, options);
        },
      };
      const end = (settle: () => void, reason: string) => {
        if (run.done) return;
        run.done = true;
        if (run.approvalPending) {
          run.approvalPending = false;
          try {
            run.onDropped?.();
            this.onApprovalAbandoned?.(agent.id, task.id);
          } catch {
            // limpar o pedido nunca impede a tarefa de fechar
          }
        }
        if (run.help) this.releaseHelp(run, "ended");
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
        // O que ainda está na fila desta tarefa (a tarefa acabou antes do próximo turno) não roda solto.
        const unsent = terminal.cancel(task.id);
        const late = run.notes.filter((note) => unsent.some((text) => text.includes(note.message))).map((note) => note.text);
        const others = unsent.filter((text) => !run.notes.some((note) => text.includes(note.message))).length;
        if (late.length > 0) {
          const lateNotes = this.onLateNotes;
          hooks.log({
            kind: "text",
            text: lateNotes ? "_A nota do usuário chegou depois da entrega: vai para o agente como conversa._" : "_A nota do usuário chegou depois do fim do trabalho e não foi enviada ao agente._",
          });
          // Depois do fim (a tarefa já não está ativa aqui): vira conversa, sem entrar na próxima tarefa.
          if (lateNotes) setTimeout(() => lateNotes(agent.id, task.id, late), 0).unref();
        }
        if (others > 0) hooks.log({ kind: "text", text: "_Uma mensagem para o agente (ex.: a resposta do usuário) ficou na fila depois do fim do trabalho e não foi enviada._" });
        bridge.close(reason);
        if (this.active.get(agent.id) === run) this.active.delete(agent.id);
        settle();
      };
      const onAbort = () => {
        terminal.cancel(task.id);
        if (run.ours) terminal.interrupt();
        end(() => reject(signal.reason as Error), "Tarefa cancelada");
      };
      const unsubscribe = terminal.onEvent((event) => {
        if (run.done) return;
        switch (event.type) {
          case "turn_start":
            run.ours = event.tag === task.id;
            if (run.ours) run.queued = Math.max(0, run.queued - 1);
            return;
          case "dropped":
            if (event.tag === task.id) run.finish({ status: "failed", result: event.reason, kind: event.reason === STOP_REASONS.user ? "cancelada" : "motor", ...(event.reason === STOP_REASONS.user ? { cancelled: true } : {}) });
            return;
          case "turn_end": {
            if (!run.ours || event.tag !== task.id) return;
            run.ours = false;
            if (run.delivered !== undefined) {
              run.finish({ status: "done", result: run.delivered });
              return;
            }
            if (run.approvalPending || run.help || run.queued > 0) return;
            const text = event.result.trim();
            run.finish(event.ok && text ? { status: "done", result: text } : { status: "failed", result: text || NO_RESULT, kind: event.ok ? "agente" : "motor" });
            return;
          }
          default:
            if (run.ours) bridge.handle(event);
        }
      });
      signal.addEventListener("abort", onAbort, { once: true });
      this.active.set(agent.id, run);
      const first = taskMessage(task, input.context, input.diary);
      run.send(input.resumedDecision ? `${first}\n\n${resumedDecisionMessage(input.resumedDecision)}` : first, { freshSession: true });
    });
  }

  // ---------- Ferramentas MCP dos agentes de time ----------

  /**
   * `submit_result`: a tarefa fecha com o resultado no fim deste turno (assim o resto do turno, como o
   * resultado da própria chamada, ainda entra no log). Fora de um turno dela, ou se o turno não
   * acabar em DELIVER_GRACE_MS, fecha na hora.
   */
  deliver(agentId: string, result: string): string {
    const run = this.require(agentId);
    const text = result.trim();
    if (!text) throw new Error("The result is empty");
    if (run.delivered !== undefined) throw new Error("You already submitted this task");
    run.delivered = text;
    if (!run.ours) run.finish({ status: "done", result: text });
    else setTimeout(() => run.finish({ status: "done", result: text }), this.deliverGraceMs).unref();
    return "Submitted. The task will be completed when you finish this turn.";
  }

  /** `report_progress`: percent de 0 a 100 (ou de 0 a 1). */
  progress(agentId: string, pct: number, message: string): string {
    const run = this.require(agentId);
    const value = pct > 1 ? pct / 100 : pct;
    run.hooks.onProgress(Math.min(1, Math.max(0, value)), message);
    return "Progress recorded.";
  }

  /**
   * `request_approval`: abre o item no "Para você" (a tarefa fica esperando você) e volta na hora;
   * a decisão chega como mensagem na sessão. Recusa = a tarefa falha (o orquestrador aborta).
   */
  requestApproval(
    agentId: string,
    question: string,
    draft?: { type?: string; text?: string; title?: string; where?: string; to?: string; mediaIds?: string[]; sources?: ForYouSource[] },
    /** Chamado na aprovação, antes da mensagem (ex.: o navegador libera a ação aprovada). */
    onApproved?: () => void,
    /** Lote: até 10 rascunhos, cada um um item do "Para você"; a decisão volta numa mensagem só. */
    batch?: { question: string; draft: NonNullable<typeof draft> }[],
    /** Chamado se o pedido acaba sem aprovação (recusado, cancelado ou a tarefa terminou antes). */
    onDropped?: () => void,
  ): string {
    const run = this.require(agentId);
    if (run.approvalPending) throw new Error("There is already an approval request waiting for the user");
    if (batch && batch.length > APPROVAL_BATCH_MAX) throw new Error(`At most ${APPROVAL_BATCH_MAX} items per request_approval`);
    run.approvalPending = true;
    run.onDropped = onDropped;
    const toDraft = (value: typeof draft, asked: string): ApprovalDraft | undefined => {
      const hasExtras = (value?.mediaIds?.length ?? 0) > 0 || (value?.sources?.length ?? 0) > 0;
      return value && (value.text || hasExtras)
        ? compact({ type: value.text ? (value.type ?? "outro") : value.type, text: value.text ?? asked, title: value.title, where: value.where, to: value.to, mediaIds: value.mediaIds, sources: value.sources })
        : undefined;
    };
    const fullDraft = toDraft(draft, question);
    const items = batch?.map((entry) => ({ question: entry.question, ...(toDraft(entry.draft, entry.question) ? { draft: compact(toDraft(entry.draft, entry.question)!) } : {}) }));
    void run.hooks.requestApproval({ question, ...(fullDraft ? { draft: compact(fullDraft) } : {}), ...(items ? { items } : {}) }).then((decision) => {
      run.approvalPending = false;
      run.onDropped = undefined;
      if (run.done) return;
      if (!decision.items && (decision.cancelled || !decision.approved)) onDropped?.();
      if (decision.items) {
        // Lote: uma mensagem com o resultado de cada item (a não ser que o próprio agente tenha retirado todos).
        if (decision.items.every((item) => item.cancelled?.by === "agente")) return;
        if (!decision.approved) {
          onDropped?.();
          return;
        }
        if (decision.items.some((item) => item.status === "approved")) onApproved?.();
        run.send(batchDecisionMessage(question, decision));
        return;
      }
      if (decision.cancelled) {
        // Retirado pelo próprio agente (no turno dele): o resultado da ferramenta já disse; sem mensagem.
        if (decision.cancelled.by !== "agente") run.send(cancelledMessage(question, decision.cancelled, "aprovacao"));
        return;
      }
      if (decision.retry) {
        run.send(reworkMessage(question, decision));
        return;
      }
      if (!decision.approved) return;
      onApproved?.();
      run.send(
        [
          `Decisão do usuário sobre "${question}": APROVADO.`,
          decision.text ? `Texto final (use este):\n${decision.text}` : "",
          decision.response ? `Resposta/nota do usuário: ${decision.response}` : "",
          "Continue a tarefa e termine com `submit_result`.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    });
    return batch
      ? `${batch.length} approval items sent to the user (one per draft). The task waits until ALL are decided; you get ONE message with the result of each. End this turn now.`
      : "Approval request sent to the user. End this turn now: the decision arrives in a later message.";
  }

  /**
   * `request_help`: segura a tarefa até o Maestro responder (a resposta chega como nota, por
   * `message_agent`) ou até `timeoutMs`; nos dois casos `release` avisa quem marcou a espera.
   * Sem resposta a tempo, o agente é avisado para seguir com o que tem.
   */
  holdForHelp(agentId: string, timeoutMs: number, release: (why: "answered" | "timeout" | "ended") => void): void {
    const run = this.require(agentId);
    if (run.help) clearTimeout(run.help.timer);
    const timer = setTimeout(() => {
      if (run.done || !run.help) return;
      this.releaseHelp(run, "timeout");
      run.send("O Maestro não respondeu ao seu pedido de ajuda a tempo. Siga com o que você tem e termine com `submit_result`, dizendo o que faltou.");
    }, timeoutMs);
    timer.unref();
    run.help = { timer, release };
  }

  /** O agente está segurando a tarefa à espera do Maestro (`request_help`)? */
  isWaitingHelp(agentId: string): boolean {
    const run = this.active.get(agentId);
    return run !== undefined && !run.done && run.help !== undefined;
  }

  private releaseHelp(run: ActiveRun, why: "answered" | "timeout" | "ended"): void {
    const help = run.help;
    if (!help) return;
    clearTimeout(help.timer);
    run.help = undefined;
    try {
      help.release(why);
    } catch {
      // a espera some mesmo que quem a marcou falhe
    }
  }

  /**
   * Nota do usuário para o agente no meio de uma tarefa (a caixa da tela de trabalho dele): entra no
   * turno em curso se a CLI aceitar entrada ao vivo; senão vai na fila da sessão da tarefa e chega no
   * próximo limite de turno. Undefined = o agente não tem tarefa em curso (aí é conversa).
   */
  note(agentId: string, text: string): { taskId: string; live: boolean } | undefined {
    const run = this.active.get(agentId);
    if (!run || run.done) return undefined;
    if (run.help) this.releaseHelp(run, "answered");
    const message = noteMessage(text);
    const terminal = this.terminals.get(agentId);
    const live = run.ours && terminal.inject?.(message) === true;
    if (!live) {
      run.notes.push({ message, text: text.trim() });
      run.send(message);
    }
    return { taskId: run.taskId, live };
  }

  /** Id da tarefa em curso do agente (com execução aberta aqui), se houver. */
  activeTaskId(agentId: string): string | undefined {
    const run = this.active.get(agentId);
    return run && !run.done ? run.taskId : undefined;
  }

  /**
   * `ask_user`: questionário no "Para você" que segura só esta tarefa (as outras seguem).
   * As respostas chegam numa mensagem quando o usuário enviar; recusar = a tarefa falha.
   */
  requestInformation(agentId: string, title: string, questions: ForYouQuestion[]): string {
    const run = this.require(agentId);
    if (run.approvalPending) throw new Error("You already have a request waiting for the user");
    if (questions.length === 0) throw new Error("Send at least one question");
    run.approvalPending = true;
    void run.hooks.requestApproval({ question: title, questions }).then((decision) => {
      run.approvalPending = false;
      if (run.done) return;
      if (decision.cancelled) {
        if (decision.cancelled.by !== "agente") run.send(cancelledMessage(title, decision.cancelled, "questionario"));
        return;
      }
      if (!decision.approved) return;
      run.send(
        [
          `Respostas do usuário (“${title}”; “decida você” = escolha você):`,
          decision.response ?? decision.text ?? "(sem respostas)",
          "Continue a tarefa e termine com `submit_result`.",
        ].join("\n\n"),
      );
    });
    return "Questions sent to the user (Para você). Only this task waits; end this turn now: the answers arrive in a later message.";
  }

  /** Id da tarefa em curso do agente (para o `get_task` e o `request_help`). */
  currentTaskId(agentId: string): string {
    return this.require(agentId).taskId;
  }

  /** Tem tarefa em curso? (para as ferramentas responderem com clareza) */
  hasActive(agentId: string): boolean {
    return this.active.has(agentId);
  }

  private require(agentId: string): ActiveRun {
    const run = this.active.get(agentId);
    if (!run || run.done) throw new Error("You have no task in progress right now");
    return run;
  }
}

/** Texto da nota do usuário na sessão da tarefa (não muda a tarefa: é uma orientação a mais). */
export function noteMessage(text: string): string {
  return [
    "Nota do usuário sobre a tarefa em andamento (ele escreveu direto para você, pela tela de trabalho):",
    text.trim(),
    "",
    "Leve isso em conta no que falta e siga a mesma tarefa; não é uma tarefa nova. Termine com `submit_result`, como sempre (se já entregou, responda em uma frase e não entregue de novo).",
  ].join("\n");
}

/**
 * O item do "Para você" que segurava a tarefa foi retirado sem resposta (pelo Maestro ou descartado
 * pelo usuário): a tarefa segue sem a aprovação/as respostas. Começa como uma decisão do usuário.
 */
export function cancelledMessage(question: string, cancel: ApprovalCancel, kind: "aprovacao" | "questionario"): string {
  const who = cancel.by === "usuario" ? "o usuário descartou" : cancel.by === "maestro" ? "o Maestro cancelou" : "o item foi cancelado";
  const reason = cancel.reason?.trim() ? ` Motivo: ${cancel.reason.trim()}` : "";
  return [
    `Decisão do usuário sobre "${question}": SEM RESPOSTA — ${who} este item do Para você.${reason}`,
    kind === "questionario"
      ? "Siga a tarefa sem essas respostas: decida você (use os padrões que sugeriu). Não pergunte de novo a mesma coisa."
      : "Siga a tarefa sem essa aprovação: não publique nem envie o texto que pedia aprovação; faça o resto e diga no resultado o que ficou de fora.",
    "Termine com `submit_result`.",
  ].join("\n\n");
}

/** Mensagem de uma recusa com motivo dentro do limite de retrabalho: o agente refaz e pede aprovação de novo. */
export function reworkMessage(question: string, decision: ApprovalDecision): string {
  const attempt = decision.rework ? ` (retrabalho ${decision.rework.count} de ${decision.rework.max})` : "";
  return [
    `Decisão do usuário sobre "${question}": RECUSADO${attempt}.`,
    `Motivo da recusa: ${decision.reason ?? decision.response ?? "(sem motivo)"}`,
    "Refaça o rascunho levando o motivo em conta e peça aprovação de novo com `request_approval` (não publique nem envie a versão recusada). Termine com `submit_result` só depois da nova decisão.",
  ].join("\n\n");
}

/** Mensagem do resultado de um lote: cada item com a decisão (aprovado com o texto final, recusado com o motivo). */
export function batchDecisionMessage(question: string, decision: ApprovalDecision): string {
  const items = decision.items ?? [];
  const lines = items.map((item, index) => {
    const head = `${index + 1}. [${item.itemId}] "${item.question}"`;
    if (item.status === "approved") {
      return [`${head}: APROVADO.`, item.text ? `Texto final (use este):\n${item.text}` : "", item.response ? `Nota do usuário: ${item.response}` : ""].filter(Boolean).join("\n");
    }
    if (item.status === "rejected") return `${head}: RECUSADO.${item.reason ? ` Motivo: ${item.reason}` : " (sem motivo: não refaça este)"}`;
    const by = item.cancelled?.by;
    const who = by === "maestro" ? "o Maestro cancelou" : by === "agente" ? "você retirou" : "o usuário descartou";
    const why = item.cancelled?.reason?.trim() ? ` Motivo: ${item.cancelled.reason.trim()}` : "";
    return `${head}: SEM RESPOSTA — ${who} este item.${why} Não publique nem envie este texto.`;
  });
  const retry = decision.retry && items.some((item) => item.status === "rejected" && item.reason);
  const attempt = decision.rework ? ` (retrabalho ${decision.rework.count} de ${decision.rework.max})` : "";
  return [
    `Decisão do usuário sobre o lote "${question}" (${items.length} item(ns)):`,
    lines.join("\n\n"),
    retry
      ? `Refaça SÓ os recusados com motivo${attempt}, levando o motivo em conta, e peça aprovação de novo com \`request_approval\` (só dos refeitos). Os aprovados não precisam voltar. Termine com \`submit_result\` depois, incluindo os textos finais aprovados.`
      : "Continue a tarefa com isso e termine com `submit_result` (use os textos finais aprovados; não publique nem envie o que foi recusado ou ficou sem resposta).",
  ].join("\n\n");
}

/**
 * A tarefa recomeçou depois de um reinício do server e o usuário já tinha decidido o que ela pedia
 * (aprovação ou perguntas): vai junto com a tarefa, para o agente seguir sem perguntar de novo.
 */
export function resumedDecisionMessage(decision: ApprovalDecision): string {
  if (decision.items || decision.retry) {
    const body = decision.items ? batchDecisionMessage("seu pedido", decision) : reworkMessage("o seu pedido", decision);
    return ["## Decisão do usuário (tomada antes de um reinício do servidor)", "Esta tarefa recomeçou depois de um reinício; você tinha pedido aprovação e o usuário JÁ decidiu:", body].join("\n\n");
  }
  if (decision.cancelled) {
    return [
      "## Já resolvido antes de um reinício do servidor",
      "Esta tarefa recomeçou depois de um reinício. Você tinha pedido ao usuário uma aprovação ou respostas, e o item foi RETIRADO sem resposta.",
      cancelledMessage("o seu pedido", decision.cancelled, "questionario").split("\n\n").slice(1).join("\n\n"),
    ].join("\n\n");
  }
  return [
    "## Já decidido pelo usuário (antes de um reinício do servidor)",
    "Esta tarefa recomeçou depois de um reinício. Você já tinha pedido ao usuário uma aprovação ou respostas, e ele JÁ decidiu: APROVADO.",
    decision.text ? `Texto final (use este):\n${decision.text}` : "",
    decision.response ? `Resposta do usuário:\n${decision.response}` : "",
    "NÃO pergunte de novo (nem `request_approval` nem `ask_user` sobre isso): use esta decisão, continue a tarefa e termine com `submit_result`.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

/** Runner de cada workspace: os de CLI no CliAgentRunner; sem motor, no MockRunner (modo simulado) ou falhando a tarefa (NoEngineRunner). */
export class EngineRunner implements AgentRunner {
  private readonly mock: AgentRunner;

  constructor(
    mock: AgentRunner | undefined,
    private readonly cli: CliAgentRunner,
  ) {
    this.mock = mock ?? new NoEngineRunner();
  }

  providerFor(agent: Agent): AgentProvider | undefined {
    return isCliEngine(agent.engine) ? this.cli.providerFor(agent) : (this.mock.providerFor?.(agent) ?? this.mock.provider);
  }

  run(input: RunInput, hooks: RunHooks): Promise<RunOutcome> {
    return isCliEngine(input.agent.engine) ? this.cli.run(input, hooks) : this.mock.run(input, hooks);
  }
}
