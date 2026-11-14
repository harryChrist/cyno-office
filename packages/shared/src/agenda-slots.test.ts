import { describe, expect, it } from "vitest";
import { agendaEventSchema, availabilitySchema, availabilityBodySchema, type AgendaEvent } from "./agenda";
import { availabilityIntervals, checkSlot, nextFreeSlots } from "./agenda-slots";

/** Segunda 9/11/2026, meio-dia em São Paulo (UTC-3, sem horário de verão). */
const NOW = new Date("2026-11-09T12:00:00-03:00");
const at = (day: number, time: string) => `2026-11-${String(day).padStart(2, "0")}T${time}:00-03:00`;
const utc = (day: number, time: string) => new Date(at(day, time)).toISOString();
const ev = (id: number, start: string, end: string, extra: Partial<AgendaEvent> = {}): AgendaEvent =>
  agendaEventSchema.parse({ id: `G-${String(id).padStart(4, "0")}`, title: `Evento ${id}`, start, end, createdAt: "2026-11-01T00:00:00.000Z", ...extra });
const av = (patch: Record<string, unknown> = {}) => availabilitySchema.parse(patch);

describe("checkSlot", () => {
  it("horário livre dentro da disponibilidade serve", () => {
    expect(checkSlot([], av(), { start: at(10, "17:00"), end: at(10, "18:00") }, { now: NOW })).toEqual({ ok: true });
  });

  it("choque: recusa, diz com quem e sugere os 3 horários livres mais próximos (antes ou depois)", () => {
    const events = [ev(1, at(10, "17:00"), at(10, "18:00"), { workspace: "linkedin" })];
    const result = checkSlot(events, av(), { start: at(10, "17:00"), end: at(10, "18:00") }, { now: NOW });
    expect(result).toMatchObject({ ok: false, problem: "conflict", conflicts: [{ id: "G-0001", workspace: "linkedin" }] });
    if (result.ok) throw new Error("esperava recusa");
    expect(result.reason).toContain("Evento 1");
    // 18:15 já não cabe (a janela acaba às 18:00): as mais próximas são as da tarde do mesmo dia, antes do choque.
    expect(result.nextFree.map((slot) => slot.start)).toEqual([utc(10, "13:00"), utc(10, "14:00"), utc(10, "15:00")]);
    for (const slot of result.nextFree) expect(checkSlot(events, av(), slot, { now: NOW }).ok).toBe(true);
  });

  it("sem nada livre antes (ainda não passou da antecedência), as sugestões são as próximas depois", () => {
    const events = [ev(1, at(10, "09:00"), at(10, "10:00"))];
    const result = checkSlot(events, av(), { start: at(10, "09:00"), end: at(10, "10:00") }, { now: NOW });
    if (result.ok) throw new Error("esperava recusa");
    expect(result.nextFree.map((slot) => slot.start)).toEqual([utc(10, "10:15"), utc(10, "11:15"), utc(10, "12:15")]);
  });

  it("o intervalo entre compromissos conta (15 min)", () => {
    const events = [ev(1, at(10, "10:00"), at(10, "11:00"))];
    expect(checkSlot(events, av(), { start: at(10, "11:00"), end: at(10, "12:00") }, { now: NOW }).ok).toBe(false);
    expect(checkSlot(events, av(), { start: at(10, "11:15"), end: at(10, "12:15") }, { now: NOW }).ok).toBe(true);
    expect(checkSlot(events, av({ bufferMinutes: 0 }), { start: at(10, "11:00"), end: at(10, "12:00") }, { now: NOW }).ok).toBe(true);
    expect(checkSlot(events, av(), { start: at(10, "08:45"), end: at(10, "09:45") }, { now: NOW }).ok).toBe(false);
  });

  it("evento cancelado e o próprio evento (ignoreId) não chocam", () => {
    const events = [ev(1, at(10, "10:00"), at(10, "11:00"), { status: "cancelado" }), ev(2, at(10, "14:00"), at(10, "15:00"))];
    expect(checkSlot(events, av(), { start: at(10, "10:00"), end: at(10, "11:00") }, { now: NOW }).ok).toBe(true);
    expect(checkSlot(events, av(), { start: at(10, "14:30"), end: at(10, "15:30") }, { now: NOW, ignoreId: "G-0002" }).ok).toBe(true);
  });

  it("fora da disponibilidade: sábado e fora da janela, com sugestões na segunda", () => {
    const result = checkSlot([], av(), { start: at(14, "10:00"), end: at(14, "11:00") }, { now: NOW });
    expect(result).toMatchObject({ ok: false, problem: "outside_availability" });
    if (result.ok) throw new Error("esperava recusa");
    // Sábado 10h: as mais próximas são as do fim da tarde de sexta, antes; segunda só viria depois.
    expect(result.nextFree.map((slot) => slot.start)).toEqual([utc(13, "15:00"), utc(13, "16:00"), utc(13, "17:00")]);
    expect(checkSlot([], av(), { start: at(10, "08:00"), end: at(10, "09:30") }, { now: NOW })).toMatchObject({ problem: "outside_availability" });
    expect(checkSlot([], av(), { start: at(10, "17:30"), end: at(10, "18:30") }, { now: NOW })).toMatchObject({ problem: "outside_availability" });
  });

  it("dia sem janela e dia bloqueado por exceção", () => {
    const blocked = av({ exceptions: [{ date: "2026-11-11", off: true }] });
    expect(checkSlot([], blocked, { start: at(11, "10:00"), end: at(11, "11:00") }, { now: NOW })).toMatchObject({ problem: "outside_availability" });
    expect(nextFreeSlots([], blocked, { durationMs: 3_600_000, from: Date.parse(at(11, "08:00")), now: NOW })[0]!.start).toBe(utc(12, "09:00"));
    // Exceção com janela troca as janelas do dia (sábado aberto de 10h às 12h).
    const saturday = av({ exceptions: [{ date: "2026-11-14", from: "10:00", to: "12:00" }] });
    expect(checkSlot([], saturday, { start: at(14, "10:00"), end: at(14, "11:00") }, { now: NOW }).ok).toBe(true);
    expect(checkSlot([], saturday, { start: at(14, "11:30"), end: at(14, "12:30") }, { now: NOW }).ok).toBe(false);
  });

  it("antecedência mínima: o dono passa por cima, os outros não; passado é recusado", () => {
    const soon = { start: at(9, "12:30"), end: at(9, "13:30") };
    expect(checkSlot([], av(), soon, { now: NOW })).toMatchObject({ ok: false, problem: "notice" });
    expect(checkSlot([], av(), soon, { now: NOW, skipNotice: true }).ok).toBe(true);
    expect(checkSlot([], av(), { start: at(9, "13:00"), end: at(9, "14:00") }, { now: NOW }).ok).toBe(true);
    expect(checkSlot([], av(), { start: at(9, "10:00"), end: at(9, "11:00") }, { now: NOW })).toMatchObject({ ok: false, problem: "notice" });
  });

  it("duração inválida", () => {
    expect(checkSlot([], av(), { start: at(10, "11:00"), end: at(10, "10:00") }, { now: NOW })).toMatchObject({ ok: false, problem: "invalid", nextFree: [] });
    expect(checkSlot([], av(), { start: at(10, "09:00"), end: at(12, "09:00") }, { now: NOW })).toMatchObject({ problem: "invalid" });
  });

  it("evento que atravessa a meia-noite: precisa de janelas coladas e conflita dos dois lados", () => {
    const night = av({
      weekly: [
        { weekday: 5, from: "20:00", to: "24:00" },
        { weekday: 6, from: "00:00", to: "02:00" },
      ],
    });
    // sexta 13/11 23:00 até sábado 14/11 01:00.
    expect(checkSlot([], night, { start: at(13, "23:00"), end: at(14, "01:00") }, { now: NOW }).ok).toBe(true);
    expect(checkSlot([], night, { start: at(13, "23:00"), end: at(14, "03:00") }, { now: NOW })).toMatchObject({ problem: "outside_availability" });
    const events = [ev(1, at(13, "22:00"), at(14, "00:30"))];
    expect(checkSlot(events, night, { start: at(14, "00:30"), end: at(14, "01:30") }, { now: NOW })).toMatchObject({ problem: "conflict" });
    expect(checkSlot(events, night, { start: at(14, "00:45"), end: at(14, "01:45") }, { now: NOW }).ok).toBe(true);
    // Sem as janelas coladas, atravessar a meia-noite não serve.
    const gap = av({
      weekly: [
        { weekday: 5, from: "20:00", to: "23:00" },
        { weekday: 6, from: "01:00", to: "02:00" },
      ],
    });
    expect(checkSlot([], gap, { start: at(13, "22:30"), end: at(14, "01:30") }, { now: NOW }).ok).toBe(false);
  });
});

