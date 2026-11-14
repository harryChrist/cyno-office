import { randomUUID } from "node:crypto";
import type { EngineBlock } from "@cyno/shared";
import { errorMessage } from "../../util/text";
import type { TerminalAgent, TerminalEvent } from "./types";

/** Separador entre o resumo/contexto que abre uma conversa nova e a mensagem de verdade. */
export const CONVERSATION_SEPARATOR = "\n\n---\n\n";

/**
 * O que a `ConversationSession` pede a quem a usa (o Maestro de um workspace, o Cyno da plataforma).
 * A sessão só sabe de mensagens, de fila, de contexto de abertura e de rotação; tudo o que é do dono
 * dela (qual terminal, o que montar no começo, como registrar um aviso) vem por aqui.
 */
export type ConversationHooks = {
  /** Prefixo dos textos de log ("Maestro (CLI)"). */
  label: string;
  /** Prefixo da chave de uma sessão nova da CLI ("maestro"). */
  sessionKeyPrefix: string;
  log: { info(data: object, message: string): void; error(data: object, message: string): void };
  /** A sessão foi desligada (workspace fechando): nada mais sai. */
  isStopped(): boolean;
  /** O terminal do dono (lança se não houver) e quem recebe cada evento dele (o `id` volta ao ouvinte). */
  locate(): { id: string; terminal: TerminalAgent };
  onTerminalEvent(id: string, terminal: TerminalAgent, event: TerminalEvent): void;
  /** Por que o motor está indisponível agora (undefined = pode trabalhar). */
  blocked(): EngineBlock | undefined;
  /** Conversa acima disto (tokens) é renovada na próxima mensagem; 0 = nunca. */
  rotateTokens(): number;
  /**
   * Contexto que abre uma conversa nova (o Cérebro do Maestro). Ausente = nada é montado: a mensagem
   * vai direto. Devolve "" quando não há o que levar.
   */
  primer?(): Promise<string>;
  /** A mensagem de abertura com o contexto (`primer` não vazio) na frente. */
  framePrimer?(primer: string, message: string): string;
  /** Resumo de uma conversa nova (rotação), montado só com o que o servidor já sabe. "" = abre sem resumo. */
  seed(tag: string, primer: string): string;
  /** Uma mensagem entrou na fila do terminal (o dono conta os turnos pendentes). */
  onQueued?(tag: string): void;
  /** O terminal não está disponível: a mensagem não sai (o dono marca o pedido como falho). */
  onUnavailable?(tag: string, error: unknown): void;
  /** A mensagem foi segura porque o motor está sem cota (`first`: a primeira vez desta tag). */
  onHold?(tag: string, first: boolean, block: EngineBlock): void;
  /** O motor voltou: devolve false para descartar a mensagem segura (ex.: o pedido já fechou). */
  onResume?(tag: string): boolean;
};

/** Mensagem segura esperando o motor voltar. `build` monta o texto só quando ela de fato sai. */
type Held = { tag: string; build: () => string };

/**
 * A sessão de conversa de um agente com terminal de CLI: manda as mensagens na ordem, segura as que
 * esperam o motor voltar, monta o contexto que abre uma conversa e marca quando ela passou do teto.
 * NUNCA limpa nem renova a conversa sozinha: só com `rotateTokens()` ligado (padrão do app: 0) ou
 * quando o dono pede (`startNewConversation`).
 */
export class ConversationSession {
  /** Mensagens esperando o motor voltar (cota esgotada), na ordem. */
  private held: Held[] = [];
  /**
   * Fila (outbox) da mensagem que abriu uma conversa NOVA (rotação): fica aqui até o terminal
   * confirmar que o turno começou (`turn_start` da mesma tag). Se o terminal a descartar (`dropped`),
   * ela é reenviada na conversa ANTIGA (a sessão nova só vale depois de confirmada) e a rotação fica
   * para a próxima mensagem. Em memória: no boot os pedidos abertos são retomados por `resume`.
   */
  private outbox = new Map<string, { message: string; retried: boolean }>();
  /** Avisos para a próxima vez que o agente acordar: vão no fim da próxima mensagem; nada acorda só por isso. */
  private notices: string[] = [];
  /** Falas recentes da conversa (para o resumo de uma conversa nova). */
  protected recentChat: string[] = [];
  private attached: { terminal: TerminalAgent; off: () => void } | undefined;
  /** A conversa passou do teto (ou o dono pediu outra): a próxima mensagem abre uma nova. */
  private rotateDue = false;
  /**
   * A conversa atual da CLI já tem histórico (já recebeu o contexto de abertura)?
   * undefined = não sei (boot, terminal novo): a próxima mensagem pergunta ao terminal.
   */
  private history: boolean | undefined;
  /** Montando o contexto de abertura (assíncrono): as mensagens seguintes esperam atrás, na ordem. */
  private priming: Promise<void> | undefined;
  /** Conversas renovadas desde o boot (para o log). */
  rotations = 0;

