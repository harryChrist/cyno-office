import type { MediaItem } from "@cyno/shared";
import { creatorLabel, kindFilterOf, type MediaFilters } from "./mediaView";

/** Lógica pura do agrupamento da galeria: carrosséis, versões descartadas, seções por tempo e o escopo escolhido. */

/** Uma mídia e o workspace onde ela está guardada. */
export type Located = { ws: string; item: MediaItem };

/**
 * Um cartão da galeria. `single` pode ter versões anteriores descartadas da mesma peça (ficam no detalhe);
 * `carousel` junta os slides de um carrossel (o `main` é o primeiro slide).
 */
export type GalleryEntry =
  | { key: string; type: "single"; main: Located; versions: Located[]; time: string }
  | { key: string; type: "carousel"; main: Located; slides: Located[]; time: string };

export const entryKey = (located: Located): string => `${located.ws}:${located.item.id}`;

/** "Carrossel · slide 2 de 3" (ou "slide 2/3"). Só com isso, e o mesmo pedido, é que se agrupa como carrossel. */
const SLIDE = /^(.*?)[\s·\-–:]*slide\s*(\d+)\s*(?:de|\/)\s*(\d+)\s*$/i;

/** Número do slide e o título sem a parte do slide (null se o título não é de slide). */
export function slideInfo(title: string): { base: string; label: string; n: number; total: number } | null {
  const match = SLIDE.exec(title.trim());
  return match ? { base: match[1]!.trim().toLowerCase(), label: match[1]!.trim(), n: Number(match[2]), total: Number(match[3]) } : null;
}

/** "Carrossel · 3 slides". */
export function carouselTitle(slides: readonly Located[]): string {
  const label = slideInfo(slides[0]!.item.title)?.label || "Carrossel";
  return `${label} · ${slides.length} slides`;
}

const newest = (a: Located, b: Located) => b.item.createdAt.localeCompare(a.item.createdAt) || b.item.id.localeCompare(a.item.id);

/**
 * Monta os cartões. Agrupa só o que é seguro, dentro de cada workspace:
 * - slides: imagens do mesmo pedido (`taskId`) cujo título diz "slide N de M" e que têm o mesmo título-base;
 * - versões: no mesmo pedido, mesmo tipo e mesmas dimensões, as descartadas MAIS ANTIGAS que a versão atual
 *   (a mais nova não descartada) ficam dentro dela. Com `showDiscarded`, elas também aparecem soltas.
 * Ordem: do mais novo para o mais antigo.
 */
export function buildEntries(items: readonly Located[], showDiscarded: boolean): GalleryEntry[] {
  const used = new Set<Located>();
  const entries: GalleryEntry[] = [];

  // Carrosséis
  const slideGroups = new Map<string, Located[]>();
  for (const located of items) {
    const { item } = located;
    const info = item.kind === "image" && item.taskId && item.status !== "descartado" ? slideInfo(item.title) : null;
    if (!info) continue;
    const key = `${located.ws}|${item.taskId}|${info.base}|${info.total}`;
    slideGroups.set(key, [...(slideGroups.get(key) ?? []), located]);
  }
  for (const [key, group] of slideGroups) {
    if (group.length < 2) continue;
    const slides = [...group].sort((a, b) => (slideInfo(a.item.title)?.n ?? 0) - (slideInfo(b.item.title)?.n ?? 0) || a.item.createdAt.localeCompare(b.item.createdAt));
    for (const slide of slides) used.add(slide);
    entries.push({ key: `carousel:${key}`, type: "carousel", main: slides[0]!, slides, time: [...group].sort(newest)[0]!.item.createdAt });
  }

  // Versões
  const pieces = new Map<string, Located[]>();
  for (const located of items) {
    if (used.has(located) || !located.item.taskId) continue;
    const { item } = located;
    const key = `${located.ws}|${item.taskId}|${item.kind}|${item.width ?? 0}x${item.height ?? 0}`;
    pieces.set(key, [...(pieces.get(key) ?? []), located]);
  }
  const versionsOf = new Map<Located, Located[]>();
  for (const group of pieces.values()) {
    const live = group.filter((located) => located.item.status !== "descartado").sort(newest);
    const current = live[0];
    if (!current) continue;
    const older = group.filter((located) => located.item.status === "descartado" && located.item.createdAt < current.item.createdAt).sort(newest);
    if (older.length > 0) versionsOf.set(current, older);
  }
  const hidden = new Set<Located>([...versionsOf.values()].flat());

  for (const located of items) {
    if (used.has(located)) continue;
    const discarded = located.item.status === "descartado";
    if (discarded && hidden.has(located) && !showDiscarded) continue;
    entries.push({ key: entryKey(located), type: "single", main: located, versions: versionsOf.get(located) ?? [], time: located.item.createdAt });
  }
  return entries.sort((a, b) => b.time.localeCompare(a.time) || b.key.localeCompare(a.key));
}

