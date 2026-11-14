import { describe, expect, it } from "vitest";
import { useTempDirs } from "../dev/test-utils";
import { AgendaService } from "../platform/agenda/agenda-service";
import { agendaTools, parseAgendaInstant } from "./agenda-tools";
import type { McpTool } from "./protocol";

const tempDir = useTempDirs();
/** Segunda 9/11/2026, meio-dia em São Paulo; amanhã (terça 10/11) às 17h cabe na disponibilidade padrão. */
const NOW = new Date("2026-11-09T12:00:00-03:00");
const NAMES: Record<string, string> = { a: "Workspace A", b: "Workspace B" };

async function setup() {
  const agenda = await AgendaService.openAt(await tempDir(), () => NOW);
  const toolsFor = (workspace: string | "cyno") =>
    agendaTools({
      agenda,
      actor: workspace === "cyno" ? { kind: "cyno" } : { kind: "agente", workspace, name: `Maestro ${workspace}`, address: `${workspace}/maestro` },
      now: () => NOW,
      workspaceName: (id) => NAMES[id],
    });
  const run = async (tools: McpTool[], name: string, args: object) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`sem ferramenta ${name}`);
    return tool.call(tool.input.parse(args));
  };
  return { agenda, toolsFor, run };
}

describe("ferramentas agenda_*", () => {
  it("expõe o mesmo conjunto para o workspace e para o Cyno", async () => {
    const { toolsFor } = await setup();
    for (const who of ["a", "cyno"]) expect(toolsFor(who).map((tool) => tool.name).sort()).toEqual(["agenda_book", "agenda_cancel", "agenda_free_slots", "agenda_list", "agenda_move"]);
  });

  it("livre -> BOOKED; o mesmo horário em outro workspace -> NOT BOOKED com 3 horários livres válidos", async () => {
    const { agenda, toolsFor, run } = await setup();
    const booked = await run(toolsFor("a"), "agenda_book", { title: "Reunião sobre X", start: "2026-11-10T17:00", duration_minutes: 60, kind: "reuniao" });
    expect(booked.isError).toBeUndefined();
    expect(booked.text).toContain("BOOKED G-0001");
    expect(agenda.get("G-0001")).toMatchObject({ workspace: "a", start: "2026-11-10T20:00:00.000Z", end: "2026-11-10T21:00:00.000Z" });

    const refused = await run(toolsFor("b"), "agenda_book", { title: "Call", start: "2026-11-10T17:00", duration_minutes: 60 });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^NOT BOOKED/);
    // Não vaza o título do outro workspace.
    expect(refused.text).not.toContain("Reunião sobre X");
    expect(refused.text).toContain("another workspace");
    const suggested = [...refused.text.matchAll(/\d\) \w{3} (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}) to/g)].map((match) => match[1]!);
    expect(suggested).toHaveLength(3);
    expect(agenda.list()).toHaveLength(1);
    // Cada sugestão marca de verdade.
    for (const start of suggested) {
      const result = await run(toolsFor("b"), "agenda_book", { title: `Call ${start}`, start, duration_minutes: 60 });
      expect(result.text, start).toContain("BOOKED");
    }
  });

  it("sábado (fora da disponibilidade) é recusado com sugestões; antecedência e fim antes do início também", async () => {
    const { toolsFor, run } = await setup();
    const saturday = await run(toolsFor("a"), "agenda_book", { title: "Gravação", start: "2026-11-14T10:00", duration_minutes: 60 });
    expect(saturday.isError).toBe(true);
    expect(saturday.text).toContain("NOT BOOKED: it is outside the hours the owner marked as available");
    expect(saturday.text).toContain("2026-11-13T17:00");
    const soon = await run(toolsFor("a"), "agenda_book", { title: "Já", start: "2026-11-09T12:20", duration_minutes: 30 });
    expect(soon.text).toContain("too soon");
    const bad = await run(toolsFor("a"), "agenda_book", { title: "X", start: "2026-11-10T10:00", end: "2026-11-10T09:00" });
    expect(bad.text).toMatch(/^NOT BOOKED/);
    expect((await run(toolsFor("a"), "agenda_book", { title: "X", start: "amanhã 17h", duration_minutes: 60 })).text).toContain("not a valid start");
  });

  it("agenda_list: o workspace vê os dele com título e o resto como BUSY; o Cyno vê tudo", async () => {
    const { toolsFor, run } = await setup();
    await run(toolsFor("a"), "agenda_book", { title: "Segredo do A", start: "2026-11-10T10:00", duration_minutes: 60, link: "https://meet.example/a" });
    await run(toolsFor("b"), "agenda_book", { title: "Reunião do B", start: "2026-11-10T14:00", duration_minutes: 60 });
    const asB = (await run(toolsFor("b"), "agenda_list", { from: "2026-11-09", to: "2026-11-13" })).text;
    expect(asB).toContain("Reunião do B");
    expect(asB).toContain("yours");
    expect(asB).toContain("BUSY");
    expect(asB).not.toContain("Segredo do A");
    expect(asB).not.toContain("meet.example");
    expect(asB).toContain("Mon 09:00-18:00");
    const asCyno = (await run(toolsFor("cyno"), "agenda_list", { from: "2026-11-09", to: "2026-11-13" })).text;
    expect(asCyno).toContain("Segredo do A");
    expect(asCyno).toContain("Workspace A");
    expect(asCyno).toContain("Reunião do B");
    expect((await run(toolsFor("b"), "agenda_list", {})).text).toContain("Now: Mon 2026-11-09T12:00");
  });

  it("só cancela e move o que o próprio workspace criou (o Cyno, qualquer um)", async () => {
    const { agenda, toolsFor, run } = await setup();
    await run(toolsFor("a"), "agenda_book", { title: "Do A", start: "2026-11-10T10:00", duration_minutes: 60 });
    const denied = await run(toolsFor("b"), "agenda_cancel", { id: "G-0001" });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("another workspace");
    expect((await run(toolsFor("b"), "agenda_move", { id: "G-0001", start: "2026-11-10T15:00" })).isError).toBe(true);
    expect(agenda.get("G-0001")!.status).toBe("marcado");
    const moved = await run(toolsFor("a"), "agenda_move", { id: "G-0001", start: "2026-11-10T15:00" });
    expect(moved.text).toContain("MOVED G-0001");
    expect(agenda.get("G-0001")).toMatchObject({ start: "2026-11-10T18:00:00.000Z", end: "2026-11-10T19:00:00.000Z" });
    await run(toolsFor("b"), "agenda_book", { title: "Do B", start: "2026-11-10T10:00", duration_minutes: 60 });
    const clash = await run(toolsFor("a"), "agenda_move", { id: "G-0001", start: "2026-11-10T10:00" });
    expect(clash.text).toMatch(/^NOT MOVED/);
    expect(agenda.get("G-0001")!.start).toBe("2026-11-10T18:00:00.000Z");
    expect((await run(toolsFor("cyno"), "agenda_cancel", { id: "G-0002", reason: "pedido do dono" })).text).toContain("Cancelled G-0002");
    expect((await run(toolsFor("a"), "agenda_cancel", { id: "G-0001" })).text).toContain("Cancelled G-0001");
    expect((await run(toolsFor("a"), "agenda_cancel", { id: "G-0404" })).isError).toBe(true);
  });

  it("agenda_free_slots lista horários dentro da disponibilidade", async () => {
    const { toolsFor, run } = await setup();
    await run(toolsFor("a"), "agenda_book", { title: "X", start: "2026-11-10T09:00", duration_minutes: 60 });
    const text = (await run(toolsFor("b"), "agenda_free_slots", { from: "2026-11-10", to: "2026-11-10", duration_minutes: 60 })).text;
    expect(text).toContain("2026-11-10T10:15 to 11:15");
    expect(text).not.toContain("T09:00");
    expect(text).not.toMatch(/T(0[0-8]|18|19|2\d):/);
    expect((await run(toolsFor("b"), "agenda_free_slots", { from: "2026-11-14", to: "2026-11-15", duration_minutes: 60 })).text).toContain("No free");
  });

  it("parseAgendaInstant: sem deslocamento vale São Paulo; com deslocamento, o dele", () => {
    expect(new Date(parseAgendaInstant("2026-11-10T17:00")!).toISOString()).toBe("2026-11-10T20:00:00.000Z");
    expect(new Date(parseAgendaInstant("2026-11-10 17:00:30")!).toISOString()).toBe("2026-11-10T20:00:30.000Z");
    expect(new Date(parseAgendaInstant("2026-11-10T17:00Z")!).toISOString()).toBe("2026-11-10T17:00:00.000Z");
    expect(new Date(parseAgendaInstant("2026-11-10T17:00-0300")!).toISOString()).toBe("2026-11-10T20:00:00.000Z");
    expect(parseAgendaInstant("2026-11-10")).toBeUndefined();
    expect(parseAgendaInstant("2026-11-10T25:00")).toBeUndefined();
  });
});
