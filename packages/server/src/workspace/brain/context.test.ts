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
  await writeNote(dir, a.id, "nota-a.md", `# Nota A ${MARKERS.a}\n\nCORPO_A`);
  await writeNote(dir, b.id, "nota-b.md", `# Nota B ${MARKERS.b}\n\nCORPO_B`);
  await writeNote(dir, c.id, "nota-c.md", `# Nota C ${MARKERS.c}\n\nCORPO_C`);
  await writeNote(dir, "global", "nota-global.md", `# Nota global ${MARKERS.global}\n\nCORPO_GLOBAL`);
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
    // Só os títulos: o texto das notas não entra.
    expect(everything).not.toContain("CORPO_A");
    expect(everything).not.toContain("CORPO_B");
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
    expect(context.sources[0]!.omitted!.map((note) => note.file)).toEqual(["nota-a.md"]);
    expect(context.sources[0]!.notes.filter((note) => note.layer === "note")).toEqual([]);
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
    await writeNote(outroDir, oa.id, "nota.md", "# Outro A OUTRO_PRIVADO_A\n\nOUTRO_CORPO_A");
    await writeNote(outroDir, ob.id, "nota.md", "# Outro B OUTRO_PRIVADO_B\n\nOUTRO_CORPO_B");
    await writeNote(outroDir, "global", "nota.md", "# Outro global OUTRO_PRIVADO_GLOBAL\n\nOUTRO_CORPO_GLOBAL");
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
    await writeNote(outroDir, oa.id, "nota.md", "# Outro A OUTRO_PRIVADO_A\n\nOUTRO_CORPO_A");
    await writeNote(outroDir, "global", "nota.md", "# Outro global OUTRO_PRIVADO_GLOBAL\n\nOUTRO_CORPO_GLOBAL");
    await writeNote(dir, "sala-do-maestro", "plano.md", "# Plano PLANO_DO_MAESTRO\n\nCORPO_PLANO");
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
    // Dos quartos, o Maestro recebe o briefing e os títulos das notas (o texto, com read_note).
    expect(everything).toContain("BRIEFING_DE_A");
    for (const marker of [MARKERS.a, MARKERS.b, MARKERS.c]) expect(context.text).toContain(marker);
    for (const body of ["CORPO_A", "CORPO_B", "CORPO_C", "CORPO_PLANO"]) expect(everything).not.toContain(body);
    expect(everything).not.toContain("GIRASSOL-AZUL-42");
    expect(everything).toContain(MARKERS.global);
    expect(everything).toContain("PLANO_DO_MAESTRO");
    expect(everything).not.toMatch(/OUTRO_PRIVADO|OUTRO_BRIEFING/);

    // E a sala do outro workspace só vê o outro workspace.
    const outro = JSON.stringify(await getContext(app, "sala-do-maestro", "outro"));
    expect(outro).toContain("OUTRO_BRIEFING_A");
    expect(outro).toContain("OUTRO_PRIVADO_A");
    expect(outro).not.toContain("OUTRO_CORPO_A");
    expect(outro).toContain("OUTRO_PRIVADO_GLOBAL");
    expect(outro).not.toContain("PLANO_DO_MAESTRO");
    expect(outro).not.toContain("GIRASSOL-AZUL-42");
    for (const marker of Object.values(MARKERS)) expect(outro).not.toContain(marker);

    // Os outros quartos não passam a ver a sala do Maestro.
    expect(JSON.stringify(await getContext(app, a.id))).not.toContain("PLANO_DO_MAESTRO");
  });
});

