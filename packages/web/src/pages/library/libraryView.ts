import { libraryUsage, type LibraryConnector, type LibraryGrantsInput, type LibraryWorkspaceInfo, type ServerEvent } from "@cyno/shared";

// ---------- Abas e endereço ----------

/**
 * As abas da Biblioteca. Cérebro e Mídia vêm primeiro (são as mais abertas) e são por workspace (o endereço leva o
 * workspace: `#/biblioteca/midia/<ws>`).
 */
export const LIBRARY_TABS = [
  { id: "cerebro", label: "Cérebro (notas)", ready: true },
  { id: "midia", label: "Mídia", ready: true },
  { id: "apps", label: "Apps", ready: true },
  { id: "conectores", label: "Conectores (MCP)", ready: true },
  { id: "skills", label: "Skills", ready: true },
] as const;
export type LibraryTabId = (typeof LIBRARY_TABS)[number]["id"];

/** A aba que abre ao entrar na Biblioteca sem aba no endereço: o Cérebro do workspace atual. */
export const DEFAULT_LIBRARY_TAB: LibraryTabId = "cerebro";
/** A aba de abertura quando não há workspace nenhum (o Cérebro é de um workspace só). */
export const PLATFORM_LIBRARY_TAB: LibraryTabId = "conectores";

/** Filtros da lista de conectores. */
export const LIBRARY_FILTERS = [
  { id: "todos", label: "Todos" },
  { id: "em-uso", label: "Em uso" },
  { id: "sem-uso", label: "Sem uso" },
  { id: "problema", label: "Com problema" },
] as const;
export type LibraryFilterId = (typeof LIBRARY_FILTERS)[number]["id"];

/** Para onde o endereço aponta: `#/biblioteca/conectores[/<workspace>]` (o workspace filtra a lista). */
export type LibraryLocation = { tab: LibraryTabId; workspaceId: string | null; /** Item destacado (`?item=<id>`): o cartão que o painel do agente apontou. */ item?: string | null };

/** Abas que mostram uma página de um workspace só (com seletor de workspace). */
export const WORKSPACE_TABS: readonly LibraryTabId[] = ["midia", "cerebro"];
export const isWorkspaceTab = (tab: LibraryTabId): boolean => WORKSPACE_TABS.includes(tab);

export function libraryHash(location: Partial<LibraryLocation> = {}): string {
  const tab = location.tab ?? DEFAULT_LIBRARY_TAB;
  const base = location.workspaceId ? `#/biblioteca/${tab}/${encodeURIComponent(location.workspaceId)}` : `#/biblioteca/${tab}`;
  return location.item ? `${base}?item=${encodeURIComponent(location.item)}` : base;
}

