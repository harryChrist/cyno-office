import { z } from "zod";
import { AGENT_PROVIDERS, type AgentProvider } from "./agent-log";
import type { FreebuffUsageDetail } from "./freebuff";

/**
 * Uso da assinatura de uma CLI (ex.: os limites de 5 horas e da semana do Claude). O uso é da
 * CONTA, não do workspace, então o server guarda o último por provedor, igual para todos os
 * workspaces. Duas fontes alimentam o mesmo estado:
 * - "cli": os eventos que a própria CLI escreve enquanto um agente roda (no Claude Code,
 *   `rate_limit_event`);
 * - "account": a consulta periódica do uso da conta inteira na Anthropic (inclui o uso do próprio
 *   usuário no Claude Code / claude.ai), feita pelo server mesmo sem agente rodando.
 */

/** Uma janela de limite (five_hour, seven_day, seven_day_opus…). */
export type UsageWindow = {
  /** Id da janela como a CLI manda (ex.: "five_hour", "seven_day"). */
  id: string;
  /** Quanto da janela já foi usado, de 0 a 1. */
  utilization: number;
  /** Quando a janela zera (ISO), se a CLI disser. */
  resetsAt?: string;
  /** Estado da janela segundo a CLI (ex.: "allowed", "allowed_warning", "rejected"). */
  status?: string;
  /** Gravidade segundo a conta (ex.: "normal", "warning", "critical"), se a fonte disser. */
  severity?: string;
  /** Rótulo pronto (pt-BR) quando o id sozinho não basta (ex.: "Sessão 5h" de um grupo do Antigravity). */
  label?: string;
  /** Grupo de modelos que divide a janela (ex.: "Modelos Gemini", "Claude e GPT"); ausente = a conta toda. */
  group?: string;
  /**
   * Modelos a que a janela vale (palavras, ex.: ["claude", "gpt"]); ausente = todos. Uma janela
   * esgotada só segura os agentes cujo modelo bate com uma delas (veja quotaBlock).
   */
  appliesTo?: string[];
};

/** De onde veio o último dado: eventos da CLI ou a consulta do uso da conta. */
export type UsageSource = "cli" | "account";

/** Última consulta da conta falhou: o valor mostrado é o último conhecido. */
export type UsageStale = {
  /** Motivo curto em pt-BR (ex.: "Login do Claude Code expirado"). */
  reason: string;
  /** Desde quando (ISO) as consultas falham. */
  since: string;
};

/** Último uso conhecido da assinatura de um provedor (evento usage:updated e office:snapshot). */
export type SubscriptionUsage = {
  provider: AgentProvider;
  /** Janelas conhecidas, na ordem: 5 horas, semana e as outras. */
  windows: UsageWindow[];
  /** Estado geral segundo a CLI (ex.: "allowed", "rejected"). */
  status?: string;
  /** Quando chegou o último dado (da CLI ou da conta; um aviso de dado velho não muda). */
  updatedAt: string;
  /** Fonte do último dado recebido. */
  source?: UsageSource;
  /** Última consulta bem-sucedida do uso da conta (ISO). */
  fetchedAt?: string;
  /** Presente quando a consulta da conta está falhando (o valor pode estar velho). */
  stale?: UsageStale;
  /** Só no Freebuff: as horas do dia, as horas abertas por agente e a escolha de modelo (a cota dele é em horas, não em janelas). */
  freebuff?: FreebuffUsageDetail;
};

/** A partir daqui (0..1) a janela aparece em cor de alerta. */
export const USAGE_WARN_THRESHOLD = 0.8;
/** A partir daqui (0..1) a janela aparece em cor de perigo. */
export const USAGE_DANGER_THRESHOLD = 0.95;

/** Cor da janela (a que aparece no anel, na barra e na faixa): abaixo daqui (0..1) é a cor normal. */
export const USAGE_TONE_AMBER = 0.5;
/** A partir daqui (0..1) a cor da janela é a de perigo (de 50% até aqui, a de atenção). */
export const USAGE_TONE_RED = 0.8;
/** Uma leitura com mais que isto (ms) é "antiga": o número aparece apagado, com a idade, e nunca como atual. */
export const USAGE_STALE_MS = 30 * 60_000;

/** Cor de uma janela de limite: normal, atenção (50% a 79%) e perigo (80% em diante, barrada ou crítica). */
export type UsageTone = "ok" | "warn" | "danger";

/** "3 min", "2 h 5 min", "1 d": uma duração curta em minutos. */
export function formatUsageDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  return `${Math.round(hours / 24)} d`;
}

/** De quando é a leitura que se mostra, e se a consulta da conta está falhando. */
export type UsageReadingMeta = { updatedAt?: string; fetchedAt?: string; stale?: UsageStale };