describe("buildContext: só o que o time precisa seguir", () => {
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
  const ruleNote = (file: string, title: string, body: string, mtimeMs = Date.now()) => note(file, `---\ntipo: regra\ntags: [regra]\n---\n# ${title}\n\n${body}`, mtimeMs);
  const filler = (n: number) => `${"palavra comum de enchimento ".repeat(Math.ceil(n / 28))}`.slice(0, n);
  const build = (rooms: Room[], notes: Record<string, StoredNote[]>, roomId: string, query = "", agent?: { id: string; name: string }, agentRules: Record<string, string> = {}) =>
    buildContext({ rooms: () => rooms, readNotes: async (id) => notes[id] ?? [], readAgentRules: async (id) => agentRules[id] ?? "" }, roomId, query, agent);

  it("carrega _regras, as notas de regra e o _briefing; as outras notas e o _indice ficam de fora", async () => {
    const notes = [
      note("_regras.md", `# Regras\n\nREGRA_FIXA\n${filler(5000)}`),
      note("_briefing.md", "# Briefing\n\nBRIEFING_FIXO"),
      note("_indice.md", "# Índice\n\nINDICE_SECRETO [[paleta]]"),
      ruleNote("sem-emoji.md", "Sem emoji", "REGRA_SEM_EMOJI"),
      note("regra-tom.md", "# Regra: tom leve\n\nREGRA_DO_TITULO"),
      note("paleta.md", "# Paleta de cores\n\nCORPO_DA_PALETA"),
    ];
    const context = await build([room("a")], { a: notes }, "a", "ajuste a paleta");
    const self = context.sources[0]!;
    expect(self.notes.map((item) => item.file)).toEqual(["_regras.md", expect.any(String), expect.any(String), "_briefing.md"]);
    expect(self.notes.slice(1, 3).map((item) => item.file).sort()).toEqual(["regra-tom.md", "sem-emoji.md"]);
    expect(self.notes[0]!.truncated).toBe(true);
    expect(self.notes[0]!.content.length).toBeLessThanOrEqual(BRAIN_LIMITS.fixed.regras + 120);
    expect(context.text).toContain("REGRA_SEM_EMOJI");
    expect(context.text).toContain("REGRA_DO_TITULO");
    expect(context.text).toContain("BRIEFING_FIXO");
    expect(context.text).not.toContain("INDICE_SECRETO");
    expect(context.text).not.toContain("CORPO_DA_PALETA");
    // A nota comum aparece só como título + caminho.
    expect(context.text).toContain("## Notas do Cérebro (só os títulos");
    expect(context.text).toContain("- Paleta de cores — `a/paleta.md`");
    expect(self.omitted).toEqual([{ file: "paleta.md", title: "Paleta de cores" }]);
    expect(context.stats).toMatchObject({ included: 4, omitted: 1, chars: context.text.length });
  });

  it("a ordem é regras do agente, sala (regras, notas de regra, briefing), lobby, conectados", async () => {
    const rooms = [room("a", { readsGlobalBrain: true, readsBrainsOf: ["b"] }), room("b")];
    const notes = {
      a: [note("_regras.md", "# R\n\nREGRAS_A"), note("_briefing.md", "# B\n\nBRIEF_A"), ruleNote("r.md", "R", "NOTA_REGRA_A")],
      global: [note("_regras.md", "# R\n\nREGRAS_GLOBAL"), note("_briefing.md", "# B\n\nBRIEF_GLOBAL")],
      b: [note("_regras.md", "# R\n\nREGRAS_B"), note("_briefing.md", "# B\n\nBRIEF_B"), ruleNote("r.md", "R", "NOTA_REGRA_B"), note("_indice.md", "# I\n\nINDICE_B")],
    };
    const context = await build(rooms, notes, "a", "", { id: "clara", name: "Clara" }, { clara: "- Sempre cite a fonte." });
    expect(context.sources.map((source) => source.kind)).toEqual(["agent", "self", "lobby", "connected"]);
    const text = context.text;
    const order = ["## Suas regras (só para você, Clara)", "Sempre cite a fonte.", "REGRAS_A", "NOTA_REGRA_A", "BRIEF_A", "REGRAS_GLOBAL", "BRIEF_GLOBAL", "BRIEF_B"].map((part) => text.indexOf(part));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    // Sala conectada: só o briefing (nem regras, nem notas de regra, nem índice).
    for (const absent of ["REGRAS_B", "NOTA_REGRA_B", "INDICE_B"]) expect(text).not.toContain(absent);
    // Mas a nota de regra dela é um título na lista.
    expect(text).toContain("`b/r.md`");
  });

  it("as regras do agente entram só para ele, e só se houver conteúdo", async () => {
    const notes = { a: [note("_briefing.md", "# B\n\nBRIEF_A")] };
    const rules = { clara: "- Nunca use emojis.", eco: "   " };
    const clara = await build([room("a")], notes, "a", "", { id: "clara", name: "Clara" }, rules);
    expect(clara.sources[0]).toMatchObject({ kind: "agent", id: "clara", name: "Clara", notes: [{ file: "regras.md", title: "Suas regras", layer: "fixed", content: "- Nunca use emojis." }] });
    const eco = await build([room("a")], notes, "a", "", { id: "eco", name: "Eco" }, rules);
    expect(eco.sources.map((source) => source.kind)).toEqual(["self"]);
    expect(eco.text).not.toContain("Suas regras");
    const none = await build([room("a")], notes, "a", "", undefined, rules);
    expect(none.text).not.toContain("Nunca use emojis");
    const long = await build([room("a")], notes, "a", "", { id: "clara", name: "Clara" }, { clara: filler(BRAIN_LIMITS.agentRules + 500) });
    expect(long.sources[0]!.notes[0]!.truncated).toBe(true);
    expect(long.sources[0]!.notes[0]!.content.length).toBeLessThan(BRAIN_LIMITS.agentRules + 120);
  });

  it("orçamento das regras: cada nota é cortada no teto, o total é do quarto e depois do lobby, e o que não coube vira título (regra)", async () => {
    const rules = Array.from({ length: 10 }, (_, i) => ruleNote(`regra-${i}.md`, `Regra ${i}`, filler(BRAIN_LIMITS.ruleNote + 400), 1_000_000 + i));
    const lobbyRule = ruleNote("global-regra.md", "Regra global", "REGRA_GLOBAL_CURTA");
    const rooms = [room("a", { readsGlobalBrain: true })];
    const context = await build(rooms, { a: rules, global: [lobbyRule] }, "a");
    const loadedRules = context.sources[0]!.notes.filter((item) => item.layer === "note");
    expect(loadedRules.every((item) => item.content.length <= BRAIN_LIMITS.ruleNote + 120)).toBe(true);
    expect(loadedRules.every((item) => item.truncated)).toBe(true);
    expect(loadedRules.reduce((sum, item) => sum + item.content.length, 0)).toBeLessThanOrEqual(BRAIN_LIMITS.rulesTotal);
    // Mais novas primeiro.
    expect(loadedRules[0]!.file).toBe("regra-9.md");
    const left = context.sources[0]!.omitted!;
    expect(left.length).toBe(10 - loadedRules.length);
    expect(left.length).toBeGreaterThan(0);
    // O orçamento é um só: o lobby só entra se sobrar espaço.
    expect(context.text.includes("REGRA_GLOBAL_CURTA")).toBe(context.sources[1]!.notes.some((item) => item.file === "global-regra.md"));
    // As que ficaram de fora vêm primeiro na lista, marcadas.
    const titleLines = context.text.split("## Notas do Cérebro")[1]!.split("\n").filter((line) => line.startsWith("- "));
    expect(titleLines[0]).toMatch(/\(regra\)$/);
  });

  it("a lista de títulos tem teto (+N) e vai por relevância; sem consulta, as mais recentes primeiro", async () => {
    const many = Array.from({ length: 45 }, (_, i) => note(`assunto-${i}.md`, `# Assunto ${i}\n\n${filler(300)}`, 1_000_000 + i));
    const special = note("paleta-de-cores.md", "# Paleta de cores do site\n\nazul", 1);
    const withQuery = await build([room("a")], { a: [...many, special] }, "a", "ajuste a paleta de cores");
    const lines = withQuery.text.split("## Notas do Cérebro")[1]!.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(BRAIN_LIMITS.titles + 1);
    expect(lines[0]).toBe("- Paleta de cores do site — `a/paleta-de-cores.md`");
    expect(lines.at(-1)).toBe("- … e mais 16 (use `search_notes`)");
    expect(withQuery.sources[0]!.omitted).toHaveLength(46);

    const recent = await build([room("a")], { a: many }, "a");
    const first = recent.text.split("## Notas do Cérebro")[1]!.split("\n").filter((line) => line.startsWith("- "))[0];
    expect(first).toBe("- Assunto 44 — `a/assunto-44.md`");
  });

  it("o histórico nunca entra e não há lista quando não há notas", async () => {
    const context = await build([room("a")], { a: [note("_briefing.md", "# B\n\nBRIEF")] }, "a");
    expect(context.text).not.toContain("## Notas do Cérebro");
    expect(context.text).toContain("Aqui entram só as regras e o briefing");
  });

  it("quartos conectados mandam só o briefing; as notas deles viram títulos", async () => {
    const rooms = [room("a", { readsBrainsOf: ["b"] }), room("b")];
    const notes = {
      b: [note("_regras.md", "# Regras de B\n\nREGRAS_DE_B"), note("_briefing.md", "# B\n\nBRIEFING_DE_B"), note("prazo.md", "# Prazo da entrega\n\nPRAZO_DE_B")],
    };
    const context = await build(rooms, notes, "a", "qual o prazo?");
    expect(context.text).toContain("BRIEFING_DE_B");
    expect(context.text).toContain("- Prazo da entrega — `b/prazo.md`");
    expect(context.text).not.toContain("PRAZO_DE_B");
    expect(context.text).not.toContain("REGRAS_DE_B");
  });

  it("a Sala do Maestro: briefing de cada quarto e títulos das notas deles, sem regras nem índice dos quartos", async () => {
    const rooms = [room("sala-maestro", { kind: "maestro" }), room("a"), room("b")];
    const notes = {
      "sala-maestro": [note("_regras.md", "# R\n\nREGRAS_MAESTRO")],
      a: [note("_regras.md", "# R\n\nREGRAS_A"), note("_briefing.md", "# B\n\nBRIEF_A"), note("_indice.md", "# I\n\nINDICE_A"), note("doc-a.md", "# Doc de A\n\nCORPO_A"), ruleNote("regra-a.md", "Regra de A", "CORPO_REGRA_A")],
      b: [note("_briefing.md", "# B\n\nBRIEF_B")],
    };
    const context = await build(rooms, notes, "sala-maestro");
    expect(context.sources.map((source) => source.kind)).toEqual(["self", "managed", "managed"]);
    expect(context.text).toContain("REGRAS_MAESTRO");
    expect(context.text).toContain("BRIEF_A");
    expect(context.text).toContain("BRIEF_B");
    expect(context.text).toContain("- Doc de A — `a/doc-a.md`");
    expect(context.text).toContain("- Regra de A — `a/regra-a.md`");
    for (const absent of ["REGRAS_A", "INDICE_A", "CORPO_A", "CORPO_REGRA_A"]) expect(context.text).not.toContain(absent);
  });
});
