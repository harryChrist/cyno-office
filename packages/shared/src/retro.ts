import { z } from "zod";
import { FOR_YOU_RULE_LIMITS, forYouRuleScopeSchema } from "./api";
import type { ForYouRuleScope } from "./for-you";

/**
 * Retrospectiva da Gestão (fatia 6): padrões achados por código nas recusas, nas edições e nas falhas dos últimos 14 dias, e as regras
 * que o dono aprova um a um. O relatório (`kind: "retro"`) é guardado em `reports/retro/<AAAA-Www>.json`, junto da revisão da semana.
 */

/** Rotas do workspace (dentro de `/api/w/:ws`). */
export const WORKSPACE_RETRO_PATH = "/retro";
export const WORKSPACE_RETRO_GENERATE_PATH = "/retro/generate";
export const WORKSPACE_RETRO_ASK_PATH = "/retro/maestro";

/** Olha os últimos 14 dias; um padrão vira candidato com 3 itens em 2 dias diferentes (ou 5 no total). */
export const RETRO_LOOKBACK_DAYS = 14;
export const RETRO_MIN_ITEMS = 3;
export const RETRO_MIN_DAYS = 2;
export const RETRO_MIN_TOTAL = 5;
/** Uma regra recusada some por 8 semanas; duas semanas depois de aprovada a retrospectiva mede o antes e o depois. */
export const RETRO_SUPPRESS_WEEKS = 8;
export const RETRO_IMPACT_DAYS = 14;
/** O Maestro escreve no máximo estes grupos de uma vez (mais que isso fica para o próximo clique). */
export const RETRO_MAX_ASK_GROUPS = 5;

/** O que o grupo é: recusas (por categoria ou motivo), um traço do que o dono corta ou acrescenta, palavras trocadas, falhas do agente. */
export const RETRO_GROUP_KINDS = ["rejection", "edit_trait", "edit_words", "failure"] as const;
export type RetroGroupKind = (typeof RETRO_GROUP_KINDS)[number];

/** Traços conhecidos das edições: têm texto de regra pronto, por molde (não gastam IA). */
export const RETRO_TRAITS = ["emoji", "hashtag", "exclamation", "shorter", "longer", "repeat"] as const;
export type RetroTrait = (typeof RETRO_TRAITS)[number];

export const retroExcerptSchema = z.object({ itemId: z.string().max(32), before: z.string().max(FOR_YOU_RULE_LIMITS.excerpt), after: z.string().max(FOR_YOU_RULE_LIMITS.excerpt).optional() });

/** Um padrão achado: o que se repete, em quem, quantas vezes e a evidência. */
export const retroGroupSchema = z.object({
  /** Hash estável do padrão (tipo + chave + agentes): é o que a recusa de uma regra guarda por 8 semanas. */
  id: z.string().max(40),
  kind: z.enum(RETRO_GROUP_KINDS),
  /** Os agentes do padrão (2 ou mais = regra global) e o quarto de cada um. */
  agentIds: z.array(z.string()).min(1),
  agentNames: z.array(z.string()),
  roomIds: z.array(z.string()),
  /** O tipo de aprovação ("comentario"). */
  type: z.string(),
  typeName: z.string(),
  /** A categoria da recusa, o traço, as palavras ou o começo da falha: o que define o grupo. */
  key: z.string().max(120),
  trait: z.enum(RETRO_TRAITS).optional(),
  /** As (até) 3 palavras mais frequentes dos motivos ou das trocas. */
  words: z.array(z.string()).max(6),
  /** `count` itens do padrão em `days` dias diferentes, de `total` considerados ("cortou emojis em 6 de 7 comentários"). */
  count: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  days: z.number().int().nonnegative(),
  itemIds: z.array(z.string().max(32)).max(FOR_YOU_RULE_LIMITS.itemIds),
  excerpts: z.array(retroExcerptSchema).max(FOR_YOU_RULE_LIMITS.excerpts),
  /** A frase da evidência ("cortou emojis em 6 de 7 comentários") e, nos traços conhecidos, o texto da regra (molde). */
  line: z.string().max(300),
  template: z.string().max(FOR_YOU_RULE_LIMITS.text).optional(),
  /** Exemplos de motivos (recusas) ou de trocas, em texto livre: o que o Maestro lê para redigir a regra. */
  samples: z.array(z.string().max(300)).max(6),
});
export type RetroGroup = z.infer<typeof retroGroupSchema>;

