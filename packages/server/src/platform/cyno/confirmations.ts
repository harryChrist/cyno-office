import { createHash } from "node:crypto";
import { CONFIRMATION_MAX_PENDING, CONFIRMATION_TTL_MS, confirmationSchema, type Confirmation, type DangerousAction } from "@cyno/shared";
import type { WriteQueue } from "../../store/write-queue";
import { HttpError } from "../http/errors";
import { JsonRecords } from "./records";

/** O que a ferramenta do Cyno entrega para registrar um pedido (tudo montado por código, menos `reason`). */
export type ConfirmationRequest = {
  action: DangerousAction;
  /** Os parâmetros exatos e já resolvidos (ids, não nomes); é o que será executado, e só isso. */
  params: Record<string, unknown>;
  summary: string;
  impact?: string;
  details?: string[];
  workspace?: string;
  /** O que o modelo disse (mostrado à parte, como "Cyno diz:"). */
  reason?: string;
  origin?: "cyno" | "biblioteca";
};

/** JSON com as chaves em ordem (o hash não depende da ordem em que os campos foram escritos). */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Hash de uma ação com os parâmetros: confirma que o que executa é o que foi gravado e mostrado. */
export function paramsHashOf(action: string, params: Record<string, unknown>): string {
  return createHash("sha256").update(stable({ action, params })).digest("hex");
}

/**
 * O livro das confirmações (`data/platform/cyno/confirmations.json`): grava os pedidos de ação perigosa,
 * cuida da validade (30 min) e das transições de estado. NÃO executa nada: quem executa é o `CynoStructure`,
 * chamado pela rota HTTP do dono. Ler (`list`) já marca como expiradas as que passaram da validade.
 */
export class ConfirmationBook {
  /** Chamado sempre que uma pendente vence (quem estiver olhando a lista no momento ou o relógio do servidor). */
  onExpired: ((expired: Confirmation[]) => void) | undefined;

  private constructor(
    private readonly records: JsonRecords<Confirmation>,
    private readonly now: () => Date,
  ) {}

  static async open(file: string, queue: WriteQueue, now: () => Date, onError?: (error: unknown) => void): Promise<ConfirmationBook> {
    const records = await JsonRecords.open<Confirmation>(
      file,
      queue,
      (raw) => {
        const parsed = confirmationSchema.safeParse(raw);
        return parsed.success ? parsed.data : undefined;
      },
      onError,
    );
    const book = new ConfirmationBook(records, now);
    // Autorizada que ficou no meio de uma execução (o servidor caiu): não sabemos o que aconteceu, então vira "falhou".
    for (const confirmation of records.all()) {
      if (confirmation.status === "autorizada") {
        confirmation.status = "falhou";
        confirmation.result = "O servidor reiniciou durante a execução: confira o estado e peça de novo se faltar.";
      }
    }
    book.sweep();
    return book;
  }

  /** Marca como expiradas as pendentes vencidas; devolve as que mudaram. */
  sweep(): Confirmation[] {
    const now = this.now().getTime();
    const expired = this.records.all().filter((confirmation) => confirmation.status === "pendente" && Date.parse(confirmation.expiresAt) <= now);
    for (const confirmation of expired) confirmation.status = "expirada";
    if (expired.length > 0) {
      this.records.save();
      this.onExpired?.(structuredClone(expired));
    }
    return expired;
  }

  /** As confirmações mais recentes por último (a lista recente que a tela mostra). */
  list(limit = 40): Confirmation[] {
    this.sweep();
    return structuredClone(this.records.all().slice(-limit));
  }

  pending(): Confirmation[] {
    this.sweep();
    return structuredClone(this.records.all().filter((confirmation) => confirmation.status === "pendente"));
  }

  get(id: string): Confirmation | undefined {
    this.sweep();
    const found = this.records.all().find((confirmation) => confirmation.id === id);
    return found ? structuredClone(found) : undefined;
  }

