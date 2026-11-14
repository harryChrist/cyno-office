import { readFile } from "node:fs/promises";
import path from "node:path";
import { availabilitySchema, type AgendaServerEvent } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { AgendaService, type AgendaActor } from "./agenda-service";

const tempDir = useTempDirs();
/** Segunda 9/11/2026, meio-dia em São Paulo. */
const NOW = new Date("2026-11-09T12:00:00-03:00");
const at = (day: number, time: string) => `2026-11-${String(day).padStart(2, "0")}T${time}:00-03:00`;
const agente = (workspace: string): AgendaActor => ({ kind: "agente", workspace, name: `Maestro ${workspace}`, address: `${workspace}/maestro` });
const OWNER: AgendaActor = { kind: "dono" };

async function open() {
  const dir = await tempDir();
  return { dir, agenda: await AgendaService.openAt(dir, () => NOW) };
}

describe("AgendaService", () => {
  it("marca, grava em platform/agenda/events.json e publica agenda:upserted", async () => {
    const { dir, agenda } = await open();
    const events: AgendaServerEvent[] = [];
    agenda.subscribe((event) => events.push(event));
    const outcome = await agenda.book({ title: "Reunião X", start: at(10, "17:00"), end: at(10, "18:00"), kind: "reuniao", link: "https://meet.example/x" }, agente("linkedin"));
    expect(outcome).toMatchObject({ ok: true, event: { id: "G-0001", workspace: "linkedin", by: { kind: "agente", address: "linkedin/maestro" }, status: "marcado", source: "local" } });
    expect(events).toEqual([expect.objectContaining({ type: "agenda:upserted", event: expect.objectContaining({ id: "G-0001" }) })]);
    await agenda.idle();
    const file = JSON.parse(await readFile(path.join(dir, "platform", "agenda", "events.json"), "utf8")) as { events: { id: string }[] };
    expect(file.events.map((event) => event.id)).toEqual(["G-0001"]);
    // Reabrir lê de volta e o próximo id continua.
    const again = await AgendaService.openAt(dir, () => NOW);
    expect(again.list().map((event) => event.id)).toEqual(["G-0001"]);
    const second = await again.book({ title: "Outra", start: at(11, "10:00"), end: at(11, "11:00") }, OWNER);
    expect(second).toMatchObject({ ok: true, event: { id: "G-0002", by: { kind: "dono" } } });
  });

  it("choque entre workspaces: o segundo é recusado com 3 sugestões, sem gravar; só o dono sobrepõe", async () => {
    const { agenda } = await open();
    await agenda.book({ title: "Reunião X", start: at(10, "17:00"), end: at(10, "18:00") }, agente("a"));
    const refused = await agenda.book({ title: "Call", start: at(10, "17:00"), end: at(10, "18:00") }, agente("b"));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.check.problem).toBe("conflict");
    expect(refused.check.nextFree).toHaveLength(3);
    expect(agenda.list()).toHaveLength(1);
    // "override" de um agente é ignorado (a IA não força).
    const forced = await agenda.book({ title: "Call", start: at(10, "17:00"), end: at(10, "18:00") }, agente("b"), { override: true });
    expect(forced.ok).toBe(false);
    // O dono, pela tela, marca por cima.
    const owner = await agenda.book({ title: "Call", start: at(10, "17:00"), end: at(10, "18:00") }, OWNER, { override: true });
    expect(owner.ok).toBe(true);
    expect(agenda.list()).toHaveLength(2);
  });

  it("dois pedidos simultâneos para o mesmo horário: só um é marcado", async () => {
    const { agenda } = await open();
    const [a, b] = await Promise.all([
      agenda.book({ title: "A", start: at(10, "10:00"), end: at(10, "11:00") }, agente("a")),
      agenda.book({ title: "B", start: at(10, "10:00"), end: at(10, "11:00") }, agente("b")),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it("mover: mesma conferência (ignora o próprio), guarda movedFrom; agente só mexe no que o workspace criou", async () => {
    const { agenda } = await open();
    await agenda.book({ title: "A", start: at(10, "10:00"), end: at(10, "11:00") }, agente("a"));
    await agenda.book({ title: "B", start: at(10, "14:00"), end: at(10, "15:00") }, agente("b"));
    const moved = await agenda.change("G-0001", { start: at(10, "10:30"), end: at(10, "11:30") }, agente("a"));
    expect(moved).toMatchObject({ ok: true, event: { movedFrom: new Date(at(10, "10:00")).toISOString() } });
    const clash = await agenda.change("G-0001", { start: at(10, "14:00"), end: at(10, "15:00") }, agente("a"));
    expect(clash.ok).toBe(false);
    expect(agenda.get("G-0001")!.start).toBe(new Date(at(10, "10:30")).toISOString());
    await expect(agenda.change("G-0002", { start: at(11, "10:00"), end: at(11, "11:00") }, agente("a"))).rejects.toMatchObject({ statusCode: 403 });
    await expect(agenda.cancel("G-0002", agente("a"))).rejects.toMatchObject({ statusCode: 403 });
    // O dono e o Cyno mexem em qualquer um; renomear não passa pela conferência de choque.
    expect(await agenda.change("G-0002", { title: "B renomeado" }, OWNER)).toMatchObject({ ok: true, event: { title: "B renomeado" } });
    expect(await agenda.change("G-0002", { start: at(11, "10:00"), end: at(11, "11:00") }, { kind: "cyno" })).toMatchObject({ ok: true });
    await expect(agenda.change("G-9999", { title: "x" }, OWNER)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("cancelar libera o horário, fica na lista só com `cancelled` e não pode mais ser movido", async () => {
    const { agenda } = await open();
    await agenda.book({ title: "A", start: at(10, "10:00"), end: at(10, "11:00") }, agente("a"));
    const cancelled = await agenda.cancel("G-0001", agente("a"), "cliente desmarcou");
    expect(cancelled).toMatchObject({ status: "cancelado", cancelReason: "cliente desmarcou" });
    expect(agenda.list()).toEqual([]);
    expect(agenda.list({ cancelled: true })).toHaveLength(1);
    expect((await agenda.book({ title: "B", start: at(10, "10:00"), end: at(10, "11:00") }, agente("b"))).ok).toBe(true);
    await expect(agenda.change("G-0001", { title: "x" }, OWNER)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("lista por período (eventos que atravessam o limite entram) e a disponibilidade persiste", async () => {
    const { dir, agenda } = await open();
    await agenda.book({ title: "Noite", start: at(10, "09:00"), end: at(10, "10:00") }, OWNER, { override: true });
    await agenda.book({ title: "Virada", start: at(10, "23:30"), end: at(11, "00:30") }, OWNER, { override: true });
    expect(agenda.list({ from: Date.parse(at(11, "00:00")), to: Date.parse(at(12, "00:00")) }).map((event) => event.title)).toEqual(["Virada"]);
    const events: AgendaServerEvent[] = [];
    agenda.subscribe((event) => events.push(event));
    await agenda.setAvailability(availabilitySchema.parse({ weekly: [{ weekday: 6, from: "10:00", to: "12:00" }], bufferMinutes: 0 }));
    expect(events).toEqual([expect.objectContaining({ type: "agenda:availability" })]);
    const again = await AgendaService.openAt(dir, () => NOW);
    expect(again.getAvailability()).toMatchObject({ weekly: [{ weekday: 6, from: "10:00", to: "12:00" }], bufferMinutes: 0 });
  });
});
