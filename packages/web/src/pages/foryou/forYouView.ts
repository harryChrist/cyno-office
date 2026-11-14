import {
  actorLabel,
  FOR_YOU_QUESTION_TYPE,
  formatCharCount,
  forYouLimit,
  forYouTextLength,
  forYouTypeColorVar,
  forYouKind,
  forYouTypeNameFrom,
  lastUpdate,
  type ForYouHistoryEntry,
  type ForYouItem,
  type ForYouLimit,
  type ForYouSource,
  type ForYouTypeDef,
} from "@cyno/shared";
import type { CSSProperties } from "react";

/** Lógica pura da página "Para você": filtros, contagens, título do card, limite e navegação. */

/** Pendentes (esperando você), decididos (aprovados, rejeitados, respondidos) e cancelados (retirados sem decisão). */
export type StatusFilter = "pendente" | "decididos" | "cancelados";
export const STATUS_FILTERS: readonly StatusFilter[] = ["pendente", "decididos", "cancelados"];
export const STATUS_FILTER_LABELS: Record<StatusFilter, string> = { pendente: "Pendentes", decididos: "Decididos", cancelados: "Cancelados" };
/** Situação escolhida na lateral: "todos" mostra "Esperando você" e "Decididos" juntos, em dois grupos. */
export type StatusView = StatusFilter | "todos";
export const STATUS_VIEWS: readonly StatusView[] = ["todos", ...STATUS_FILTERS];
export const STATUS_VIEW_LABELS: Record<StatusView, string> = { todos: "Todos", ...STATUS_FILTER_LABELS };
/** "todos" ou o id de um tipo. */
export type TypeFilter = string;

export type TypeList = readonly ForYouTypeDef[] | null | undefined;

/** O que a tela mostra de um tipo; um id sem tipo (excluído no meio) aparece cinza, com o id como nome. */
export type TypeDisplay = Pick<ForYouTypeDef, "id" | "name" | "icon" | "color" | "behavior"> & { def?: ForYouTypeDef };

/**
 * Planos, questionários e rotinas não são de um tipo de aprovação (carregam "outro"/"pergunta" só por
 * compatibilidade): o filtro e o selo usam o tipo deles ("Planos", "Questionários").
 */
export const KIND_FILTERS = {
  plano: { id: "@plano", name: "Planos", icon: "estrela", color: "violeta", behavior: "texto" },
  questionario: { id: "@questionario", name: "Questionários", icon: "interrogacao", color: "ciano", behavior: "pergunta" },
  rotina: { id: "@rotina", name: "Rotinas", icon: "bandeira", color: "verde", behavior: "texto" },
  sprint: { id: "@sprint", name: "Entregas", icon: "maleta", color: "ambar", behavior: "texto" },
  regra: { id: "@regra", name: "Regras", icon: "escudo", color: "rosa", behavior: "texto" },
} as const satisfies Record<string, TypeDisplay>;
const KIND_FILTER_IDS: readonly string[] = Object.values(KIND_FILTERS).map((kind) => kind.id);

/** Em que opção do filtro o item entra: o tipo (aprovação) ou o tipo especial (plano, questionário). */
export function filterKey(item: Pick<ForYouItem, "type" | "kind">): string {
  if (item.kind === "plano" || item.kind === "questionario" || item.kind === "rotina" || item.kind === "sprint" || item.kind === "regra") return KIND_FILTERS[item.kind].id;
  return item.type;
}

export function typeDisplay(types: TypeList, id: string): TypeDisplay {
  const kind = Object.values(KIND_FILTERS).find((candidate) => candidate.id === id);
  if (kind) return { ...kind };
  const def = types?.find((type) => type.id === id);
  if (def) return { id, name: def.name, icon: def.icon, color: def.color, behavior: def.behavior, def };
  return { id, name: forYouTypeNameFrom(id), icon: "ponto", color: "cinza", behavior: id === FOR_YOU_QUESTION_TYPE ? "pergunta" : "texto" };
}

/** `--c` do tipo (ícone, barra, selo): o token da cor na paleta. */
export function typeStyle(type: Pick<ForYouTypeDef, "color">): CSSProperties {
  return { "--c": forYouTypeColorVar(type.color) } as CSSProperties;
}

export const isPending = (item: Pick<ForYouItem, "status">) => item.status === "pendente";

export const isCancelled = (item: Pick<ForYouItem, "status">) => item.status === "cancelado";

/** Em que grupo da lateral o item entra. */
export function statusGroup(item: Pick<ForYouItem, "status">): StatusFilter {
  return isPending(item) ? "pendente" : isCancelled(item) ? "cancelados" : "decididos";
}

