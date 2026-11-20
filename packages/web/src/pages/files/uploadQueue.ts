import { FILE_LIMITS, fileNameError, fileSizeLabel } from "@cyno/shared";

/**
 * A fila de envio da página "Arquivos", sem React nem rede: um arquivo por vez, pula o que não pode ir, pergunta o
 * que fazer com nome repetido (409) e para quando cancelam. Quem envia de verdade entra por `send`.
 */

export type UploadCandidate = { name: string; size: number };

/** Por que o arquivo nem começa a ser enviado (nome inválido ou trancado, grande demais), ou null se pode ir. */
export function uploadSkipReason(file: UploadCandidate): string | null {
  const problem = fileNameError(file.name, "file");
  if (problem) return problem;
  if (file.size > FILE_LIMITS.uploadBytes) return `Passa de ${fileSizeLabel(FILE_LIMITS.uploadBytes)}.`;
  return null;
}

export type ReplaceChoice = { action: "replace" | "skip"; /** "Fazer o mesmo para os próximos". */ all: boolean };

export type UploadProgress = { /** Posição entre os que vão ser enviados (1 a total). */ index: number; total: number; name: string; fraction: number };

export type UploadDeps<T extends UploadCandidate> = {
  send: (file: T, overwrite: boolean, onProgress: (fraction: number) => void, signal: AbortSignal) => Promise<void>;
  askReplace: (name: string) => Promise<ReplaceChoice>;
  onProgress: (progress: UploadProgress) => void;
  /** Mensagem de um erro (padrão: a do próprio erro). */
  describe?: (error: unknown) => string;
};

export type UploadSummary = {
  sent: number;
  skipped: Array<{ name: string; reason: string }>;
  failed: Array<{ name: string; message: string }>;
  cancelled: boolean;
};

const isConflict = (error: unknown): boolean => typeof error === "object" && error !== null && (error as { status?: unknown }).status === 409;

export async function runUploadQueue<T extends UploadCandidate>(files: readonly T[], deps: UploadDeps<T>, signal: AbortSignal): Promise<UploadSummary> {
  const describe = deps.describe ?? ((error: unknown) => (error instanceof Error ? error.message : String(error)));
  const summary: UploadSummary = { sent: 0, skipped: [], failed: [], cancelled: false };
  const queue: T[] = [];
  for (const file of files) {
    const reason = uploadSkipReason(file);
    if (reason) summary.skipped.push({ name: file.name, reason });
    else queue.push(file);
  }
  let standing: "replace" | "skip" | null = null;
  for (let at = 0; at < queue.length; at += 1) {
    const file = queue[at]!;
    if (signal.aborted) break;
    const report = (fraction: number) => deps.onProgress({ index: at + 1, total: queue.length, name: file.name, fraction });
    report(0);
    try {
      await deps.send(file, false, report, signal);
      summary.sent += 1;
      continue;
    } catch (error) {
      if (signal.aborted) break;
      if (!isConflict(error)) {
        summary.failed.push({ name: file.name, message: describe(error) });
        continue;
      }
    }
    const choice: ReplaceChoice = standing ? { action: standing, all: true } : await deps.askReplace(file.name);
    if (signal.aborted) break;
    if (choice.all) standing = choice.action;
    if (choice.action === "skip") {
      summary.skipped.push({ name: file.name, reason: "Já existe um arquivo com esse nome." });
      continue;
    }
    try {
      await deps.send(file, true, report, signal);
      summary.sent += 1;
    } catch (error) {
      if (signal.aborted) break;
      summary.failed.push({ name: file.name, message: describe(error) });
    }
  }
  summary.cancelled = signal.aborted;
  return summary;
}

/** A frase do fim do envio ("5 arquivos enviados", com o que ficou de fora). */
export function uploadSummaryText(summary: UploadSummary): string {
  const parts: string[] = [];
  if (summary.sent > 0) parts.push(summary.sent === 1 ? "1 arquivo enviado" : `${summary.sent} arquivos enviados`);
  else if (summary.cancelled) parts.push("Envio cancelado");
  else if (summary.skipped.length + summary.failed.length === 0) parts.push("Nada para enviar");
  if (summary.sent > 0 && summary.cancelled) parts.push("o resto foi cancelado");
  if (summary.skipped.length > 0) parts.push(summary.skipped.length === 1 ? "1 pulado" : `${summary.skipped.length} pulados`);
  if (summary.failed.length > 0) parts.push(summary.failed.length === 1 ? "1 com erro" : `${summary.failed.length} com erro`);
  return parts.join(", ");
}
