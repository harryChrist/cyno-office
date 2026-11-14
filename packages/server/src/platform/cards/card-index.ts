import { pendingForYou, waitingHref, type Card, type ForYouItem, type ServerEvent, type UsageRecord, type WaitingItem } from "@cyno/shared";
import { buildCard, CARD_METRICS_WINDOW_MS, type CardInput } from "./card";
import { diffFacts, factsMapOf, renderDigest, type FactsMap } from "./compact";

/** Debounce padrão do recálculo (ms): uma rajada de eventos vira um recálculo só. */
export const CARD_DEBOUNCE_MS = 2000;

/** Eventos que não mudam a ficha (e chegam aos montes): não marcam o workspace como sujo. */
const IGNORED_EVENTS: ReadonlySet<ServerEvent["type"]> = new Set(["agent:log", "agent:chat-status", "activity:appended", "task:progress", "usage:agents", "connector:activity", "browser:tabs", "browser:activity", "sync:resumed"]);

/** Um workspace como o índice o enxerga (o `CynoService` monta um por runtime; os testes usam falsos). */
export type CardSource = {
  id: string;
  name: string;
  /** O barramento de eventos do workspace. */
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  /** A frase (ou a sugestão) mudou. */
  onSummaryChange: (listener: () => void) => () => void;
  /** Tudo o que a ficha lê, tirado dos serviços na hora. */
  read: () => Omit<CardInput, "now" | "workspace" | "name">;
  /** O gasto desde `fromMs` (assíncrono, vem do disco): o índice guarda a última leitura e recalcula a ficha quando ela muda (o bloco de gasto da Gestão). */
  usage?: (fromMs: number) => Promise<readonly UsageRecord[]>;
};

export type CardIndexDeps = {
  sources: () => CardSource[];
  /** Avisa quando a lista de workspaces muda (criou, renomeou, excluiu). */
  subscribeList: (listener: () => void) => () => void;
  now: () => Date;
  debounceMs?: number;
  /** O cursor do delta mudou (digest ou delta): quem chama grava em disco para sobreviver a um reinício. */
  onSeen?: (seen: FactsMap) => void;
};

/** A ficha sem o carimbo de hora (para saber se mudou de verdade). */
const stable = (card: Card): string => JSON.stringify({ ...card, updatedAt: undefined });

/**
 * O índice das fichas, calculado por código (sem IA). Assina o barramento de cada workspace, marca o
 * workspace como sujo quando algo relevante muda e recalcula com debounce (a conta é pura, em
 * memória, ~1 ms). Só avisa (`cards:changed`) quando a ficha mudou de verdade. Nada vai para o disco
 * (a frase tem o próprio arquivo); no boot tudo é recalculado.
 */
export class CardIndex {
  private readonly cache = new Map<string, Card>();
  private readonly watching = new Map<string, () => void>();
  private readonly dirty = new Set<string>();
  private readonly listeners = new Set<(workspaces: string[]) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private offList: (() => void) | undefined;
  private closed = false;
  /** O que o Cyno viu da última vez (para o delta nas mensagens seguintes). */
  private seen: FactsMap | undefined;
  /** A última leitura do gasto de cada workspace (a ficha é calculada na hora, em memória; o gasto vem do disco, de forma assíncrona) e a assinatura dela. */
  private readonly usage = new Map<string, { records: readonly UsageRecord[]; signature: string }>();

  constructor(private readonly deps: CardIndexDeps) {}

  /** Começa a ouvir a lista de workspaces (só na primeira leitura: sem ninguém olhando as fichas, nada é assinado). */
  start(): void {
    this.offList ??= this.deps.subscribeList(() => {
      this.sync();
      this.schedule();
    });
    this.sync();
  }

  /** Todas as fichas (recalcula na hora o que estiver sujo ou ainda não calculado). */
  cards(): Card[] {
    this.start();
    this.flush();
    return this.deps.sources().flatMap((source) => this.cache.get(source.id) ?? []);
  }

  card(workspace: string): Card | undefined {
    return this.cards().find((card) => card.workspace === workspace);
  }