/**
 * O que mostrar de uma janela, a REGRA ÚNICA da honestidade do uso (anel, detalhe, Gastos e Gestão):
 * - `value`: leitura utilizável (`percent` é o número);
 * - `renewed`: o `resetsAt` já passou e nenhuma leitura chegou depois dele: a janela zerou, o uso
 *   de agora é desconhecido (`percent` = null, mostrar "renovada" e um traço);
 * - `none`: sem leitura nenhuma (traço).
 * `old` = a leitura tem mais de 30 min (`USAGE_STALE_MS`): número esmaecido, com a idade, sem cor
 * de alerta (`tone` volta a "ok"). `ageLabel` é sempre preenchido que houver data ("agora", "há 42 min").
 */
export type UsageWindowState = {
  kind: "value" | "renewed" | "none";
  /** 0..100 arredondado, ou null (renovada / sem leitura). */
  percent: number | null;
  /** Cor por faixa; "ok" quando a leitura é antiga, renovada ou ausente. */
  tone: UsageTone;
  /** A leitura tem mais de 30 min. */
  old: boolean;
  /** A janela já renovou desde a leitura. */
  renewed: boolean;
  /** Idade da leitura em minutos inteiros, ou null se a data é desconhecida. */
  ageMinutes: number | null;
  /** "agora" ou "há 42 min"; "" se a data é desconhecida. */
  ageLabel: string;
  /** O que escrever no lugar do número: "42%", "–" ou "renovada". */
  text: string;
};

/** A faixa de cor de um percentual inteiro (0..100) e do que a CLI/conta disse da janela. */
export function usageToneFor(percent: number, window?: Pick<UsageWindow, "status" | "severity">): UsageTone {
  const severity = window?.severity ?? "";
  if (window?.status === "rejected" || /critical|exceed|block|reject|danger|limit/.test(severity)) return "danger";
  if (percent >= USAGE_TONE_RED * 100) return "danger";
  if (percent >= USAGE_TONE_AMBER * 100 || window?.status === "allowed_warning" || /warn|elevat|high|approach/.test(severity)) return "warn";
  return "ok";
}

/** Quando foi lida a janela: o mais recente entre a consulta da conta e o último dado recebido. */
function readingTime(meta: UsageReadingMeta): number {
  const times = [meta.updatedAt, meta.fetchedAt].map((iso) => (iso ? Date.parse(iso) : Number.NaN)).filter((time) => !Number.isNaN(time));
  return times.length > 0 ? Math.max(...times) : Number.NaN;
}

/** "agora" / "há 42 min" a partir de uma idade em minutos. */
export function usageAgeLabel(ageMinutes: number): string {
  return ageMinutes < 1 ? "agora" : `há ${formatUsageDuration(ageMinutes)}`;
}

/** Função pura: a janela (ou nenhuma), de quando é a leitura e o instante atual dão o que mostrar. */
export function usageWindowState(window: UsageWindow | undefined, meta: UsageReadingMeta, now: number): UsageWindowState {
  const read = readingTime(meta);
  const known = !Number.isNaN(read);
  const ageMinutes = known ? Math.max(0, Math.floor((now - read) / 60_000)) : null;
  const ageLabel = ageMinutes === null ? "" : usageAgeLabel(ageMinutes);
  const old = known && now - read > USAGE_STALE_MS;
  const resets = window?.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  // Zerou depois da leitura: o percentual guardado era de outro ciclo.
  const renewed = window !== undefined && !Number.isNaN(resets) && resets <= now && (!known || read < resets);
  if (!window) return { kind: "none", percent: null, tone: "ok", old, renewed: false, ageMinutes, ageLabel, text: "–" };
  if (renewed) return { kind: "renewed", percent: null, tone: "ok", old, renewed: true, ageMinutes, ageLabel, text: "renovada" };
  const percent = Math.round(Math.min(1, Math.max(0, window.utilization)) * 100);
  return { kind: "value", percent, tone: old ? "ok" : usageToneFor(percent, window), old, renewed: false, ageMinutes, ageLabel, text: `${percent}%` };
}

const isoString = z.string().refine((value) => !Number.isNaN(Date.parse(value)));

/** Validação de uma janela (ex.: ao ler data/usage.json). */
export const usageWindowSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,40}$/),
  utilization: z.number().min(0).max(1),
  resetsAt: isoString.optional(),
  status: z.string().max(40).optional(),
  severity: z.string().max(40).optional(),
  label: z.string().max(60).optional(),
  group: z.string().max(60).optional(),
  appliesTo: z.array(z.string().min(1).max(40)).max(12).optional(),
});

/** Validação do uso de um provedor (ex.: ao ler data/usage.json no boot). */
export const subscriptionUsageSchema = z.object({
  provider: z.enum(AGENT_PROVIDERS),
  windows: z.array(usageWindowSchema).max(40),
  status: z.string().max(40).optional(),
  updatedAt: isoString,
  source: z.enum(["cli", "account"]).optional(),
  fetchedAt: isoString.optional(),
  stale: z.object({ reason: z.string().max(200), since: isoString }).optional(),
});

/** Ordem de exibição das janelas conhecidas (as desconhecidas vão no fim, em ordem alfabética). */
const WINDOW_ORDER = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"];

