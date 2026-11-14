import { ENGINE_LABELS, type AgentEngine, type Card, type CardProject, type WaitingItem } from "@cyno/shared";

/**
 * Funções puras da página inicial do Cyno: os textos dos cartões das fichas e o
 * agrupamento do "Esperando você" de todos os workspaces.
 */

/** "Claude", "Gemini"…; motor desconhecido volta como veio. */
export function engineName(engine: string): string {
  return ENGINE_LABELS[engine as AgentEngine] ?? engine;
}

/** "Claude · sonnet" */
export function modelLabel(engine: string, model?: string): string {
  return model ? `${engineName(engine)} · ${model}` : engineName(engine);
}

const MAESTRO_STATUS: Record<Card["team"]["maestro"]["status"], string> = { parado: "Maestro dormindo", ocioso: "Maestro acordado", ocupado: "Maestro trabalhando" };
export const maestroStatusLabel = (status: Card["team"]["maestro"]["status"]): string => MAESTRO_STATUS[status];

/** A equipe em uma linha: "Eco, Crivo e mais 2" (sem o Maestro). */
export function teamLine(card: Card, max = 3): string {
  const names = card.team.agents.map((agent) => agent.name);
  if (names.length === 0) return "Só o Maestro";
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} e mais ${names.length - max}`;
}

/** Quantos agentes de time estão trabalhando agora. */
export const busyAgents = (card: Card): number => card.team.agents.filter((agent) => agent.terminal === "busy").length;

/** "3/10" quando o projeto tem tarefas; vazio senão. */
export function progressLabel(project: Pick<CardProject, "done" | "total">): string {
  return project.total ? `${project.done ?? 0}/${project.total}` : "";
}

/** O que está em andamento, em uma linha por projeto (máximo `max`). */
export function workingLines(card: Card, max = 2): { id: string; text: string; progress: string }[] {
  return card.projects.active.slice(0, max).map((project) => ({ id: project.id, text: project.title, progress: progressLabel(project) }));
}

/** "Hoje 18h", "Amanhã 08h", "qui 08h". */
export function nextRunLabel(iso: string, now: Date, timeZone = "America/Sao_Paulo"): string {
  const day = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const when = new Date(iso);
  const hour = new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(when);
  const [h = "", m = ""] = hour.split(":");
  const time = m === "00" ? `${h}h` : `${h}h${m}`;
  if (day(when) === day(now)) return `hoje ${time}`;
  if (day(when) === day(new Date(now.getTime() + 86_400_000))) return `amanhã ${time}`;
  const weekday = new Intl.DateTimeFormat("pt-BR", { timeZone, weekday: "short" }).format(when).replace(".", "");
  return `${weekday} ${time}`;
}

/** A rotina com o próximo horário mais perto, para o cartão ("Convites · hoje 18h"). */
export function nextRoutine(card: Card, now: Date): string | undefined {
  const upcoming = card.routines.filter((routine) => routine.next).sort((a, b) => a.next!.localeCompare(b.next!))[0];
  return upcoming ? `${upcoming.title} · ${nextRunLabel(upcoming.next!, now)}` : undefined;
}

/** Uso: "Claude 41% das 5 h" ou "3 turnos em 5 h". */
export function usageLabel(card: Card): string {
  if (card.usage.windowPercent !== undefined && card.usage.windowEngine) return `${engineName(card.usage.windowEngine)} ${card.usage.windowPercent}% das 5 h`;
  if (card.usage.turns5h === 0) return "Sem uso em 5 h";
  return `${card.usage.turns5h} ${card.usage.turns5h === 1 ? "turno" : "turnos"} em 5 h`;
}

/** Há quanto tempo: "agora", "há 5 min", "há 3 h", "há 2 dias". */
export function ageLabel(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  return `há ${days} ${days === 1 ? "dia" : "dias"}`;
}

export type WaitingGroup = { workspace: string; workspaceName: string; items: WaitingItem[] };

/** Agrupa o "Esperando você" por workspace: o grupo com o item mais antigo vem primeiro, e dentro dele o mais antigo primeiro. */
export function groupWaiting(items: readonly WaitingItem[]): WaitingGroup[] {
  const sorted = [...items].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const groups = new Map<string, WaitingGroup>();
  for (const item of sorted) {
    const group = groups.get(item.workspace) ?? { workspace: item.workspace, workspaceName: item.workspaceName, items: [] };
    group.items.push(item);
    groups.set(item.workspace, group);
  }
  return [...groups.values()];
}

/** Texto do selo de um cartão: nada esperando = vazio. */
export const waitingBadge = (card: Pick<Card, "waitingForYou">): string => (card.waitingForYou > 0 ? `${card.waitingForYou} ${card.waitingForYou === 1 ? "espera" : "esperam"} você` : "");

/** Ordem dos cartões: quem mais espera você primeiro, depois quem está trabalhando, depois pelo nome. */
export function sortCards(cards: readonly Card[]): Card[] {
  return [...cards].sort((a, b) => b.waitingForYou - a.waitingForYou || b.projects.active.length - a.projects.active.length || a.name.localeCompare(b.name, "pt-BR"));
}
