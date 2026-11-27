// Regras puras da faixa da cidade na página do Cyno: aberta ou fechada (lembrada), a escolha do prédio pelo clique e
// o resumo da faixa recolhida. Sem React nem motor.
import type { CidadeMontada } from "./montarCidade";

const CHAVE_ABERTA = "cyno:cidade-aberta";
/** Larguras a partir das quais a faixa abre sozinha na primeira visita (no celular nasce recolhida). */
export const LARGURA_PARA_ABRIR = 1100;

function ler(chave: string): string | null {
  try {
    return localStorage.getItem(chave);
  } catch {
    return null;
  }
}

function gravar(chave: string, valor: string): void {
  try {
    localStorage.setItem(chave, valor);
  } catch {
    // sem armazenamento: vale só nesta visita
  }
}

/** Primeira visita: aberta em tela larga, recolhida no celular. */
export function abertaPorPadrao(larguraDaJanela: number): boolean {
  return larguraDaJanela >= LARGURA_PARA_ABRIR;
}

/** A escolha lembrada do dono; sem ela, o padrão da largura. */
export function lerFaixaAberta(larguraDaJanela: number): boolean {
  const guardado = ler(CHAVE_ABERTA);
  if (guardado === "1") return true;
  if (guardado === "0") return false;
  return abertaPorPadrao(larguraDaJanela);
}

export function guardarFaixaAberta(aberta: boolean): void {
  gravar(CHAVE_ABERTA, aberta ? "1" : "0");
}

/** O clique no prédio abre o cartão dele; clicar no mesmo de novo ou no chão o fecha. */
export function escolherPredio(atual: string | null, clicado: string | null): string | null {
  if (clicado === null) return null;
  return clicado === atual ? null : clicado;
}

/** "5 prédios · 2 com janelas acesas · 3 esperam você" (a linha da faixa recolhida). */
export function resumoDaFaixa(cidade: Pick<CidadeMontada, "predios" | "acesos" | "esperando">): string {
  const n = cidade.predios.length;
  if (n === 0) return "Nenhum prédio ainda";
  const partes = [n === 1 ? "1 prédio" : `${n} prédios`];
  partes.push(cidade.acesos === 0 ? "ninguém trabalhando" : cidade.acesos === 1 ? "1 trabalhando" : `${cidade.acesos} trabalhando`);
  if (cidade.esperando > 0) partes.push(cidade.esperando === 1 ? "1 espera você" : `${cidade.esperando} esperam você`);
  return partes.join(" · ");
}
