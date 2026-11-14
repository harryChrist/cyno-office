// A meta da semana do dono, na praça da cidade: "tarefas concluídas na semana, em todos os workspaces", com o alvo
// editável. Puro (o relógio e o armazenamento entram por parâmetro); a leitura das rotas fica em `useMetaDaSemana`.
import { addDays, dayKeyOf, parseDayKey } from "@cyno/shared";
import type { GoalView, PracaDados } from "@cyno/cena/cidade";
import type { CidadeMontada } from "./montarCidade";

export const ALVO_PADRAO = 20;
export const ALVO_MIN = 1;
export const ALVO_MAX = 9999;

const CHAVE_ALVO = "cyno.cidade.meta";
const CHAVE_FESTEJADA = "cyno.cidade.meta.festejada";

/** A semana (segunda a domingo, em São Paulo, como o resto do sistema) que contém `agora`: de/até em `AAAA-MM-DD` e a chave dela (a segunda-feira). */
export function semanaDe(agora: Date): { from: string; to: string; chave: string } {
  const hoje = dayKeyOf(agora.getTime());
  const partes = parseDayKey(hoje);
  // Dia da semana do dia de São Paulo (0 = domingo), pelo calendário, sem depender do fuso do navegador.
  const diaDaSemana = partes ? new Date(Date.UTC(partes.y, partes.m - 1, partes.d)).getUTCDay() : 1;
  const inicio = addDays(hoje, -((diaDaSemana + 6) % 7)); // segunda = 0
  return { from: inicio, to: addDays(inicio, 6), chave: inicio };
}

/** Limita o alvo a um inteiro de 1 a 9999 (lixo vira o padrão). */
export function alvoValido(valor: unknown): number {
  const n = typeof valor === "number" ? valor : typeof valor === "string" ? Number(valor) : Number.NaN;
  if (!Number.isFinite(n)) return ALVO_PADRAO;
  return Math.min(ALVO_MAX, Math.max(ALVO_MIN, Math.round(n)));
}

/** O termômetro da praça: a porcentagem, o rótulo e o texto de progresso. */
export function metaDaSemana(feitas: number, alvo: number): GoalView {
  const meta = alvoValido(alvo);
  const n = Math.max(0, Math.floor(feitas));
  const pct = Math.max(0, Math.min(1, n / meta));
  return {
    pct,
    pctText: `${Math.floor(pct * 100)}%`,
    label: `${meta} ${meta === 1 ? "tarefa concluída" : "tarefas concluídas"} na semana`,
    progressText: n >= meta ? "Meta batida!" : `${n} de ${meta}`,
    reached: n >= meta ? 1 : 0,
  };
}

/** A meta acabou de bater? (antes abaixo do alvo, agora no alvo ou acima; `antes` null = primeira leitura, sem festa) */
export function acabouDeBater(antes: number | null, depois: number, alvo: number): boolean {
  return antes !== null && antes < alvo && depois >= alvo;
}

/** O que a praça mostra: prédios acesos, agentes trabalhando e a meta (null = sem leitura ainda). */
export function pracaDaCidade(cidade: Pick<CidadeMontada, "acesos" | "trabalhando">, meta: GoalView | null = null): PracaDados {
  return { acesos: cidade.acesos, agentes: cidade.trabalhando, meta, semMeta: "Contando as tarefas da semana…" };
}

type Armazem = Pick<Storage, "getItem" | "setItem">;

function padrao(): Armazem | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function lerAlvo(armazem: Pick<Storage, "getItem"> | null = padrao()): number {
  try {
    const bruto = armazem?.getItem(CHAVE_ALVO);
    return bruto ? alvoValido(bruto) : ALVO_PADRAO;
  } catch {
    return ALVO_PADRAO;
  }
}

export function guardarAlvo(alvo: number, armazem: Pick<Storage, "setItem"> | null = padrao()): number {
  const valido = alvoValido(alvo);
  try {
    armazem?.setItem(CHAVE_ALVO, String(valido));
  } catch {
    // sem armazenamento: vale só nesta visita
  }
  return valido;
}

/** A festa da semana já foi feita? (a meta não festeja duas vezes na mesma semana) */
export function jaFestejou(chaveDaSemana: string, armazem: Pick<Storage, "getItem"> | null = padrao()): boolean {
  try {
    return armazem?.getItem(CHAVE_FESTEJADA) === chaveDaSemana;
  } catch {
    return false;
  }
}

export function marcarFestejada(chaveDaSemana: string, armazem: Pick<Storage, "setItem"> | null = padrao()): void {
  try {
    armazem?.setItem(CHAVE_FESTEJADA, chaveDaSemana);
  } catch {
    // sem armazenamento: pode festejar de novo ao recarregar
  }
}
