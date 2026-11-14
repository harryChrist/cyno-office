import { z } from "zod";
import { MAX_ID_LENGTH, SAFE_ID_PATTERN } from "./ids";

/**
 * A cadeia de atenção (Junção V2, J2-03 a J2-06): o Cyno chama o dono quando algo precisa dele.
 * O alerta nasce no servidor (uma vez, com chave de repetição) e chega a todas as abas pelo socket
 * da plataforma; o contador, o título da aba, o aviso, o som e a notificação do navegador leem
 * as funções puras deste arquivo.
 *
 * A ideia da cadeia (contador clicável, título com o número, aviso com "Responder", sino, notificação
 * do navegador) vem do Habblaud (github.com/marmottajr/habblaud, MIT, Copyright (c) 2026 Márcio Junior);
 * aqui só há o desenho e as regras, o código é nosso.
 */

export const ATTENTION_PATH = "/api/attention";
export const ATTENTION_PREFS_PATH = "/api/attention/prefs";

/** Tipos de alerta. `budget` e `delivery` ficam previstos (orçamento e entregas são de outras fatias). */
export const ATTENTION_KINDS = ["approval", "plan", "sprint", "routine", "question", "help", "failed", "blocked", "engine_down", "usage", "budget", "delivery"] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** alert = espera o dono; warn = vale ver; info = só informa. */
export const ATTENTION_LEVELS = ["alert", "warn", "info"] as const;
export type AttentionLevel = (typeof ATTENTION_LEVELS)[number];

export const ATTENTION_KIND_LABELS: Record<AttentionKind, string> = {
  approval: "Aprovações",
  plan: "Planos",
  sprint: "Entregas de sprint",
  routine: "Rotinas",
  question: "Perguntas",
  help: "Pedidos de ajuda",
  failed: "Tarefas que falharam",
  blocked: "Tarefas travadas",
  engine_down: "Terminal que caiu",
  usage: "Limite de uso",
  budget: "Orçamento",
  delivery: "Entregas",
};

/** Quanto tempo a mesma chave fica sem voltar a avisar (só sobe o contador). */
export const ATTENTION_DEDUPE_MS = 10 * 60_000;
/** Vários alertas do mesmo tipo, workspace e agente dentro deste tempo viram um. */
export const ATTENTION_COALESCE_MS = 3_000;
/** Falhas do mesmo projeto dentro deste tempo viram "N tarefas falharam em X". */
export const ATTENTION_FAILED_COALESCE_MS = 60_000;
/** O pedido de ajuda de skill só chama o dono se o Maestro não resolver neste tempo. */
export const HELP_ESCALATE_MS = 5 * 60_000;
/** Um alerta mais velho que isto, quando a aba conecta, entra no número mas não vira aviso nem som. */
export const ATTENTION_STALE_MS = 5 * 60_000;
/** O terminal em erro por tanto tempo, sem voltar, é "caiu e não voltou". */
export const ENGINE_DOWN_SETTLE_MS = 45_000;
/** Limite de uso: o alerta rearma quando o uso cai este tanto (0 a 1) abaixo do nível. */
export const USAGE_HYSTERESIS = 0.05;
export const ATTENTION_TEXT_MAX = 140;

/** Para onde o alerta leva. */
export const ATTENTION_PAGES = ["para-voce", "trabalho", "gestao", "agente", "cyno"] as const;
export type AttentionPage = (typeof ATTENTION_PAGES)[number];
export type AttentionTarget = {
  page: AttentionPage;
  workspaceId?: string;
  /** O item (Aprovações), a tarefa (Trabalho), o agente (agente) ou a aba (Gestão). */
  ref?: string;
};

