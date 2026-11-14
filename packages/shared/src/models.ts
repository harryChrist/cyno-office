import { z } from "zod";
import { AGENT_EFFORTS, AGENT_ENGINES, ENGINE_LABELS, isCliEngine, type AgentEffort, type AgentEngine, type EngineInfo } from "./terminal";
import { freebuffBlock, type FreebuffAgentRef } from "./freebuff";
import type { SubscriptionUsage, UsageWindow } from "./usage";

/**
 * Modelos padrão: só valores que PREENCHEM coisas novas na hora em que nascem (não há herança viva
 * nem resolução em tempo de execução).
 * - Globais (Configurações › Geral › Modelos padrão, DATA_DIR/models.json): preenchem os padrões de cada workspace NOVO.
 * - Do workspace (`Workspace.models`): preenchem cada agente novo (`agentes`), o Maestro de um
 *   workspace novo (`maestro`) e dizem o modelo padrão dos subagentes internos das CLIs (`subagentes`).
 * - O agente guarda o próprio motor/modelo/esforço; na hora de rodar só valem os dele.
 * Mudar o global não mexe nos workspaces existentes; mudar o do workspace não mexe nos agentes existentes.
 */

/** Motor + modelo + esforço concretos (o que um agente guarda e o que um padrão preenche). */
export type ModelChoice = { engine: AgentEngine; model?: string; effort?: AgentEffort };

/** Motores com subagentes internos (Claude Code: ferramenta Agent; Antigravity: invoke_subagent). */
export const SUBAGENT_ENGINES = ["claude", "gemini"] as const satisfies readonly AgentEngine[];
export type SubagentEngine = (typeof SUBAGENT_ENGINES)[number];

/** Modelo/esforço padrão dos subagentes de um motor (no Antigravity o nível vem no nome do modelo). */
export type SubagentChoice = { model?: string; effort?: AgentEffort };

export type ModelDefaults = {
  maestro: ModelChoice;
  agentes: ModelChoice;
  subagentes: Partial<Record<SubagentEngine, SubagentChoice>>;
  /** O Cyno, o agente da plataforma (global; ausente = `INITIAL_MODEL_DEFAULTS.cyno`). Não preenche nada nos workspaces. */
  cyno?: ModelChoice;
};

/**
 * Padrões iniciais (os globais de uma instalação nova; pedido do usuário em 11/11): tudo no Claude
 * Sonnet (o Maestro com esforço alto) e, no Antigravity, o Gemini 3.8 Flash. Opus só quando o
 * usuário escolher para um agente.
 */
export const INITIAL_MODEL_DEFAULTS: ModelDefaults = {
  maestro: { engine: "claude", model: "sonnet", effort: "high" },
  agentes: { engine: "claude", model: "sonnet", effort: "medium" },
  subagentes: { claude: { model: "sonnet", effort: "medium" }, gemini: { model: "gemini-3.8-flash-medium" } },
  cyno: { engine: "claude", model: "sonnet", effort: "medium" },
};

/** Motor/modelo/esforço do Cyno nos padrões (ausente = o inicial: Claude Sonnet, esforço médio). */
export function cynoChoiceOf(defaults: Pick<ModelDefaults, "cyno"> | undefined): ModelChoice {
  return { ...(defaults?.cyno ?? INITIAL_MODEL_DEFAULTS.cyno!) };
}

/**
 * Modelo de cada motor quando nada foi dito (nem pelo agente nem pelo padrão do workspace, que só
 * vale para o motor dele): Claude Sonnet e Gemini 3.8 Flash, em vez do padrão da própria CLI.
 */
export const ENGINE_FALLBACK_MODELS: Record<"claude" | "gemini", { model: string; effort?: AgentEffort }> = {
  claude: { model: "sonnet", effort: "medium" },
  gemini: { model: "gemini-3.8-flash-medium" },
};

/** Nome/alias de modelo da CLI (vai como argumento de `--model`; nunca começa com "-"). */
const choiceModelSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/, "modelo inválido");

