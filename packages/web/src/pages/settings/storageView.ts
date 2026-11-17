import type { StorageFolder, StoragePart, StorageState } from "@cyno/shared";
import { countLabel, formatDateTime } from "../../ui/format";
import { formatBytes } from "./settingsView";

/** Intervalo entre as consultas enquanto alguma medição está rodando. */
export const STORAGE_POLL_MS = 3000;

type Measured = { bytes: number; files: number; state: StorageState; computedAt: string | null };

/** O que a linha mostra: "1,2 GB", "calculando…" (ainda sem número) ou "sem acesso". Com número velho e remedindo, mostra o velho. */
export function storageLabel(info: Pick<Measured, "bytes" | "state" | "computedAt">): string {
  if (info.state === "error") return "sem acesso";
  if (info.state === "computing" && info.computedAt === null) return "calculando…";
  return formatBytes(info.bytes);
}

/** Texto do title: número de arquivos e quando foi medido. */
export function storageTitle(info: Measured, now: Date = new Date()): string {
  if (info.state === "error") return "Não foi possível ler esta pasta (talvez ela não exista mais ou falte permissão).";
  if (info.state === "computing" && info.computedAt === null) return "Medindo a pasta em segundo plano. Pastas grandes podem levar alguns segundos.";
  const files = countLabel(info.files, "arquivo", "arquivos");
  const when = info.computedAt ? `medido em ${formatDateTime(info.computedAt, now)}` : "";
  return [files, when, info.state === "computing" ? "atualizando…" : ""].filter(Boolean).join(" · ");
}

/** Há alguma medição em andamento (a tela consulta de novo enquanto isso for verdade). */
export function anyComputing(data: { workspace: Pick<Measured, "state">; folders: Pick<StorageFolder, "state">[] } | null): boolean {
  return !!data && (data.workspace.state === "computing" || data.folders.some((folder) => folder.state === "computing"));
}

/** Soma das pastas de trabalho já medidas (as que ainda não têm número ficam de fora; `pending` diz quantas faltam). */
export function foldersTotal(folders: Pick<StorageFolder, "bytes" | "state" | "computedAt">[]): { bytes: number; pending: number; failed: number } {
  let bytes = 0;
  let pending = 0;
  let failed = 0;
  for (const folder of folders) {
    if (folder.state === "error") failed += 1;
    else if (folder.state === "computing" && folder.computedAt === null) pending += 1;
    else bytes += folder.bytes;
  }
  return { bytes, pending, failed };
}

/** Partes da barra: só as que têm bytes, com a fração (de 0 a 1) do total das partes. */
export function barSegments(parts: StoragePart[]): { id: StoragePart["id"]; label: string; bytes: number; share: number }[] {
  const total = parts.reduce((sum, part) => sum + part.bytes, 0);
  return parts.filter((part) => part.bytes > 0).map((part) => ({ id: part.id, label: part.label, bytes: part.bytes, share: total > 0 ? part.bytes / total : 0 }));
}

/** "34%" / "<1%" para a legenda. */
export function shareLabel(share: number): string {
  const pct = share * 100;
  return pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}
