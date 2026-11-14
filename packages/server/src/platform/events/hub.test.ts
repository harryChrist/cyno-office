import type { ServerEvent } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { EventHub, type HubJournalOptions, type SequencedMeta } from "./hub";

const removed = (id: string): ServerEvent => ({ type: "calendar:deleted", id });
const activity: ServerEvent = { type: "browser:activity", activity: { agentId: "a1", tabId: "t1", label: "Abriu google.com", at: "2026-11-09T00:00:00.000Z" } };

function journaled(overrides: Partial<HubJournalOptions> = {}) {
  let now = 1_000_000;
  const hub = new EventHub({ journal: { maxEvents: 100, maxAgeMs: 60_000, maxBytes: 1_000_000, now: () => now, ...overrides } });
  return { hub, advance: (ms: number) => (now += ms) };
}

const ids = (replayed: SequencedMeta[] | null) => replayed?.map((meta) => (JSON.parse(meta.wire) as { id: string }).id) ?? null;

describe("EventHub com histórico (reconexão)", () => {
  it("numera os eventos em ordem crescente e manda a mensagem pronta com o seq", () => {
    const { hub } = journaled();
    const seen: { type: string; meta?: SequencedMeta }[] = [];
    hub.subscribe((event, meta) => seen.push({ type: event.type, ...(meta ? { meta } : {}) }));
    hub.publish(removed("e1"));
    hub.publish(removed("e2"));
    hub.publish(removed("e3"));
    expect(seen.map((item) => item.meta?.seq)).toEqual([1, 2, 3]);
    expect(JSON.parse(seen[1]!.meta!.wire)).toEqual({ type: "calendar:deleted", id: "e2", seq: 2 });
    expect(hub.seq).toBe(3);
  });

  it("eventos só visuais vão ao vivo, mas sem seq e fora do histórico", () => {
    const { hub } = journaled();
    const metas: (SequencedMeta | undefined)[] = [];
    hub.subscribe((_event, meta) => metas.push(meta));
    hub.publish(removed("e1"));
    hub.publish(activity);
    hub.publish(removed("e2"));
    expect(metas.map((meta) => meta?.seq)).toEqual([1, undefined, 2]);
    expect(hub.journalSize).toBe(2);
    expect(ids(hub.replaySince(hub.epoch, 0))).toEqual(["e1", "e2"]);
  });

  it("replay: devolve só o que veio depois de `since`, em ordem (vazio = nada perdido)", () => {
    const { hub } = journaled();
    for (const id of ["e1", "e2", "e3", "e4"]) hub.publish(removed(id));
    expect(ids(hub.replaySince(hub.epoch, 2))).toEqual(["e3", "e4"]);
    expect(hub.replaySince(hub.epoch, 2)!.map((meta) => meta.seq)).toEqual([3, 4]);
    expect(hub.replaySince(hub.epoch, 4)).toEqual([]);
  });

  it("outro epoch (server reiniciou), since à frente do hub ou inválido: precisa de snapshot", () => {
    const { hub } = journaled();
    hub.publish(removed("e1"));
    expect(hub.replaySince("outro-boot", 0)).toBeNull();
    expect(hub.replaySince(hub.epoch, 5)).toBeNull();
    expect(hub.replaySince(hub.epoch, -1)).toBeNull();
    expect(hub.replaySince(hub.epoch, 0.5)).toBeNull();
    expect(new EventHub({ journal: { maxEvents: 1, maxAgeMs: 1, maxBytes: 1 } }).epoch).not.toBe(hub.epoch);
  });

  it("histórico limitado em quantidade: quem perdeu além do que sobrou recebe snapshot", () => {
    const { hub } = journaled({ maxEvents: 3 });
    for (let i = 1; i <= 5; i++) hub.publish(removed(`e${i}`));
    expect(hub.journalSize).toBe(3);
    expect(ids(hub.replaySince(hub.epoch, 2))).toEqual(["e3", "e4", "e5"]);
    expect(hub.replaySince(hub.epoch, 1)).toBeNull();
  });

  it("histórico limitado em idade e em bytes", () => {
    const aged = journaled({ maxAgeMs: 1000 });
    aged.hub.publish(removed("velho"));
    aged.advance(2000);
    aged.hub.publish(removed("novo"));
    expect(aged.hub.replaySince(aged.hub.epoch, 0)).toBeNull();
    expect(ids(aged.hub.replaySince(aged.hub.epoch, 1))).toEqual(["novo"]);
    // Sem eventos novos, o que envelheceu também sai na hora do replay.
    aged.advance(2000);
    expect(aged.hub.replaySince(aged.hub.epoch, 1)).toBeNull();
    expect(aged.hub.replaySince(aged.hub.epoch, 2)).toEqual([]);

    const one = JSON.stringify({ ...removed("e1"), seq: 1 }).length;
    const sized = journaled({ maxBytes: one * 2 });
    for (const id of ["e1", "e2", "e3"]) sized.hub.publish(removed(id));
    expect(sized.hub.journalSize).toBe(2);
    expect(sized.hub.replaySince(sized.hub.epoch, 0)).toBeNull();
    expect(ids(sized.hub.replaySince(sized.hub.epoch, 1))).toEqual(["e2", "e3"]);
  });

  it("compacta o histórico sem perder a contagem (muitos eventos)", () => {
    const { hub } = journaled({ maxEvents: 50 });
    for (let i = 1; i <= 5000; i++) hub.publish(removed(`e${i}`));
    expect(hub.journalSize).toBe(50);
    expect(ids(hub.replaySince(hub.epoch, 4997))).toEqual(["e4998", "e4999", "e5000"]);
    expect(hub.replaySince(hub.epoch, 4949)).toBeNull();
    expect(hub.replaySince(hub.epoch, 4950)).toHaveLength(50);
  });

  it("sem histórico (hub de lista/uso): nada de seq e nunca replay", () => {
    const hub = new EventHub();
    const metas: (SequencedMeta | undefined)[] = [];
    hub.subscribe((_event, meta) => metas.push(meta));
    hub.publish(removed("e1"));
    expect(metas).toEqual([undefined]);
    expect(hub.seq).toBe(0);
    expect(hub.replaySince(hub.epoch, 0)).toBeNull();
  });
});