const inGroup = (item: ForYouItem, filter: StatusFilter) => statusGroup(item) === filter;

/** Quantos pendentes, decididos e cancelados. */
export function statusCounts(items: readonly ForYouItem[]): Record<StatusFilter, number> {
  const counts: Record<StatusFilter, number> = { pendente: 0, decididos: 0, cancelados: 0 };
  for (const item of items) counts[statusGroup(item)] += 1;
  return counts;
}

/** Dá para descartar (pendente e não é um plano, uma entrega de sprint nem uma regra: o plano tem o próprio Cancelar, a entrega só se aprova ou se devolve e a regra só se aprova ou se recusa). */
export function canDiscard(item: Pick<ForYouItem, "status" | "kind">): boolean {
  return isPending(item) && forYouKind(item) !== "plano" && forYouKind(item) !== "sprint" && forYouKind(item) !== "regra";
}

/** "Cancelado pelo Maestro", "Cancelado por Clara", "Descartado por você" (null = não foi cancelado). */
export function cancelLabel(item: Pick<ForYouItem, "status" | "cancelledBy"> & { cancelReason?: string }, agentName?: string): string | null {
  if (!isCancelled(item)) return null;
  const by = item.cancelledBy ?? "maestro";
  // Meta que fechou: o servidor dispensa as opções que sobraram ("Dispensado: meta batida").
  if (by === "servidor") return item.cancelReason ?? "Dispensado pelo servidor";
  return by === "usuario" ? "Descartado por você" : `Cancelado ${actorLabel(by, agentName)}`;
}

export type UpdateBadge = { label: string; reason?: string; count: number; entries: ForYouHistoryEntry[] };

/** Selo "Atualizado pelo Maestro" (ou pelo agente) com o motivo da última alteração; null = nunca alterado. */
export function updateBadge(item: Pick<ForYouItem, "history">, agentName?: string): UpdateBadge | null {
  const last = lastUpdate(item);
  if (!last) return null;
  const entries = (item.history ?? []).filter((entry) => entry.action === "alterado");
  return { label: `Atualizado ${actorLabel(last.by, agentName)}`, ...(last.reason ? { reason: last.reason } : {}), count: entries.length, entries };
}

export type TypeOption = { type: TypeFilter; label: string; count: number; display?: TypeDisplay };

/**
 * Opções do filtro por tipo dentro do grupo (pendentes ou decididos): "Todos", os planos e os
 * questionários, e cada tipo de aprovação que tem itens, na ordem dos tipos do workspace (ids sem
 * tipo vão no fim). O tipo selecionado aparece mesmo com 0 (para dar para sair dele).
 */
export function typeOptions(items: readonly ForYouItem[], status: StatusView, selected: TypeFilter, types: TypeList): TypeOption[] {
  const group = items.filter((item) => status === "todos" || inGroup(item, status));
  const counts = new Map<string, number>();
  for (const item of group) counts.set(filterKey(item), (counts.get(filterKey(item)) ?? 0) + 1);
  const known = [...KIND_FILTER_IDS, ...(types ?? []).map((type) => type.id)];
  const orphans = [...counts.keys()].filter((id) => !known.includes(id)).sort();
  const ids = [...known, ...orphans].filter((id) => counts.has(id) || (id === selected && selected !== "todos"));
  return [
    { type: "todos", label: "Todos", count: group.length },
    ...ids.map((id) => {
      const display = typeDisplay(types, id);
      return { type: id, label: display.name, count: counts.get(id) ?? 0, display };
    }),
  ];
}

/**
 * Itens da lista: pendentes do mais antigo para o mais novo (é uma fila); decididos e cancelados
 * do mais recente para o mais antigo.
 */
export function visibleItems(items: readonly ForYouItem[], status: StatusView, type: TypeFilter): ForYouItem[] {
  if (status === "todos") {
    const { waiting, decided } = sections(items, type);
    return [...waiting, ...decided];
  }
  const list = items.filter((item) => inGroup(item, status) && (type === "todos" || filterKey(item) === type));
  if (status === "pendente") return list.sort(byWaiting);
  return list.sort(byDecided);
}

const byWaiting = (a: ForYouItem, b: ForYouItem) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
const byDecided = (a: ForYouItem, b: ForYouItem) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt) || b.id.localeCompare(a.id);

/**
 * Visão "Todos": "Esperando você" (pendentes, do mais antigo para o mais novo) e "Decididos"
 * (aprovados, editados, rejeitados, respondidos e cancelados, do mais recente para o mais antigo),
 * ambos já filtrados pelo tipo.
 */
