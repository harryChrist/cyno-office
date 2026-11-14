import type { DeliveryCard } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { deliveryDuration, deliveryFacts } from "./deliveriesView";

const card = (patch: Partial<DeliveryCard> = {}): DeliveryCard => ({
  id: "t1",
  taskId: "t1",
  agentId: "rafa",
  request: "Faça o post",
  headline: "Pronto.",
  text: "Pronto.",
  startedAt: "2026-11-12T12:00:00.000Z",
  finishedAt: "2026-11-12T12:05:00.000Z",
  tools: 0,
  edited: 0,
  media: [],
  ...patch,
});

describe("números da entrega", () => {
  it("duração: segundos, minutos, horas; sem início ou sem diferença, nada", () => {
    expect(deliveryDuration(card({ finishedAt: "2026-11-12T12:00:42.000Z" }))).toBe("42 s");
    expect(deliveryDuration(card())).toBe("5 min");
    expect(deliveryDuration(card({ finishedAt: "2026-11-12T13:05:00.000Z" }))).toBe("1 h 05 min");
    expect(deliveryDuration(card({ startedAt: undefined }))).toBeUndefined();
    expect(deliveryDuration(card({ finishedAt: "2026-11-12T12:00:00.200Z" }))).toBeUndefined();
  });

  it("frases curtas, no singular e no plural", () => {
    expect(deliveryFacts(card())).toEqual(["5 min"]);
    expect(deliveryFacts(card({ tools: 1, edited: 1, media: [{ id: "M-0001", kind: "image", title: "x", fileName: "x.png" }] }))).toEqual(["5 min", "1 ferramenta", "1 arquivo editado", "1 mídia"]);
    expect(deliveryFacts(card({ startedAt: undefined, tools: 12, edited: 3 }))).toEqual(["12 ferramentas", "3 arquivos editados"]);
  });
});
