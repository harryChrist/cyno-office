import type { DeliveryCard } from "@cyno/shared";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Quanto tempo o trabalho levou ("5 min", "42 s"), se a entrega sabe quando começou. */
export function deliveryDuration(card: Pick<DeliveryCard, "startedAt" | "finishedAt">): string | undefined {
  if (!card.startedAt) return undefined;
  const ms = Date.parse(card.finishedAt) - Date.parse(card.startedAt);
  if (!Number.isFinite(ms) || ms < 1000) return undefined;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** Os números de uma entrega, em frases curtas: duração, ferramentas, arquivos editados, mídias. */
export function deliveryFacts(card: DeliveryCard): string[] {
  const out: string[] = [];
  const duration = deliveryDuration(card);
  if (duration) out.push(duration);
  if (card.tools > 0) out.push(plural(card.tools, "ferramenta", "ferramentas"));
  if (card.edited > 0) out.push(plural(card.edited, "arquivo editado", "arquivos editados"));
  if (card.media.length > 0) out.push(plural(card.media.length, "mídia", "mídias"));
  return out;
}
