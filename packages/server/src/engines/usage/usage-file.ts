import { readFile } from "node:fs/promises";
import { subscriptionUsageSchema, usageKey, type SubscriptionUsage } from "@cyno/shared";
import { writeJsonAtomic } from "../../store/atomic-write";
import type { SubscriptionUsageTracker } from "./subscription-usage";

/**
 * `DATA_DIR/usage.json`: o último uso conhecido de cada provedor/conta, para o medidor não voltar
 * vazio depois de um restart (o web mostra "atualizado há X min"). Formato `{ version: 1, usage: [...] }`.
 * Itens antigos (sem `accountId`) continuam válidos como conta padrão. Nunca guarda token nem credencial.
 */
type UsageFile = { version: 1; usage: SubscriptionUsage[] };

/** Lê o arquivo; ausente, ilegível ou inválido = []. Itens inválidos são descartados um a um. */
export async function loadUsageFile(file: string): Promise<SubscriptionUsage[]> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return [];
  }
  const list = typeof data === "object" && data !== null && Array.isArray((data as { usage?: unknown }).usage) ? (data as { usage: unknown[] }).usage : [];
  const result: SubscriptionUsage[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const parsed = subscriptionUsageSchema.safeParse(item);
    if (!parsed.success || parsed.data.provider === "mock") continue;
    const key = usageKey(parsed.data.provider, parsed.data.accountId);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(parsed.data);
  }
  return result;
}

export function saveUsageFile(file: string, usage: SubscriptionUsage[]): Promise<void> {
  const content: UsageFile = { version: 1, usage: usage.filter((item) => item.provider !== "mock") };
  return writeJsonAtomic(file, content);
}

/**
 * Grava o estado do tracker a cada mudança (`usage:updated` ou `forget`), em série (uma gravação por
 * vez, e só a última pendente vale). Devolve `flush` (espera a gravação em andamento) e `stop`.
 */
export function persistUsage(
  tracker: SubscriptionUsageTracker,
  file: string,
  onError: (error: unknown) => void = () => {},
): { flush: () => Promise<void>; stop: () => void } {
  let running: Promise<void> = Promise.resolve();
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    running = running.then(async () => {
      pending = false;
      try {
        await saveUsageFile(file, tracker.snapshot());
      } catch (error) {
        onError(error);
      }
    });
  };
  const unsubscribe = tracker.onChange(schedule);
  return { flush: () => running, stop: unsubscribe };
}
