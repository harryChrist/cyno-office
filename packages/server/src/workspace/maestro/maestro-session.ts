import { engineBlockLabel, findMaestroAgent, findMaestroRoom, isActiveTaskStatus, subtasksOf, type AgentLogBody } from "@cyno/shared";
import { CONVERSATION_SEPARATOR, ConversationSession, type ConversationHooks } from "../../engines/terminals/conversation-session";
import type { TerminalAgent, TerminalEvent } from "../../engines/terminals/types";
import { errorMessage, shorten } from "../../util/text";
import type { MaestroCore } from "./maestro-core";
import { isChatTag } from "./maestro-text";

/**
 * Conversa do Maestro acima disto (tokens) é renovada na próxima mensagem. 0 = nunca: a conversa
 * segue até a CLI compactar sozinha perto da janela cheia (--autocompact auto). MAESTRO_ROTATE_TOKENS
 * no ambiente liga de novo.
 */
export const MAESTRO_ROTATE_TOKENS = 0;

/** Tetos do resumo que abre a conversa nova do Maestro. */
const SEED_LIMITS = { recent: 8, recentChars: 320, brainChars: 8000 } as const;

/** Começo da mensagem que abre a conversa nova do Maestro (o resumo vem antes do separador). */
export const MAESTRO_SEED_HEADER = "(Conversa nova: a anterior ficou grande e foi encerrada.";
export const MAESTRO_SEED_SEPARATOR = CONVERSATION_SEPARATOR;
/** Começo do contexto do Cérebro que vai antes da primeira mensagem de uma conversa nova do Maestro. */
export const MAESTRO_PRIMER_HEADER = "(Contexto do Cérebro deste workspace, montado pelo servidor no início da conversa.";

/** Quantas falas recentes da conversa entram no resumo de uma conversa nova (e quanto de cada). */
const SEED_CHAT = { lines: 8, chars: 240 } as const;

/**
 * A sessão do Maestro (o terminal dele): a `ConversationSession` comum com os ganchos do Maestro (o
 * terminal do workspace, o contexto do Cérebro, o resumo dos pedidos, o que registrar no log do pedido
 * ou da conversa quando uma mensagem espera o motor). NUNCA limpa nem renova a conversa sozinha: só
 * com `rotateTokens` ligado (padrão: 0).
 */
export class MaestroSession extends ConversationSession {
  private readonly core: MaestroCore;

  constructor(
    core: MaestroCore,
    /** Ouvinte dos eventos do terminal (os turnos). */
    onTerminalEvent: (maestroId: string, terminal: TerminalAgent, event: TerminalEvent) => void,
  ) {
    const self: { current?: MaestroSession } = {};
    super(maestroHooks(core, onTerminalEvent, (tag, brain) => self.current!.seed(tag, brain), () => self.current!.brainText()));
    self.current = this;
    this.core = core;
  }

  /** Guarda a fala no resumo de uma conversa nova (só entradas "chat"). */
  rememberChat(body: AgentLogBody): void {
    if (body.kind !== "chat") return;
    this.remember(`- ${body.from === "user" ? "Usuário" : "Você"}: ${shorten(body.text.replace(/\s+/g, " "), SEED_CHAT.chars)}`, SEED_CHAT.lines);
  }

  /** Briefing e índice do global e de cada quarto (o contexto do Cérebro do Maestro, com os tetos de sempre). */
  private async brainText(): Promise<string> {
    const room = findMaestroRoom(this.core.deps.state.read());
    if (!room || !this.core.deps.brain) return "";
    try {
      return shorten((await this.core.deps.brain.buildContext(room.id, "")).text.trim(), SEED_LIMITS.brainChars);
    } catch {
      return "";
    }
  }

