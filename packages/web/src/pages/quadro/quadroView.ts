import { BOARD_ID_PATTERN, BOARD_KIT_EXPORT_FORMATS, type Board, type BoardChange, type BoardExportResultMessage, type BoardKitExportFormat, type BoardShare, type ServerEvent } from "@cyno/shared";
import { BOARD_USER_CREATOR } from "@cyno/shared";

/** Lógica pura da tela do Quadro (endereço, lista de abas, o que cada evento faz, mensagens do iframe e textos). */

/** O id do quadro no endereço (`#/<ws>/quadro/<id>`); null se não há ou não parece um id. */
export function boardIdFromSub(sub: string): string | null {
  const first = sub.split("?")[0]?.split("/")[0] ?? "";
  let id = first;
  try {
    id = decodeURIComponent(first);
  } catch {
    // Endereço mal formado: segue o texto como veio.
  }
  return BOARD_ID_PATTERN.test(id) ? id : null;
}

/** O quadro aberto: o do endereço, se existe; senão o primeiro da lista (o mexido por último). */
export function pickBoard(boards: readonly Board[], wanted: string | null): Board | null {
  return boards.find((board) => board.id === wanted) ?? boards[0] ?? null;
}

/** Aplica um evento na lista de abas. Quadro novo entra na frente; um já conhecido troca no lugar (as abas não pulam enquanto o dono olha). */
export function applyBoardEvent(boards: readonly Board[], event: ServerEvent): Board[] {
  if (event.type === "board:upserted") {
    const known = boards.some((board) => board.id === event.board.id);
    if (!known) return [event.board, ...boards];
    return boards.map((board) => (board.id === event.board.id ? event.board : board));
  }
  if (event.type === "board:deleted") return boards.filter((board) => board.id !== event.id);
  return [...boards];
}

/** O que a tela faz com um quadro aberto quando algo mudou: página (recarrega tudo), dados (manda por postMessage) ou nada (só título e descrição). */
export type LiveAction = "reload" | "data" | "none";

export function liveAction(changed: readonly BoardChange[]): LiveAction {
  if (changed.includes("page")) return "reload";
  if (changed.includes("data")) return "data";
  return "none";
}

/** Mensagens que o iframe manda para a página-mãe (o kit do Quadro). */
export type FrameMessage = { type: "ready" } | { type: "height"; height: number } | { type: "error"; message: string } | { type: "export-result"; result: BoardExportResultMessage };

export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record.type === "quadro:ready") return { type: "ready" };
  if (record.type === "quadro:height") return typeof record.height === "number" && Number.isFinite(record.height) ? { type: "height", height: record.height } : null;
  if (record.type === "quadro:error") return { type: "error", message: typeof record.message === "string" && record.message.trim() ? record.message.trim().slice(0, 400) : "A página do quadro falhou." };
  if (record.type === "quadro:export-result") {
    const { requestId, format } = record;
    if (typeof requestId !== "string" || !requestId) return null;
    if (typeof format !== "string" || !(BOARD_KIT_EXPORT_FORMATS as readonly string[]).includes(format)) return null;
    const kind = format as BoardKitExportFormat;
    if (record.ok === true) return typeof record.text === "string" ? { type: "export-result", result: { type: "quadro:export-result", requestId, format: kind, ok: true, text: record.text } } : null;
    if (record.ok === false) return { type: "export-result", result: { type: "quadro:export-result", requestId, format: kind, ok: false, error: typeof record.error === "string" && record.error.trim() ? record.error.trim().slice(0, 400) : "Não deu para exportar o quadro." } };
  }
  return null;
}

/** Tempo relativo curto: "agora", "há 5 min", "há 3 h", "há 2 dias" e, passado um mês, a data. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "em data desconhecida";
  const seconds = Math.max(0, Math.round((now.getTime() - time) / 1000));
  if (seconds < 45) return "agora";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 31) return days === 1 ? "há 1 dia" : `há ${days} dias`;
  return `em ${new Date(time).toLocaleDateString("pt-BR")}`;
}

/** "Dados atualizados há 5 min". */
export function dataAgeLabel(board: Pick<Board, "dataUpdatedAt">, now: Date = new Date()): string {
  const ago = relativeTime(board.dataUpdatedAt, now);
  return `Dados atualizados ${ago}`;
}

/** Quem fez o quadro, em linguagem simples (o nome do agente quando ele ainda existe). */
export function authorLabel(createdBy: string, agents: readonly { id: string; name: string }[]): string {
  if (createdBy === BOARD_USER_CREATOR) return "Feito por você";
  const agent = agents.find((current) => current.id === createdBy);
  return agent ? `Feito por ${agent.name}` : "Feito por um agente";
}

/** O texto do aviso antes de apagar (diz o que se perde). */
export function deleteMessage(title: string, shared = false): string {
  const base = `Apagar o quadro "${title}"? A página e os dados dele serão apagados e não dá para desfazer. Os agentes podem montar outro quando você pedir.`;
  return shared ? `${base} O link compartilhado deste quadro para de funcionar.` : base;
}