  /** Quando a próxima pendente vence (para o relógio do servidor), em ms; undefined sem pendentes. */
  nextExpiry(): number | undefined {
    const times = this.records.all().filter((confirmation) => confirmation.status === "pendente").map((confirmation) => Date.parse(confirmation.expiresAt));
    return times.length > 0 ? Math.min(...times) : undefined;
  }

  /**
   * Registra o pedido. O mesmo pedido (mesmos parâmetros) ainda pendente devolve o mesmo id, sem criar outro.
   * Lança `HttpError 409` com o motivo se já há `CONFIRMATION_MAX_PENDING` pendentes.
   */
  create(request: ConfirmationRequest): { confirmation: Confirmation; duplicate: boolean } {
    this.sweep();
    const paramsHash = paramsHashOf(request.action, request.params);
    const all = this.records.all();
    const same = all.find((confirmation) => confirmation.status === "pendente" && confirmation.paramsHash === paramsHash);
    if (same) return { confirmation: structuredClone(same), duplicate: true };
    const pending = all.filter((confirmation) => confirmation.status === "pendente");
    if (pending.length >= CONFIRMATION_MAX_PENDING) {
      throw new HttpError(409, `There are already ${pending.length} confirmations waiting for the owner (${pending.map((item) => item.id).join(", ")}). Wait for them to be decided before asking for more.`);
    }
    const at = this.now();
    const next = all.reduce((max, item) => Math.max(max, Number(item.id.slice(2)) || 0), 0) + 1;
    const confirmation = confirmationSchema.parse({
      id: `C-${String(next).padStart(4, "0")}`,
      action: request.action,
      params: request.params,
      paramsHash,
      summary: request.summary.slice(0, 600),
      impact: (request.impact ?? "").slice(0, 600),
      details: (request.details ?? []).map((line) => line.slice(0, 400)).slice(0, 30),
      ...(request.workspace ? { workspace: request.workspace } : {}),
      reason: (request.reason ?? "").slice(0, 600),
      status: "pendente",
      origin: request.origin ?? "cyno",
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + CONFIRMATION_TTL_MS).toISOString(),
    });
    this.records.add(confirmation);
    return { confirmation: structuredClone(confirmation), duplicate: false };
  }

  /**
   * Passa de "pendente" para "autorizada" (a execução vai começar) ou "recusada". Lança 404/409/410 com o
   * motivo se não dá: outra decisão já foi tomada, venceu a validade, ou os parâmetros gravados não batem com o hash.
   */
  decide(id: string, decision: "autorizada" | "recusada"): Confirmation {
    this.sweep();
    const found = this.records.all().find((confirmation) => confirmation.id === id);
    if (!found) throw new HttpError(404, "Confirmação não encontrada");
    if (found.status === "expirada") throw new HttpError(409, "Esta confirmação expirou (passou de 30 minutos). Peça de novo ao Cyno.");
    if (found.status !== "pendente") throw new HttpError(409, `Esta confirmação já foi decidida (${found.status}).`);
    if (decision === "autorizada" && paramsHashOf(found.action, found.params) !== found.paramsHash) {
      found.status = "falhou";
      found.decidedAt = this.now().toISOString();
      found.result = "Os parâmetros gravados não batem com o que foi mostrado: nada foi executado.";
      this.records.save();
      throw new HttpError(409, found.result);
    }
    found.status = decision;
    found.decidedAt = this.now().toISOString();
    this.records.save();
    return structuredClone(found);
  }

  /** Fecha uma autorizada com o resultado da execução. */
  finish(id: string, ok: boolean, result: string): Confirmation {
    const found = this.records.all().find((confirmation) => confirmation.id === id);
    if (!found) throw new HttpError(404, "Confirmação não encontrada");
    found.status = ok ? "executada" : "falhou";
    found.result = result.slice(0, 9000);
    this.records.save();
    return structuredClone(found);
  }
}
