import { randomUUID } from "node:crypto";
import { UNSEQUENCED_EVENT_TYPES, type ServerEvent } from "@cyno/shared";

/** Número de ordem do evento no hub e a mensagem pronta para o WebSocket (`{...evento, seq}`). */
export type SequencedMeta = { seq: number; wire: string };

/** `meta` só vem nos hubs com histórico e nos eventos que entram nele (os só visuais não entram). */
export type ServerEventListener = (event: ServerEvent, meta?: SequencedMeta) => void;

/** Quanto o histórico da reconexão guarda (o que passar de qualquer um dos limites sai, o mais antigo primeiro). */
export type HubJournalOptions = {
  maxEvents: number;
  maxAgeMs: number;
  /** Teto em bytes (soma das mensagens serializadas). */
  maxBytes: number;
  now?: () => number;
};

/** Histórico padrão de cada workspace: 5000 eventos, 10 min ou 8 MiB, o que vier primeiro. */
export const DEFAULT_HUB_JOURNAL: HubJournalOptions = { maxEvents: 5000, maxAgeMs: 10 * 60_000, maxBytes: 8 * 1024 * 1024 };

type JournalEntry = SequencedMeta & { at: number };

/**
 * Barramento de eventos: toda mudança de estado é publicada aqui e sai pelo WebSocket.
 *
 * Com `journal`, cada evento ganha um `seq` crescente e fica num histórico em memória limitado: um
 * cliente que caiu (reinício do Wi-Fi, aba em segundo plano) reconecta com `since=<último seq>` e
 * recebe só o que perdeu (`replaySince`). `epoch` identifica este hub: muda a cada boot do server
 * (e a cada vez que o workspace é aberto), então um `seq` de outro epoch não vale aqui.
 */
export class EventHub {
  readonly epoch: string = randomUUID();
  private readonly listeners = new Set<ServerEventListener>();
  private readonly journalOptions: HubJournalOptions | null;
  private readonly now: () => number;
  /** Histórico; as entradas antes de `head` já saíram (compacta de vez em quando, não a cada evento). */
  private journal: JournalEntry[] = [];
  private head = 0;
  private journalBytes = 0;
  private lastSeq = 0;

  constructor(options: { journal?: HubJournalOptions } = {}) {
    this.journalOptions = options.journal ?? null;
    this.now = options.journal?.now ?? Date.now;
  }

  subscribe(listener: ServerEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: ServerEvent): void {
    const meta = this.record(event);
    for (const listener of this.listeners) listener(event, meta);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** `seq` do último evento publicado (0 = nenhum ainda). */
  get seq(): number {
    return this.lastSeq;
  }

  /** Quantos eventos o histórico guarda agora (testes e diagnóstico). */
  get journalSize(): number {
    return this.journal.length - this.head;
  }

  /**
   * Os eventos publicados depois de `since` neste epoch, em ordem (vazio = nada perdido). null quando
   * não dá para garantir a sequência inteira: outro epoch (server reiniciou), `since` à frente do
   * hub, sem histórico, ou o histórico já descartou algum evento depois de `since`. Aí o cliente
   * precisa do snapshot completo.
   */
  replaySince(epoch: string, since: number): SequencedMeta[] | null {
    if (!this.journalOptions || epoch !== this.epoch || !Number.isInteger(since) || since < 0 || since > this.lastSeq) return null;
    this.prune();
    if (since === this.lastSeq) return [];
    const first = this.journal[this.head];
    if (!first || first.seq > since + 1) return null;
    const start = this.head + since + 1 - first.seq;
    return this.journal.slice(start).map(({ seq, wire }) => ({ seq, wire }));
  }

  private record(event: ServerEvent): SequencedMeta | undefined {
    if (!this.journalOptions || UNSEQUENCED_EVENT_TYPES.has(event.type)) return undefined;
    const seq = ++this.lastSeq;
    const entry: JournalEntry = { seq, wire: JSON.stringify({ ...event, seq }), at: this.now() };
    this.journal.push(entry);
    this.journalBytes += entry.wire.length;
    this.prune();
    return { seq, wire: entry.wire };
  }

  /** Tira do começo o que passou do tamanho, da idade ou dos bytes. */
  private prune(): void {
    const options = this.journalOptions;
    if (!options) return;
    const oldest = this.now() - options.maxAgeMs;
    while (
      this.head < this.journal.length &&
      (this.journal.length - this.head > options.maxEvents || this.journalBytes > options.maxBytes || this.journal[this.head]!.at < oldest)
    ) {
      this.journalBytes -= this.journal[this.head]!.wire.length;
      this.head += 1;
    }
    if (this.head > 1024 && this.head * 2 > this.journal.length) {
      this.journal = this.journal.slice(this.head);
      this.head = 0;
    }
  }
}
