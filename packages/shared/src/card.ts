import { z } from "zod";

/**
 * Ficha de um workspace (o que o Cyno e a página inicial mostram). Quase tudo é calculado por código
 * (`Card`, em memória, recalculado quando o workspace muda); só a frase "o que este workspace faz"
 * é escrita à mão (`CardSummary`, em `data/workspaces/<id>/card.json`). Declarada na Fatia 1 do Cyno;
 * o cálculo entra na Fatia 2.
 */

export const CARD_SUMMARY_MAX = 280;

/** card.json: a frase e quem a escreveu (a do dono não é sobrescrita por IA sem aviso). */
export const cardSummarySchema = z.object({
  summary: z.string().trim().max(CARD_SUMMARY_MAX).default(""),
  by: z.enum(["dono", "maestro", "cyno"]).default("dono"),
  at: z.iso.datetime({ offset: true }).optional(),
  stale: z.boolean().optional(),
  /** Frase sugerida por uma IA quando já existe uma escrita pelo dono (ela não a sobrescreve): o dono aceita ou ignora no cartão. */
  proposal: z.object({ summary: z.string().trim().max(CARD_SUMMARY_MAX), by: z.enum(["maestro", "cyno"]), at: z.iso.datetime({ offset: true }) }).optional(),
});
export type CardSummary = z.output<typeof cardSummarySchema>;

/** PUT /api/w/:ws/card/summary */
export const updateCardSummaryBodySchema = z.strictObject({ summary: z.string().trim().max(CARD_SUMMARY_MAX) });

export type CardAgent = { id: string; name: string; engine: string; model?: string; focus?: string; terminal: "stopped" | "starting" | "ready" | "busy" | "error" };
/** O Maestro da ficha: motor/modelo e se está parado, ocioso ou ocupado. */
export type CardMaestro = { engine: string; model?: string; status: "parado" | "ocioso" | "ocupado" };
export type CardProject = { id: string; title: string; stage?: string; done?: number; total?: number; dueAt?: string; status: string };

/**
 * Os números da Gestão de um workspace (o bloco "Gestão" da página do Cyno). Saem do MESMO `computeMetrics` da aba Gestão, em modo leve
 * (sem retrospectiva e sem previsão); setas só com 5 ou mais entregas dos dois lados.
 */
export type CardMetrics = {
  /** Entregas nos últimos 7 dias e nos 7 antes deles. */
  throughput7d: number;
  throughputPrev7d: number;
  /** Mediana (ms) do tempo até entregar nos últimos 28 dias; null = sem entrega. */
  medianCycleMs: number | null;
  /** Há quanto tempo (ms) espera o item do dono mais antigo; null = nada esperando. */
  oldestWaitMs: number | null;
  /** Itens esperando o OK do dono (as regras da retrospectiva ficam de fora: não seguram o time). */
  waiting: number;
  /** Travados agora (bloqueios, esperas longas e falhas não resolvidas). */
  blocked: number;
  /** Projetos abertos com o prazo atrasado ou a menos de 24 h. */
  atRisk: number;
  /** Gasto equivalente à API dos últimos 7 dias (USD): não é o que se paga (assinatura). */
  weekCostUsd: number;
};

export type Card = {
  workspace: string;
  name: string;
  summary: CardSummary;
  team: { rooms: { id: string; name: string }[]; agents: CardAgent[]; maestro: CardMaestro };
  engines: { engine: string; available: boolean }[];
  sites: { domain: string; login: "ok" | "nao-verificado" | "faltando" }[];
  connectors: { id: string; usedBy: string[] }[];
  routines: { id: string; title: string; type: string; next?: string; target?: number; unit?: string; period?: string }[];
  projects: { active: CardProject[]; counts: Record<string, number> };
  deliveries: { title: string; at: string }[];
  waitingForYou: number;
  /** Ids dos itens que esperam o dono (a ficha muda quando troca um item por outro, mesmo com a mesma contagem). */
  waitingIds: string[];
  usage: { windowPercent?: number; windowEngine?: string; turns5h: number };
  /** Os números da Gestão (ausente = a conta ainda não rodou ou o workspace não tem como medir). */
  metrics?: CardMetrics;
  updatedAt: string;
};

/** Rotas da ficha (atrás da senha). */
export const CARDS_PATH = "/api/cyno/cards";
export const WAITING_PATH = "/api/cyno/waiting";

/** GET /api/cyno/cards */
export type CardsResponse = { cards: Card[] };

/** Um item que espera o dono, com o destino dele (o "Esperando você" de todos os workspaces juntos). */
export type WaitingItem = {
  workspace: string;
  workspaceName: string;
  id: string;
  /** Tipo do cartão do Para você ("post", "pergunta"…), como o item guarda. */
  type: string;
  /** Espécie do cartão ("sprint" = entrega de sprint, "plano"…), quando o item tem uma. */
  kind?: string;
  title: string;
  /** Quem pediu (nome do agente), se souber. */
  agent?: string;
  at: string;
  /** Endereço do Para você do workspace certo. */
  href: string;
};
/** GET /api/cyno/waiting (do mais antigo para o mais novo). */
export type WaitingResponse = { items: WaitingItem[] };

/** Endereço do Para você do workspace (`#/<ws>/para-voce`); o foco no item vai pelo `useForYouFocus` da web. */
export function waitingHref(workspace: string): string {
  return `#/${encodeURIComponent(workspace)}/para-voce`;
}
