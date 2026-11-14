import { ASK_LIMITS, askRecordSchema, type AskRecord } from "@cyno/shared";
import { JsonRecords } from "./records";

/** Por que um `ask_cyno` foi barrado (a mensagem vai ao Maestro, em inglês, dizendo o que fazer). */
export class AskRefused extends Error {}

const HOUR_MS = 3_600_000;

/**
 * O livro dos pedidos de ajuda dos Maestros ao Cyno (`data/platform/asks.json`) e os limites contra laço:
 * poucas perguntas abertas por workspace, um teto por hora por workspace e na plataforma, e o Cyno
 * responde UMA vez por pergunta (continuar a conversa é abrir outra, que conta no limite).
 */
export class AskLedger {
  constructor(
    private readonly records: JsonRecords<AskRecord>,
    private readonly now: () => Date,
  ) {}

  static parse(raw: unknown): AskRecord | undefined {
    const parsed = askRecordSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  list(): AskRecord[] {
    return this.records.all();
  }

  get(id: string): AskRecord | undefined {
    return this.records.all().find((ask) => ask.id === id);
  }

  /** Perguntas abertas há mais que `expireMs`: viram `sem_resposta` (devolve as que mudaram para o aviso ao Maestro). */
  expire(): AskRecord[] {
    const limit = this.now().getTime() - ASK_LIMITS.expireMs;
    const expired = this.records.all().filter((ask) => ask.status === "aberto" && Date.parse(ask.createdAt) <= limit);
    for (const ask of expired) ask.status = "sem_resposta";
    if (expired.length > 0) this.records.save();
    return expired;
  }

  /** Abre a pergunta ou lança `AskRefused` com o motivo. */
  open(input: { workspace: string; requestId?: string; question: string; context?: string }): AskRecord {
    const all = this.records.all();
    const since = this.now().getTime() - HOUR_MS;
    const open = all.filter((ask) => ask.workspace === input.workspace && ask.status === "aberto");
    if (open.length >= ASK_LIMITS.openPerWorkspace) {
      throw new AskRefused(`This workspace already has ${open.length} open questions to the Cyno (${open.map((ask) => ask.id).join(", ")}). Wait for the answers (they arrive as messages) before asking again.`);
    }
    const recent = all.filter((ask) => ask.workspace === input.workspace && Date.parse(ask.createdAt) > since);
    if (recent.length >= ASK_LIMITS.perWorkspaceHour) {
      throw new AskRefused(`Limit reached: ${ASK_LIMITS.perWorkspaceHour} questions to the Cyno per hour for this workspace. Decide on your own, or ask the owner with ask_user.`);
    }
    if (all.filter((ask) => Date.parse(ask.createdAt) > since).length >= ASK_LIMITS.perHour) {
      throw new AskRefused(`The platform reached its limit of ${ASK_LIMITS.perHour} questions to the Cyno per hour. Decide on your own, or ask the owner with ask_user.`);
    }
    const at = this.now().toISOString();
    const next = all.reduce((max, ask) => Math.max(max, Number(ask.id.slice(2)) || 0), 0) + 1;
    const record = askRecordSchema.parse({
      id: `A-${String(next).padStart(4, "0")}`,
      workspace: input.workspace,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      kind: "help",
      message: input.question,
      ...(input.context ? { context: input.context } : {}),
      status: "aberto",
      createdAt: at,
    });
    this.records.add(record);
    return record;
  }

  /** Responde (uma vez). Devolve o registro, ou undefined se a pergunta não existe ou já foi fechada. */
  answer(id: string, text: string): AskRecord | undefined {
    const ask = this.get(id);
    if (!ask || ask.status !== "aberto") return undefined;
    ask.status = "respondido";
    ask.answer = text.slice(0, 4000);
    ask.answeredAt = this.now().toISOString();
    this.records.save();
    return ask;
  }
}
