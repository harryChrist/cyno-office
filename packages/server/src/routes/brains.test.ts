import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApiErrorBody, BrainNoteResponse, ListBrainsResponse } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, createRoom, createTask, createWorkspace, soloTeam } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";
import { rootPaths } from "../store/paths";

const setupApp = useTestApp();
const API = "/api/w/principal";

const listBrains = (app: Parameters<typeof call>[0], ws = "principal") => call<ListBrainsResponse>(app, "GET", `/api/w/${ws}/brains`);

describe("API: GET /brains", () => {
  it("lista lobby, Sala do Maestro e os quartos, com nome, tipo e resumo das notas", async () => {
    const { app } = await setupApp();
    const brains = await listBrains(app);
    expect(brains.map((brain) => [brain.id, brain.kind, brain.name])).toEqual([
      ["global", "lobby", "Lobby"],
      ["sala-do-maestro", "maestro", "Sala do Maestro"],
      ["projetox", "team", "ProjetoX"],
      ["projetoy", "team", "ProjetoY"],
    ]);
    const global = brains[0]!;
    // Fixas no topo (regras, briefing, índice), depois as notas curtas.
    expect(global.notes.slice(0, 3).map((note) => [note.file, note.layer])).toEqual([
      ["_regras.md", "fixed"],
      ["_briefing.md", "fixed"],
      ["_indice.md", "fixed"],
    ]);
    expect(global.notes.filter((note) => note.layer === "note").map((note) => note.file).sort()).toEqual(["aprendizados.md", "preferencias.md"]);
    const preferencias = global.notes.find((note) => note.file === "preferencias.md")!;
    expect(preferencias).toMatchObject({ title: "Preferências do usuário", tags: [] });
    expect(preferencias.excerpt).toMatch(/^Escreve em português do Brasil/);
    expect(preferencias.excerpt.length).toBeLessThanOrEqual(160);
    expect(preferencias.date).not.toBeNull();
    expect(brains[1]!.notes.map((note) => note.layer)).toEqual(["fixed", "fixed", "fixed"]);
  });

  it("o resultado de uma tarefa concluída vai para o histórico (depois das notas), com data e tags do frontmatter", async () => {
    const { app, log } = await setupApp();
    const { room, team } = await soloTeam(app);
    await writeFile(path.join((await setupBrainDir(app, room.id)), "antiga.md"), "---\ndata: 2001-01-01\n---\n# Antiga\n\nvelha");
    const task = await createTask(app, room.id, team.id, "Escrever o resumo da semana");
    await log.waitForTask(task.id, "done");

    const brain = (await listBrains(app)).find((candidate) => candidate.id === room.id)!;
    const notes = brain.notes.filter((note) => note.layer !== "fixed");
    expect(notes.map((note) => [note.title, note.layer])).toEqual([
      ["Antiga", "note"],
      ["Escrever o resumo da semana", "history"],
    ]);
    const result = notes[1]!;
    expect(result.file).toMatch(/^historico\/\d{4}-\d{2}-\d{2}-\d{6}-escrever-o-resumo-da-semana\.md$/);
    expect(result).toMatchObject({ tags: ["agent-office", "tarefa"] });
    expect(result.excerpt).toMatch(/^Agente:/);
    expect(notes[0]!.date).toBe(new Date("2001-01-01").toISOString());

    // A nota do histórico abre pelo caminho com a barra codificada; nada fora da pasta.
    const opened = await call<BrainNoteResponse>(app, "GET", `${API}/brains/${room.id}/notes/${encodeURIComponent(result.file)}`);
    expect(opened.title).toBe("Escrever o resumo da semana");
    for (const bad of ["historico%2F..%2F..%2Foffice.json", "historico%2Fsub%2Fx.md", "..%2Fglobal%2Fpreferencias.md"]) {
      await call(app, "GET", `${API}/brains/${room.id}/notes/${bad}`, undefined, 404);
    }
  });

  it("um quarto novo aparece com o Cérebro vazio; quarto removido some da lista", async () => {
    const { app } = await setupApp();
    const room = await createRoom(app, "Laboratório");
    const created = (await listBrains(app)).find((brain) => brain.id === room.id)!;
    expect(created.kind).toBe("team");
    expect(created.notes.map((note) => note.file)).toEqual(["_regras.md", "_briefing.md", "_indice.md"]);
    await call(app, "DELETE", `${API}/rooms/projetoy`);
    expect((await listBrains(app)).some((brain) => brain.id === "projetoy")).toBe(false);
    await call(app, "GET", `${API}/brains/projetoy/notes/briefing.md`, undefined, 404);
  });
});

