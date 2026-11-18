import type { ForYouArchiveSummary, ForYouItem } from "@cyno/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError } from "../../api/client";
import { sortArchiveItems } from "./archiveView";

type MonthState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; items: ForYouItem[] };

/**
 * O arquivo das Aprovações decididas há mais tempo que o prazo. Fica em estado local da página (nunca no
 * store global): o resumo vem uma vez ao abrir a página e cada mês só é buscado quando alguém o abre.
 */
export function useForYouArchive() {
  const [summary, setSummary] = useState<ForYouArchiveSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [months, setMonths] = useState<Record<string, MonthState>>({});
  const alive = useRef(true);

  const fetchSummary = useCallback(() => {
    api
      .getForYouArchive()
      .then((next) => {
        if (alive.current) setSummary(next);
      })
      .catch((failure: unknown) => {
        if (alive.current) setError(describeError(failure));
      });
  }, []);

  /** "Tentar de novo": limpa o erro e busca o resumo outra vez. */
  const reload = useCallback(() => {
    setError(null);
    fetchSummary();
  }, [fetchSummary]);

  useEffect(() => {
    alive.current = true;
    fetchSummary();
    return () => {
      alive.current = false;
    };
  }, [fetchSummary]);

  const loadMonth = useCallback((month: string) => {
    setMonths((current) =>
      current[month]?.status === "ready"
        ? current
        : { ...current, [month]: { status: "loading" } },
    );
    api
      .getForYouArchiveMonth(month)
      .then((items) => {
        if (alive.current)
          setMonths((current) => ({
            ...current,
            [month]: { status: "ready", items: sortArchiveItems(items) },
          }));
      })
      .catch((failure: unknown) => {
        if (alive.current)
          setMonths((current) => ({
            ...current,
            [month]: { status: "error", error: describeError(failure) },
          }));
      });
  }, []);

  /** Um item do arquivo pelo id (para "Abrir em Aprovações" de algo que já saiu da lista viva); null se não achou ou falhou. */
  const findItem = useCallback(
    async (id: string): Promise<ForYouItem | null> => {
      try {
        const found = await api.findForYouArchive({ id });
        return found.find((item) => item.id === id) ?? null;
      } catch {
        return null;
      }
    },
    [],
  );

  return { summary, error, months, reload, loadMonth, findItem };
}
