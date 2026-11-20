import { z } from "zod";
import type { EngineBlock } from "./models";

/**
 * Freebuff como motor de agente (só agentes de time). O que a CLI gratuita da Codebuff cobra não é
 * token, é HORA ABERTA: a hora começa na primeira mensagem de um processo, dura 60 minutos e custa
 * (multiplicador do modelo) horas do saldo do dia. Este arquivo tem os tipos e as regras puras que o
 * servidor e a tela dividem; o estado vai pelo uso da assinatura (`SubscriptionUsage.freebuff`).
 */

/** O modelo padrão do dono para os agentes do Freebuff. */
export const FREEBUFF_DEFAULT_MODEL = { name: "DeepSeek V4.1 Flash", effort: "high" } as const;

/** Uma hora aberta dura isto (o fim real vem do arquivo da sessão; o relógio é a reserva). */
export const FREEBUFF_HOUR_MS = 3_600_000;

/** Teto padrão de horas abertas ao mesmo tempo (duas instâncias com mensagem gastam duas horas). */
export const FREEBUFF_DEFAULT_MAX_OPEN_HOURS = 1;
export const FREEBUFF_MAX_OPEN_HOURS_LIMIT = 6;

/** Um modelo da lista do `/model` (o nome é o que a TUI mostra; a chave interna dela é opaca e muda). */
export type FreebuffModel = {
  name: string;
  /** Quantas horas do saldo cada hora aberta gasta (1x, 2x...). */
  multiplier: number;
  /** Níveis de esforço (low, medium, high...), quando se sabe; vazio = não lido. */
  efforts: string[];
  defaultEffort?: string;
  /** Seção da lista (STANDARD, PREMIUM, POWERFUL). */
  section?: string;
};

/** A escolha de modelo do Freebuff: uma só para a plataforma (a escolha da TUI é global na máquina). */
export type FreebuffSettings = { model: string; effort: string; maxOpenHours: number };

/** Uma hora aberta (de um agente). */
export type FreebuffHourSession = {
  agentId: string;
  agentName?: string;
  workspaceId: string;
  openedAt: string;
  endsAt: string;
  /** `measured`: o fim veio do arquivo da sessão do Freebuff; `estimated`: abertura + 60 min. */
  endsAtSource: "measured" | "estimated";
  /** Horas do saldo que esta hora custou. */
  multiplier: number;
  model: string;
  effort?: string;
  /** O processo do Freebuff está vivo agora (falso depois de um reinício do servidor, até reassumir). */
  hasProcess: boolean;
};

/** As horas do dia: o que o Freebuff disse (medido) e o que o Cyno abriu depois (estimado). */
export type FreebuffHoursInfo = {
  /** Total do dia (ex.: 21). Ausente = o Cyno ainda não leu. */
  total?: number;
  /** Quanto restava na última leitura da tela (banner "N/21 hours remaining" ou `/model`), menos o que o Cyno abriu depois. */
  remaining?: number;
  /** Horas na carteira (ganhas em indicações), se a tela disse. */
  wallet?: number;
  /** Quando o dia vira (ISO). */
  resetsAt?: string;
  /** Quando foi a última leitura da tela (ISO). */
  measuredAt?: string;
  /** Horas que o Cyno abriu depois da última leitura (é o que faz `remaining` ser estimativa). */
  openedSince: number;
};

/** O estado do Freebuff no uso da assinatura (vai em `SubscriptionUsage.freebuff`). */
export type FreebuffUsageDetail = {
  settings: FreebuffSettings & { multiplier?: number };
  hours: FreebuffHoursInfo;
  sessions: FreebuffHourSession[];
  /**
   * Agentes com pedido na fila que ainda não abriram a hora (o processo está subindo, escolhendo o modelo...):
   * eles já contam para o teto de horas abertas, senão dois agentes começariam juntos antes de qualquer hora abrir.
   */
  pending?: { agentId: string; agentName?: string; workspaceId: string }[];
};

/** Um agente: o id vale dentro do workspace (sem o workspace, vale só o id: a tela de um workspace só vê os dele). */
export type FreebuffAgentRef = { agentId: string; workspaceId?: string };

const isSameAgent = (session: Pick<FreebuffHourSession, "agentId" | "workspaceId">, agent: FreebuffAgentRef) =>
  session.agentId === agent.agentId && (agent.workspaceId === undefined || session.workspaceId === agent.workspaceId);

/** Horas abertas agora (a hora de um agente já acabou = não conta). */
export function openFreebuffSessions(detail: Pick<FreebuffUsageDetail, "sessions"> | undefined, now: number): FreebuffHourSession[] {
  return (detail?.sessions ?? []).filter((session) => Date.parse(session.endsAt) > now);
}

/** O agente tem uma hora aberta agora? (o agendador prefere dar trabalho a quem já pagou a hora) */
export function freebuffHoldsHour(detail: Pick<FreebuffUsageDetail, "sessions"> | undefined, agent: FreebuffAgentRef, now: number): boolean {
  return openFreebuffSessions(detail, now).some((session) => isSameAgent(session, agent));
}