export const modelChoiceSchema = z.object({
  engine: z.enum(AGENT_ENGINES),
  model: choiceModelSchema.optional(),
  effort: z.enum(AGENT_EFFORTS).optional(),
}) satisfies z.ZodType<ModelChoice>;

export const subagentChoiceSchema = z.object({
  model: choiceModelSchema.optional(),
  effort: z.enum(AGENT_EFFORTS).optional(),
}) satisfies z.ZodType<SubagentChoice>;

export const modelDefaultsSchema = z.object({
  maestro: modelChoiceSchema,
  agentes: modelChoiceSchema,
  subagentes: z.object({ claude: subagentChoiceSchema.optional(), gemini: subagentChoiceSchema.optional() }),
  cyno: modelChoiceSchema.optional(),
}) satisfies z.ZodType<ModelDefaults>;

/** GET/PUT dos padrões globais (o PUT manda o objeto inteiro). */
export const MODEL_DEFAULTS_PATH = "/api/settings/models";
export type ModelDefaultsResponse = { defaults: ModelDefaults };
export const updateModelDefaultsBodySchema = z.strictObject({ defaults: modelDefaultsSchema });
export type UpdateModelDefaultsBody = z.input<typeof updateModelDefaultsBodySchema>;

/** Cópia (os padrões nunca são compartilhados por referência). */
export function cloneModelDefaults(defaults: ModelDefaults): ModelDefaults {
  return JSON.parse(JSON.stringify(defaults)) as ModelDefaults;
}

/** Campos de um agente novo a partir de um padrão ("mock" = sem motor, como sempre foi). */
export function agentFieldsFromChoice(choice: ModelChoice): { engine?: AgentEngine; model?: string; effort?: AgentEffort } {
  if (!isCliEngine(choice.engine)) return {};
  return { engine: choice.engine, ...(choice.model ? { model: choice.model } : {}), ...(choice.effort ? { effort: choice.effort } : {}) };
}

/** Padrão dos subagentes de um motor (undefined = o motor não tem subagentes ou não há padrão). */
export function subagentChoiceFor(subagentes: ModelDefaults["subagentes"] | undefined, engine: AgentEngine | undefined): SubagentChoice | undefined {
  if (engine !== "claude" && engine !== "gemini") return undefined;
  return subagentes?.[engine];
}

/** O esforço vale para este modelo? O Haiku do Claude Code aceita `--effort` mas não tem níveis de esforço: roda igual. */
export function modelUsesEffort(engine: AgentEngine | undefined, model: string | undefined): boolean {
  // Freebuff: o esforço é da plataforma (Configurações › Motores), não do agente.
  if (engine === "freebuff" || engine === "hermes") return false;
  // Antigravity: nos modelos Gemini o nível vai no NOME do modelo (gemini-3.8-flash-medium) e a CLI recusa `--effort`.
  // Sem modelo vale o padrão da plataforma, que também é Gemini.
  if (engine === "gemini") return model !== undefined && !/^gemini-/i.test(model);
  return !(engine === "claude" && model !== undefined && /haiku/i.test(model));
}

/** A escolha sem o esforço que não vale para o motor e o modelo dela (ver `modelUsesEffort`). */
export function withoutUnusedEffort<T extends { engine?: AgentEngine | undefined; model?: string | undefined; effort?: AgentEffort | undefined }>(choice: T): T {
  if (choice.effort === undefined || modelUsesEffort(choice.engine, choice.model)) return choice;
  const { effort: _effort, ...rest } = choice;
  return rest as T;
}

/** Os padrões de modelo sem o esforço que não vale (Maestro, agentes, Cyno e subagentes de cada motor). */
export function cleanModelDefaults(defaults: ModelDefaults): ModelDefaults {
  const sub = (engine: "claude" | "gemini", choice: SubagentChoice | undefined): SubagentChoice | undefined =>
    choice && choice.effort !== undefined && !modelUsesEffort(engine, choice.model) ? { ...(choice.model ? { model: choice.model } : {}) } : choice;
  const claude = sub("claude", defaults.subagentes.claude);
  const gemini = sub("gemini", defaults.subagentes.gemini);
  return {
    maestro: withoutUnusedEffort(defaults.maestro),
    agentes: withoutUnusedEffort(defaults.agentes),
    subagentes: { ...(claude ? { claude } : {}), ...(gemini ? { gemini } : {}) },
    ...(defaults.cyno ? { cyno: withoutUnusedEffort(defaults.cyno) } : {}),
  };
}