/** Todas as mídias de um cartão (slides, ou a peça atual e as versões). */
export function entryItems(entry: GalleryEntry): Located[] {
  return entry.type === "carousel" ? entry.slides : [entry.main, ...entry.versions];
}

/** O cartão passa nos filtros? Carrossel passa se qualquer slide passar; descartados só com o interruptor (ou filtrando por Descartado). */
export function entryMatches(entry: GalleryEntry, filters: MediaFilters, showDiscarded: boolean, agents: (ws: string, id: string) => string): boolean {
  const parts = entry.type === "carousel" ? entry.slides : [entry.main];
  if (entry.type === "single" && entry.main.item.status === "descartado" && !showDiscarded && filters.status !== "descartado") return false;
  const needle = filters.q
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  return parts.some(({ ws, item }) => {
    if (filters.kind !== "todos" && kindFilterOf(item.kind) !== filters.kind) return false;
    if (filters.status !== "todos" && item.status !== filters.status) return false;
    if (filters.agent !== "todos" && item.createdBy !== filters.agent) return false;
    if (!needle) return true;
    const text = [item.title, item.fileName, item.note, item.where, agents(ws, item.createdBy), ...(item.tags ?? [])].filter(Boolean).join(" ");
    return text
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .includes(needle);
  });
}

export type TimeSection = { id: "hoje" | "semana" | "antes" | "tudo"; title: string | null; entries: GalleryEntry[] };

const DAY = 24 * 3_600_000;
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "Hoje", "Esta semana" (últimos 7 dias) e "Antes"; com menos de 9 cartões, uma seção só e sem título. Mantém a ordem recebida. */
export function timeSections(entries: readonly GalleryEntry[], now: Date = new Date()): TimeSection[] {
  if (entries.length === 0) return [];
  if (entries.length < 9) return [{ id: "tudo", title: null, entries: [...entries] }];
  const today = startOfDay(now);
  const buckets: Record<"hoje" | "semana" | "antes", GalleryEntry[]> = { hoje: [], semana: [], antes: [] };
  for (const entry of entries) {
    const at = new Date(entry.time).getTime();
    buckets[at >= today ? "hoje" : at >= today - 6 * DAY ? "semana" : "antes"].push(entry);
  }
  const titles = { hoje: "Hoje", semana: "Esta semana", antes: "Antes" } as const;
  return (["hoje", "semana", "antes"] as const).filter((id) => buckets[id].length > 0).map((id) => ({ id, title: titles[id], entries: buckets[id] }));
}

/** Estado em comum dos slides (null se divergem). */
export function commonStatus(entry: GalleryEntry): MediaItem["status"] | null {
  if (entry.type === "single") return entry.main.item.status;
  const first = entry.slides[0]!.item.status;
  return entry.slides.every((slide) => slide.item.status === first) ? first : null;
}

/** Quem fez, para a linha de apoio: um agente só, ou "Davi e mais 1". */
export function entryAuthor(entry: GalleryEntry, agents: (ws: string, id: string) => string): string {
  const names = [...new Set(entryItems(entry).map(({ ws, item }) => creatorLabel(item.createdBy, new Map([[item.createdBy, agents(ws, item.createdBy)]]))))];
  return names.length <= 1 ? (names[0] ?? "") : `${names[0]} e mais ${names.length - 1}`;
}

// ---------- Escopo ("de onde?") ----------

export type Scope = "este" | "outro" | "todos";
const SCOPE_KEY = "cyno.media.scope";
const OTHER_KEY = "cyno.media.other";

export function loadScope(): { scope: Scope; other: string | null } {
  try {
    const scope = localStorage.getItem(SCOPE_KEY);
    return { scope: scope === "outro" || scope === "todos" ? scope : "este", other: localStorage.getItem(OTHER_KEY) };
  } catch {
    return { scope: "este", other: null };
  }
}

export function saveScope(scope: Scope, other: string | null): void {
  try {
    localStorage.setItem(SCOPE_KEY, scope);
    if (other) localStorage.setItem(OTHER_KEY, other);
  } catch {
    // sem armazenamento: a escolha vale só nesta visita
  }
}

/** A chave que identifica o conteúdo mostrado de cada escopo (a posição de rolagem se guarda por ela). */
export const scopeKey = (scope: Scope, other: string | null): string => (scope === "outro" ? `outro:${other ?? ""}` : scope);

// ---------- Densidade da grade ----------

/** Confortável (cartões maiores) ou compacta (mais colunas, menos texto). */
export type Density = "confortavel" | "compacta";
const DENSITY_KEY = "cyno.media.density";

export function loadDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_KEY) === "compacta" ? "compacta" : "confortavel";
  } catch {
    return "confortavel";
  }
}

export function saveDensity(density: Density): void {
  try {
    localStorage.setItem(DENSITY_KEY, density);
  } catch {
    // sem armazenamento: vale só nesta visita
  }
}
