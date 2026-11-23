/**
 * Porteiro das consultas de uso: deixa no máximo `limit` consultas rodando ao mesmo tempo (as outras esperam na fila,
 * em ordem). Serve para muitas contas não dispararem todas juntas (nem tomarem limite de taxa do serviço).
 */
export type QueryGate = <T>(run: () => Promise<T>) => Promise<T>;

export function createQueryGate(limit: number): QueryGate {
  const max = Math.max(1, Math.floor(limit));
  let running = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    running -= 1;
    waiting.shift()?.();
  };
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (running >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await run();
    } finally {
      release();
    }
  };
}
