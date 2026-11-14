// Lê as tarefas concluídas na semana de todos os workspaces (rota de atividade de cada um), soma e acompanha o alvo.
// Só trabalha com a faixa aberta; erro de um workspace conta como zero e a próxima leitura tenta de novo.
import type { ActivitySummary } from "@cyno/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson } from "../../api/client";
import { acabouDeBater, alvoValido, guardarAlvo, jaFestejou, lerAlvo, marcarFestejada, semanaDe } from "./meta";

/** De quanto em quanto tempo a soma é refeita com a faixa aberta. */
export const RELOGIO_DA_META_MS = 60_000;

/** Soma `tasksDone` da semana nos workspaces (função da rede injetável, para testar). */
export async function tarefasDaSemana(ids: readonly string[], semana: { from: string; to: string }, buscar: (caminho: string) => Promise<ActivitySummary> = (c) => requestJson<ActivitySummary>(c)): Promise<number> {
  const partes = await Promise.all(
    ids.map(async (id) => {
      try {
        const resumo = await buscar(`/api/w/${encodeURIComponent(id)}/activity/summary?from=${semana.from}&to=${semana.to}`);
        return typeof resumo.tasksDone === "number" ? resumo.tasksDone : 0;
      } catch {
        return 0;
      }
    }),
  );
  return partes.reduce((soma, n) => soma + n, 0);
}

export interface MetaDaSemana {
  /** Tarefas concluídas na semana (null = ainda não leu). */
  feitas: number | null;
  alvo: number;
  definirAlvo(valor: number): void;
  /** Sobe a cada vez que a meta bate (dispara os fogos). */
  fogos: number;
}

export function useMetaDaSemana(ids: readonly string[], ativo: boolean): MetaDaSemana {
  const [feitas, setFeitas] = useState<number | null>(null);
  const [alvo, setAlvo] = useState(() => lerAlvo());
  const [fogos, setFogos] = useState(0);
  const anterior = useRef<number | null>(null);
  const alvoRef = useRef(alvo);
  useEffect(() => {
    alvoRef.current = alvo;
  }, [alvo]);
  const chave = [...ids].sort().join("|");

  useEffect(() => {
    if (!ativo || ids.length === 0) return;
    let vivo = true;
    const ler = async () => {
      const semana = semanaDe(new Date());
      const total = await tarefasDaSemana(ids, semana);
      if (!vivo) return;
      if (acabouDeBater(anterior.current, total, alvoRef.current) && !jaFestejou(semana.chave)) {
        marcarFestejada(semana.chave);
        setFogos((n) => n + 1);
      }
      anterior.current = total;
      setFeitas(total);
    };
    void ler();
    const relogio = setInterval(() => void ler(), RELOGIO_DA_META_MS);
    return () => {
      vivo = false;
      clearInterval(relogio);
    };
    // `chave` representa a lista de ids
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ativo, chave]);

  const definirAlvo = useCallback((valor: number) => {
    const novo = guardarAlvo(alvoValido(valor));
    setAlvo(novo);
  }, []);

  return { feitas, alvo, definirAlvo, fogos };
}