export function parseLibraryHash(hash: string): LibraryLocation {
  const parts = hash.replace(/^#\/?/, "").split("?")[0]!.split("/").filter(Boolean).map(decodeURIComponent);
  const tab = LIBRARY_TABS.find((candidate) => candidate.id === parts[1] && candidate.ready)?.id ?? DEFAULT_LIBRARY_TAB;
  const item = new URLSearchParams(hash.split("?")[1] ?? "").get("item");
  return { tab, workspaceId: parts[0] === "biblioteca" ? (parts[2] ?? null) : null, ...(item ? { item } : {}) };
}

/** Abre a Biblioteca (o navStore acompanha o endereço pelo popstate). */
export function openLibrary(location: Partial<LibraryLocation> = {}): void {
  window.history.pushState(null, "", libraryHash(location));
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// ---------- Estado e filtros ----------

/** O conector está ligado e com problema (precisa de login ou deu erro)? */
export function hasProblem(connector: Pick<LibraryConnector, "enabled" | "status">): boolean {
  return connector.enabled && (connector.status.state === "needs_auth" || connector.status.state === "error");
}

const plain = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

export type LibraryQuery = { filter: LibraryFilterId; query: string; workspaceId?: string | null };

/** Filtra e busca (nome, descrição, endereço, ferramentas, workspaces e agentes que usam). */
export function filterConnectors(list: readonly LibraryConnector[], { filter, query, workspaceId }: LibraryQuery): LibraryConnector[] {
  const needle = plain(query.trim());
  return list.filter((connector) => {
    if (workspaceId && !(workspaceId in connector.grants)) return false;
    const used = libraryUsage(connector).agents > 0;
    if (filter === "em-uso" && !used) return false;
    if (filter === "sem-uso" && used) return false;
    if (filter === "problema" && !hasProblem(connector)) return false;
    if (!needle) return true;
    const haystack = [
      connector.name,
      connector.description,
      connector.url ?? "",
      connector.command ?? "",
      ...connector.status.tools.map((tool) => tool.name),
      ...connector.uses.flatMap((use) => [use.workspaceName, ...use.agents.map((agent) => agent.name)]),
    ]
      .map(plain)
      .join("\n");
    return haystack.includes(needle);
  });
}

/** Quantos conectores cada filtro mostraria (os números nos botões). */
export function filterCounts(list: readonly LibraryConnector[], workspaceId?: string | null): Record<LibraryFilterId, number> {
  return Object.fromEntries(LIBRARY_FILTERS.map((filter) => [filter.id, filterConnectors(list, { filter: filter.id, query: "", workspaceId }).length])) as Record<LibraryFilterId, number>;
}

/** Aplica library:upserted / library:deleted a uma lista (antes do GET, ignora). */
export function applyLibraryEvent(list: LibraryConnector[] | null, event: ServerEvent): LibraryConnector[] | null {
  if (list === null) return list;
  if (event.type === "library:deleted") return list.some((item) => item.id === event.id) ? list.filter((item) => item.id !== event.id) : list;
  if (event.type !== "library:upserted") return list;
  const index = list.findIndex((item) => item.id === event.item.id);
  if (index === -1) return [...list, event.item];
  return list.map((item, i) => (i === index ? event.item : item));
}

export function usageLabel(connector: Pick<LibraryConnector, "uses">): string {
  const { workspaces, agents } = libraryUsage(connector);
  if (workspaces === 0) return "Ninguém usa ainda";
  const ws = workspaces === 1 ? "1 workspace" : `${workspaces} workspaces`;
  const ag = agents === 0 ? "nenhum agente" : agents === 1 ? "1 agente" : `${agents} agentes`;
  return `${ws} · ${ag}`;
}

export const ORIGIN_LABELS: Record<LibraryConnector["origin"], string> = { manual: "Digitado à mão", "claude-code": "Importado do Claude Code", app: "De um app" };

// ---------- Liberar: o rascunho da janela ----------

/** Rascunho da janela de liberar: workspace marcado e, dentro dele, os agentes marcados. */
export type GrantDraft = Record<string, { agentIds: string[] }>;

export function draftOf(connector: Pick<LibraryConnector, "grants">): GrantDraft {
  return Object.fromEntries(Object.entries(connector.grants).map(([ws, grant]) => [ws, { agentIds: [...grant.agentIds] }]));
}

export function grantsOf(draft: GrantDraft): LibraryGrantsInput {
  return Object.fromEntries(Object.entries(draft).map(([ws, grant]) => [ws, { agentIds: [...grant.agentIds] }]));
}

export const sameDraft = (a: GrantDraft, b: GrantDraft) => {
  const norm = (draft: GrantDraft) => JSON.stringify(Object.keys(draft).sort().map((ws) => [ws, [...draft[ws]!.agentIds].sort()]));
  return norm(a) === norm(b);
};

/** Marcar/desmarcar um workspace (desmarcar tira os agentes dele junto). */
export function toggleWorkspace(draft: GrantDraft, workspaceId: string, on: boolean): GrantDraft {
  const next = { ...draft };
  if (on) next[workspaceId] = next[workspaceId] ?? { agentIds: [] };
  else delete next[workspaceId];
  return next;
}

/** Marcar/desmarcar um agente (marcar um agente libera o workspace dele também). */
export function toggleAgent(draft: GrantDraft, workspaceId: string, agentId: string, on: boolean): GrantDraft {
  const current = draft[workspaceId]?.agentIds ?? [];
  const agentIds = on ? [...new Set([...current, agentId])] : current.filter((id) => id !== agentId);
  return { ...draft, [workspaceId]: { agentIds } };
}

/** "Todos do time": marca ou desmarca todos os agentes do workspace. */
export function toggleAllAgents(draft: GrantDraft, workspace: LibraryWorkspaceInfo, on: boolean): GrantDraft {
  return { ...draft, [workspace.id]: { agentIds: on ? workspace.agents.map((agent) => agent.id) : [] } };
}

/** O conector guarda alguma credencial? (a janela avisa que ela vale para todos os workspaces liberados) */
export function hasSecret(connector: Pick<LibraryConnector, "secretHeaders" | "secretEnv" | "url">): boolean {
  return connector.secretHeaders.length > 0 || connector.secretEnv.length > 0 || (connector.url?.includes("•") ?? false);
}

/** O que a mudança faz, em palavras (o resumo no pé da janela). */
export function describeDraftChange(before: GrantDraft, after: GrantDraft, workspaces: readonly LibraryWorkspaceInfo[]): string[] {
  const nameOf = (ws: string) => workspaces.find((candidate) => candidate.id === ws)?.name ?? ws;
  const lines: string[] = [];
  for (const ws of Object.keys(after)) {
    if (!(ws in before)) {
      lines.push(`Liberar para ${nameOf(ws)}${after[ws]!.agentIds.length > 0 ? ` (${after[ws]!.agentIds.length} ${after[ws]!.agentIds.length === 1 ? "agente" : "agentes"})` : " (sem agentes ainda)"}`);
      continue;
    }
    const added = after[ws]!.agentIds.filter((id) => !before[ws]!.agentIds.includes(id)).length;
    const removed = before[ws]!.agentIds.filter((id) => !after[ws]!.agentIds.includes(id)).length;
    if (added > 0) lines.push(`Entregar a ${added} ${added === 1 ? "agente" : "agentes"} em ${nameOf(ws)}`);
    if (removed > 0) lines.push(`Tirar de ${removed} ${removed === 1 ? "agente" : "agentes"} em ${nameOf(ws)}`);
  }
  for (const ws of Object.keys(before)) if (!(ws in after)) lines.push(`Retirar de ${nameOf(ws)}`);
  return lines;
}
