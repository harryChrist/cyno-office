// A ponte de dados da cidade: as fichas dos workspaces do Cyno viram os prédios do motor da cidade. Pura (sem lojas,
// sem relógio, sem motor): a hora entra por parâmetro, e só os tipos vêm do pacote @cyno/cena (apagados no build).
import type { Card } from "@cyno/shared";
import type { WorldBuildingPublic, WorldTheme } from "@cyno/cena/cidade";
import { atribuirLotes, loteDoIndice, type Lotes } from "./lotes";

/** Distrito dos lotes (um só: a cidade é local). */
export const DISTRITO = "cyno";

/** Agentes por andar na fachada: acima disso o prédio ganha andares mesmo com uma sala só. */
export const AGENTES_POR_ANDAR = 6;

/** O que a janela de cada agente mostra: o estado que a fachada desenha. */
export type EstadoDaJanela = "acesa" | "ambar" | "apagada";

export interface ResumoDoPredio {
  id: string;
  nome: string;
  /** Maestro e agentes de time. */
  agentes: number;
  trabalhando: number;
  /** Quantos itens esperam o dono (o selo do letreiro). */
  esperando: number;
  andares: number;
  /** O workspace está parado: nada presente, nada esperando e nenhum projeto ativo (prédio inteiro apagado). */
  parado: boolean;
  /** Janelas por estado, na ordem de `agentes`: acesas, âmbar (esperam o dono) e apagadas. */
  janelas: Record<EstadoDaJanela, number>;
}

export interface CidadeMontada {
  predios: WorldBuildingPublic[];
  resumos: ResumoDoPredio[];
  /** Os lotes depois da atribuição (guardar: o prédio não muda de lugar quando outro é criado ou apagado). */
  lotes: Lotes;
  /** Prédios com agente trabalhando e o total de agentes trabalhando (a placa da praça). */
  acesos: number;
  trabalhando: number;
  /** Itens esperando o dono em todos os workspaces. */
  esperando: number;
}

/** Tema de época como no escritório: Halloween em outubro, Natal de 1º de novembro a 26 de dezembro. */
export function temaDaEpoca(agora: Date): WorldTheme {
  const mes = agora.getMonth();
  if (mes === 9) return "halloween";
  if (mes === 10 || (mes === 11 && agora.getDate() <= 26)) return "christmas";
  return "none";
}

/** Conta o que a fachada de um workspace mostra (sem desenhar nada). */
export function resumirWorkspace(card: Card): ResumoDoPredio {
  const time = card.team.agents;
  const agentes = time.length + 1; // o Maestro é um morador
  let trabalhando = time.filter((agente) => agente.terminal === "busy").length + (card.team.maestro.status === "ocupado" ? 1 : 0);
  const presentes = time.filter((agente) => agente.terminal === "ready" || agente.terminal === "busy" || agente.terminal === "starting").length + (card.team.maestro.status === "parado" ? 0 : 1);
  const esperando = Math.max(0, card.waitingForYou);
  // quem espera o dono precisa de uma janela para piscar: se todas estavam acesas, uma delas passa a âmbar
  const ambar = esperando > 0 ? Math.min(esperando, agentes) : 0;
  if (trabalhando + ambar > agentes) trabalhando = agentes - ambar;
  const andares = Math.max(1, card.team.rooms.length, Math.ceil(agentes / AGENTES_POR_ANDAR));
  const parado = presentes === 0 && esperando === 0 && card.projects.active.length === 0;
  return {
    id: card.workspace,
    nome: card.name,
    agentes,
    trabalhando,
    esperando,
    andares,
    parado,
    janelas: { acesa: trabalhando, ambar, apagada: Math.max(0, agentes - trabalhando - ambar) },
  };
}

/**
 * Das fichas dos workspaces para os prédios. A ordem das fichas é a de criação (o primeiro vai para o primeiro lote
 * da espiral); quem já tinha lote em `lotes` o mantém, quem sumiu libera o seu e quem chega pega o menor livre.
 */
export function montarCidade(cards: readonly Card[], agora: Date, lotes: Lotes = {}): CidadeMontada {
  const novos = atribuirLotes(
    cards.map((card) => card.workspace),
    lotes,
  );
  const tema = temaDaEpoca(agora);
  const resumos: ResumoDoPredio[] = [];
  const predios: WorldBuildingPublic[] = [];
  for (const card of cards) {
    const r = resumirWorkspace(card);
    resumos.push(r);
    const lote = loteDoIndice(novos[card.workspace] ?? 0);
    predios.push({
      id: card.workspace,
      lot: { district: DISTRITO, x: lote.x, y: lote.y },
      owner: { id: card.workspace, name: card.name },
      state: r.parado ? "away" : "online",
      theme: tema,
      floors: r.andares,
      agents: { total: r.agentes, working: r.janelas.acesa, waiting: r.janelas.ambar, idle: r.janelas.apagada },
      rev: 1,
      // O campo de curtidas do motor leva o selo do letreiro: quantos itens esperam o dono (CYNO-PATCH 10).
      likes: r.esperando,
      sinceMonth: card.updatedAt.slice(0, 7),
    });
  }
  return {
    predios,
    resumos,
    lotes: novos,
    acesos: resumos.filter((r) => r.trabalhando > 0).length,
    trabalhando: resumos.reduce((soma, r) => soma + r.trabalhando, 0),
    esperando: resumos.reduce((soma, r) => soma + r.esperando, 0),
  };
}