/** Falta de cota ou de acesso: vira aviso ("Sem cota no Gemini em 4 tarefas"), nunca regra. */
export const retroNoticeSchema = z.object({ kind: z.enum(["cota", "acesso"]), agentId: z.string().optional(), agentName: z.string().optional(), count: z.number().int().nonnegative(), text: z.string().max(300) });
export type RetroNotice = z.infer<typeof retroNoticeSchema>;

export const RETRO_RULE_STATES = ["esperando", "aprovada", "recusada"] as const;
export type RetroRuleState = (typeof RETRO_RULE_STATES)[number];

/** Uma regra proposta e em que pé ela está (o relatório e o `get_report` mostram). */
export const retroRuleSchema = z.object({
  itemId: z.string(),
  groupId: z.string(),
  text: z.string().max(FOR_YOU_RULE_LIMITS.text),
  scope: forYouRuleScopeSchema,
  scopeLabel: z.string(),
  source: z.enum(["molde", "maestro"]),
  retro: z.string(),
  state: z.enum(RETRO_RULE_STATES),
  proposedAt: z.string(),
  decidedAt: z.string().optional(),
  /** Onde a nota foi gravada (aprovada): "global/regra-….md". */
  notePath: z.string().optional(),
  line: z.string().max(300),
});
export type RetroRule = z.infer<typeof retroRuleSchema>;

/** "regra X: recusas desse tipo caíram de 5 para 1": o mesmo número nas duas semanas em volta da aprovação. */
export const retroImpactSchema = z.object({
  itemId: z.string(),
  text: z.string(),
  /** O que foi contado ("recusas desse tipo", "emojis cortados", "falhas desse tipo"). */
  what: z.string(),
  before: z.number().int().nonnegative(),
  after: z.number().int().nonnegative(),
  approvedAt: z.string(),
  line: z.string().max(400),
});
export type RetroImpact = z.infer<typeof retroImpactSchema>;

export const storedRetroSchema = z.object({
  v: z.literal(1),
  kind: z.literal("retro"),
  /** "2026-W46": a semana da revisão a que ela acompanha. */
  period: z.string(),
  workspace: z.string(),
  workspaceName: z.string(),
  from: z.string(),
  to: z.string(),
  generatedAt: z.string(),
  trigger: z.enum(["schedule", "manual", "mcp"]),
  candidates: z.array(retroGroupSchema),
  rules: z.array(retroRuleSchema),
  impacts: z.array(retroImpactSchema),
  notices: z.array(retroNoticeSchema),
  /** Quantos itens decididos entraram na conta (o relatório diz "poucos dados" se for pouco). */
  considered: z.object({ decided: z.number().int().nonnegative(), edited: z.number().int().nonnegative(), rejected: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }),
});
export type StoredRetro = z.infer<typeof storedRetroSchema>;

/** A estimativa do botão "Escrever as regras com o Maestro": quantos grupos, tokens e quanto custa (equivalente à API). */
export type RetroEstimate = { groups: number; tokens: number; usd: number | null; model: string | null; label: string };

/** O que a aba "O que aprendemos" lê (`GET /retro`). */
export type RetroView = {
  /** A retrospectiva de agora (semana corrente de São Paulo) e a janela olhada. */
  period: string;
  from: string;
  to: string;
  now: string;
  /** Padrões com a regra pronta por molde que ainda não viraram cartão (`generate` abre os cartões, sem IA). */
  ready: RetroGroup[];
  /** Padrões que ainda não viraram cartão e precisam do Maestro para virar texto. */
  needsMaestro: RetroGroup[];
  /** Todas as regras propostas (esperando, aprovadas e recusadas), as mais novas primeiro. */
  rules: RetroRule[];
  impacts: RetroImpact[];
  notices: RetroNotice[];
  /** Regras esperando o OK do dono (o selo da aba). */
  waiting: number;
  estimate: RetroEstimate;
  /** O Maestro está ligado e livre para pedir? `asking` = um pedido de regras já está com ele. */
  maestro: { available: boolean; asking: boolean; reason?: string };
  /** Retrospectivas guardadas (mais novas primeiro). */
  stored: { period: string; generatedAt: string }[];
  considered: StoredRetro["considered"];
};

/** `POST /retro/generate`: monta (e grava) a retrospectiva de agora e abre os cartões das regras por molde. */
export type RetroGenerateResult = { view: RetroView; opened: number };
/** `POST /retro/maestro`: o pedido foi para o Maestro com estes grupos. */
export type RetroAskResult = { view: RetroView; asked: number; taskId: string };

export type RuleScopeInput = ForYouRuleScope;

/** A semana ISO da retrospectiva ("2026-W46") e o texto do escopo para a tela. */
export const RETRO_PERIOD_PATTERN = /^\d{4}-W\d{2}$/;
