import type { Avatar, MediaItem } from "@cyno/shared";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { api, describeError } from "../../api/client";
import { collect, createScopeCache, keysToFetch } from "./mediaCache";

/** A biblioteca de um workspace e o nome (e o rosto) dos agentes dele, como veio do servidor. */
type WorkspaceMedia = { items: MediaItem[]; agents: Record<string, { name: string; avatar?: Avatar }> };

/** O que a Mídia busca de outros workspaces (só leitura). */
export type RemoteMedia = {
  items: Record<string, MediaItem[]>;
  agents: Record<string, Record<string, string>>;
  avatars: Record<string, Record<string, Avatar>>;
  /** Falta chegar algum workspace pedido (a tela segura a lista anterior até lá). */
  pending: boolean;
  error: string | null;
  reload: () => void;
};

// ---------- Cache de módulo: vale para a página inteira e sobrevive a sair e voltar ----------

const cache = createScopeCache<WorkspaceMedia>({ ttlMs: 30_000 });
const inFlight = new Set<string>();
const failures = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

const notify = () => {
  version += 1;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Pede um workspace e guarda a resposta. Uma resposta atrasada só enche o cache da própria chave: nunca atropela a tela de outra. */
async function fetchWorkspace(id: string): Promise<void> {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    const [items, agents] = await Promise.all([api.listMediaOf(id), api.agentNamesOf(id).catch(() => [])]);
    cache.set(id, { items, agents: Object.fromEntries(agents.map((agent) => [agent.id, { name: agent.name, avatar: agent.avatar }])) });
    failures.delete(id);
  } catch (error) {
    failures.set(id, describeError(error));
  } finally {
    inFlight.delete(id);
    notify();
  }
}

/** Chegou ou saiu mídia no workspace: o que está guardado dele deixa de valer (a próxima visita pede de novo). */
export function dropRemoteMedia(workspaceId: string): void {
  cache.drop(workspaceId);
  notify();
}

/** Esquenta o cache em segundo plano (os outros workspaces, para "Outro" e "Todos" abrirem na hora). */
export function prefetchRemoteMedia(workspaceIds: readonly string[]): void {
  for (const id of keysToFetch(workspaceIds, cache, inFlight)) void fetchWorkspace(id);
}

/** O que está guardado de um workspace (e se já passou do prazo); só para os testes e para quem quer espiar sem pedir. */
export function peekRemoteMedia(workspaceId: string): { items: MediaItem[]; stale: boolean } | undefined {
  const entry = cache.read(workspaceId);
  return entry ? { items: entry.value.items, stale: entry.stale } : undefined;
}

/** Só para os testes. */
export function resetRemoteMediaCache(): void {
  cache.clear();
  inFlight.clear();
  failures.clear();
  notify();
}

/**
 * A biblioteca dos workspaces pedidos (a lista é comparada pelo conteúdo). O que já foi carregado aparece na hora e é
 * revalidado em segundo plano; só quando falta algum workspace é que `pending` fica ligado (e `items` vem vazio).
 */
export function useRemoteMedia(workspaceIds: readonly string[]): RemoteMedia {
  const key = workspaceIds.join("\n");
  const ids = useMemo(() => (key ? key.split("\n") : []), [key]);
  const tick = useSyncExternalStore(subscribe, () => version, () => 0);

  useEffect(() => {
    for (const id of keysToFetch(ids, cache, inFlight)) void fetchWorkspace(id);
  }, [ids]);

  const reload = useCallback(() => {
    for (const id of keysToFetch(ids, cache, inFlight, true)) {
      failures.delete(id);
      void fetchWorkspace(id);
    }
    notify();
  }, [ids]);

  return useMemo<RemoteMedia>(() => {
    void tick;
    const empty = { items: {}, agents: {}, avatars: {} };
    if (ids.length === 0) return { ...empty, pending: false, error: null, reload };
    const ready = collect(ids, cache);
    const failed = ids.map((id) => failures.get(id)).find((message) => message !== undefined) ?? null;
    if (!ready) return { ...empty, pending: failed === null, error: failed, reload };
    const items: RemoteMedia["items"] = {};
    const agents: RemoteMedia["agents"] = {};
    const avatars: RemoteMedia["avatars"] = {};
    ids.forEach((id, index) => {
      const entry = ready[index]!;
      items[id] = entry.items;
      agents[id] = Object.fromEntries(Object.entries(entry.agents).map(([agentId, agent]) => [agentId, agent.name]));
      avatars[id] = Object.fromEntries(Object.entries(entry.agents).flatMap(([agentId, agent]) => (agent.avatar ? [[agentId, agent.avatar] as const] : [])));
    });
    return { items, agents, avatars, pending: false, error: null, reload };
  }, [ids, tick, reload]);
}
