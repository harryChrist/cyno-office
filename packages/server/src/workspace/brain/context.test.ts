import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrainContext, Room } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { useTestApp, type TestApp } from "../../dev/test-app";
import { buildContext } from "./context";
import { BRAIN_LIMITS } from "./limits";
import { noteTitle, type StoredNote } from "./notes";

const setupApp = useTestApp();

/** Marcadores únicos: se um deles aparece no contexto, a nota daquele Cérebro vazou. */
const MARKERS = { a: "SEGREDO_A", b: "SEGREDO_B", c: "SEGREDO_C", global: "SEGREDO_GLOBAL" } as const;

async function createRoom(app: TestApp["app"], name: string, ws = "principal"): Promise<Room> {
  const response = await app.inject({ method: "POST", url: `/api/w/${ws}/rooms`, payload: { name, theme: "sand" } });
  expect(response.statusCode).toBe(201);
  return response.json<Room>();
}

async function setSharing(app: TestApp["app"], id: string, body: object, ws = "principal"): Promise<void> {
  const response = await app.inject({ method: "PATCH", url: `/api/w/${ws}/rooms/${id}/brain-sharing`, payload: body });
  expect(response.statusCode).toBe(200);
}

async function getContext(app: TestApp["app"], id: string, ws = "principal"): Promise<BrainContext> {
  const response = await app.inject({ method: "GET", url: `/api/w/${ws}/rooms/${id}/context` });
  expect(response.statusCode).toBe(200);
  return response.json<BrainContext>();
}

async function writeNote(dir: string, brainId: string, file: string, content: string): Promise<void> {
  await mkdir(path.join(dir, "brains", brainId), { recursive: true });
  await writeFile(path.join(dir, "brains", brainId, file), content);
}

/** Quartos A, B e C com notas marcadas; A lê B e não lê o global; B lê A e C. */
async function setup() {
  const testApp = await setupApp();
  const { app, dir } = testApp;
  const [a, b, c] = [await createRoom(app, "A"), await createRoom(app, "B"), await createRoom(app, "C")];
  await writeNote(dir, a.id, "nota-a.md", `# Nota A\n\n${MARKERS.a}`);
  await writeNote(dir, b.id, "nota-b.md", `# Nota B\n\n${MARKERS.b}`);
  await writeNote(dir, c.id, "nota-c.md", `# Nota C\n\n${MARKERS.c}`);
  await writeNote(dir, "global", "nota-global.md", `# Nota global\n\n${MARKERS.global}`);
  await setSharing(app, a.id, { readsBrainsOf: [b.id], readsGlobalBrain: false });
  await setSharing(app, b.id, { readsBrainsOf: [a.id, c.id] });
  return { ...testApp, a, b, c };
}

const visibleIds = (context: BrainContext) => context.sources.map((source) => `${source.kind}:${source.id}`);

