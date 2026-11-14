import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseNotePath } from "../workspace/brain/access";
import { useTestApp } from "../dev/test-app";
import type { McpTool } from "./protocol";

const setupApp = useTestApp();

/** Chama uma ferramenta MCP do agente direto (sem CLI nem HTTP): erro vira { isError }. */
async function callTool(tools: McpTool[], name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`sem a ferramenta ${name}`);
  const parsed = tool.input.safeParse(args);
  if (!parsed.success) return { text: parsed.error.message, isError: true };
  try {
    return await tool.call(parsed.data);
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}

async function setup() {
  const testApp = await setupApp();
  const runtime = testApp.workspaces.get("principal");
  const tools = (agentId: string) => runtime.officeTools(agentId);
  const brainDir = (id: string) => path.join(testApp.dir, "brains", id);
  // Histórico do ProjetoY com um termo só dele (busca também acha o histórico).
  await mkdir(path.join(brainDir("projetoy"), "historico"), { recursive: true });
  await writeFile(path.join(brainDir("projetoy"), "historico", "2026-11-07-101010-pesquisa.md"), '---\ntask: "t-1"\n---\n# Pesquisa de mercado\n\nLeitores de ebook: MARCADOR_HISTORICO_Y.\n');
  return { ...testApp, runtime, tools, brainDir };
}

describe("ferramentas MCP do Cérebro: visibilidade", () => {
  it("search_notes só acha o que o quarto do agente enxerga (inclui o histórico; nunca o quarto isolado)", async () => {
    const { tools } = await setup();
    // Lia (ProjetoX) lê o próprio quarto e o global; o ProjetoY é isolado.
    const fromLia = await callTool(tools("lia"), "search_notes", { query: "girassol azul confidencial" });
    expect(fromLia.text).toMatch(/^Nothing found/);
    expect(fromLia.text).not.toContain("GIRASSOL-AZUL-42");
    expect(fromLia.text).not.toContain("projetoy/");
    const prefs = await callTool(tools("lia"), "search_notes", { query: "preferências do usuário" });
    expect(prefs.text).toContain("`global/preferencias.md`");

    // Clara (ProjetoY) acha a nota confidencial e o histórico do próprio quarto, mas não o global (não lê o lobby).
    const fromClara = await callTool(tools("clara"), "search_notes", { query: "confidencial girassol" });
    expect(fromClara.text).toContain("`projetoy/confidencial.md`");
    const history = await callTool(tools("clara"), "search_notes", { query: "ebook leitores" });
    expect(history.text).toContain("`projetoy/historico/2026-11-07-101010-pesquisa.md`");
    expect(history.text).toContain("history");
    expect((await callTool(tools("clara"), "search_notes", { query: "preferências do usuário" })).text).not.toContain("global/");

    // O Maestro enxerga todos os quartos (e o global).
    const fromMaestro = await callTool(tools("maestro"), "search_notes", { query: "girassol" });
    expect(fromMaestro.text).toContain("`projetoy/confidencial.md`");
  });

  it("read_note respeita a mesma regra e recusa caminhos estranhos", async () => {
    const { tools } = await setup();
    const own = await callTool(tools("clara"), "read_note", { path: "projetoy/confidencial.md" });
    expect(own.text).toContain("GIRASSOL-AZUL-42");
    const history = await callTool(tools("clara"), "read_note", { path: "projetoy/historico/2026-11-07-101010-pesquisa" });
    expect(history.text).toContain("MARCADOR_HISTORICO_Y");
    const denied = await callTool(tools("lia"), "read_note", { path: "projetoy/confidencial.md" });
    expect(denied).toMatchObject({ isError: true });
    expect(denied.text).toMatch(/cannot see/);
    for (const caminho of ["projetox/../projetoy/confidencial.md", "projetox/historico/../../projetoy/confidencial.md", "../office.json", "projetox/sub/x.md", "global"]) {
      const result = await callTool(tools("lia"), "read_note", { path: caminho });
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain("GIRASSOL");
    }
    expect((await callTool(tools("maestro"), "read_note", { path: "projetoy/confidencial.md" })).text).toContain("GIRASSOL-AZUL-42");
  });
});