describe("nextFreeSlots", () => {
  it("anda em passos de 15 min, sem sobrepor sugestões e pulando compromissos", () => {
    const events = [ev(1, at(10, "09:00"), at(10, "10:00")), ev(2, at(10, "11:00"), at(10, "11:30"))];
    const slots = nextFreeSlots(events, av(), { durationMs: 30 * 60_000, from: Date.parse(at(10, "08:00")), now: NOW });
    // 09:00 ocupado (+15 min de intervalo): 10:15 cabe; 10:45 bate no intervalo de 11:00; 11:45 serve.
    expect(slots.map((slot) => slot.start)).toEqual([utc(10, "10:15"), utc(10, "11:45"), utc(10, "12:15")]);
  });

  it("até o limite (until) e duração que cabe", () => {
    expect(nextFreeSlots([], av(), { durationMs: 3_600_000, from: Date.parse(at(10, "17:30")), now: NOW, until: Date.parse(at(10, "23:00")) })).toEqual([]);
    expect(nextFreeSlots([], av(), { durationMs: 10 * 3_600_000, now: NOW })).toEqual([]);
    expect(nextFreeSlots([], av({ weekly: [] }), { durationMs: 3_600_000, now: NOW })).toEqual([]);
  });

  it("respeita a antecedência mínima a partir de agora", () => {
    const [first] = nextFreeSlots([], av({ minNoticeMinutes: 120 }), { durationMs: 3_600_000, now: NOW });
    expect(first!.start).toBe(utc(9, "14:00"));
  });
});