describe("buildContext: isolamento entre Cérebros", () => {
  it("A lendo B e sem o global: vê A e B; nunca o global nem C", async () => {
    const { app, a, b } = await setup();
    const context = await getContext(app, a.id);
    expect(visibleIds(context)).toEqual([`self:${a.id}`, `connected:${b.id}`]);

    const everything = JSON.stringify(context);
    expect(everything).toContain(MARKERS.a);
    expect(everything).toContain(MARKERS.b);
    expect(everything).not.toContain(MARKERS.c);
    expect(everything).not.toContain(MARKERS.global);
    expect(context.text).toContain(MARKERS.b);
  });

  it("não é transitivo: B lendo C não faz A ver C", async () => {
    const { app, a, b, c } = await setup();
    const fromB = await getContext(app, b.id);
    expect(visibleIds(fromB)).toEqual([`self:${b.id}`, `connected:${a.id}`, `connected:${c.id}`]);
    expect(JSON.stringify(fromB)).toContain(MARKERS.c);

    const fromA = JSON.stringify(await getContext(app, a.id));
    expect(fromA).not.toContain(MARKERS.c);
    expect(fromA).not.toContain(`"${c.id}"`);
  });

  it("ligar \"Lê o Cérebro global\" inclui o Cérebro global", async () => {
    const { app, a } = await setup();
    await setSharing(app, a.id, { readsGlobalBrain: true });
    const context = await getContext(app, a.id);
    expect(context.sources.map((source) => source.kind)).toEqual(["self", "lobby", "connected"]);
    expect(JSON.stringify(context)).toContain(MARKERS.global);
    expect(JSON.stringify(context)).not.toContain(MARKERS.c);
  });

  it("tirar B da lista de A faz B sumir do contexto de A (B continua lendo A: não é simétrico)", async () => {
    const { app, a, b } = await setup();
    await setSharing(app, a.id, { readsBrainsOf: [] });
    const fromA = await getContext(app, a.id);
    expect(visibleIds(fromA)).toEqual([`self:${a.id}`]);
    expect(JSON.stringify(fromA)).not.toContain(MARKERS.b);
    const fromB = JSON.stringify(await getContext(app, b.id));
    expect(fromB).toContain(MARKERS.a);
  });

  it("vale só a configuração do Cérebro, não as portas nem a vizinhança no grid", async () => {
    const { app, a, c } = await setup();
    // A e C não são vizinhos (há B entre eles) e nunca houve porta configurada entre eles.
    await setSharing(app, c.id, { readsBrainsOf: [a.id], readsGlobalBrain: true });
    const fromC = await getContext(app, c.id);
    expect(visibleIds(fromC)).toEqual([`self:${c.id}`, "lobby:global", `connected:${a.id}`]);
    expect(JSON.stringify(fromC)).toContain(MARKERS.a);
    expect(JSON.stringify(fromC)).not.toContain(MARKERS.b);
  });

  it("quarto inexistente -> erro 404", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "GET", url: "/api/w/principal/rooms/nao-existe/context" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Sala "nao-existe" não encontrada' });
  });

  it("rejeita ids de path traversal e reservados", async () => {
    const { app } = await setup();
    for (const id of ["..%2F..%2Fetc", "global", "lobby", "A"]) {
      const response = await app.inject({ method: "GET", url: `/api/w/principal/rooms/${id}/context` });
      expect([400, 404]).toContain(response.statusCode);
      expect(JSON.stringify(response.json())).not.toContain(MARKERS.global);
    }
  });

  it("só lê arquivos .md comuns (ignora outras extensões, ocultos e links simbólicos)", async () => {
    const { app, dir, a, c } = await setup();
    const brainA = path.join(dir, "brains", a.id);
    await writeFile(path.join(brainA, "dados.txt"), MARKERS.c);
    await writeFile(path.join(brainA, ".oculta.md"), MARKERS.c);
    await symlink(path.join(dir, "brains", c.id, "nota-c.md"), path.join(brainA, "atalho.md"));
    await mkdir(path.join(brainA, "sub.md"));
    const context = await getContext(app, a.id);
    expect(context.sources[0]!.notes.filter((note) => note.layer === "note").map((note) => note.file)).toEqual(["nota-a.md"]);
    expect(JSON.stringify(context)).not.toContain(MARKERS.c);
  });

  it("seed: ProjetoX não vê a nota confidencial do ProjetoY", async () => {
    const { app } = await setupApp();
    const context = await getContext(app, "projetox");
    expect(visibleIds(context)).toEqual(["self:projetox", "lobby:global"]);
    expect(JSON.stringify(context)).not.toContain("GIRASSOL-AZUL-42");
  });
});