/** "Claude Code · sonnet · médio" (o que aparece nas telas e no log; sem o esforço onde ele não vale, como no Haiku). */
export function describeModelChoice(choice: Partial<ModelChoice>): string {
  const engine = choice.engine ?? "mock";
  if (!isCliEngine(engine)) return ENGINE_LABELS.mock;
  const effort = choice.effort && modelUsesEffort(engine, choice.model) ? [EFFORT_LABELS[choice.effort]] : [];
  return [ENGINE_LABELS[engine], choice.model ?? (engine === "freebuff" ? "modelo da plataforma" : engine === "openclaw" || engine === "hermes" ? "modelo da conta ligada" : "padrão da CLI"), ...effort].join(" · ");
}

export const EFFORT_LABELS: Record<AgentEffort, string> = { low: "baixo", medium: "médio", high: "alto", xhigh: "muito alto", max: "máximo" };

// ---------- Disponibilidade (cota da assinatura) ----------

/**
 * Por que os agentes de um motor estão indisponíveis agora: a cota da assinatura acabou (volta em
 * `resetsAt`, se a CLI disse) ou o motor não está instalado/não respondeu. Nunca há troca automática
 * de motor: o agente espera.
 */
export type EngineBlock =
  | { reason: "quota"; resetsAt?: string }
  | { reason: "unavailable"; detail?: string }
  /** Freebuff: outro agente tem a hora aberta e o teto de horas abertas foi atingido (`holder` = o nome dele; `resetsAt` = quando a hora dele acaba). */
  | { reason: "hour"; holder: string; resetsAt?: string };

/** "Tentar agora" com um motor sem cota: POST com `{ engine }` (as filas paradas andam; se ainda faltar cota, voltam a esperar). */
export const ENGINE_RETRY_PATH = "/api/engines/retry";
export const engineRetryBodySchema = z.strictObject({ engine: z.enum(AGENT_ENGINES) });

/** Status que a CLI manda quando o limite foi atingido (rate_limit_event "rejected"). */
const BLOCKED_STATUSES = new Set(["rejected", "blocked", "exhausted"]);

/** "Gemini 3.8 Flash (High)" / "gemini-3.8-flash-high" -> " gemini 3 8 flash high " (para casar palavras). */
const modelWords = (text: string) => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/**
 * A janela vale para este modelo? Sem `appliesTo` (ou sem modelo): sim. Com: só se o modelo tiver
 * uma das palavras (ex.: "claude" casa "claude-opus-5-5-high"; "gemini 4 argon" casa "gemini-4-argon-low").
 */
export function usageWindowAppliesTo(window: Pick<UsageWindow, "appliesTo">, model: string | undefined): boolean {
  if (!window.appliesTo || window.appliesTo.length === 0 || model === undefined) return true;
  const words = modelWords(model);
  return window.appliesTo.some((keyword) => {
    const key = modelWords(keyword);
    return key.trim() !== "" && words.includes(key);
  });
}

/**
 * A cota de um provedor acabou? Sim quando o estado geral ou alguma janela diz "rejected", ou uma
 * janela chegou a 100% — e o `resetsAt` dela ainda não passou (passou = já zerou, mesmo sem dado novo).
 * `resetsAt` da resposta: quando a última janela que bloqueia zera (antes disso nada roda).
 * `model`: só as janelas que valem para ele contam (`appliesTo`; ex.: a cota de Claude/GPT do
 * Antigravity acabar não segura um agente no Gemini Flash). Sem `model`: todas.
 */
