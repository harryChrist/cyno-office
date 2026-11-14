import { useEffect, useState } from "react";

type Clock = { now: number; until: number };

/**
 * Contagem regressiva em segundos: devolve os segundos que faltam e uma função `start(segundos)`
 * (chamada no tratador do 429). Atualiza a cada segundo e para quando chega a 0.
 */
export function useCountdown(): [number, (seconds: number) => void] {
  const [clock, setClock] = useState<Clock | null>(null);
  const until = clock?.until ?? null;
  useEffect(() => {
    if (until === null) return;
    const timer = setInterval(() => {
      setClock({ now: Date.now(), until });
      if (Date.now() >= until) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [until]);
  const seconds = clock ? Math.max(0, Math.ceil((clock.until - clock.now) / 1000)) : 0;
  return [seconds, (wait) => setClock({ now: Date.now(), until: Date.now() + wait * 1000 })];
}

/** Lê os segundos de espera de uma resposta 429 (corpo `retryAfterSeconds` ou cabeçalho `retry-after`). */
export async function retryAfterOf(response: Response): Promise<number> {
  const header = Number(response.headers.get("retry-after"));
  const body = (await response.json().catch(() => null)) as { retryAfterSeconds?: number } | null;
  return body?.retryAfterSeconds ?? (Number.isFinite(header) ? header : 0);
}