export type AttentionAlert = {
  /** "al-<ms>-<n>": novo a cada vez que o alerta nasce. */
  id: string;
  /** `${kind}:${workspaceId ?? "plataforma"}:${ref}`: a chave de repetição e de limpeza. */
  key: string;
  kind: AttentionKind;
  level: AttentionLevel;
  /** Conta no número da aba e no contador. */
  needsOwner: boolean;
  workspaceId?: string;
  workspaceName?: string;
  agentId?: string;
  agentName?: string;
  projectId?: string;
  sprintId?: string;
  taskId?: string;
  forYouId?: string;
  groupId?: string;
  /** pt-BR, até 140 caracteres, já sem segredos. */
  text: string;
  /** Itens juntos (um lote de 8 aprovações = 1 alerta com count 8). */
  count: number;
  at: string;
  updatedAt: string;
  target: AttentionTarget;
  /** Veio do boot, de reconexão ou de reabertura: entra na lista e no número, sem aviso, som nem notificação. */
  replay?: boolean;
};

export const ATTENTION_CLEAR_REASONS = ["decided", "resolved", "seen", "expired", "muted"] as const;
export type AttentionClearReason = (typeof ATTENTION_CLEAR_REASONS)[number];

export type AttentionServerEvent =
  | { type: "attention:raised"; alert: AttentionAlert }
  /** Só `count`, `text` e `updatedAt` mudaram. */
  | { type: "attention:updated"; alert: AttentionAlert }
  | { type: "attention:cleared"; key: string; reason: AttentionClearReason };
export const ATTENTION_EVENT_TYPES = ["attention:raised", "attention:updated", "attention:cleared"] as const;

/** GET /api/attention */
export type AttentionResponse = { open: AttentionAlert[]; serverTime: string };

/** O tipo conta como "espera o dono" (e o nível é alert)? Limite de uso e orçamento não entram. */
const OWNER_KINDS: ReadonlySet<AttentionKind> = new Set(["approval", "question", "plan", "sprint", "routine", "help", "blocked", "engine_down"]);
export function needsOwnerOf(kind: AttentionKind, level: AttentionLevel): boolean {
  return level === "alert" && OWNER_KINDS.has(kind);
}

/** Tipos que se resolvem sozinhos (a causa some); os outros pedem "Visto" (o orçamento também: só some no fim do período). */
export function isSelfResolving(kind: AttentionKind): boolean {
  return kind !== "failed" && kind !== "delivery" && kind !== "budget";
}

// ---------- Preferências da conta ----------

const workspaceKeySchema = z.string().max(MAX_ID_LENGTH).regex(SAFE_ID_PATTERN);
const kindFlags = Object.fromEntries(ATTENTION_KINDS.map((kind) => [kind, z.boolean().optional()])) as Record<AttentionKind, z.ZodOptional<z.ZodBoolean>>;
const mutedWorkspacesSchema = z.record(workspaceKeySchema, z.object({ until: z.string().optional() }));
const kindsSchema = z.object(kindFlags);

/** Preferências da conta (`data/platform/attention.json`): valem para todos os aparelhos. */
export const attentionPrefsSchema = z.object({
  /** Workspace silenciado (sem `until` = sempre). O alerta continua contando; só não avisa. */
  mutedWorkspaces: mutedWorkspacesSchema.default({}),
  /** Tipo desligado (false) não avisa (toast, som, notificação); continua no sino. Ausente = ligado. */
  kinds: kindsSchema.default({}),
  /** "Não perturbe" até este instante (ISO). */
  dndUntil: z.string().optional(),
});
export type AttentionPrefs = z.output<typeof attentionPrefsSchema>;
export const DEFAULT_ATTENTION_PREFS: AttentionPrefs = { mutedWorkspaces: {}, kinds: {} };

/** PUT /api/attention/prefs: troca só o que veio. */
export const attentionPrefsBodySchema = z.strictObject({
  mutedWorkspaces: mutedWorkspacesSchema.optional(),
  kinds: z.strictObject(kindFlags).optional(),
  dndUntil: z.string().nullable().optional(),
});
export type AttentionPrefsBody = z.input<typeof attentionPrefsBodySchema>;

const parsedTime = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : undefined;
};

/** O workspace está silenciado agora? */
export function workspaceMuted(prefs: AttentionPrefs, workspaceId: string | undefined, now: number): boolean {
  if (!workspaceId || !Object.hasOwn(prefs.mutedWorkspaces, workspaceId)) return false;
  const until = parsedTime(prefs.mutedWorkspaces[workspaceId]?.until);
  return until === undefined || until > now;
}