/** Os dois quadros de exemplo do estado vazio (dados fictícios, só para mostrar como fica). */
export const EXAMPLE_IDS = ["catalogo", "estudos"] as const;
export type ExampleId = (typeof EXAMPLE_IDS)[number];

// ---------- Tela inicial dos quadros: busca, ordem e cartões ----------

/** Sem acento, minúsculo e com espaços simples: a busca não diferencia "Concurso" de "concúrso". */
export function normalizeText(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Quadros cujo título ou descrição contêm todas as palavras da busca (busca vazia devolve todos). */
export function filterBoards<T extends Pick<Board, "title" | "description">>(boards: readonly T[], query: string): T[] {
  const words = normalizeText(query).split(" ").filter(Boolean);
  if (words.length === 0) return [...boards];
  return boards.filter((board) => {
    const haystack = normalizeText(`${board.title} ${board.description}`);
    return words.every((word) => haystack.includes(word));
  });
}

export type BoardSort = "recentes" | "nome";
export const BOARD_SORTS: { id: BoardSort; label: string }[] = [
  { id: "recentes", label: "Mexidos por último" },
  { id: "nome", label: "Nome" },
];

/** Quando o quadro foi mexido pela última vez (página ou dados). */
export function touchedAt(board: Pick<Board, "pageUpdatedAt" | "dataUpdatedAt" | "createdAt">): number {
  return Math.max(Date.parse(board.pageUpdatedAt) || 0, Date.parse(board.dataUpdatedAt) || 0, Date.parse(board.createdAt) || 0);
}

export function sortBoards(boards: readonly Board[], sort: BoardSort): Board[] {
  const copy = [...boards];
  if (sort === "nome") return copy.sort((a, b) => a.title.localeCompare(b.title, "pt-BR", { sensitivity: "base", numeric: true }) || a.id.localeCompare(b.id));
  return copy.sort((a, b) => touchedAt(b) - touchedAt(a) || b.id.localeCompare(a.id));
}

/** "1 quadro", "12 quadros". */
export function boardCountLabel(count: number): string {
  return count === 1 ? "1 quadro" : `${count} quadros`;
}

/** Um número de 0 a 7 estável por quadro: escolhe a cor de destaque do cartão (as mesmas oito cores dos gráficos do kit). */
export function accentIndex(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 8;
}

/** A inicial do título, para o selo do cartão. */
export function initialOf(title: string): string {
  const letter = [...title.trim()].find((char) => /\p{L}|\p{N}/u.test(char));
  return (letter ?? "Q").toLocaleUpperCase("pt-BR");
}

/** Anda pela lista do seletor (para cima ou para baixo, sem passar das pontas); lista vazia dá -1. */
export function moveIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  return Math.min(length - 1, Math.max(0, index + delta));
}

/** O que a página mostra para o endereço: a tela inicial, um quadro, ou um id que não existe (nem existiu). */
export type QuadroRoute = { kind: "home" } | { kind: "board"; board: Board } | { kind: "missing"; id: string };

export function resolveRoute(boards: readonly Board[], wanted: string | null): QuadroRoute {
  if (!wanted) return { kind: "home" };
  const board = boards.find((current) => current.id === wanted);
  return board ? { kind: "board", board } : { kind: "missing", id: wanted };
}

// ---------- Compartilhar por link e baixar ----------

/** O endereço só funciona na rede local (localhost, 127.x, 10.x, 172.16 a 31.x, 192.168.x): o link não abre para quem está fora. */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** O link completo: o endereço em que o app está aberto mais o caminho público devolvido pelo servidor. */
export function shareLink(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** "Sem validade" ou "Vale até 25/11/2026 às 14:30" (no fuso de quem olha). */
export function shareExpiryLabel(share: BoardShare): string {
  if (!share.shared || !share.expiresAt) return "Sem validade";
  const date = new Date(share.expiresAt);
  if (!Number.isFinite(date.getTime())) return "Sem validade";
  const two = (n: number) => String(n).padStart(2, "0");
  return `Vale até ${two(date.getDate())}/${two(date.getMonth() + 1)}/${date.getFullYear()} às ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** Rótulo de cada opção de validade: 0 é "Sem validade". */
export function expiryOptionLabel(days: number): string {
  if (days === 0) return "Sem validade";
  return days === 1 ? "1 dia" : `${days} dias`;
}

/** Quantos dias faltam para a validade atual, para marcar a opção mais próxima no seletor (sem validade = 0). */
export function currentExpiryOption(share: BoardShare, options: readonly number[], now: Date = new Date()): number {
  if (!share.shared || !share.expiresAt) return 0;
  const left = (Date.parse(share.expiresAt) - now.getTime()) / 86_400_000;
  if (!Number.isFinite(left)) return 0;
  const positive = options.filter((days) => days > 0);
  return positive.reduce((best, days) => (Math.abs(days - left) < Math.abs(best - left) ? days : best), positive[0] ?? 0);
}