describe("availabilityIntervals e schemas", () => {
  it("junta janelas coladas, inclusive de dias vizinhos", () => {
    const joined = availabilityIntervals(
      av({
        weekly: [
          { weekday: 1, from: "22:00", to: "24:00" },
          { weekday: 2, from: "00:00", to: "01:00" },
        ],
      }),
      Date.parse(at(9, "00:00")),
      Date.parse(at(10, "12:00")),
    );
    expect(joined).toContainEqual({ start: Date.parse(at(9, "22:00")), end: Date.parse(at(10, "01:00")) });
  });

  it("o body da disponibilidade confere janelas e exceções", () => {
    expect(availabilityBodySchema.safeParse({}).success).toBe(true);
    expect(availabilityBodySchema.safeParse({ weekly: [{ weekday: 1, from: "10:00", to: "09:00" }] }).success).toBe(false);
    expect(availabilityBodySchema.safeParse({ weekly: [{ weekday: 1, from: "10:00", to: "24:00" }] }).success).toBe(true);
    expect(availabilityBodySchema.safeParse({ exceptions: [{ date: "2026-11-11" }] }).success).toBe(false);
    expect(availabilityBodySchema.safeParse({ exceptions: [{ date: "2026-11-11", off: true }] }).success).toBe(true);
    expect(availabilityBodySchema.safeParse({ timezone: "Marte/Olimpo" }).success).toBe(false);
  });
});