export function sortUsageWindows(windows: UsageWindow[]): UsageWindow[] {
  const rank = (id: string) => {
    const index = WINDOW_ORDER.indexOf(id);
    return index === -1 ? WINDOW_ORDER.length : index;
  };
  return [...windows].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

const titleCase = (text: string) => text.replace(/_/g, " ").replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());

/** Rótulo curto (pt-BR) de uma janela: "Sessão 5h", "Semana", "Semana · Opus"… */
export function usageWindowLabel(id: string): string {
  if (id === "five_hour") return "Sessão 5h";
  if (id === "seven_day") return "Semana";
  const scoped = /^(five_hour|seven_day)_(.+)$/.exec(id);
  if (scoped) return `${scoped[1] === "five_hour" ? "Sessão 5h" : "Semana"} · ${titleCase(scoped[2]!)}`;
  return id.replace(/_/g, " ");
}

/** Nome do provedor para a interface. */
export function usageProviderLabel(provider: AgentProvider): string {
  const labels: Record<AgentProvider, string> = { mock: "Simulado", claude: "Claude", codex: "Codex", gemini: "Antigravity", opencode: "OpenCode", freebuff: "Freebuff", openclaw: "OpenClaw", hermes: "Hermes" };
  return labels[provider];
}

/** Rota do pedido manual de nova consulta do uso da conta. */
export const USAGE_REFRESH_PATH = "/api/usage/refresh";

/** Corpo (opcional) de `POST /api/usage/refresh`: de qual motor (padrão: "claude"). */
export const usageRefreshBodySchema = z.object({ provider: z.enum(["claude", "gemini"]).default("claude") });

/**
 * Resposta de `POST /api/usage/refresh`: `refreshed` = consultou de verdade agora (falso quando a
 * última consulta foi há menos de 30 s). O estado novo também chega por `usage:updated`.
 */
export type UsageRefreshResponse = { refreshed: boolean; usage: SubscriptionUsage | null };

/**
 * Uso de um turno informado pela CLI ao terminar (no Claude Code, o `usage` do evento `result`).
 * A assinatura não diz quanto cada agente gastou: isto é só o que o processo do agente relatou.
 */
export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Tokens lidos do cache do prompt (bem mais baratos para o limite). */
  cacheReadTokens: number;
  /** Tokens gravados no cache do prompt. */
  cacheCreationTokens: number;
  /** Parte do cache gravado com validade de 5 min / 1 h (Claude Code: `usage.cache_creation`), se vier. */
  cacheCreation5mTokens?: number;
  cacheCreation1hTokens?: number;
  /** Modelos que a CLI disse ter usado no turno (Claude Code: as chaves de `modelUsage`), se vierem. */
  models?: string[];
  /** Duração do turno informada pela CLI (Claude Code: `duration_ms`). */
  durationMs?: number;
  /** Modo rápido (preço maior na API), se a CLI disser. */
  speed?: "standard" | "fast";
  /** Buscas na web do servidor do modelo (`server_tool_use.web_search_requests`), se vierem. */
  webSearches?: number;
  /**
   * Custo em dólar que o PRÓPRIO programa relatou no turno (OpenClaw: `costUsd`; Hermes: custo estimado). Maior que
   * zero quase sempre quer dizer chave de API paga (a assinatura não tem custo por turno): vira alerta na tela Motores.
   */
  reportedCostUsd?: number;
  /** Os números são estimativa (Freebuff: entrada lida do registro do chat, saída pelo tamanho do texto), não contagem da CLI. */
  estimated?: boolean;
};

/** Soma do que um agente relatou numa janela de tempo (estimativa do uso por agente). */
export type AgentUsageTally = {
  agentId: string;
  provider: AgentProvider;
  /** Turnos terminados na janela (cada mensagem que o agente respondeu). */
  turns: number;
  /** Turnos que vieram com contagem de tokens (um turno sem `usage` da CLI só conta como turno). */
  measuredTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Soma do custo em dinheiro que o programa relatou (só OpenClaw e Hermes, e só quando houve). */
  reportedCostUsd?: number;
  /** Turnos (dos medidos) cujos tokens são estimativa (Freebuff); ausente = nenhum. */
  estimatedTurns?: number;
  /** Último turno terminado (ISO). */
  lastAt: string;
};

/**
 * Um turno terminado por um agente de CLI (evento `usage:agents`): o web soma no "Por agente" sem
 * consultar a rota de novo. `usage` ausente = a CLI não informa tokens (só conta o turno).
 */
export type AgentUsageTurn = {
  agentId: string;
  provider: AgentProvider;
  /** Quando o turno terminou (ISO). */
  at: string;
  usage?: TurnUsage;
};

/** Até quanto tempo para trás o server guarda os turnos dos agentes (o pedido não passa disso). */
export const AGENT_USAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** `GET /api/w/:ws/usage/agents?since=`: o uso relatado por agente do workspace desde `since`. */
export const agentUsageQuerySchema = z.object({ since: isoString.optional() });

/** Resposta de `GET /api/w/:ws/usage/agents`: maior uso primeiro. `since`: início efetivo da soma. */
export type AgentUsageResponse = { since: string; agents: AgentUsageTally[] };
