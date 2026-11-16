import type { AgentInfo } from "@cyno/cena/tipos";
import { memoriaDeEfeitosVazia, type MemoriaDeEfeitos } from "./efeitos";

/** Quanto tempo um subagente que terminou fica no retrato como `done` (o motor entrega ao pai e o manda embora). */
export const SUB_TERMINADO_MS = 25_000;
/** Quanto tempo quem desligou o terminal fica no retrato como `offline` (o tempo de descer pelo elevador). */
export const SAIDA_MS = 30_000;
/** Quanto tempo a atividade de "concluiu" / "falhou" aparece depois da transição da tarefa. */
export const RESULTADO_MS = 8_000;

export type ResultadoDeTarefa = { taskId: string; titulo: string; falhou: boolean; ate: number };

/**
 * O único estado entre chamadas do adaptador. Entra e sai sem ser mutado (cada chamada devolve uma memória nova).
 * Só `primeiraVez`, `ordemDasSalas` e `inicio` valem entre recargas da página (`memoriaParaJson` / `memoriaDeJson`): são o que
 * mantém a ordem de chegada, e com ela a mesa, estável. O resto é transitório.
 */
export type MemoriaDaCena = {
  /** agentId -> quando apareceu pela primeira vez (ordem de chegada; `startedAt` do personagem). */
  primeiraVez: ReadonlyMap<string, number>;
  /** salaId -> ordem de chegada da sala (0, 1, 2...): a planta só cresce para o fim; sala nova entra depois das que já estavam. */
  ordemDasSalas: ReadonlyMap<string, number>;
  /** agentId -> desde quando o estado atual vale (`statusSince`). */
  desde: ReadonlyMap<string, { chave: string; em: number }>;
  /** Subagentes rodando no último retrato (id do personagem -> personagem), para saber quando terminam. */
  subsAtivos: ReadonlyMap<string, AgentInfo>;
  /** Subagentes que acabaram de terminar: ficam `done` até `ate`. */
  subsTerminados: ReadonlyMap<string, { sub: AgentInfo; ate: number }>;
  /** taskId -> status visto no retrato anterior (para detectar transições). */
  tarefasVistas: ReadonlyMap<string, string>;
  /** agentId -> resultado recente de uma tarefa (concluiu/falhou). */
  resultados: ReadonlyMap<string, ResultadoDeTarefa>;
  /** agentId -> até quando fica como `offline` (descendo pelo elevador). */
  saindo: ReadonlyMap<string, number>;
  /** Agentes presentes (não offline) no retrato anterior. */
  presentes: ReadonlySet<string>;
  /** Festa e alarme em curso, e o que já foi visto para não repetir (ver `efeitos.ts`). */
  efeitos: MemoriaDeEfeitos;
  /** Número do último retrato publicado. */
  rev: number;
  /** Quando a memória nasceu (`meta.startedAt`). */
  inicio: number;
};

export function memoriaInicial(agora: number): MemoriaDaCena {
  return {
    primeiraVez: new Map(),
    ordemDasSalas: new Map(),
    desde: new Map(),
    subsAtivos: new Map(),
    subsTerminados: new Map(),
    tarefasVistas: new Map(),
    resultados: new Map(),
    saindo: new Map(),
    presentes: new Set(),
    efeitos: memoriaDeEfeitosVazia(),
    rev: 0,
    inicio: agora,
  };
}

type MemoriaGuardada = { v: 1; inicio: number; primeiraVez: Record<string, number>; salas?: Record<string, number> };

/** A parte da memória que sobrevive à recarga da página, em JSON. */
export function memoriaParaJson(memoria: MemoriaDaCena): string {
  const guardada: MemoriaGuardada = { v: 1, inicio: memoria.inicio, primeiraVez: Object.fromEntries(memoria.primeiraVez), salas: Object.fromEntries(memoria.ordemDasSalas) };
  return JSON.stringify(guardada);
}

/** Lê o que `memoriaParaJson` guardou; JSON ausente ou estragado vira memória vazia. */
export function memoriaDeJson(json: string | null | undefined, agora: number): MemoriaDaCena {
  const vazia = memoriaInicial(agora);
  if (!json) return vazia;
  try {
    const bruto = JSON.parse(json) as Partial<MemoriaGuardada> | null;
    if (!bruto || bruto.v !== 1 || typeof bruto.inicio !== "number" || typeof bruto.primeiraVez !== "object" || bruto.primeiraVez === null) return vazia;
    const primeiraVez = new Map<string, number>();
    for (const [id, em] of Object.entries(bruto.primeiraVez)) if (typeof em === "number" && Number.isFinite(em)) primeiraVez.set(id, em);
    const ordemDasSalas = new Map<string, number>();
    if (bruto.salas && typeof bruto.salas === "object") for (const [id, ordem] of Object.entries(bruto.salas)) if (typeof ordem === "number" && Number.isFinite(ordem)) ordemDasSalas.set(id, ordem);
    return { ...vazia, inicio: bruto.inicio, primeiraVez, ordemDasSalas };
  } catch {
    return vazia;
  }
}
