import type { AgendaEvent, Card, SentRequestView, WaitingItem } from "@cyno/shared";
import { dayKeyOf, todayKey, upcomingEvents } from "../agenda/agendaTime";
import { isOpenRequest } from "./cynoRequests";
import { busyAgents, nextRoutine, progressLabel } from "./cynoHome";

/**
 * Funções puras do painel lateral da página do Cyno: as abas, o que cada uma conta, as linhas do Resumo
 * e a memória (`localStorage`, sempre com try/catch) da aba escolhida e do painel recolhido.
 */

export const SIDE_TABS = [
  { id: "resumo", label: "Resumo" },
  { id: "workspaces", label: "Workspaces" },
  { id: "agenda", label: "Agenda" },
  { id: "mural", label: "Mural" },
] as const;
export type SideTabId = (typeof SIDE_TABS)[number]["id"];

const TAB_KEY = "cyno:side-tab";
const COLLAPSED_KEY = "cyno:side-collapsed";

const WIDTH_KEY = "cyno:side-width";

/** Largura do painel lateral no computador: padrão, limites e o mínimo que a conversa sempre mantém. */
export const SIDE_WIDTH_DEFAULT = 360;
export const SIDE_WIDTH_MIN = 300;
export const SIDE_WIDTH_MAX = 640;
export const CONV_WIDTH_MIN = 420;
/** O vão entre a conversa e o painel (o mesmo `gap` do `.cyno-layout`). */
export const SIDE_GAP = 16;
export const SIDE_WIDTH_STEP = 16;

/**
 * Largura que o painel pode ter de verdade: entre 300 e 640 px e, se o espaço (`available`, a largura do
 * layout) encolher, a conversa nunca fica com menos de 420 px; o painel cede primeiro, até os 300 px.
 */
export function clampSideWidth(width: number, available: number): number {
  const max = Math.max(SIDE_WIDTH_MIN, Math.min(SIDE_WIDTH_MAX, available - SIDE_GAP - CONV_WIDTH_MIN));
  const value = Number.isFinite(width) ? Math.round(width) : SIDE_WIDTH_DEFAULT;
  return Math.min(max, Math.max(SIDE_WIDTH_MIN, value));
}

export const isSideTab = (value: unknown): value is SideTabId => SIDE_TABS.some((tab) => tab.id === value);

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // modo privado ou dados bloqueados: a escolha só vale até fechar a página
  }
}

/** A aba lembrada (o Resumo na primeira vez ou se o valor guardado não vale mais). */
export function loadSideTab(): SideTabId {
  const stored = read(TAB_KEY);
  return isSideTab(stored) ? stored : "resumo";
}
export const saveSideTab = (tab: SideTabId): void => write(TAB_KEY, tab);

export const loadSideCollapsed = (): boolean => read(COLLAPSED_KEY) === "1";
export const saveSideCollapsed = (collapsed: boolean): void => write(COLLAPSED_KEY, collapsed ? "1" : "0");

/** A largura lembrada do painel (360 px na primeira vez ou se o valor guardado não vale). */
export function loadSideWidth(): number {
  const stored = Number(read(WIDTH_KEY));
  return Number.isFinite(stored) && stored >= SIDE_WIDTH_MIN && stored <= SIDE_WIDTH_MAX ? Math.round(stored) : SIDE_WIDTH_DEFAULT;
}
export const saveSideWidth = (width: number): void => write(WIDTH_KEY, String(Math.round(width)));

/**
 * Os itens que esperam o dono, o mais antigo primeiro (os `max` primeiros). A entrega de uma sprint pendente
 * entra sempre na lista, mesmo com `max` itens mais antigos: ela toma o lugar do último.
 */
export function oldestWaiting(items: readonly WaitingItem[], max = 3): WaitingItem[] {
  const byAge = (a: WaitingItem, b: WaitingItem) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id);
  const sorted = [...items].sort(byAge);
  const top = sorted.slice(0, max);
  const delivery = sorted.find((item) => item.kind === "sprint");
  if (delivery && max > 0 && !top.includes(delivery)) top[max - 1] = delivery;
  return top.sort(byAge);
}

/** Pedidos enviados ainda em aberto, o mais novo primeiro. */
export const openRequests = (requests: readonly SentRequestView[]): SentRequestView[] => requests.filter(isOpenRequest).sort((a, b) => b.sentAt.localeCompare(a.sentAt));

/** Quantos compromissos marcados ainda faltam hoje. */
export function agendaTodayCount(events: readonly AgendaEvent[], now: Date): number {
  const today = todayKey(now);
  return upcomingEvents(events, now, 200).filter((event) => dayKeyOf(event.start) === today).length;
}

export type SideCounts = Record<SideTabId, number>;

/** O que cada aba mostra no contador: o que espera você, os pedidos abertos, os compromissos de hoje e as novidades do mural. */
export function sideCounts(input: { waiting: number; openRequests: number; agendaToday: number; muralNews: number }): SideCounts {
  return { resumo: input.waiting, workspaces: input.openRequests, agenda: input.agendaToday, mural: input.muralNews };
}

export type WorkspaceLine = { workspace: string; name: string; tone: "wait" | "busy" | "idle"; text: string; meta?: string };

/** Uma linha por workspace: o que espera você, o que anda ou "Nada em andamento"; a próxima rotina vai como detalhe. */
export function workspaceLine(card: Card, now: Date): WorkspaceLine {
  const active = card.projects.active;
  const first = active[0];
  const progress = first ? progressLabel(first) : "";
  const busy = busyAgents(card);
  let tone: WorkspaceLine["tone"] = "idle";
  let text = "Nada em andamento";
  if (card.waitingForYou > 0) {
    tone = "wait";
    text = card.waitingForYou === 1 ? "1 item espera você" : `${card.waitingForYou} itens esperam você`;
  } else if (first) {
    tone = "busy";
    text = `${first.title}${progress ? ` · ${progress}` : ""}${active.length > 1 ? ` e mais ${active.length - 1}` : ""}`;
  } else if (busy > 0) {
    tone = "busy";
    text = busy === 1 ? "1 agente trabalhando" : `${busy} agentes trabalhando`;
  }
  const meta = card.waitingForYou > 0 && first ? `${first.title}${progress ? ` · ${progress}` : ""}${active.length > 1 ? ` e mais ${active.length - 1}` : ""}` : nextRoutine(card, now);
  return { workspace: card.workspace, name: card.name, tone, text, meta };
}
