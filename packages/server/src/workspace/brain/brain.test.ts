import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dataPaths } from "../../store/paths";
import { useTempDirs } from "../../dev/test-utils";
import { Brain } from "./brain";
import { MAX_NOTE_BYTES, noteTitle } from "./notes";

const tempDir = useTempDirs();
const fixedDate = new Date(2026, 10, 7, 9, 5, 3); // 07/11/2026 09:05:03 (hora local)

async function makeBrain() {
  const dir = await tempDir();
  const brain = new Brain({ paths: dataPaths(dir), rooms: () => [], now: () => fixedDate });
  return { dir, brain };
}

const frontmatter = { task: "t-1", agent: "lia", team: "projetox-frontend", data: fixedDate.toISOString(), tags: ["agent-office", "tarefa"] };

describe("Brain.writeHistoryNote", () => {
  it("grava historico/YYYY-MM-DD-HHmmss-<slug>.md com frontmatter YAML", async () => {
    const { dir, brain } = await makeBrain();
    const written = await brain.writeHistoryNote("projetox", { title: "Criar tela de pedidos!", body: "Feito.", frontmatter });
    expect(written.file).toBe("historico/2026-11-07-090503-criar-tela-de-pedidos.md");
    const content = await readFile(path.join(dir, "brains", "projetox", written.file), "utf8");
    expect(content).toBe(
      [
        "---",
        'task: "t-1"',
        'agent: "lia"',
        'team: "projetox-frontend"',
        `data: "${fixedDate.toISOString()}"`,
        'tags: ["agent-office", "tarefa"]',
        "---",
        "",
        "# Criar tela de pedidos!",
        "",
        "Feito.",
        "",
      ].join("\n"),
    );
  });

  it("nunca sobrescreve: mesmo segundo e mesmo título ganham sufixo", async () => {
    const { dir, brain } = await makeBrain();
    const note = { title: "Resumo", body: "x", frontmatter };
    const first = await brain.writeHistoryNote("projetox", note);
    const second = await brain.writeHistoryNote("projetox", note);
    expect([first.file, second.file]).toEqual(["historico/2026-11-07-090503-resumo.md", "historico/2026-11-07-090503-resumo-2.md"]);
    expect(await readdir(path.join(dir, "brains", "projetox", "historico"))).toHaveLength(2);
    // O histórico nunca aparece entre as notas da raiz (que são as que entram no contexto).
    expect(await brain.readNotes("projetox")).toEqual([]);
    expect((await brain.readHistory("projetox")).map((note) => note.layer)).toEqual(["history", "history"]);
  });

  it("escapa valores no frontmatter e recusa ids inseguros", async () => {
    const { brain } = await makeBrain();
    const written = await brain.writeHistoryNote("projetox", {
      title: "Linha 1\nLinha 2",
      body: "ok",
      frontmatter: { ...frontmatter, task: 'aspas " e\nquebra' },
    });
    const content = await readFile(written.path, "utf8");
    expect(content).toContain('task: "aspas \\" e\\nquebra"');
    expect(content).toContain("# Linha 1 Linha 2");
    await expect(brain.writeHistoryNote("../fora", { title: "x", body: "x", frontmatter })).rejects.toThrow(/inválido/);
  });
});

describe("Brain.readNotes", () => {
  it("pasta ausente = nenhuma nota; notas grandes são cortadas", async () => {
    const { dir, brain } = await makeBrain();
    expect(await brain.readNotes("projetox")).toEqual([]);
    await brain.ensureBrain("projetox");
    await writeFile(path.join(dir, "brains", "projetox", "grande.md"), "a".repeat(MAX_NOTE_BYTES + 10));
    const [note] = await brain.readNotes("projetox");
    expect(note!.content.length).toBeLessThan(MAX_NOTE_BYTES + 100);
    expect(note!.content).toMatch(/nota cortada/);
  });

  it("título vem do primeiro cabeçalho (ignorando o frontmatter) ou do nome do arquivo", () => {
    expect(noteTitle("x.md", "---\ntask: \"1\"\n---\n\n# Título real\n\ntexto")).toBe("Título real");
    expect(noteTitle("sem-titulo.md", "só texto")).toBe("sem-titulo");
  });

  it("lista as pastas de Cérebro existentes", async () => {
    const { brain } = await makeBrain();
    expect(await brain.brainIds()).toEqual([]);
    await brain.ensureBrain("velho");
    expect(await brain.brainIds()).toEqual(["velho"]);
  });
});
