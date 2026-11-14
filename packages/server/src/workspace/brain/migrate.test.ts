import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Room } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { dataPaths } from "../../store/paths";
import { useTempDirs } from "../../dev/test-utils";
import { Brain } from "./brain";

const tempDir = useTempDirs();

const room = (id: string, name: string): Room => ({ id, kind: "team", name, theme: "sand", gridPosition: { x: 0, y: 0 }, readsGlobalBrain: true, readsBrainsOf: [] });
const result = (task: string, text: string) => `---\ntask: "${task}"\nagent: "lia"\nteam: "t"\ndata: "2026-11-07T06:25:02.000Z"\ntags: ["agent-office", "tarefa"]\n---\n\n# Resultado\n\n${text}\n`;

/** Tudo o que está nas pastas de Cérebro (caminho relativo -> conteúdo), para comparar antes/depois. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${rel}/`);
      else out[rel] = await readFile(path.join(dir, entry.name), "utf8");
    }
  };
  await walk(root, "");
  return out;
}

async function setup() {
  const dir = await tempDir();
  const paths = dataPaths(dir);
  const x = paths.brainDir("projetox");
  await mkdir(path.join(x, "historico"), { recursive: true });
  await writeFile(path.join(x, "2026-11-07-062502-checagem.md"), result("t-1", "RESULTADO_1"));
  await writeFile(path.join(x, "2026-11-08-020056-tela-de-login.md"), result("t-2", "RESULTADO_2"));
  // Já existe um arquivo com o mesmo nome no histórico: o movido ganha sufixo (nada é sobrescrito).
  await writeFile(path.join(x, "historico", "2026-11-08-020056-tela-de-login.md"), result("t-0", "JA_ESTAVA"));
  // Nome datado mas escrito à mão (sem `task`): fica na raiz como nota curta.
  await writeFile(path.join(x, "2026-01-01-120000-ata.md"), "# Ata da reunião\n\nATA_A_MAO");
  await writeFile(path.join(x, "visao-geral.md"), "# ProjetoX — visão geral\n\nApp de pedidos para cafeterias.");
  await writeFile(path.join(x, "_regras.md"), "# Regras do usuário\n\nREGRA_DO_USUARIO");
  // Pasta de um quarto que não existe mais: o histórico é movido, mas não ganha fixos.
  const velho = paths.brainDir("velho");
  await mkdir(velho, { recursive: true });
  await writeFile(path.join(velho, "2026-11-01-101010-coisa.md"), result("t-9", "VELHO"));
  const brain = new Brain({ paths, rooms: () => [room("projetox", "ProjetoX")] });
  return { dir, paths, brain, x, velho };
}

describe("Brain.migrate: Cérebro em camadas", () => {
  it("move os resultados datados para historico/, cria os fixos que faltam e não apaga nada", async () => {
    const { paths, brain, x, velho } = await setup();
    const before = await snapshot(paths.brainsDir);
    const report = await brain.migrate();

    expect(report.moved.sort()).toEqual([
      "projetox/historico/2026-11-07-062502-checagem.md",
      "projetox/historico/2026-11-08-020056-tela-de-login-2.md",
      "velho/historico/2026-11-01-101010-coisa.md",
    ]);
    expect(report.created.sort()).toEqual(["global/_briefing.md", "global/_indice.md", "global/_regras.md", "projetox/_briefing.md", "projetox/_indice.md"]);

    expect((await readdir(x)).sort()).toEqual(["2026-01-01-120000-ata.md", "_briefing.md", "_indice.md", "_regras.md", "historico", "visao-geral.md"]);
    expect((await readdir(path.join(x, "historico"))).sort()).toEqual([
      "2026-11-07-062502-checagem.md",
      "2026-11-08-020056-tela-de-login-2.md",
      "2026-11-08-020056-tela-de-login.md",
    ]);
    expect(await readFile(path.join(x, "historico", "2026-11-08-020056-tela-de-login.md"), "utf8")).toContain("JA_ESTAVA");
    expect(await readFile(path.join(x, "historico", "2026-11-08-020056-tela-de-login-2.md"), "utf8")).toContain("RESULTADO_2");
    expect(await readFile(path.join(x, "_regras.md"), "utf8")).toContain("REGRA_DO_USUARIO");
    const indice = await readFile(path.join(x, "_indice.md"), "utf8");
    expect(indice).toContain("[[visao-geral]] — App de pedidos para cafeterias.");
    expect(indice).toContain("[[2026-01-01-120000-ata]]");
    expect(indice).not.toContain("checagem");
    expect(await readFile(path.join(x, "_briefing.md"), "utf8")).toContain("Veja: [[visao-geral]].");
    expect((await readdir(velho)).sort()).toEqual(["historico"]);

    // Nenhum conteúdo antigo sumiu: cada arquivo de antes continua em algum lugar, igual.
    const after = await snapshot(paths.brainsDir);
    const contents = new Set(Object.values(after));
    for (const content of Object.values(before)) expect(contents.has(content)).toBe(true);

    // O histórico não entra no contexto; as notas curtas e os fixos sim.
    const notes = await brain.readNotes("projetox");
    expect(notes.map((note) => [note.file, note.layer])).toEqual([
      ["2026-01-01-120000-ata.md", "note"],
      ["_briefing.md", "fixed"],
      ["_indice.md", "fixed"],
      ["_regras.md", "fixed"],
      ["visao-geral.md", "note"],
    ]);
  });

  it("é idempotente: rodar de novo não muda nada", async () => {
    const { paths, brain } = await setup();
    await brain.migrate();
    const once = await snapshot(paths.brainsDir);
    expect(await brain.migrate()).toEqual({ moved: [], created: [] });
    expect(await snapshot(paths.brainsDir)).toEqual(once);
  });
});
