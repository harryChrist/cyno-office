import {
  MEDIA_EXT_MIME,
  MEDIA_MIME_TABLE,
  MEDIA_STATUSES,
  MEDIA_USER_CREATOR,
  type MediaItem,
  type MediaKind,
  type MediaOrigin,
  type MediaStatus,
} from "@cyno/shared";

/** Lógica pura da página Mídia: rótulos, filtros, contagens e a checagem do arquivo antes de enviar. */

export const KIND_LABELS: Record<MediaKind, string> = { image: "Imagens", video: "Vídeos", audio: "Áudios", document: "Documentos", other: "Outros" };
export const KIND_LABELS_SINGULAR: Record<MediaKind, string> = { image: "Imagem", video: "Vídeo", audio: "Áudio", document: "Documento", other: "Arquivo" };

export const STATUS_LABELS: Record<MediaStatus, string> = { rascunho: "Rascunho", aprovado: "Aprovado", publicado: "Publicado", descartado: "Descartado" };

/** Como a mídia nasceu (texto do detalhe). */
export const ORIGIN_LABELS: Record<MediaOrigin, string> = { html: "Feito em HTML", arquivo: "Arquivo do agente", upload: "Enviado por você", screenshot: "Print", mural: "Trazida de outro workspace", app: "Feito por um app" };

/** Tipo no filtro: documentos e "outros" viram "Arquivos". */
export type KindFilter = "image" | "video" | "audio" | "file";
export const KIND_FILTERS: readonly KindFilter[] = ["image", "video", "audio", "file"];
export const KIND_FILTER_LABELS: Record<KindFilter, string> = { image: "Imagens", video: "Vídeos", audio: "Áudios", file: "Arquivos" };
export const kindFilterOf = (kind: MediaKind): KindFilter => (kind === "document" || kind === "other" ? "file" : kind);

export type MediaFilters = { kind: KindFilter | "todos"; status: MediaStatus | "todos"; agent: string; q: string };
export const NO_FILTERS: MediaFilters = { kind: "todos", status: "todos", agent: "todos", q: "" };

export const isFiltering = (filters: MediaFilters): boolean => filters.kind !== "todos" || filters.status !== "todos" || filters.agent !== "todos" || filters.q.trim() !== "";

const normalize = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Quem fez: o nome do agente, "Você" (upload) ou o id quando o agente não existe mais. */
export function creatorLabel(createdBy: string, agents: ReadonlyMap<string, string>): string {
  if (createdBy === MEDIA_USER_CREATOR) return "Você";
  return agents.get(createdBy) ?? createdBy;
}

/** Aplica os filtros (e a busca por título, arquivo, nota, onde, autor e etiquetas). Mantém a ordem recebida. */
export function filterMedia(items: readonly MediaItem[], filters: MediaFilters, agents: ReadonlyMap<string, string>): MediaItem[] {
  const needle = normalize(filters.q.trim());
  return items.filter((item) => {
    if (filters.kind !== "todos" && kindFilterOf(item.kind) !== filters.kind) return false;
    if (filters.status !== "todos" && item.status !== filters.status) return false;
    if (filters.agent !== "todos" && item.createdBy !== filters.agent) return false;
    if (!needle) return true;
    const haystack = [item.title, item.fileName, item.note, item.where, item.folder, creatorLabel(item.createdBy, agents), ...(item.tags ?? [])].filter(Boolean).join(" ");
    return normalize(haystack).includes(needle);
  });
}

export type Option<T extends string> = { value: T | "todos"; label: string; count: number };

/** Menu de tipo: "Tudo" e cada tipo que tem itens (o selecionado fica mesmo com 0). */
export function kindOptions(items: readonly MediaItem[], selected: MediaFilters["kind"]): Option<KindFilter>[] {
  const counts = new Map<KindFilter, number>();
  for (const item of items) counts.set(kindFilterOf(item.kind), (counts.get(kindFilterOf(item.kind)) ?? 0) + 1);
  return [
    { value: "todos", label: "Tudo", count: items.length },
    ...KIND_FILTERS.filter((kind) => counts.has(kind) || kind === selected).map((kind) => ({ value: kind, label: KIND_FILTER_LABELS[kind], count: counts.get(kind) ?? 0 })),
  ];
}

/** Menu de estado: "Todos" e cada estado que tem itens. */
export function statusOptions(items: readonly MediaItem[], selected: MediaFilters["status"]): Option<MediaStatus>[] {
  const counts = new Map<MediaStatus, number>();
  for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  return [
    { value: "todos", label: "Todos", count: items.length },
    ...MEDIA_STATUSES.filter((status) => counts.has(status) || status === selected).map((status) => ({ value: status, label: STATUS_LABELS[status], count: counts.get(status) ?? 0 })),
  ];
}

