/**
 * Lógica pura do cache da Mídia: guarda o que já foi carregado de cada workspace para a volta ser instantânea,
 * diz o que ainda precisa ser pedido (faltando ou velho) e descarta o que a rede já desmentiu. Os filtros e a busca
 * rodam no navegador em cima da lista inteira do workspace, então a "chave" do cache é o workspace.
 */

export type CacheRead<T> = { value: T; stale: boolean };

export type ScopeCache<T> = {
  /** O que há guardado, e se já passou do prazo (velho: mostra e revalida em segundo plano). */
  read: (key: string) => CacheRead<T> | undefined;
  set: (key: string, value: T) => void;
  /** Esquece uma chave (chegou mídia nova pelo socket, por exemplo). */
  drop: (key: string) => void;
  clear: () => void;
};

/** Cache por chave com prazo: `ttlMs` depois de gravar, a entrada continua valendo para mostrar, mas conta como velha. */
export function createScopeCache<T>(options: { ttlMs?: number; now?: () => number } = {}): ScopeCache<T> {
  const ttl = options.ttlMs ?? 30_000;
  const now = options.now ?? (() => Date.now());
  const map = new Map<string, { value: T; at: number }>();
  return {
    read(key) {
      const entry = map.get(key);
      return entry ? { value: entry.value, stale: now() - entry.at >= ttl } : undefined;
    },
    set(key, value) {
      map.set(key, { value, at: now() });
    },
    drop(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
  };
}

/**
 * Quais chaves precisam de pedido agora: as que faltam e as velhas, menos as que já estão a caminho.
 * (Com `force`, também as frescas: o "tentar de novo" e a atualização manual.)
 */
export function keysToFetch(keys: readonly string[], cache: Pick<ScopeCache<unknown>, "read">, inFlight: ReadonlySet<string>, force = false): string[] {
  return keys.filter((key) => {
    if (inFlight.has(key)) return false;
    const entry = cache.read(key);
    return force || !entry || entry.stale;
  });
}

/**
 * Ordem dos pedidos: só o último "vale". `begin()` devolve uma senha; `isCurrent(senha)` diz se ainda é a mais nova.
 * Usado quando uma resposta velha pode chegar depois de uma troca nova e não deve mexer na tela.
 */
export function createLatest(): { begin: () => number; isCurrent: (ticket: number) => boolean } {
  let latest = 0;
  return {
    begin: () => (latest += 1),
    isCurrent: (ticket) => ticket === latest,
  };
}

/** Os valores prontos de várias chaves; `null` enquanto alguma ainda não chegou (todas ou nenhuma: a tela não mostra "meia lista"). */
export function collect<T>(keys: readonly string[], cache: Pick<ScopeCache<T>, "read">): T[] | null {
  const values: T[] = [];
  for (const key of keys) {
    const entry = cache.read(key);
    if (!entry) return null;
    values.push(entry.value);
  }
  return values;
}