describe("buildContext: isolamento entre workspaces", () => {
  it("não vaza entre workspaces, nem com quartos de mesmo id e Cérebro global", async () => {
    const testApp = await setup();
    const { app, dataDir, a, b } = testApp;
    const create = await app.inject({ method: "POST", url: "/api/workspaces", payload: { name: "Outro" } });
    expect(create.statusCode).toBe(201);
    const outroDir = path.join(dataDir, "workspaces", "outro");

    // Quartos com os mesmos ids (a, b) no outro workspace, lendo o global e um ao outro.
    const [oa, ob] = [await createRoom(app, "A", "outro"), await createRoom(app, "B", "outro")];
    expect([oa.id, ob.id]).toEqual([a.id, b.id]);
    await writeNote(outroDir, oa.id, "nota.md", "# Outro A\n\nOUTRO_PRIVADO_A");
    await writeNote(outroDir, ob.id, "nota.md", "# Outro B\n\nOUTRO_PRIVADO_B");
    await writeNote(outroDir, "global", "nota.md", "# Outro global\n\nOUTRO_PRIVADO_GLOBAL");
    await setSharing(app, oa.id, { readsBrainsOf: [ob.id], readsGlobalBrain: true }, "outro");
    await setSharing(app, a.id, { readsGlobalBrain: true });

    const principal = JSON.stringify(await getContext(app, a.id));
    expect(principal).toContain(MARKERS.a);
    expect(principal).toContain(MARKERS.global);
    expect(principal).not.toMatch(/OUTRO_PRIVADO/);

    const outro = JSON.stringify(await getContext(app, oa.id, "outro"));
    expect(outro).toContain("OUTRO_PRIVADO_A");
    expect(outro).toContain("OUTRO_PRIVADO_B");
    expect(outro).toContain("OUTRO_PRIVADO_GLOBAL");
    for (const marker of Object.values(MARKERS)) expect(outro).not.toContain(marker);

    // Um quarto que só existe no principal é 404 no outro.
    const response = await app.inject({ method: "GET", url: "/api/w/outro/rooms/c/context" });
    expect(response.statusCode).toBe(404);
    });

  it("a Sala do Maestro vê todos os quartos do mesmo workspace, mas nunca os de outro", async () => {
    const testApp = await setup();
    const { app, dir, dataDir, a, b, c } = testApp;
    const create = await app.inject({ method: "POST", url: "/api/workspaces", payload: { name: "Outro" } });
    expect(create.statusCode).toBe(201);
    const outroDir = path.join(dataDir, "workspaces", "outro");
    const oa = await createRoom(app, "A", "outro");
    await writeNote(outroDir, oa.id, "nota.md", "# Outro A\n\nOUTRO_PRIVADO_A");
    await writeNote(outroDir, "global", "nota.md", "# Outro global\n\nOUTRO_PRIVADO_GLOBAL");
    await writeNote(dir, "sala-do-maestro", "plano.md", "# Plano\n\nPLANO_DO_MAESTRO");
    await writeNote(dir, a.id, "_briefing.md", "# Briefing — A\n\nBRIEFING_DE_A");
    await writeNote(outroDir, oa.id, "_briefing.md", "# Briefing — Outro A\n\nOUTRO_BRIEFING_A");

    const context = await getContext(app, "sala-do-maestro");
    // O seed tem projetox e projetoy; o setup criou A, B e C (sem conexão com a sala).
    expect(visibleIds(context)).toEqual([
      "self:sala-do-maestro",
      "lobby:global",
      "managed:projetox",
      "managed:projetoy",
      `managed:${a.id}`,
      `managed:${b.id}`,
      `managed:${c.id}`,
    ]);
    const everything = JSON.stringify(context);
    // Dos quartos, o Maestro recebe só o briefing e o índice (as notas ele busca com search_notes).
    expect(everything).toContain("BRIEFING_DE_A");
    for (const marker of [MARKERS.a, MARKERS.b, MARKERS.c]) expect(everything).not.toContain(marker);
    expect(everything).not.toContain("GIRASSOL-AZUL-42");
    expect(everything).toContain(MARKERS.global);
    expect(everything).toContain("PLANO_DO_MAESTRO");
    expect(everything).not.toMatch(/OUTRO_PRIVADO|OUTRO_BRIEFING/);

    // E a sala do outro workspace só vê o outro workspace.
    const outro = JSON.stringify(await getContext(app, "sala-do-maestro", "outro"));
    expect(outro).toContain("OUTRO_BRIEFING_A");
    expect(outro).not.toContain("OUTRO_PRIVADO_A");
    expect(outro).toContain("OUTRO_PRIVADO_GLOBAL");
    expect(outro).not.toContain("PLANO_DO_MAESTRO");
    expect(outro).not.toContain("GIRASSOL-AZUL-42");
    for (const marker of Object.values(MARKERS)) expect(outro).not.toContain(marker);

    // Os outros quartos não passam a ver a sala do Maestro.
    expect(JSON.stringify(await getContext(app, a.id))).not.toContain("PLANO_DO_MAESTRO");
  });
});