  /** O que espera o dono em todos os workspaces, do mais antigo ao mais novo, cada item com o destino. */
  waiting(pending: (workspace: string) => { item: ForYouItem; agent?: string }[]): WaitingItem[] {
    const items: WaitingItem[] = [];
    for (const source of this.deps.sources()) {
      for (const { item, agent } of pending(source.id)) {
        items.push({
          workspace: source.id,
          workspaceName: source.name,
          id: item.id,
          type: item.type,
          ...(item.kind ? { kind: item.kind } : {}),
          title: item.title ?? ([item.where, item.to].filter(Boolean).join(" · ") || item.type),
          ...(agent ? { agent } : {}),
          at: item.createdAt,
          href: waitingHref(source.id),
        });
      }
    }
    return items.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  /** Ouvinte das mudanças (recebe os ids dos workspaces cuja ficha mudou). */
  subscribe(listener: (workspaces: string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------- Contexto do Cyno ----------

  /** O digest de todas as fichas (abre a conversa) e lembra o que foi mostrado. */
  digest(): string {
    const cards = this.cards();
    this.seen = factsMapOf(cards);
    this.deps.onSeen?.(this.seen);
    return renderDigest(cards);
  }

  /** O que mudou desde o último digest/delta, em linhas (vazio = nada mudou). Avança o cursor. */
  delta(): string[] {
    const cards = this.cards();
    const after = factsMapOf(cards);
    const lines = this.seen ? diffFacts(this.seen, after) : [];
    this.seen = after;
    this.deps.onSeen?.(after);
    return lines;
  }

  /** Depois de um reinício: volta o cursor de onde estava (o delta da próxima mensagem mostra o que mudou na queda). */
  restoreSeen(seen: FactsMap): void {
    this.seen = seen;
  }

  /** O Cyno ainda não viu nenhuma ficha nesta conversa. */
  get unseen(): boolean {
    return this.seen === undefined;
  }

  /** A próxima mensagem leva o digest inteiro (conversa nova). */
  forgetSeen(): void {
    this.seen = undefined;
  }

  // ---------- Internos ----------

  /** Casa as assinaturas com a lista atual de workspaces. */
  sync(): void {
    if (this.closed) return;
    const sources = this.deps.sources();
    const ids = new Set(sources.map((source) => source.id));
    for (const [id, off] of this.watching) {
      if (ids.has(id)) continue;
      off();
      this.watching.delete(id);
      this.usage.delete(id);
      this.cache.delete(id);
      this.dirty.delete(id);
      this.emit([id]);
    }
    for (const source of sources) {
      if (this.watching.has(source.id)) continue;
      const offEvents = source.subscribe((event) => {
        if (!IGNORED_EVENTS.has(event.type)) this.mark(source.id);
      });
      const offSummary = source.onSummaryChange(() => this.mark(source.id));
      this.watching.set(source.id, () => {
        offEvents();
        offSummary();
      });
      this.dirty.add(source.id);
    }
    // Nome mudou (renomear): a ficha precisa recalcular.
    for (const source of sources) {
      const card = this.cache.get(source.id);
      if (card && card.name !== source.name) this.mark(source.id);
    }
  }

  private mark(workspace: string): void {
    if (this.closed) return;
    this.dirty.add(workspace);
    this.schedule();
  }

  private schedule(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.deps.debounceMs ?? CARD_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /** Recalcula os sujos e avisa os ouvintes dos que mudaram de verdade. */
  private flush(): void {
    if (this.closed || this.dirty.size === 0) return;
    const now = this.deps.now();
    const changed: string[] = [];
    const byId = new Map(this.deps.sources().map((source) => [source.id, source]));
    for (const id of [...this.dirty]) {
      this.dirty.delete(id);
      const source = byId.get(id);
      if (!source) continue;
      const read = source.read();
      const next = buildCard({ ...read, ...(read.metrics ? { metrics: { ...read.metrics, usage: [...(this.usage.get(id)?.records ?? [])] } } : {}), workspace: source.id, name: source.name, now });
      if (read.metrics && source.usage) void this.refreshUsage(source, now.getTime());
      const before = this.cache.get(id);
      this.cache.set(id, next);
      if (!before || stable(before) !== stable(next)) changed.push(id);
    }
    if (this.timer && this.dirty.size === 0) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // Uma leitura (`cards()`) que recalculou algo também avisa quem está de olho (a tela já pode estar velha).
    if (changed.length > 0) this.emit(changed);
  }

  /** Relê o gasto da semana; se mudou, marca o workspace para recalcular (com o debounce de sempre). Uma leitura igual não faz nada, então não vira laço. */
  private async refreshUsage(source: CardSource, now: number): Promise<void> {
    try {
      const records = await source.usage!(now - CARD_METRICS_WINDOW_MS);
      if (this.closed) return;
      const last = records.at(-1);
      const signature = `${records.length}:${last?.id ?? ""}:${last?.at ?? ""}`;
      if (this.usage.get(source.id)?.signature === signature) return;
      this.usage.set(source.id, { records, signature });
      this.mark(source.id);
    } catch {
      // Sem o gasto a ficha só fica sem esse número: nada a fazer.
    }
  }

  private emit(workspaces: string[]): void {
    for (const listener of [...this.listeners]) listener(workspaces);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.offList?.();
    for (const off of this.watching.values()) off();
    this.watching.clear();
    this.listeners.clear();
  }
}

/** Itens pendentes de um workspace com o nome do agente que pediu (para o "Esperando você"). */
export function pendingWithAgents(items: readonly ForYouItem[], agentName: (agentId: string) => string | undefined): { item: ForYouItem; agent?: string }[] {
  return pendingForYou(items).map((item) => {
    const agent = agentName(item.agentId);
    return { item, ...(agent ? { agent } : {}) };
  });
}