export function sections(items: readonly ForYouItem[], type: TypeFilter): { waiting: ForYouItem[]; decided: ForYouItem[] } {
  const list = items.filter((item) => type === "todos" || filterKey(item) === type);
  return { waiting: list.filter(isPending).sort(byWaiting), decided: list.filter((item) => !isPending(item)).sort(byDecided) };
}

/** Idade de quem espera: "há 5 min", "há 3 h" e, a partir de 24 h, "há 2 d". */
export function waitingAge(createdAt: string, now: number = Date.now()): string {
  const ms = now - Date.parse(createdAt);
  if (!Number.isFinite(ms)) return createdAt;
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `há ${hours} h` : `há ${Math.floor(hours / 24)} d`;
}

/** Título do card: "onde", senão "para", senão a pergunta, senão "Tipo do agente". */
export function cardTitle(item: ForYouItem, agentName: string | undefined, types: TypeList): string {
  if (item.where) return item.where;
  if (item.to) return `Para ${item.to}`;
  if (item.title) return item.title;
  const type = typeDisplay(types, item.type);
  if (type.behavior === "pergunta") return `${type.name} para você`;
  return agentName ? `${type.name} de ${agentName}` : type.name;
}

export type CounterTone = "ok" | "perto" | "passou";

export type CounterState = {
  length: number;
  limit: ForYouLimit | null;
  tone: CounterTone;
  /** Quanto passou do limite (0 se não passou ou não tem limite). */
  over: number;
  /** Preenchimento da barra, 0..1. */
  fill: number;
};

/**
 * Contador do texto: perto a partir de 90% do limite; passou acima dele. Conta como o server
 * confere o request_approval (forYouTextLength: um emoji conta 1).
 */
export function counterState(item: Pick<ForYouItem, "type" | "where">, text: string, types: TypeList): CounterState {
  const limit = forYouLimit(types?.find((type) => type.id === item.type), item.where);
  const length = forYouTextLength(text);
  if (!limit) return { length, limit, tone: "ok", over: 0, fill: 0 };
  const over = Math.max(0, length - limit.max);
  const tone: CounterTone = over > 0 ? "passou" : length >= limit.max * 0.9 ? "perto" : "ok";
  return { length, limit, tone, over, fill: Math.min(1, length / limit.max) };
}

/** Nome do limite para o aviso: o do tipo ("Legenda de post"), com o do "onde" se for outro ("Perfil (headline)"). */
function limitLabel(item: Pick<ForYouItem, "type">, limit: ForYouLimit, types: TypeList): string {
  const typeName = typeDisplay(types, item.type).name;
  return limit.name.toLowerCase() === typeName.toLowerCase() ? typeName : `${typeName} (${limit.name})`;
}

/** "Passa 250 caracteres do limite de Legenda de post" (null = cabe ou não tem limite). */
export function overLimitWarning(item: Pick<ForYouItem, "type" | "where">, text: string, types: TypeList): string | null {
  const counter = counterState(item, text, types);
  if (!counter.limit || counter.over === 0) return null;
  const unit = counter.over === 1 ? "caractere" : "caracteres";
  return `Passa ${formatCharCount(counter.over)} ${unit} do limite de ${limitLabel(item, counter.limit, types)}`;
}

export type OverLimitConfirm = { length: number; max: number; label: string };

/**
 * Aprovar um texto acima do limite pede confirmação (não bloqueia): devolve o que o diálogo
 * mostra, ou null quando pode aprovar direto (cabe, sem limite, pergunta ou outra decisão).
 */
export function approvalConfirm(item: Pick<ForYouItem, "type" | "where">, status: ForYouItem["status"], text: string, types: TypeList): OverLimitConfirm | null {
  if (status !== "aprovado" || typeDisplay(types, item.type).behavior === "pergunta") return null;
  const counter = counterState(item, text, types);
  if (!counter.limit || counter.over === 0) return null;
  return { length: counter.length, max: counter.limit.max, label: limitLabel(item, counter.limit, types) };
}

/** Chaves de `meta` que viram chip ou já aparecem em outro lugar (não entram nos "extras"). */
const SHOWN_META = new Set(["crivo", "simulado"]);

/** Metadados extras do card (chave/valor), sem os que já viraram chip. */
export function extraMeta(item: ForYouItem): [string, string][] {
  return Object.entries(item.meta).filter(([key]) => !SHOWN_META.has(key.toLowerCase()));
}

export type CrivoTone = "ok" | "no" | "neutro";

/** "aprovado…" = ok, "reprovado…" = no. */
export function crivoTone(crivo: string): CrivoTone {
  if (/^aprovad/i.test(crivo)) return "ok";
  if (/^reprovad/i.test(crivo)) return "no";
  return "neutro";
}