/** Minutos que faltam para a hora de um agente acabar (arredondado para cima; undefined = sem hora aberta). */
export function freebuffMinutesLeft(detail: Pick<FreebuffUsageDetail, "sessions"> | undefined, agent: FreebuffAgentRef, now: number): number | undefined {
  const session = openFreebuffSessions(detail, now).find((candidate) => isSameAgent(candidate, agent));
  return session ? Math.max(0, Math.ceil((Date.parse(session.endsAt) - now) / 60_000)) : undefined;
}

/**
 * Por que o agente não pode trabalhar agora no Freebuff (função pura; o servidor e a tela usam a mesma):
 * - quem já tem hora aberta nunca espera (usa a hora que já pagou);
 * - o teto de horas abertas foi atingido por outro agente: `hour`, com o nome dele e quando a hora acaba;
 * - o saldo do dia (mais a carteira) não paga uma hora nova: `quota`, com a hora em que o dia vira.
 */
export function freebuffBlock(detail: FreebuffUsageDetail | undefined, agent: FreebuffAgentRef | undefined, now: number): EngineBlock | undefined {
  if (!detail) return undefined;
  const open = openFreebuffSessions(detail, now);
  if (agent && open.some((session) => isSameAgent(session, agent))) return undefined;
  const cap = Math.max(1, detail.settings.maxOpenHours);
  const pending = (detail.pending ?? []).filter((candidate) => !open.some((session) => session.agentId === candidate.agentId && session.workspaceId === candidate.workspaceId) && !(agent && isSameAgent(candidate, agent)));
  if (open.length + pending.length >= cap) {
    if (open.length > 0) {
      const first = [...open].sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt))[0]!;
      return { reason: "hour", holder: first.agentName ?? first.agentId, resetsAt: first.endsAt };
    }
    const first = pending[0]!;
    return { reason: "hour", holder: first.agentName ?? first.agentId };
  }
  const { remaining, wallet = 0, resetsAt } = detail.hours;
  const need = detail.settings.multiplier ?? 1;
  const resets = resetsAt !== undefined && Date.parse(resetsAt) > now ? resetsAt : undefined;
  if (remaining !== undefined && remaining + wallet < need) return { reason: "quota", ...(resets ? { resetsAt: resets } : {}) };
  return undefined;
}

/** Freebuff: a cota do dia acabou e ele já gasta da carteira? (a leitura de antes do virar do dia não vale) */
export function freebuffWalletState(detail: Pick<FreebuffUsageDetail, "hours" | "settings"> | undefined, now: number): { wallet?: number; dailyExhausted: boolean; usingWallet: boolean } {
  if (!detail) return { dailyExhausted: false, usingWallet: false };
  const { remaining, wallet, resetsAt } = detail.hours;
  const need = detail.settings.multiplier ?? 1;
  const stale = resetsAt !== undefined && Date.parse(resetsAt) <= now;
  const dailyExhausted = !stale && remaining !== undefined && remaining < need;
  return { ...(wallet !== undefined ? { wallet } : {}), dailyExhausted, usingWallet: dailyExhausted && (wallet ?? 0) >= need };
}

/** "2 horas por hora aberta" / "1 hora por hora aberta". */
export function freebuffCostText(multiplier: number): string {
  return `${multiplier === 1 ? "1 hora" : `${multiplier} horas`} por hora aberta`;
}

// ---------- Tela Motores ----------

/** Rotas do Freebuff na tela Motores. */
export const FREEBUFF_SETTINGS_PATH = "/api/engines/freebuff/settings";
export const FREEBUFF_MODELS_REFRESH_PATH = "/api/engines/freebuff/models/refresh";
export const FREEBUFF_TEST_PATH = "/api/engines/freebuff/test";

/** O que a tela Motores mostra do Freebuff (em `EngineStatus.freebuff`). */
export type FreebuffEngineInfo = {
  settings: FreebuffSettings;
  /** O modelo escolhido está na lista lida (undefined = lista ainda não lida). */
  modelFound?: boolean;
  /** Multiplicador do modelo escolhido, se a lista foi lida. */
  multiplier?: number;
  /** Modelos lidos do `/model` (cache em disco). */
  models: FreebuffModel[];
  modelsReadAt?: string;
  hours: FreebuffHoursInfo;
  sessions: FreebuffHourSession[];
};

/** Corpo de `PUT /api/engines/freebuff/settings` (campos opcionais). */
export const freebuffSettingsBodySchema = z.strictObject({
  model: z.string().trim().min(1).max(80).optional(),
  effort: z.string().trim().min(1).max(20).optional(),
  maxOpenHours: z.number().int().min(1).max(FREEBUFF_MAX_OPEN_HOURS_LIMIT).optional(),
});
export type FreebuffSettingsBody = z.input<typeof freebuffSettingsBodySchema>;

/** Corpo de `POST /api/engines/freebuff/test`: só roda com `confirm: true` (o teste abre uma hora e gasta horas do dia). */
export const freebuffTestBodySchema = z.strictObject({ confirm: z.boolean().optional() });
