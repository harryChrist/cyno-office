// Adaptado de Habblaud (github.com/marmottajr/habblaud), MIT, Copyright (c) 2026 Márcio Junior.
// Origem: server/deliveries/deliveries.ts (`headlineOf`, `summaryOf`, `stripMarkdown`, `cut`, `paragraphs`).
// O resto (`deliveryOf`, o cartão) é do Cyno: o Habblaud descobre a entrega lendo transcrições; o Cyno
// já tem o resultado da tarefa direto. Sem IA: manchete e resumo saem do texto, por código.
import type { AgentLogEntry } from "./agent-log";
import type { MediaItem } from "./media";
import { canonicalToolName } from "./work-phrase";

export const HEADLINE_MAX = 180;
export const SUMMARY_MAX = 600;
export const DELIVERY_REQUEST_MAX = 240;

function stripMarkdown(s: string): string {
  return s
    .replace(/`{3}[\s\S]*?`{3}/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=\s|$|[.,;:!?])/g, "$1$2")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max - 1);
  const sp = head.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? head.slice(0, sp) : head).replace(/[\s,;:.-]+$/, "")}…`;
}

function paragraphs(text: string): string[] {
  return text
    .replace(/`{3}[\s\S]*?`{3}/g, "\n\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    // Régua horizontal (---, ***, ___) não é parágrafo: o Habblaud a tratava como prosa e a manchete virava "---".
    .filter((p) => p && !/^([-*_]\s*){3,}$/.test(p));
}

const isProse = (p: string) => !/^(\||#|>|[-*+]\s|\d+[.)]\s|`{3})/.test(p) && !/^[A-Z_ ]+:\s/.test(p);

/** Primeira frase da resposta (a manchete), sem markdown. */
export function headlineOf(text: string): string {
  const first = paragraphs(text).find(isProse) ?? paragraphs(text)[0] ?? "";
  const plain = stripMarkdown(first);
  const m = /^(.+?[.!?])(\s|$)/.exec(plain);
  return cut(m ? m[1]! : plain, HEADLINE_MAX);
}

/** Último parágrafo em texto corrido (o resumo em linguagem simples), se for diferente da manchete. */
export function summaryOf(text: string, headline: string): string | undefined {
  const paras = paragraphs(text).filter(isProse);
  const last = paras[paras.length - 1];
  if (!last || paras.length < 2) return undefined;
  const plain = stripMarkdown(last);
  if (plain.length < 60 || plain.startsWith(headline.replace(/…$/, ""))) return undefined;
  return cut(plain, SUMMARY_MAX);
}

/** A manchete e o resumo de um resultado; vazio dá `null` (não há o que mostrar). */
export function headlineAndSummary(text: string | undefined): { headline: string; summary?: string } | null {
  if (!text || !text.trim()) return null;
  const headline = headlineOf(text);
  if (!headline) return null;
  const summary = summaryOf(text, headline);
  return { headline, ...(summary ? { summary } : {}) };
}

// ---------------------------------------------------------------- o cartão da entrega

export type DeliveryMedia = { id: string; kind: MediaItem["kind"]; title: string; fileName: string };

/** A entrega de um pedido: o fim do trabalho de um agente, derivada do resultado da tarefa. */
export type DeliveryCard = {
  /** O id da tarefa (uma entrega por tarefa). */
  id: string;
  taskId: string;
  projectId?: string;
  agentId: string;
  /** O pedido, em até 240 caracteres. */
  request: string;
  headline: string;
  summary?: string;
  /** A resposta inteira. */
  text: string;
  startedAt?: string;
  finishedAt: string;
  /** Quantas ferramentas o agente usou no trabalho. */
  tools: number;
  /** Quantos arquivos distintos ele criou ou editou. */
  edited: number;
  media: DeliveryMedia[];
};

export type DeliveryTask = {
  id: string;
  agentId?: string | undefined;
  prompt: string;
  status: string;
  outcome?: string | undefined;
  result?: string | undefined;
  projectId?: string | undefined;
  createdAt: string;
  updatedAt: string;
};

const PATH_KEYS = ["filepath", "absolutepath", "targetfile", "path", "file", "filename", "notebookpath"];

function editedPath(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const flat = new Map<string, unknown>();
  for (const [key, value] of Object.entries(input)) flat.set(key.toLowerCase().replace(/[^a-z]/g, ""), value);
  for (const key of PATH_KEYS) {
    const value = flat.get(key);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/**
 * A entrega de uma tarefa, ou null quando não é entrega: sem resultado, ainda em andamento, falhou ou foi
 * cancelada. `entries` são as do log da tarefa (conta ferramentas e arquivos editados); `media` são as da
 * biblioteca (entram as ligadas à tarefa). Função pura.
 */
export function deliveryOf(input: { task: DeliveryTask; entries?: readonly AgentLogEntry[]; media?: readonly MediaItem[] }): DeliveryCard | null {
  const { task } = input;
  if (task.status !== "done" || task.outcome === "cancelled" || !task.agentId) return null;
  const parts = headlineAndSummary(task.result);
  if (!parts || !task.result) return null;
  let tools = 0;
  const edited = new Set<string>();
  let startedAt: string | undefined;
  for (const entry of input.entries ?? []) {
    if (entry.taskId !== task.id || entry.thread !== undefined) continue;
    if (!startedAt || entry.at < startedAt) startedAt = entry.at;
    if (entry.kind !== "tool") continue;
    tools++;
    if (EDIT_TOOLS.has(canonicalToolName(entry.name))) {
      const path = editedPath(entry.input);
      if (path) edited.add(path);
    }
  }
  const media = (input.media ?? [])
    .filter((item) => item.taskId === task.id || item.rootTaskId === task.id)
    .map((item): DeliveryMedia => ({ id: item.id, kind: item.kind, title: item.title, fileName: item.fileName }));
  const request = stripMarkdown(task.prompt.split("\n")[0]?.trim() || task.prompt);
  return {
    id: task.id,
    taskId: task.id,
    ...(task.projectId ? { projectId: task.projectId } : {}),
    agentId: task.agentId,
    request: cut(request, DELIVERY_REQUEST_MAX),
    headline: parts.headline,
    ...(parts.summary ? { summary: parts.summary } : {}),
    text: task.result,
    ...((startedAt ?? task.createdAt) ? { startedAt: startedAt ?? task.createdAt } : {}),
    finishedAt: task.updatedAt,
    tools,
    edited: edited.size,
    media,
  };
}

/** As entregas de um agente, a mais nova primeiro. */
export function deliveriesOf(input: { tasks: readonly DeliveryTask[]; agentId: string; entries?: readonly AgentLogEntry[]; media?: readonly MediaItem[] }): DeliveryCard[] {
  const cards: DeliveryCard[] = [];
  for (const task of input.tasks) {
    if (task.agentId !== input.agentId) continue;
    const card = deliveryOf({ task, ...(input.entries ? { entries: input.entries } : {}), ...(input.media ? { media: input.media } : {}) });
    if (card) cards.push(card);
  }
  return cards.sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : a.finishedAt > b.finishedAt ? -1 : 0));
}