/** Próximo índice do J/K (sem foco: o primeiro). */
export function stepIndex(current: number, length: number, step: 1 | -1): number {
  if (length === 0) return -1;
  if (current < 0) return 0;
  return Math.max(0, Math.min(length - 1, current + step));
}

/** Rótulo da ação principal e o status que ela grava. */
export function primaryAction(item: Pick<ForYouItem, "type">, types: TypeList): { status: "aprovado" | "respondido"; label: string } {
  return typeDisplay(types, item.type).behavior === "pergunta" ? { status: "respondido", label: "Responder" } : { status: "aprovado", label: "Aprovar" };
}

/** Texto do aviso depois de decidir. */
export const DONE_LABELS: Record<ForYouItem["status"], string> = {
  aprovado: "Aprovado",
  rejeitado: "Recusado",
  respondido: "Respondido",
  pendente: "Reaberto",
  cancelado: "Descartado",
};

/** Um lote de aprovações (itens do mesmo `groupId`, abertos juntos pela mesma tarefa de um agente). */
export type BatchProgress = { groupId: string; total: number; decided: number; pending: ForYouItem[] };

/** O lote do item (undefined se ele não é de um lote com mais de um item). "Decididos" inclui os cancelados. */
export function batchOf(items: readonly ForYouItem[], item: Pick<ForYouItem, "groupId">): BatchProgress | undefined {
  if (!item.groupId) return undefined;
  const group = items.filter((candidate) => candidate.groupId === item.groupId);
  if (group.length < 2) return undefined;
  const pending = group.filter(isPending);
  return { groupId: item.groupId, total: group.length, decided: group.length - pending.length, pending };
}

/** "3 de 10 decididos". */
export const batchLabel = (batch: Pick<BatchProgress, "total" | "decided">) => `${batch.decided} de ${batch.total} decididos`;

/** Rascunho local (texto e resposta ainda não enviados) de um card. */
export type CardDraft = { text?: string; response?: string; /** Motivo da recusa (campo aberto ao clicar em Recusar). */ reason?: string };

/** Descarta os rascunhos de itens que não estão mais pendentes (decididos em outra aba, por ex.). */
export function pruneDrafts(drafts: Readonly<Record<string, CardDraft>>, items: readonly ForYouItem[]): Record<string, CardDraft> {
  const pending = new Set(items.filter(isPending).map((item) => item.id));
  const kept = Object.entries(drafts).filter(([id]) => pending.has(id));
  return kept.length === Object.keys(drafts).length ? (drafts as Record<string, CardDraft>) : Object.fromEntries(kept);
}

/** Grupo de itens do mesmo pedido, como a lista os recebe (o que importa aqui: quantos itens e de qual pedido). */
type GroupShape = { requestId?: string; title: string; items: readonly unknown[] };

/** Cabeçalho do grupo só com 2 itens ou mais; com um item só, o pedido vira uma linha discreta dentro da linha do item. */
export function showGroupHeader(group: GroupShape): boolean {
  return group.items.length >= 2;
}

/** Nome do pedido a mostrar dentro da linha (grupo de um item só, e só quando veio de um pedido). */
export function inlineRequestLabel(group: GroupShape): string | undefined {
  return group.items.length === 1 && group.requestId ? group.title : undefined;
}

/** As fontes do item (o que o agente leu para escrever o rascunho); lista vazia quando não há nenhuma. */
export function sourcesOf(item: Pick<ForYouItem, "sources">): ForYouSource[] {
  return Array.isArray(item.sources) ? item.sources : [];
}

/** Primeiro endereço http(s) do texto "onde" (ex.: "Post de X (…) – https://…"), sem pontuação no fim. */
export function linkInWhere(where: string | undefined): string | undefined {
  const match = where?.match(/https?:\/\/[^\s)]+/);
  return match?.[0].replace(/[.,;]+$/, "");
}

/** "Abrir no LinkedIn" quando o endereço é do LinkedIn; senão "Abrir original". */
export function openLinkLabel(url: string): string {
  try {
    return new URL(url).hostname.endsWith("linkedin.com") ? "Abrir no LinkedIn" : "Abrir original";
  } catch {
    return "Abrir original";
  }
}

/** Quanto tempo um pedido espera: "velho" a partir de 24 h, "demora" a partir de 6 h. */
export function ageTone(createdAt: string, now: number = Date.now()): "novo" | "demora" | "velho" {
  const hours = (now - Date.parse(createdAt)) / 3_600_000;
  if (!Number.isFinite(hours)) return "novo";
  return hours >= 24 ? "velho" : hours >= 6 ? "demora" : "novo";
}
