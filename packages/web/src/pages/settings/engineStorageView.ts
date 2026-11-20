import { ENGINE_STORAGE_DAY_OPTIONS, type EngineStorageCleanupResult, type EngineStorageItem, type EngineStoragePreview, type EngineStorageRemoval, type EngineStorageSettings, type EngineStorageUsage } from "@cyno/shared";
import { countLabel, formatDateTime } from "../../ui/format";
import { formatBytes } from "./settingsView";

/** Lógica pura da seção "Armazenamento dos motores" (a tela só desenha). */

/** "Nunca", "7 dias"... (0 = nunca apagar sozinho). */
export function daysLabel(days: number): string {
  return days <= 0 ? "Nunca" : `${days} dias`;
}

/** Opções do seletor "Apagar sozinho depois de": as da API (e o valor atual, se vier algo fora da lista). */
export function dayChoices(current: number): { value: number; label: string }[] {
  const values: number[] = [...ENGINE_STORAGE_DAY_OPTIONS];
  if (!values.includes(current)) values.push(current);
  return values.map((value) => ({ value, label: daysLabel(value) }));
}

/** "1,2 MB · 8 arquivos". */
export function itemText(item: EngineStorageItem): string {
  return `${formatBytes(item.bytes)} · ${countLabel(item.files, "arquivo", "arquivos")}`;
}

/** "Mais antigo: 03/11 10:00" (vazio quando não há arquivo). */
export function oldestText(item: EngineStorageItem): string | null {
  return item.oldestAt ? `Mais antigo: ${formatDateTime(item.oldestAt)}` : null;
}

/** Texto do que sairia (ou saiu): "3 arquivos, 1,2 MB"; vazio quando nada. */
export function removalText(removal: EngineStorageRemoval): string {
  return `${countLabel(removal.files, "arquivo", "arquivos")}, ${formatBytes(removal.bytes)}`;
}

/** Soma do que sairia. */
export function removalTotal(removal: EngineStoragePreview): EngineStorageRemoval {
  return { files: removal.antigravityLogs.files + removal.freebuffChats.files, bytes: removal.antigravityLogs.bytes + removal.freebuffChats.bytes };
}

/** Existe algo ligado para limpar? (Tudo em "Nunca" = nada a fazer.) */
export function anyCleanupOn(settings: EngineStorageSettings): boolean {
  return settings.antigravityLogsDays > 0 || settings.freebuffChatsDays > 0;
}

/** O que a confirmação mostra: as linhas (só o que sairia) e o total. */
export function previewLines(preview: EngineStoragePreview): { label: string; text: string }[] {
  const lines: { label: string; text: string }[] = [];
  if (preview.antigravityLogs.files > 0) lines.push({ label: "Logs do Antigravity", text: removalText(preview.antigravityLogs) });
  if (preview.freebuffChats.files > 0) lines.push({ label: "Chats dos agentes no Freebuff", text: removalText(preview.freebuffChats) });
  return lines;
}

/** Texto do resultado da limpeza. */
export function cleanupResultText(result: EngineStorageCleanupResult): string {
  const total = removalTotal(result);
  if (total.files === 0) return "Nada para apagar.";
  return `${countLabel(total.files, "arquivo apagado", "arquivos apagados")}, ${formatBytes(total.bytes)} liberados.`;
}

/** Última limpeza, em uma linha. */
export function lastCleanupText(last: EngineStorageCleanupResult | null): string {
  if (!last) return "Nenhuma limpeza ainda.";
  const total = removalTotal(last);
  return `Última limpeza: ${formatDateTime(last.at)} · ${total.files === 0 ? "nada para apagar" : `${countLabel(total.files, "arquivo apagado", "arquivos apagados")} (${formatBytes(total.bytes)})`}`;
}

export type EngineStorageRow = {
  id: "claude" | "antigravity" | "freebuff" | "hermes" | "openclaw";
  title: string;
  /** Tamanho total do motor (a soma dos seus itens). */
  total: EngineStorageItem;
  items: EngineStorageRowItem[];
};

export type EngineStorageRowItem = {
  id: string;
  label: string;
  usage: EngineStorageItem;
  /** Nota curta embaixo do item. */
  note: string;
  /** Qual ajuste manda neste item (só os que têm limpeza). */
  setting?: keyof EngineStorageSettings;
};

const sumItems = (items: EngineStorageItem[]): EngineStorageItem => {
  const oldest = items.map((item) => item.oldestAt).filter((value): value is string => value !== null).sort()[0] ?? null;
  return { bytes: items.reduce((sum, item) => sum + item.bytes, 0), files: items.reduce((sum, item) => sum + item.files, 0), oldestAt: oldest };
};

/** Uma linha por motor, na ordem da tela. */
export function engineRows(usage: EngineStorageUsage): EngineStorageRow[] {
  const hermesRest: EngineStorageItem = {
    bytes: Math.max(0, usage.hermes.total.bytes - usage.hermes.cache.bytes),
    files: Math.max(0, usage.hermes.total.files - usage.hermes.cache.files),
    oldestAt: usage.hermes.total.oldestAt,
  };
  return [
    {
      id: "claude",
      title: "Claude Code",
      total: usage.claude,
      items: [{ id: "claude-sessoes", label: "Conversas dos agentes", usage: usage.claude, note: "Gerenciado em Histórico" }],
    },
    {
      id: "antigravity",
      title: "Antigravity",
      total: sumItems([usage.antigravity.logs, usage.antigravity.conversations]),
      items: [
        { id: "antigravity-logs", label: "Logs", usage: usage.antigravity.logs, note: "Só logs de diagnóstico antigos, inclusive os do seu uso pessoal. As conversas não são tocadas.", setting: "antigravityLogsDays" },
        { id: "antigravity-conversas", label: "Conversas", usage: usage.antigravity.conversations, note: "Sem limpeza oficial do motor; inclui as suas conversas" },
      ],
    },
    {
      id: "freebuff",
      title: "Freebuff",
      total: usage.freebuff.chats,
      items: [{ id: "freebuff-chats", label: "Chats dos agentes", usage: usage.freebuff.chats, note: "Só os chats dos agentes do Cyno.", setting: "freebuffChatsDays" }],
    },
    {
      id: "hermes",
      title: "Hermes",
      total: usage.hermes.total,
      items: [
        { id: "hermes-cache", label: "Cache", usage: usage.hermes.cache, note: "O motor cuida do próprio histórico" },
        { id: "hermes-resto", label: "Ambiente instalado", usage: hermesRest, note: "Ambiente instalado" },
      ],
    },
    {
      id: "openclaw",
      title: "OpenClaw",
      total: usage.openclaw,
      items: [{ id: "openclaw-estado", label: "Estado", usage: usage.openclaw, note: "O motor cuida do próprio histórico" }],
    },
  ];
}
