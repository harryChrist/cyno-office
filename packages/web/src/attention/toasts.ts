import type { AttentionAlert, AttentionLevel } from "@cyno/shared";

/**
 * A pilha de avisos (toasts) da cadeia de atenção, em funções puras: no máximo 4, vários alertas
 * juntos viram um aviso só ("3 itens esperando você"), a vida depende do nível (alert fica até a
 * causa sumir), o mouse em cima pausa. A ideia é a do `Toasts` do Habblaud (github.com/marmottajr/habblaud,
 * MIT, Copyright (c) 2026 Márcio Junior), reescrita aqui.
 */
export const TOAST_MAX = 4;
/** Alertas que chegam dentro deste tempo do último aviso entram nele. */
export const TOAST_JOIN_MS = 6_000;
/** Vida de cada nível (alert fica até a causa sumir). */
export const TOAST_LIFE_MS: Record<AttentionLevel, number | null> = { alert: null, warn: 9_000, info: 5_000 };
/** Ao tirar o mouse de cima, o aviso volta com pelo menos isto de vida. */
export const TOAST_RESUME_MIN_MS = 1_500;

export type Toast = {
  id: string;
  /** Os alertas que o aviso reúne (chaves), do mais antigo ao mais novo. */
  keys: string[];
  level: AttentionLevel;
  createdAt: number;
  /** null = até a causa sumir. */
  expiresAt: number | null;
  /** O mouse está em cima. */
  paused: boolean;
  /** Quanto falta de vida quando o mouse subiu (para voltar de onde parou). */
  remainingMs?: number;
};

const rank: Record<AttentionLevel, number> = { alert: 0, warn: 1, info: 2 };
const strongest = (a: AttentionLevel, b: AttentionLevel): AttentionLevel => (rank[a] <= rank[b] ? a : b);

/** Põe um alerta novo na pilha: junta no último aviso se foi há pouco, senão abre outro (e tira o excesso). */
export function addToast(toasts: readonly Toast[], alert: Pick<AttentionAlert, "key" | "level">, now: number, id: string): Toast[] {
  if (toasts.some((toast) => toast.keys.includes(alert.key))) return [...toasts];
  const last = toasts.at(-1);
  if (last && now - last.createdAt <= TOAST_JOIN_MS) {
    const level = strongest(last.level, alert.level);
    const life = TOAST_LIFE_MS[level];
    const joined: Toast = { ...last, keys: [...last.keys, alert.key], level, expiresAt: life === null ? null : (last.expiresAt === null ? now + life : Math.max(last.expiresAt, now + life)), paused: last.paused };
    return [...toasts.slice(0, -1), joined];
  }
  const life = TOAST_LIFE_MS[alert.level];
  let next: Toast[] = [...toasts, { id, keys: [alert.key], level: alert.level, createdAt: now, expiresAt: life === null ? null : now + life, paused: false }];
  while (next.length > TOAST_MAX) {
    // Sai o primeiro que não é alerta; se só há alertas, o mais antigo.
    const drop = next.findIndex((toast) => toast.level !== "alert");
    next = next.filter((_, index) => index !== (drop >= 0 ? drop : 0));
  }
  return next;
}

/**
 * Tira dos avisos os alertas que a causa já limpou; aviso sem alerta nenhum some. O que sobra volta ao
 * nível dos alertas que ficaram (um aviso que juntou uma aprovação e uma falha, depois que a aprovação
 * sai, passa a ser só o aviso da falha e some sozinho em vez de ficar para sempre).
 */
export function pruneToasts(toasts: readonly Toast[], open: ReadonlyMap<string, Pick<AttentionAlert, "level">>, now: number): Toast[] {
  return toasts.flatMap((toast) => {
    const keys = toast.keys.filter((key) => open.has(key));
    if (keys.length === 0) return [];
    if (keys.length === toast.keys.length) return [toast];
    const level = keys.map((key) => open.get(key)!.level).reduce(strongest);
    const life = TOAST_LIFE_MS[level];
    return [{ ...toast, keys, level, expiresAt: life === null ? null : (toast.expiresAt ?? now + life) }];
  });
}

/** Tira os avisos cuja vida acabou (os pausados e os que ficam até a causa sumir não saem). */
export function expireToasts(toasts: readonly Toast[], now: number): Toast[] {
  return toasts.filter((toast) => toast.paused || toast.expiresAt === null || toast.expiresAt > now);
}

export function pauseToast(toasts: readonly Toast[], id: string, now: number): Toast[] {
  return toasts.map((toast) => (toast.id === id && !toast.paused ? { ...toast, paused: true, ...(toast.expiresAt !== null ? { remainingMs: Math.max(0, toast.expiresAt - now) } : {}) } : toast));
}

export function resumeToast(toasts: readonly Toast[], id: string, now: number): Toast[] {
  return toasts.map((toast) => {
    if (toast.id !== id || !toast.paused) return toast;
    const { remainingMs: _remaining, ...rest } = toast;
    return { ...rest, paused: false, expiresAt: toast.expiresAt === null ? null : now + Math.max(TOAST_RESUME_MIN_MS, toast.remainingMs ?? 0) };
  });
}

export function dismissToast(toasts: readonly Toast[], id: string): Toast[] {
  return toasts.filter((toast) => toast.id !== id);
}

/** O que o aviso mostra, a partir dos alertas abertos. */
export type ToastView = { title: string; who?: string; actionLabel: string; /** Chave aberta ao clicar em "Responder" (o mais antigo). */ openKey: string; count: number };

const ACTION_LABEL: Partial<Record<AttentionAlert["kind"], string>> = { failed: "Ver tarefa", usage: "Abrir Gastos", budget: "Abrir Gastos", delivery: "Abrir" };

export function toastView(toast: Toast, open: ReadonlyMap<string, AttentionAlert>): ToastView | null {
  const alerts = toast.keys.flatMap((key) => (open.has(key) ? [open.get(key)!] : []));
  if (alerts.length === 0) return null;
  const total = alerts.reduce((sum, alert) => sum + alert.count, 0);
  const first = alerts[0]!;
  if (alerts.length > 1) {
    // Só avisos que não esperam o dono (limite de uso, orçamento, tarefa que falhou): "N avisos", nunca "esperando você".
    const owner = alerts.filter((alert) => alert.needsOwner);
    if (owner.length === 0) return { title: `${alerts.length} avisos novos`, actionLabel: ACTION_LABEL[first.kind] ?? "Abrir", openKey: first.key, count: total };
    return { title: `${total} itens esperando você`, actionLabel: "Responder", openKey: first.key, count: total };
  }
  const who = [first.agentName, first.workspaceName].filter(Boolean).join(" · ");
  const label = first.needsOwner ? "Responder" : (ACTION_LABEL[first.kind] ?? "Abrir");
  return { title: first.text, ...(who ? { who } : {}), actionLabel: label, openKey: first.key, count: first.count };
}