describe("buildContext: camadas, relevância e orçamento", () => {
  const room = (id: string, extra: Partial<Room> = {}): Room => ({
    id,
    kind: "team",
    name: id.toUpperCase(),
    theme: "sand",
    gridPosition: { x: 0, y: 0 },
    readsGlobalBrain: false,
    readsBrainsOf: [],
    ...extra,
  });
  const note = (file: string, content: string, mtimeMs = Date.now()): StoredNote => ({
    file,
    title: noteTitle(file, content),
    content,
    layer: file.startsWith("_") ? "fixed" : "note",
    mtimeMs,
  });
  const filler = (n: number) => `${"palavra comum de enchimento ".repeat(Math.ceil(n / 28))}`.slice(0, n);
  const build = (rooms: Room[], notes: Record<string, StoredNote[]>, roomId: string, query = "") =>
    buildContext({ rooms: () => rooms, readNotes: async (id) => notes[id] ?? [] }, roomId, query);

  it("fixos sempre entram (com teto), notas curtas por relevância até o orçamento, o resto vira lista de títulos", async () => {
    const notes = [
      note("_regras.md", `# Regras\n\nREGRA_FIXA\n${filler(5000)}`),
      note("_briefing.md", "# Briefing\n\nBRIEFING_FIXO"),
      note("_indice.md", "# Índice\n\n- [[paleta-de-cores]]"),
      ...Array.from({ length: 20 }, (_, i) => note(`assunto-${i}.md`, `# Assunto ${i}\n\n${filler(1500)}`)),
      note("paleta-de-cores.md", `# Paleta de cores do site\n\nPALETA_ESCOLHIDA azul e laranja.\n${filler(800)}`, Date.now() - 400 * 86_400_000),
      note("grande.md", `# Decisão técnica do backend\n\nINICIO_GRANDE ${filler(6000)}`),
    ];
    const context = await build([room("a")], { a: notes }, "a", "Ajuste a paleta de cores e a decisao tecnica");
    const self = context.sources[0]!;
    expect(self.notes.slice(0, 3).map((item) => item.file)).toEqual(["_regras.md", "_briefing.md", "_indice.md"]);
    expect(self.notes[0]!.content.length).toBeLessThanOrEqual(BRAIN_LIMITS.fixed.regras + 120);
    expect(self.notes[0]!.truncated).toBe(true);
    // As duas relevantes entram primeiro (a paleta é velha, mas o título casa; "decisao" casa com "Decisão" sem acento).
    expect(self.notes.slice(3, 5).map((item) => item.file).sort()).toEqual(["grande.md", "paleta-de-cores.md"]);
    const big = self.notes.find((item) => item.file === "grande.md")!;
    expect(big.truncated).toBe(true);
    expect(big.content).toContain('read_note("a/grande.md")');
    expect(big.content.length).toBeLessThan(BRAIN_LIMITS.note + 100);
    // Orçamento: as notas curtas somadas não passam do total; o que sobrou aparece só como título.
    const notesChars = self.notes.filter((item) => item.layer === "note").reduce((sum, item) => sum + item.content.length, 0);
    expect(notesChars).toBeLessThanOrEqual(BRAIN_LIMITS.notesTotal);
    expect(self.omitted!.length).toBeGreaterThan(5);
    expect(context.text).toContain("## Também existem");
    expect(context.text).toContain("`a/assunto-");
    expect(context.text).toContain("PALETA_ESCOLHIDA");
    expect(context.stats).toMatchObject({ included: self.notes.length, omitted: self.omitted!.length, chars: context.text.length });
    expect(context.text.length).toBeLessThan(BRAIN_LIMITS.notesTotal + 9000);
  });

  it("o histórico nunca entra (readNotes só lê a raiz), e sem consulta valem as mais recentes", async () => {
    const old = note("velha.md", "# Velha\n\nNOTA_VELHA", Date.now() - 100 * 86_400_000);
    const recent = note("nova.md", "# Nova\n\nNOTA_NOVA");
    const context = await build([room("a")], { a: [old, recent] }, "a");
    expect(context.sources[0]!.notes.map((item) => item.file)).toEqual(["nova.md", "velha.md"]);
  });

  it("quartos conectados mandam só briefing e índice; as notas curtas deles concorrem pela relevância", async () => {
    const rooms = [room("a", { readsBrainsOf: ["b"] }), room("b")];
    const notes = {
      b: [note("_regras.md", "# Regras de B\n\nREGRAS_DE_B"), note("_briefing.md", "# B\n\nBRIEFING_DE_B"), note("prazo.md", "# Prazo da entrega\n\nPRAZO_DE_B")],
    };
    const context = await build(rooms, notes, "a", "qual o prazo?");
    expect(context.text).toContain("BRIEFING_DE_B");
    expect(context.text).toContain("PRAZO_DE_B");
    expect(context.text).not.toContain("REGRAS_DE_B");
  });
});