/** Agentes (e "Você") que têm mídia, com nome e contagem; por ordem alfabética. */
export function agentOptions(items: readonly MediaItem[], agents: ReadonlyMap<string, string>, selected: string): Option<string>[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.createdBy, (counts.get(item.createdBy) ?? 0) + 1);
  if (selected !== "todos" && !counts.has(selected)) counts.set(selected, 0);
  const rest = [...counts.entries()].map(([value, count]) => ({ value, label: creatorLabel(value, agents), count })).sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  return [{ value: "todos", label: "Todos", count: items.length }, ...rest];
}

/** "1,4 MB", "820 KB", "512 B". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value >= 100 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1).replace(".", ",");
  return `${text} ${units[unit]}`;
}

/** "1080 × 1350 px" (null sem dimensões). */
export function dimensionsLabel(item: Pick<MediaItem, "width" | "height">): string | null {
  return item.width && item.height ? `${item.width} × ${item.height} px` : null;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const NAMED_RATIOS: readonly [string, number][] = [["1:1", 1], ["5:4", 5 / 4], ["4:3", 4 / 3], ["3:2", 3 / 2], ["16:9", 16 / 9], ["1,91:1", 1.91], ["2:1", 2], ["4:5", 4 / 5], ["3:4", 3 / 4], ["2:3", 2 / 3], ["9:16", 9 / 16], ["1:2", 1 / 2]];

/** "1:1", "4:5", "9:16"; medidas quase iguais a um formato conhecido viram "≈ 1,91:1"; senão a fração simplificada. */
export function ratioLabel(width: number, height: number): string {
  const g = gcd(width, height);
  const a = width / g;
  const b = height / g;
  if (a <= 20 && b <= 20) return `${a}:${b}`;
  const ratio = width / height;
  const close = NAMED_RATIOS.reduce((best, current) => (Math.abs(current[1] - ratio) < Math.abs(best[1] - ratio) ? current : best));
  return Math.abs(close[1] - ratio) / ratio < 0.03 ? `≈ ${close[0]}` : `${ratio >= 1 ? ratio.toFixed(2).replace(".", ",") : "1"}:${ratio >= 1 ? "1" : (1 / ratio).toFixed(2).replace(".", ",")}`;
}

/** Extensão em maiúsculas para o selo do tipo ("PDF", "MP3"). */
export function extensionLabel(item: Pick<MediaItem, "fileName" | "mime">): string {
  const fromName = item.fileName.includes(".") ? item.fileName.split(".").pop() : undefined;
  const fromMime = MEDIA_MIME_TABLE[item.mime.toLowerCase()]?.ext;
  return (fromMime ?? fromName ?? "ARQ").toUpperCase().slice(0, 5);
}

/** O mime do arquivo: o do navegador, ou o da extensão quando ele vem vazio; sem nenhum dos dois, genérico (o servidor aceita qualquer tipo). */
export function mimeForFile(file: Pick<File, "name" | "type">): string {
  const direct = file.type.toLowerCase();
  if (direct && MEDIA_MIME_TABLE[direct]) return direct;
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  return MEDIA_EXT_MIME[ext] ?? (direct || "application/octet-stream");
}

/** Confere o arquivo antes de enviar: só recusa vazio. Não há limite de tamanho nem de tipo. */
export function uploadProblem(file: Pick<File, "name" | "type" | "size">): string | null {
  return file.size === 0 ? `“${file.name}” está vazio.` : null;
}

/** Mensagem para um erro do servidor no envio (415: conteúdo que não bate com o tipo) ou o texto dele. */
export function uploadErrorMessage(status: number | undefined, fileName: string, fallback: string): string {
  if (status === 415) return `“${fileName}”: o conteúdo não bate com o tipo do arquivo.`;
  return `Não deu para enviar “${fileName}”: ${fallback}`;
}

/** Tom do selo de estado. */
export function statusTone(status: MediaStatus): "neutral" | "info" | "ok" | "muted" {
  return status === "publicado" ? "ok" : status === "aprovado" ? "info" : status === "descartado" ? "muted" : "neutral";
}

/** Mais novas primeiro. */
export function sortForGallery(items: readonly MediaItem[]): MediaItem[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/** De onde uma mídia trazida veio ("Veio de Design · M-0003", ou o texto antigo do mural "Do mural: Design · N-0001"); null se não foi trazida. */
export function cameFrom(item: Pick<MediaItem, "origin" | "note">): { workspace: string; mediaId?: string } | null {
  if (item.origin !== "mural" || !item.note) return null;
  const first = item.note.split(" — ")[0] ?? "";
  const brought = /^Veio de (.+?) · (M-\d{4,})$/.exec(first);
  if (brought) return { workspace: brought[1]!, mediaId: brought[2]! };
  const mural = /^Do mural: (.+?) · N-\d+$/.exec(first);
  return mural ? { workspace: mural[1]! } : null;
}

/** Os itens da biblioteca na ordem dos ids pedidos; ids que ainda não chegaram ficam de fora. */
export function mediaByIds(items: readonly MediaItem[] | null, ids: readonly string[] | undefined): MediaItem[] {
  if (!items || !ids?.length) return [];
  const byId = new Map(items.map((item) => [item.id, item]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** Dá para "Abrir publicação": só endereço http(s). */
export function safeHttpUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