/** "Não perturbe" vale agora? */
export function doNotDisturbActive(prefs: AttentionPrefs, now: number): boolean {
  const until = parsedTime(prefs.dndUntil);
  return until !== undefined && until > now;
}

export type SilenceReason = "kind" | "workspace" | "dnd";

/** Por que o alerta não deve avisar (toast, som, notificação); null = pode avisar. O alerta continua contando. */
export function silenceReason(prefs: AttentionPrefs, alert: Pick<AttentionAlert, "kind" | "workspaceId">, now: number): SilenceReason | null {
  if (prefs.kinds[alert.kind] === false) return "kind";
  if (workspaceMuted(prefs, alert.workspaceId, now)) return "workspace";
  if (doNotDisturbActive(prefs, now)) return "dnd";
  return null;
}

/** Fim do dia de hoje + 1 em São Paulo (meia-noite do dia seguinte, UTC-3 fixo desde 2019) em ISO: o "até amanhã". */
export function untilTomorrow(now: number): string {
  const offsetMs = 3 * 3_600_000;
  const local = new Date(now - offsetMs);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) + offsetMs;
  return new Date(midnight).toISOString();
}

// ---------- Percurso, número e título ----------

/** O que espera o dono (conta no número e no contador). */
export function ownerAlerts(open: readonly AttentionAlert[]): AttentionAlert[] {
  return open.filter((alert) => alert.needsOwner);
}

/**
 * Quantas coisas esperam o dono: soma os itens de cada alerta (um lote de 5 aprovações do mesmo agente conta 5; um
 * pedido de ajuda ou um terminal caído conta 1). É o número do contador, do título da aba e do selo do app; só com
 * aprovações ele é igual ao de Aprovações. O percurso (clicar para ir ao próximo) continua sendo por alerta.
 */
export function ownerCount(open: readonly AttentionAlert[]): number {
  return ownerAlerts(open).reduce((sum, alert) => sum + Math.max(1, Math.round(alert.count) || 1), 0);
}

/** A ordem do percurso: o que espera o dono primeiro, do mais antigo ao mais novo; depois o resto, também do mais antigo. */
export function tourOrder(open: readonly AttentionAlert[]): AttentionAlert[] {
  return [...open].sort((a, b) => Number(b.needsOwner) - Number(a.needsOwner) || a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/**
 * O próximo alerta do percurso depois de `currentKey` (dá a volta no fim); `dir = -1` anda para trás.
 * Só percorre o que espera o dono; sem nenhum, undefined. Sem `currentKey` (ou chave que não está mais
 * na lista), começa pelo mais antigo (ou, para trás, pelo mais novo).
 */
export function nextAttention(open: readonly AttentionAlert[], currentKey: string | null | undefined, dir: 1 | -1 = 1): AttentionAlert | undefined {
  const order = tourOrder(ownerAlerts(open));
  if (order.length === 0) return undefined;
  const index = currentKey ? order.findIndex((alert) => alert.key === currentKey) : -1;
  if (index < 0) return dir === 1 ? order[0] : order.at(-1);
  return order[(index + dir + order.length) % order.length];
}

/** O título da aba: `(N) Cyno` com N coisas esperando o dono (itens, não alertas). */
export function attentionTitle(count: number, base = "Cyno"): string {
  return count > 0 ? `(${count > 99 ? "99+" : count}) ${base}` : base;
}

/** A frase curta do que o contador diz ("3 esperando você; o mais antigo há 9 h"). */
export function counterSummary(open: readonly AttentionAlert[], nowMs: number): string {
  const owner = tourOrder(ownerAlerts(open));
  if (owner.length === 0) return "Nada esperando você";
  const oldest = owner[0]!;
  const minutes = Math.max(0, Math.round((nowMs - Date.parse(oldest.at)) / 60_000));
  const ago = minutes < 1 ? "agora há pouco" : minutes < 60 ? `há ${minutes} min` : minutes < 24 * 60 ? `há ${Math.round(minutes / 60)} h` : `há ${Math.round(minutes / 1440)} d`;
  return `${ownerCount(open)} esperando você; o mais antigo ${ago}`;
}