  constructor(protected readonly hooks: ConversationHooks) {}

  /** Textos montados na hora de cada mensagem que sai (o que há de novo no mural); "" = nada a acrescentar. */
  private readonly extras: Array<() => string> = [];

  /** Registra um texto a acrescentar ao fim de TODA mensagem que sair (chamado só quando ela de fato vai). */
  addExtra(extra: () => string): void {
    this.extras.push(extra);
  }

  /** Aviso para a próxima mensagem (vai no fim dela). */
  addNotice(text: string): void {
    this.notices.push(text);
  }

  /** Guarda a linha no resumo de uma conversa nova. */
  protected remember(line: string, keep: number): void {
    this.recentChat.push(line);
    if (this.recentChat.length > keep) this.recentChat.splice(0, this.recentChat.length - keep);
  }

  /** Um pedido fechou: as mensagens que esperavam por ele saem da fila. */
  dropHeld(tag: string): void {
    this.held = this.held.filter((item) => item.tag !== tag);
  }

  /** A mensagem (talvez a que levava o contexto de abertura) não chegou: a próxima confere de novo. */
  forgetHistory(): void {
    this.history = undefined;
  }

  /** O dono pede uma conversa nova (botão "Nova conversa"): a próxima mensagem abre uma sessão limpa. */
  startNewConversation(): void {
    this.rotateDue = true;
  }

  /** A próxima mensagem abre uma conversa nova? */
  get newConversationDue(): boolean {
    return this.rotateDue;
  }

  /** Para de ouvir o terminal. */
  detach(): void {
    this.attached?.off();
    this.attached = undefined;
  }

  /** Por que o agente está indisponível agora (undefined = pode trabalhar). */
  blocked(): EngineBlock | undefined {
    return this.hooks.blocked();
  }

  /** O motor pode ter voltado: as mensagens que esperavam vão para a sessão, na ordem. */
  flushHeld(): void {
    if (this.hooks.isStopped() || this.held.length === 0 || this.blocked()) return;
    const held = this.held;
    this.held = [];
    for (const { tag, build } of held) {
      if (this.hooks.onResume && !this.hooks.onResume(tag)) continue;
      this.push(tag, build);
    }
  }

  /** Segura a mensagem até o motor voltar. */
  hold(tag: string, build: () => string, block: EngineBlock): void {
    const first = !this.held.some((item) => item.tag === tag);
    this.held.push({ tag, build });
    this.hooks.onHold?.(tag, first, block);
  }

  /**
   * Manda uma mensagem para a sessão. `tag` volta nos eventos do terminal. `source` pode ser uma
   * função: o texto só é montado quando a mensagem de fato vai (agora, depois do contexto de abertura,
   * ou quando o motor volta), então reflete o estado daquela hora e nunca uma foto velha.
   */
  push(tag: string, source: string | (() => string)): void {
    if (this.hooks.isStopped()) return;
    // Avisos guardados vão no fim da próxima mensagem que sair.
    const build = (): string => {
      const raw = typeof source === "function" ? source() : source;
      let message = this.notices.length > 0 ? `${raw}\n\n(Aviso do servidor: ${this.notices.join(" ")})` : raw;
      this.notices = [];
      // Novidades que o servidor sabe (o mural): só entram quando a mensagem de fato sai, e cada uma uma única vez.
      for (const extra of this.extras) {
        const text = extra().trim();
        if (text) message = `${message}\n\n(${text})`;
      }
      return message;
    };
    const block = this.blocked();
    if (block) {
      this.hold(tag, build, block);
      return;
    }
    let terminal: TerminalAgent;
    try {
      terminal = this.terminal();
    } catch (error) {
      this.hooks.onUnavailable?.(tag, error);
      return;
    }
    this.hooks.onQueued?.(tag);
    // Montando o contexto de uma conversa nova: esta mensagem vai depois, na ordem.
    if (this.priming) {
      this.afterPriming(() => terminal.send(build(), tag));
      return;
    }
    if (this.rotateDue) {
      this.rotateDue = false;
      this.rotate(terminal, tag, build);
      return;
    }
    const primer = this.hooks.primer;
    if (this.history === true || !primer || !terminal.hasHistory) {
      terminal.send(build(), tag);
      return;
    }
    // Conversa nova (ou não sei): o contexto de abertura vai antes da 1ª mensagem, uma vez por conversa.
    this.prime(terminal, async () => {
      const fresh = this.history === false || !(await terminal.hasHistory!());
      const context = fresh ? await primer() : "";
      const message = build();
      terminal.send(context && this.hooks.framePrimer ? this.hooks.framePrimer(context, message) : message, tag);
      if (context) this.hooks.log.info({ taskId: tag, chars: context.length }, `${this.hooks.label}: conversa nova com o contexto de abertura`);
    });
  }