describe("ferramentas MCP do Cérebro: escrita", () => {
  it("agente de time salva só no próprio quarto: nota nova com frontmatter, entra no _indice; substituir troca; nada de _regras nem histórico", async () => {
    const { tools, brainDir } = await setup();
    const saved = await callTool(tools("lia"), "save_note", { title: "Decisão: paleta de cores", content: "Azul #1E40AF e laranja. Motivo: marca.", kind: "decision", tags: ["#design"] });
    expect(saved.isError).toBeFalsy();
    expect(saved.text).toContain("`projetox/decisao-paleta-de-cores.md`");
    const file = path.join(brainDir("projetox"), "decisao-paleta-de-cores.md");
    const content = await readFile(file, "utf8");
    expect(content).toMatch(/^---\ntipo: "decisao"\nautor: "Lia"\ndata: "[^"]+"\ntags: \["design"\]\n---\n\n# Decisão: paleta de cores\n\nAzul/);
    expect(await readFile(path.join(brainDir("projetox"), "_indice.md"), "utf8")).toContain("- [[decisao-paleta-de-cores]] — Azul #1E40AF e laranja.");

    // Mesmo título de novo: não duplica, pede `replace`.
    const again = await callTool(tools("lia"), "save_note", { title: "Decisão: paleta de cores", content: "x", kind: "decision" });
    expect(again).toMatchObject({ isError: true });
    expect(again.text).toContain('replace="projetox/decisao-paleta-de-cores.md"');
    const replaced = await callTool(tools("lia"), "save_note", { title: "Decisão: paleta", content: "Agora verde.", kind: "decision", replace: "projetox/decisao-paleta-de-cores.md" });
    expect(replaced.text).toContain("Note updated");
    expect(await readFile(file, "utf8")).toContain("Agora verde.");
    // O briefing do quarto pode ser atualizado pelo time; as regras não.
    expect((await callTool(tools("lia"), "save_note", { title: "Briefing", content: "Estado: login pronto.", kind: "doc", replace: "projetox/_briefing.md" })).isError).toBeFalsy();
    expect(await readFile(path.join(brainDir("projetox"), "_briefing.md"), "utf8")).toMatch(/^---\ntipo: "briefing"\nautor: "Lia"/);
    expect((await callTool(tools("lia"), "save_note", { title: "Regras", content: "x", kind: "doc", replace: "projetox/_regras.md" })).isError).toBe(true);

    // Outro quarto, global, histórico, nota grande: recusados, sem nada no disco.
    const before = (await readdir(brainDir("global"))).sort();
    for (const args of [
      { title: "Invasão", content: "x", kind: "doc", replace: "projetoy/confidencial.md" },
      { title: "Global", content: "x", kind: "doc", replace: "global/preferencias.md" },
      { title: "Outro", content: "x", kind: "doc", replace: "projetox/historico/2026-11-07-101010-pesquisa.md" },
      { title: "Grande", content: "y".repeat(7000), kind: "doc" },
    ]) {
      expect((await callTool(tools("lia"), "save_note", args)).isError).toBe(true);
    }
    expect((await readdir(brainDir("global"))).sort()).toEqual(before);
    expect(await readFile(path.join(brainDir("projetoy"), "confidencial.md"), "utf8")).toContain("GIRASSOL-AZUL-42");
  });

  it("o Maestro salva em qualquer quarto e no global (inclusive _regras); id inexistente é recusado", async () => {
    const { tools, brainDir } = await setup();
    const inRoom = await callTool(tools("maestro"), "save_note", { title: "Prazo", content: "Entrega na sexta.", kind: "decision", brain: "projetoy" });
    expect(inRoom.text).toContain("`projetoy/prazo.md`");
    expect((await callTool(tools("maestro"), "save_note", { title: "Regras", content: "Sempre em pt-BR.", kind: "doc", replace: "global/_regras.md" })).isError).toBeFalsy();
    expect(await readFile(path.join(brainDir("global"), "_regras.md"), "utf8")).toContain("Sempre em pt-BR.");
    expect((await callTool(tools("maestro"), "save_note", { title: "X", content: "x", kind: "doc", brain: "nao-existe" })).isError).toBe(true);
    expect((await callTool(tools("maestro"), "save_note", { title: "X", content: "x", kind: "doc", brain: "../fora" })).isError).toBe(true);
  });

  it("parseNotePath só separa cérebro e arquivo (quem confere é o Brain)", () => {
    expect(parseNotePath("projetox/visao-geral")).toEqual({ brainId: "projetox", file: "visao-geral.md" });
    expect(parseNotePath("[[global/_regras.md]]")).toEqual({ brainId: "global", file: "_regras.md" });
    expect(parseNotePath("sem-barra.md")).toBeNull();
  });
});
