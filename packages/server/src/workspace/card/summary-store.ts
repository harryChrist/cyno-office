import { readFile } from "node:fs/promises";
import { cardSummarySchema, CARD_SUMMARY_MAX, type CardSummary } from "@cyno/shared";
import { writeJsonAtomic } from "../../store/atomic-write";
import type { WriteQueue } from "../../store/write-queue";

/** Quem escreve a frase: o dono (a tela), o Maestro do workspace ou o Cyno. */
export type SummaryWriter = "dono" | "maestro" | "cyno";

export type SummaryWrite = { stored: "frase" | "sugestao" | "igual"; summary: CardSummary };

export type CardSummaryStoreDeps = { file: string; queue: WriteQueue; now: () => Date; log?: { warn: (obj: unknown, msg: string) => void } };

/**
 * A única parte da ficha escrita à mão: "o que este workspace faz" (até 280 caracteres), em
 * `card.json`. Fica em memória (lida uma vez ao abrir o workspace). O dono escreve sempre; uma IA
 * (Maestro ou Cyno) escreve só se não houver frase do dono: senão a frase dela vira uma SUGESTÃO
 * (`proposal`) que o dono aceita ou ignora no cartão.
 */
export class CardSummaryStore {
  private current: CardSummary = cardSummarySchema.parse({ summary: "" });
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: CardSummaryStoreDeps) {}

  static async open(deps: CardSummaryStoreDeps): Promise<CardSummaryStore> {
    const store = new CardSummaryStore(deps);
    try {
      const parsed = cardSummarySchema.safeParse(JSON.parse(await readFile(deps.file, "utf8")));
      if (parsed.success) store.current = parsed.data;
    } catch {
      // Sem arquivo (ou quebrado): sem frase.
    }
    return store;
  }

  get(): CardSummary {
    return this.current;
  }

  /** Avisa quando a frase (ou a sugestão) muda: a ficha recalcula. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Grava a frase (aparada, em uma linha). Mais de 280 caracteres, erro com a mensagem. */
  async write(text: string, by: SummaryWriter): Promise<SummaryWrite> {
    const summary = text.trim().replace(/\s+/g, " ");
    if (summary.length > CARD_SUMMARY_MAX) throw new Error(`A frase tem ${summary.length} caracteres; o máximo é ${CARD_SUMMARY_MAX}`);
    const at = this.deps.now().toISOString();
    const before = this.current;
    if (summary === before.summary && !before.proposal) return { stored: "igual", summary: before };
    // IA nunca sobrescreve a frase do dono: vira sugestão.
    if (by !== "dono" && before.summary && before.by === "dono") {
      if (summary === before.summary || before.proposal?.summary === summary) return { stored: "igual", summary: before };
      return this.save({ ...before, proposal: { summary, by, at } }, "sugestao");
    }
    const { proposal: _dropped, ...rest } = before;
    return this.save({ ...rest, summary, by, at }, "frase");
  }

  /** O dono descarta a sugestão de uma IA. */
  async dismissProposal(): Promise<CardSummary> {
    const { proposal: _dropped, ...rest } = this.current;
    return (await this.save(rest, "frase")).summary;
  }

  private async save(next: CardSummary, stored: SummaryWrite["stored"]): Promise<SummaryWrite> {
    this.current = next;
    try {
      await this.deps.queue.enqueue(() => writeJsonAtomic(this.deps.file, next));
    } catch (error) {
      // Workspace removido no meio: a frase some junto com a pasta.
      this.deps.log?.warn({ err: error }, "não foi possível gravar card.json");
    }
    for (const listener of [...this.listeners]) listener();
    return { stored, summary: next };
  }
}
