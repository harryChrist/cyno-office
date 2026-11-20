import { isScriptRunning, SCRIPT_STATUS_LABELS, SCRIPT_STOPPER_LABELS, scriptDurationLabel, type ScriptRun, type ScriptStatus } from "@cyno/shared";

/** Colunas lógicas do terminal de leitura: as mesmas do PTY do script no servidor (nada se re-quebra). */
export const SCRIPT_TERMINAL_COLS = 120;
/** Linhas guardadas no xterm. */
export const SCRIPT_SCROLLBACK = 50_000;
/** De quanto em quanto tempo a saída é lida enquanto o script roda (ms). */
export const SCRIPT_POLL_MS = 1000;

// ---------- Endereço ----------

/**
 * O script aberto vem no endereço: `#/<ws>/scripts/<id>` (a aba da página é o id). Sem id, a lista.
 * `sub` é o que o navStore guarda depois da página.
 */
export function parseScriptSub(sub: string | undefined): string | null {
  const first = (sub ?? "").split("?")[0]!.split("/")[0] ?? "";
  let decoded = first;
  try {
    decoded = decodeURIComponent(first);
  } catch {
    // mantém o texto cru
  }
  return /^s\d{1,7}$/.test(decoded) ? decoded : null;
}

// ---------- Lista ----------

/** Mais novo primeiro (pelo início; o id desempata, já que "s10" é depois de "s9"). */
export function byNewest(a: ScriptRun, b: ScriptRun): number {
  const diff = Date.parse(b.startedAt) - Date.parse(a.startedAt);
  if (diff !== 0 && !Number.isNaN(diff)) return diff;
  return Number(b.id.slice(1)) - Number(a.id.slice(1));
}

/** "Rodando agora" primeiro e, depois, "Terminados" (os dois do mais novo para o mais velho). */
export function groupRuns(runs: readonly ScriptRun[]): { running: ScriptRun[]; finished: ScriptRun[] } {
  const sorted = [...runs].sort(byNewest);
  return { running: sorted.filter(isScriptRunning), finished: sorted.filter((run) => !isScriptRunning(run)) };
}

export function runningCount(runs: readonly ScriptRun[]): number {
  return runs.filter(isScriptRunning).length;
}

/** Os que rodam agora de um agente, do mais novo para o mais velho. */
export function runningOfAgent(runs: readonly ScriptRun[], agentId: string): ScriptRun[] {
  return runs.filter((run) => run.agentId === agentId && isScriptRunning(run)).sort(byNewest);
}

/** Troca (ou inclui) um script na lista; a lista segue ordenada do mais novo para o mais velho. */
export function upsertRun(runs: readonly ScriptRun[], run: ScriptRun): ScriptRun[] {
  return [...runs.filter((candidate) => candidate.id !== run.id), run].sort(byNewest);
}

export function removeRun(runs: readonly ScriptRun[], id: string): ScriptRun[] {
  return runs.filter((run) => run.id !== id);
}

// ---------- Rótulos ----------

export type StatusTone = "live" | "ok" | "danger" | "warn" | "muted";

const STATUS_TONES: Record<ScriptStatus, StatusTone> = { running: "live", done: "ok", failed: "danger", stopped: "muted", timeout: "warn", lost: "warn" };
export const statusTone = (status: ScriptStatus): StatusTone => STATUS_TONES[status];

/** O texto do estado: "Rodando", "Parado por você", "Terminou com erro (código 2)". */
export function statusText(run: Pick<ScriptRun, "status" | "stoppedBy" | "exitCode">): string {
  if (run.status === "stopped" && run.stoppedBy) return SCRIPT_STOPPER_LABELS[run.stoppedBy];
  if (run.status === "failed" && typeof run.exitCode === "number") return `${SCRIPT_STATUS_LABELS.failed} (código ${run.exitCode})`;
  return SCRIPT_STATUS_LABELS[run.status];
}

export function durationText(run: Pick<ScriptRun, "startedAt" | "endedAt">, now: number): string {
  return scriptDurationLabel(run.startedAt, run.endedAt, now);
}

/** Tamanho da saída ("0 B", "12 KB", "1,5 MB"). */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const format = (value: number) => (value >= 10 ? Math.round(value).toString() : value.toFixed(1).replace(".", ","));
  if (bytes < 1024 * 1024) return `${format(bytes / 1024)} KB`;
  return `${format(bytes / (1024 * 1024))} MB`;
}

export const TRUNCATED_NOTICE = "A saída passou do limite e o resto não foi guardado";
export const LOST_NOTICE = "O Cyno reiniciou enquanto este script rodava";

/** Avisos do cabeçalho do visualizador. */
export function runNotices(run: Pick<ScriptRun, "truncated" | "status">): string[] {
  return [...(run.truncated ? [TRUNCATED_NOTICE] : []), ...(run.status === "lost" ? [LOST_NOTICE] : [])];
}

/** O texto da contagem do chip do agente: "1 script rodando", "2 scripts rodando". */
export function runningChipLabel(count: number): string {
  return `${count} ${count === 1 ? "script rodando" : "scripts rodando"}`;
}