  /**
   * Resumo para a conversa nova do Maestro, montado só com o que o server já sabe: os últimos
   * pedidos fechados (pedido → resultado), os abertos com as subtarefas e o briefing/índice dos
   * quartos (Cérebro). Tem teto.
   */
  private seed(currentId: string, brain: string): string {
    const state = this.core.deps.state.read();
    const mine = state.tasks.filter((task) => this.core.owns(state, task));
    const closed = mine
      .filter((task) => !isActiveTaskStatus(task.status) && task.id !== currentId)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(-SEED_LIMITS.recent)
      .map((task) => `- ${task.id} (${task.status}): “${shorten(task.prompt, 140)}” → ${shorten((task.result ?? "sem resultado").replace(/\s+/g, " "), SEED_LIMITS.recentChars)}`);
    const open = mine
      .filter((task) => isActiveTaskStatus(task.status))
      .map((task) => {
        const subtasks = subtasksOf(state.tasks, task.id).map((subtask) => `${subtask.id} (${this.core.agentName(state, subtask.agentId)}): ${subtask.status}`);
        return `- Pedido ${task.id} (${task.status}): “${shorten(task.prompt, 200)}”${subtasks.length > 0 ? ` — subtarefas: ${subtasks.join("; ")}` : ""}`;
      });
    return [
      `${MAESTRO_SEED_HEADER} Resumo do que importa, montado pelo servidor:)`,
      closed.length > 0 ? `## Últimos pedidos fechados\n${closed.join("\n")}` : "",
      open.length > 0 ? `## Pedidos em aberto\n${open.join("\n")}` : "",
      this.recentChat.length > 0 ? `## Conversa recente com o usuário\n${this.recentChat.join("\n")}` : "",
      brain ? `## Cérebro (briefing e índice)\n${brain}` : "",
      "Para detalhes antigos: `get_task(id)`, `search_notes` e `read_note`.",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
}

/** Os ganchos do Maestro para a sessão comum. */
function maestroHooks(core: MaestroCore, onTerminalEvent: (maestroId: string, terminal: TerminalAgent, event: TerminalEvent) => void, seed: (tag: string, brain: string) => string, brainText: () => Promise<string>): ConversationHooks {
  const maestro = () => findMaestroAgent(core.deps.state.read());
  return {
    label: "Maestro (CLI)",
    sessionKeyPrefix: "maestro",
    log: core.deps.log,
    isStopped: () => core.isStopped(),
    locate() {
      const agent = maestro();
      if (!agent) throw new Error("Este workspace não tem o Maestro");
      return { id: agent.id, terminal: core.deps.terminals.get(agent.id) };
    },
    onTerminalEvent,
    blocked() {
      const agent = maestro();
      return agent ? core.deps.availability?.(agent) : undefined;
    },
    rotateTokens: () => core.deps.rotateTokens ?? MAESTRO_ROTATE_TOKENS,
    ...(core.deps.brain ? { primer: brainText } : {}),
    framePrimer: (brain, message) => `${MAESTRO_PRIMER_HEADER} Use isto antes de perguntar ao usuário um fato do projeto; o resto, com search_notes / read_note.)\n\n${brain}${MAESTRO_SEED_SEPARATOR}${message}`,
    seed,
    onQueued: (tag) => void core.turn.queued.set(tag, (core.turn.queued.get(tag) ?? 0) + 1),
    onUnavailable(tag, error) {
      core.chatStatus(tag, "failed", `O terminal do Maestro não está disponível: ${errorMessage(error)}`);
      const state = core.deps.state.read();
      const task = state.tasks.find((candidate) => candidate.id === tag);
      if (task) core.finish(state, task, "failed", `O terminal do Maestro não está disponível: ${errorMessage(error)}`, undefined, "motor");
    },
    onHold(tag, first, block) {
      if (isChatTag(tag)) {
        const agent = maestro();
        if (agent && first) core.chatEntry(agent.id, { kind: "status", status: "waiting", message: `Maestro ${engineBlockLabel(block, core.now().getTime())}: a mensagem espera` });
        return;
      }
      const task = core.deps.state.read().tasks.find((candidate) => candidate.id === tag);
      if (!task) return;
      const why = `Maestro ${engineBlockLabel(block, core.now().getTime())}: o pedido espera na fila`;
      if (first) core.logEntry(task, { kind: "status", status: "waiting", message: why });
      core.setProgress(task, 0.05, why);
    },
    onResume(tag) {
      if (isChatTag(tag)) {
        const agent = maestro();
        if (agent) core.chatEntry(agent.id, { kind: "status", status: "resumed", message: "O motor do Maestro voltou: a mensagem seguiu" });
        return true;
      }
      if (!core.isOpen(tag)) return false;
      const task = core.deps.state.read().tasks.find((candidate) => candidate.id === tag);
      if (task) {
        core.logEntry(task, { kind: "status", status: "resumed", message: "O motor do Maestro voltou: seguindo com o pedido" });
        core.setProgress(task, 0.15, "O Maestro está lendo o pedido…");
      }
      return true;
    },
  };
}