async function setupBrainDir(app: Parameters<typeof call>[0], brainId: string, ws = "principal"): Promise<string> {
  const dir = app.workspaces.get(ws).store.paths.brainDir(brainId);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("API: GET /brains/:brainId/notes/:file", () => {
  it("devolve título, frontmatter e corpo sem o bloco ---", async () => {
    const { app } = await setupApp();
    const dir = await setupBrainDir(app, "projetox");
    await writeFile(
      path.join(dir, "com-frontmatter.md"),
      '---\ndata: "2026-11-07T10:00:00.000Z"\ntags: [agent-office, "tarefa"]\nautor: Harry\nagent: lia\n---\n# Título da nota\n\nCorpo com [[Preferências do usuário]].\n',
    );
    const note = await call<BrainNoteResponse>(app, "GET", `${API}/brains/projetox/notes/com-frontmatter.md`);
    expect(note).toEqual({
      file: "com-frontmatter.md",
      title: "Título da nota",
      frontmatter: { data: "2026-11-07T10:00:00.000Z", tags: ["agent-office", "tarefa"], autor: "Harry", agent: "lia" },
      body: "# Título da nota\n\nCorpo com [[Preferências do usuário]].\n",
    });

    const seed = await call<BrainNoteResponse>(app, "GET", `${API}/brains/global/notes/preferencias.md`);
    expect(seed).toMatchObject({ file: "preferencias.md", title: "Preferências do usuário", frontmatter: {} });
    expect(seed.body).toMatch(/^# Preferências do usuário\n/);
  });

  it("404 para nota ou Cérebro inexistente", async () => {
    const { app } = await setupApp();
    const body = await call<ApiErrorBody>(app, "GET", `${API}/brains/global/notes/nao-existe.md`, undefined, 404);
    expect(body).toEqual({ error: 'Nota "nao-existe.md" não encontrada' });
    await call(app, "GET", `${API}/brains/nao-existe/notes/preferencias.md`, undefined, 404);
    // A nota existe, mas em outro Cérebro.
    await call(app, "GET", `${API}/brains/projetox/notes/confidencial.md`, undefined, 404);
  });

  it("path traversal: '..', '%2e%2e', barras codificadas, outros arquivos e links simbólicos dão 404", async () => {
    const { app, dir, dataDir } = await setupApp();
    const brainDir = path.join(dir, "brains", "projetox");
    await writeFile(path.join(brainDir, "segredo.txt"), "GIRASSOL-AZUL-42");
    await writeFile(path.join(dir, "fora.md"), "# Fora\n\nGIRASSOL-AZUL-42");
    await symlink(path.join(dir, "brains", "projetoy", "confidencial.md"), path.join(brainDir, "atalho.md"));
    await mkdir(path.join(brainDir, "sub.md"));

    const urls = [
      `${API}/brains/projetox/notes/..%2Fprojetoy%2Fconfidencial.md`,
      `${API}/brains/projetox/notes/%2e%2e%2fprojetoy%2fconfidencial.md`,
      `${API}/brains/projetox/notes/%2E%2E%2F%2E%2E%2Ffora.md`,
      `${API}/brains/projetox/notes/..%5C..%5Cfora.md`,
      `${API}/brains/projetox/notes/%2e%2e`,
      `${API}/brains/projetox/notes/..`,
      // "../" literal é resolvido no endereço antes do roteamento: sair de /api/w/:ws não acha rota.
      `${API}/brains/projetox/notes/../../../../../../etc/passwd`,
      `${API}/brains/projetox/notes/segredo.txt`,
      `${API}/brains/projetox/notes/atalho.md`,
      `${API}/brains/projetox/notes/sub.md`,
      `${API}/brains/projetox/notes/.md`,
      `${API}/brains/%2e%2e/notes/fora.md`,
      `${API}/brains/..%2F..%2F..%2F/notes/workspaces.json`,
      `${API}/brains/global/notes/..%2F..%2F..%2F..%2Fworkspaces.json`,
      `${API}/brains/global/notes/${encodeURIComponent(path.join(rootPaths(dataDir).root, "workspaces.json"))}`,
    ];
    for (const url of urls) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
      expect(response.body, url).not.toContain("GIRASSOL-AZUL-42");
    }
  });
});

describe("API: Cérebros isolados por workspace", () => {
  it("um workspace não lista nem lê as notas de outro", async () => {
    const { app } = await setupApp();
    const outro = await createWorkspace(app, "Outro");
    const room = await createRoom(app, "Só do Outro", {}, outro.id);
    await writeFile(path.join(await setupBrainDir(app, "global", outro.id), "so-do-outro.md"), "# Só do outro\n\nsegredo-do-outro");
    await writeFile(path.join(await setupBrainDir(app, room.id, outro.id), "quarto.md"), "# Quarto\n\nsegredo-do-quarto");

    const other = await listBrains(app, outro.id);
    expect(other.map((brain) => brain.id)).toEqual(["global", "sala-do-maestro", room.id]);
    expect(other[0]!.notes.map((note) => note.file)).toContain("so-do-outro.md");
    expect(other[0]!.notes.map((note) => note.file)).not.toContain("preferencias.md");
    await call(app, "GET", `/api/w/${outro.id}/brains/global/notes/so-do-outro.md`);

    const principal = await listBrains(app);
    expect(JSON.stringify(principal)).not.toContain("segredo-do-");
    expect(principal.some((brain) => brain.id === room.id)).toBe(false);
    await call(app, "GET", `${API}/brains/global/notes/so-do-outro.md`, undefined, 404);
    await call(app, "GET", `${API}/brains/${room.id}/notes/quarto.md`, undefined, 404);
    await call(app, "GET", `/api/w/${outro.id}/brains/projetoy/notes/confidencial.md`, undefined, 404);
    await call(app, "GET", `/api/w/${outro.id}/brains/global/notes/preferencias.md`, undefined, 404);
  });

  it("workspace inexistente: 404", async () => {
    const { app } = await setupApp();
    await call(app, "GET", "/api/w/nao-existe/brains", undefined, 404);
    await call(app, "GET", "/api/w/nao-existe/brains/global/notes/preferencias.md", undefined, 404);
    await call(app, "GET", "/api/w/%2e%2e/brains", undefined, 404);
  });
});