  /**
   * Rotação (desligada por padrão; também o "Nova conversa" do dono): abre outra conversa (sessão
   * nova da CLI) com um resumo nosso no topo, sem chamada paga. A sessão nova é montada ANTES de
   * trocar: se o resumo não puder ser montado, a conversa antiga e a mensagem ficam como estão (e a
   * rotação tenta de novo na próxima). A mensagem fica no outbox até o terminal confirmar o turno.
   */
  private rotate(terminal: TerminalAgent, tag: string, build: () => string): void {
    this.prime(terminal, async () => {
      let seed: string | undefined;
      try {
        seed = this.hooks.seed(tag, (await this.hooks.primer?.()) ?? "");
      } catch (error) {
        this.hooks.log.error({ error: errorMessage(error) }, `${this.hooks.label}: não deu para montar a conversa nova; segue na antiga`);
      }
      const message = build();
      if (seed === undefined) {
        this.rotateDue = true;
        terminal.send(message, tag);
        return;
      }
      this.rotations += 1;
      this.outbox.set(tag, { message, retried: false });
      this.hooks.log.info({ taskId: tag, rotations: this.rotations }, `${this.hooks.label}: conversa renovada${seed ? " com resumo" : ""}`);
      terminal.send(seed ? `${seed}${CONVERSATION_SEPARATOR}${message}` : message, tag, { freshSession: true, sessionKey: `${this.hooks.sessionKeyPrefix}-${randomUUID()}` });
    });
  }

  /**
   * Eventos do terminal que dizem respeito ao outbox: `turn_start` confirma a mensagem da conversa
   * nova; `dropped` (o terminal desistiu dela) manda a MESMA mensagem de volta para a conversa
   * antiga, uma vez, e engole o evento (o pedido não falha por causa disso). true = engolido.
   */
  private confirm(terminal: TerminalAgent, event: TerminalEvent): boolean {
    if (event.type === "turn_start" && event.tag) {
      this.outbox.delete(event.tag);
      return false;
    }
    if (event.type !== "dropped" || !event.tag) return false;
    const entry = this.outbox.get(event.tag);
    if (!entry) return false;
    this.outbox.delete(event.tag);
    if (entry.retried) return false;
    this.rotations = Math.max(0, this.rotations - 1);
    this.rotateDue = true;
    this.hooks.log.error({ taskId: event.tag, reason: event.reason }, `${this.hooks.label}: a conversa nova não abriu; a mensagem volta para a antiga`);
    terminal.send(entry.message, event.tag);
    return true;
  }

  /** O terminal do dono, com o ouvinte que leva cada evento para quem cuida dos turnos. */
  terminal(): TerminalAgent {
    const { id, terminal } = this.hooks.locate();
    if (this.attached?.terminal !== terminal) {
      // Terminal novo (troca de motor, descarte): não sei se a conversa dele já tem o contexto de abertura.
      this.history = undefined;
      this.attached?.off();
      this.attached = { terminal, off: terminal.onEvent((event) => (this.confirm(terminal, event) ? undefined : this.hooks.onTerminalEvent(id, terminal, event))) };
    }
    return terminal;
  }

  /** Fim de um turno: conversa acima do teto marca a renovação (a próxima mensagem abre outra). */
  trackSize(contextTokens: number | undefined): void {
    const limit = this.hooks.rotateTokens();
    if (limit <= 0 || contextTokens === undefined || contextTokens < limit || this.rotateDue) return;
    this.rotateDue = true;
  }

  /** Roda `send` (que manda a 1ª mensagem de uma conversa) segurando as próximas até ele terminar. */
  private prime(terminal: TerminalAgent, send: () => Promise<void>): void {
    const run = (async () => {
      try {
        if (!this.hooks.isStopped()) await send();
      } catch (error) {
        this.hooks.log.error({ error: errorMessage(error) }, `${this.hooks.label}: falha ao montar o começo da conversa`);
      }
      // Daqui em diante a conversa tem histórico (o contexto foi junto); "dropped" desfaz.
      if (this.attached?.terminal === terminal) this.history = true;
    })();
    this.priming = run;
    void run.finally(() => {
      if (this.priming === run) this.priming = undefined;
    });
  }

  /** Manda depois do começo da conversa que está sendo montado (a ordem das mensagens não muda). */
  private afterPriming(send: () => void): void {
    const previous = this.priming!;
    const next = previous.then(() => {
      if (!this.hooks.isStopped()) send();
    });
    this.priming = next;
    void next.finally(() => {
      if (this.priming === next) this.priming = undefined;
    });
  }
}