export function quotaBlock(usage: SubscriptionUsage | undefined, now: number, model?: string): { resetsAt?: string } | undefined {
  if (!usage) return undefined;
  const future = (iso: string | undefined) => iso !== undefined && Date.parse(iso) > now;
  const expired = (iso: string | undefined) => iso !== undefined && Date.parse(iso) <= now;
  const blocking = usage.windows.filter(
    (window) => usageWindowAppliesTo(window, model) && (window.utilization >= 1 || BLOCKED_STATUSES.has(window.status ?? "")) && !expired(window.resetsAt),
  );
  const overall = BLOCKED_STATUSES.has(usage.status ?? "");
  if (blocking.length === 0 && !overall) return undefined;
  let candidates = blocking;
  if (candidates.length === 0) {
    // Estado geral "rejected" sem janela cheia: vale a janela mais usada (se ela já zerou, o aviso é velho).
    const fullest = [...usage.windows].sort((a, b) => b.utilization - a.utilization)[0];
    if (fullest && expired(fullest.resetsAt)) return undefined;
    candidates = fullest ? [fullest] : [];
  }
  const resets = candidates.map((window) => window.resetsAt).filter(future).sort();
  // Uma janela que bloqueia sem resetsAt conhecido: não dá para dizer quando volta.
  const unknown = candidates.some((window) => window.resetsAt === undefined);
  const resetsAt = unknown ? undefined : resets.at(-1);
  return resetsAt ? { resetsAt } : {};
}

export type AvailabilityContext = {
  /** Uso da assinatura por provedor (o último conhecido). */
  usage: readonly SubscriptionUsage[];
  /** Motores detectados (GET /api/engines); ausente = ainda não se sabe (não bloqueia). */
  engines?: readonly EngineInfo[];
  now: number;
};

/**
 * Modelo que conta para a cota: o do agente ou, sem modelo, o padrão da CLI. No Antigravity o
 * padrão é um Gemini (as janelas de Claude/GPT não seguram quem não escolheu esses modelos).
 */
const quotaModel = (engine: AgentEngine, model: string | undefined) => model ?? (engine === "gemini" ? "gemini" : undefined);

/** O motor está bloqueado agora para um agente com este `model`? (o simulado nunca está) */
export function engineBlock(engine: AgentEngine | undefined, context: AvailabilityContext, model?: string, agent?: FreebuffAgentRef): EngineBlock | undefined {
  if (!isCliEngine(engine)) return undefined;
  const info = context.engines?.find((candidate) => candidate.engine === engine);
  if (info && !info.available) return { reason: "unavailable", ...(info.reason ? { detail: info.reason } : {}) };
  // Freebuff: a cota é em horas abertas (o teto de horas e o saldo do dia estão no estado dele).
  if (engine === "freebuff") return freebuffBlock(context.usage.find((usage) => usage.provider === "freebuff")?.freebuff, agent, context.now);
  const quota = quotaBlock(
    context.usage.find((usage) => usage.provider === engine),
    context.now,
    quotaModel(engine, model),
  );
  return quota ? { reason: "quota", ...quota } : undefined;
}

/** Hora (HH:MM) de um instante, com o dia (dd/mm) se não for nas próximas 20 horas. */
export function resumeTimeLabel(iso: string, now: number, timeZone?: string): string {
  const at = new Date(iso);
  const options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", ...(timeZone ? { timeZone } : {}) };
  const time = at.toLocaleTimeString("pt-BR", options);
  if (at.getTime() - now < 20 * 3600_000) return time;
  const day = at.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", ...(timeZone ? { timeZone } : {}) });
  return `${day} ${time}`;
}

/** "sem cota · volta às 14:30", "sem cota" ou "motor indisponível". */
export function engineBlockLabel(block: EngineBlock, now: number, timeZone?: string): string {
  if (block.reason === "unavailable") return "motor indisponível";
  if (block.reason === "hour") return `esperando a hora do Freebuff de ${block.holder} acabar${block.resetsAt ? ` (às ${resumeTimeLabel(block.resetsAt, now, timeZone)})` : ""}`;
  return block.resetsAt ? `sem cota · volta às ${resumeTimeLabel(block.resetsAt, now, timeZone)}` : "sem cota";
}
