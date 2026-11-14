import { chmod, lstat, mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { HttpError } from "../../platform/http/errors";
import { WriteQueue } from "../../store/write-queue";
import { materializeAgentSkills, skillIndexLine, skillsIndexBlock, withSkillsIndex, type AgentSkill } from "./agent-skills";
import { SkillLibrary, type SkillChange } from "./skill-library";
import { librarySkillPaths } from "./store";

const tempDir = useTempDirs();
const md = (name: string, description = "Use quando a tarefa pedir exatamente isto aqui.", body = "Corpo.\n") => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function setup(options: { home?: string } = {}) {
  const root = await tempDir();
  const changes: SkillChange[] = [];
  const agents: Record<string, string[]> = { principal: ["ana", "bia"], outro: ["caio"] };
  let clock = 0;
  const open = () =>
    SkillLibrary.open({
      paths: librarySkillPaths(path.join(root, "library")),
      queue: new WriteQueue(),
      workspaceExists: (ws) => ws in agents,
      agentExists: (ws, agent) => agents[ws]?.includes(agent) ?? false,
      workspaceName: (ws) => ws,
      agentName: (_ws, agent) => agent,
      onChange: (change) => changes.push(change),
      ...(options.home ? { local: { homeDir: options.home } } : {}),
      log: silent,
      now: () => new Date(Date.UTC(2026, 10, 11, 12, 0, clock++)),
    });
  return { root, changes, agents, open, library: await open() };
}

describe("SkillLibrary: criar, atualizar, versões", () => {
  it("cria do texto, guarda a pasta e o registro; id vem do name e nunca repete", async () => {
    const { library, root } = await setup();
    const a = await library.create({ content: md("Carrossel de Post") });
    const b = await library.create({ content: md("Carrossel de Post") });
    expect([a.id, b.id]).toEqual(["carrossel-de-post", "carrossel-de-post-2"]);
    expect(a).toMatchObject({ origin: { kind: "manual" }, version: 1, files: 1, readonly: false, grants: {} });
    expect(a.weightTokens).toBeGreaterThan(0);
    expect(await readFile(path.join(root, "library", "skills", a.id, "SKILL.md"), "utf8")).toContain("Carrossel de Post");
    // O arquivo guardado não tem permissão de execução.
    expect((await stat(path.join(root, "library", "skills", a.id, "SKILL.md"))).mode & 0o111).toBe(0);
    await expect(library.create({ content: md("x"), id: a.id })).rejects.toMatchObject({ statusCode: 409 });
    await expect(library.create({ content: "sem frontmatter" })).rejects.toBeInstanceOf(HttpError);
  });

  it("recarrega do disco (skills.json) e bate com o que estava na memória", async () => {
    const { library, open } = await setup();
    const a = await library.create({ content: md("Persistida") });
    await library.save();
    expect((await open()).all()).toEqual([a]);
  });

  it("atualizar substitui, sobe a versão e guarda a anterior; restaurar volta e troca de lugar", async () => {
    const { library, root } = await setup();
    const a = await library.create({ content: md("Viva", "Use quando for a primeira versão.", "v1\n") });
    const up = await library.update(a.id, { content: md("Viva", "Use quando for a segunda versão.", "v2\n") });
    expect(up).toMatchObject({ version: 2, previousVersion: 1, description: "Use quando for a segunda versão." });
    expect(await readFile(path.join(root, "library", "skill-versions", a.id, "SKILL.md"), "utf8")).toContain("v1");
    const back = await library.restore(a.id);
    expect(back).toMatchObject({ version: 3, previousVersion: 2, description: "Use quando for a primeira versão." });
    expect((await library.detail(a.id)).content).toContain("v1");
    // Desfaz de novo: volta para o texto v2.
    await library.restore(a.id);
    expect((await library.detail(a.id)).content).toContain("v2");
    const fresh = await library.create({ content: md("Sem anterior") });
    await expect(library.restore(fresh.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("atualizar mantém os arquivos de apoio e recusa SKILL.md inválido sem mexer no que existe", async () => {
    const { library } = await setup();
    const a = await library.upload({ files: [{ path: "SKILL.md", dataBase64: Buffer.from(md("Com apoio")).toString("base64") }, { path: "modelo.html", dataBase64: Buffer.from("<p>x</p>").toString("base64") }] });
    expect(a).toMatchObject({ origin: { kind: "upload" }, files: 2 });
    await expect(library.update(a.id, { content: "quebrado" })).rejects.toMatchObject({ statusCode: 400 });
    expect((await library.get(a.id)).version).toBe(1);
    const up = await library.update(a.id, { content: md("Com apoio", "Use quando precisar do modelo html.") });
    expect(up.files).toBe(2);
    expect((await library.detail(a.id)).files.map((f) => f.path)).toEqual(["SKILL.md", "modelo.html"]);
  });

  it("upload com o id de uma skill existente substitui (guarda a anterior); skill de app é só leitura e se duplica", async () => {
    const { library } = await setup();
    const a = await library.create({ content: md("Troca", "Use quando for a primeira versão.") });
    const replaced = await library.upload({ id: a.id, files: [{ path: "SKILL.md", dataBase64: Buffer.from(md("Troca", "Use quando for a versão enviada.")).toString("base64") }] });
    expect(replaced).toMatchObject({ id: a.id, version: 2, previousVersion: 1 });
    const app = await library.addFromApp([{ path: "SKILL.md", data: Buffer.from(md("Do app")) }], "hyperframes", "src/skills/x");
    expect(app).toMatchObject({ readonly: true, origin: { kind: "app", appId: "hyperframes" } });
    await expect(library.update(app.id, { content: md("Do app") })).rejects.toMatchObject({ statusCode: 409 });
    const copy = await library.duplicate(app.id);
    expect(copy).toMatchObject({ readonly: false, origin: { kind: "manual" }, name: "Do app (cópia)" });
  });

  it("remove apaga a pasta e as versões e avisa os workspaces onde estava", async () => {
    const { library, root, changes } = await setup();
    const a = await library.create({ content: md("Some") });
    await library.update(a.id, { content: md("Some", "Use quando a v2 estiver em vigor.") });
    await library.setGrants(a.id, { principal: { agentIds: ["ana"] } });
    await library.remove(a.id);
    expect(await readdir(path.join(root, "library", "skills"))).toEqual([]);
    await expect(readdir(path.join(root, "library", "skill-versions", a.id))).rejects.toThrow();
    expect(changes.at(-1)).toMatchObject({ kind: "deleted", id: a.id, notify: ["principal"] });
    expect(() => library.get(a.id)).toThrow(/não encontrada/);
  });
});

describe("SkillLibrary: skills de apps", () => {
  it("registerAppSkill copia a pasta do app (só leitura), reaproveita o id e as liberações; removeAppSkills apaga", async () => {
    const { library, root } = await setup();
    const dir = path.join(root, "apps", "x", "src", "skills", "video");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), md("Vídeo", "Use quando for editar vídeo com o app."));
    const a = await library.registerAppSkill("hyperframes", "src/skills/video", dir);
    expect(a).toMatchObject({ readonly: true, origin: { kind: "app", appId: "hyperframes" } });
    await library.setGrants(a.id, { principal: { agentIds: ["ana"] } });
    await writeFile(path.join(dir, "SKILL.md"), md("Vídeo", "Use quando for editar vídeo, versão nova do app."));
    const b = await library.registerAppSkill("hyperframes", "src/skills/video", dir);
    expect(b.id).toBe(a.id);
    expect(b.description).toMatch(/versão nova/);
    expect(library.attachedTo("principal", "ana").map((s) => s.id)).toEqual([a.id]);
    expect(await library.removeAppSkills("hyperframes")).toEqual([a.id]);
    expect(library.all()).toEqual([]);
  });
});

describe("SkillLibrary: importar do computador por cópia", () => {
  async function fakeHome() {
    const home = await tempDir();
    const skills = path.join(home, ".claude", "skills");
    await mkdir(path.join(skills, "design", "refs"), { recursive: true });
    await writeFile(path.join(skills, "design", "SKILL.md"), md("Design bonito", "Use quando precisar de ideias de design."), { mode: 0o600 });
    await writeFile(path.join(skills, "design", "refs", "cores.md"), "azul");
    await symlink("/etc/passwd", path.join(skills, "design", "refs", "link-ruim.md"));
    await mkdir(path.join(skills, "perigosa"), { recursive: true });
    await writeFile(path.join(skills, "perigosa", "SKILL.md"), md("Perigosa"));
    await writeFile(path.join(skills, "perigosa", "bin.dat"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0]));
    const plugin = path.join(home, ".claude", "plugins", "cache", "mkt", "meu-plugin", "1.0.0", "skills", "revisar");
    await mkdir(plugin, { recursive: true });
    await writeFile(path.join(plugin, "SKILL.md"), md("Revisar texto", "Use quando for revisar um texto em português."));
    await mkdir(path.join(home, ".claude", "plugins", "cache", "mkt", "node_modules", "x", "skills", "lixo"), { recursive: true });
    await writeFile(path.join(home, ".claude", "plugins", "cache", "mkt", "node_modules", "x", "skills", "lixo", "SKILL.md"), md("Lixo de node_modules"));
    return home;
  }

  /** Foto da pasta toda (caminho, tipo, tamanho, mtime, modo) para provar que nada mudou. */
  async function snapshot(dir: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (current: string) => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        const info = await lstat(full);
        out.push(`${full}|${info.isSymbolicLink() ? "l" : info.isDirectory() ? "d" : "f"}|${info.size}|${info.mtimeMs}|${info.mode}`);
        if (info.isDirectory()) await walk(full);
      }
    };
    await walk(dir);
    return out.sort();
  }

  it("lista candidatas só com nome e descrição (skills pessoais e de plugins, sem node_modules) e marca as que não dá para importar", async () => {
    const home = await fakeHome();
    const { library } = await setup({ home });
    const { candidates } = await library.importCandidates();
    expect(candidates.map((c) => c.name)).toEqual(["Design bonito", "Perigosa", "Revisar texto"]);
    expect(candidates.find((c) => c.name === "Design bonito")).toMatchObject({ source: "~/.claude/skills", description: "Use quando precisar de ideias de design.", alreadyInLibrary: false });
    expect(candidates.find((c) => c.name === "Revisar texto")?.source).toBe("plugin meu-plugin");
    // Nenhum caminho do computador vai para a API.
    expect(JSON.stringify(candidates)).not.toContain(home);
    expect(candidates.every((c) => /^[0-9a-f]{16}$/.test(c.key))).toBe(true);
  });

  it("copia só as marcadas, ignora link simbólico, recusa executável, e NUNCA toca no original", async () => {
    const home = await fakeHome();
    const claude = path.join(home, ".claude");
    // mtime antigo conhecido: se algo tocar, muda.
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(path.join(claude, "skills", "design", "SKILL.md"), old, old);
    await chmod(path.join(claude, "skills", "design", "SKILL.md"), 0o600);
    const before = await snapshot(claude);
    const { library, root } = await setup({ home });
    const { candidates } = await library.importCandidates();
    const design = candidates.find((c) => c.name === "Design bonito")!;
    const perigosa = candidates.find((c) => c.name === "Perigosa")!;
    const result = await library.importLocal([design.key, perigosa.key, "chave-inventada"]);
    expect(result.imported.map((s) => s.name)).toEqual(["Design bonito"]);
    expect(result.imported[0]).toMatchObject({ origin: { kind: "folder", from: "~/.claude/skills" }, files: 2, grants: {} });
    expect(result.failed.map((f) => f.key).sort()).toEqual([perigosa.key, "chave-inventada"].sort());
    expect(result.failed.find((f) => f.key === perigosa.key)?.reason).toMatch(/executável/);
    // A cópia está na Biblioteca, sem o link, sem execução e sem apontar para o original.
    const copyDir = path.join(root, "library", "skills", "design-bonito");
    expect((await readdir(path.join(copyDir, "refs"))).sort()).toEqual(["cores.md"]);
    expect((await stat(path.join(copyDir, "SKILL.md"))).mode & 0o777).toBe(0o644);
    expect((await lstat(copyDir)).isSymbolicLink()).toBe(false);
    expect(JSON.stringify(result.imported)).not.toContain(home);
    // O original está exatamente como estava (nomes, tamanhos, mtimes, modos).
    expect(await snapshot(claude)).toEqual(before);
    // Importar de novo a mesma gera outra cópia (id novo), e a lista passa a marcar "já na Biblioteca".
    expect((await library.importCandidates()).candidates.find((c) => c.name === "Design bonito")?.alreadyInLibrary).toBe(true);
  });

  it("sem ~/.claude: avisa em vez de falhar", async () => {
    const { library } = await setup({ home: await tempDir() });
    const response = await library.importCandidates();
    expect(response).toMatchObject({ available: true, candidates: [] });
    expect(response.reason).toMatch(/Não achei/);
  });
});

describe("SkillLibrary: liberação (workspace -> agente)", () => {
  it("nada vem liberado; liberar valida workspace e agente; o agente só tem o que o workspace recebeu", async () => {
    const { library, changes } = await setup();
    const a = await library.create({ content: md("Alfa") });
    const b = await library.create({ content: md("Beta") });
    expect(library.attachedTo("principal", "ana")).toEqual([]);
    await expect(library.setGrants(a.id, { fantasma: { agentIds: [] } })).rejects.toMatchObject({ statusCode: 404 });
    await expect(library.setGrants(a.id, { principal: { agentIds: ["caio"] } })).rejects.toMatchObject({ statusCode: 404 }); // agente de outro workspace
    await library.setGrants(a.id, { principal: { agentIds: ["ana"] }, outro: { agentIds: [] } });
    expect(library.attachedTo("principal", "ana").map((s) => s.id)).toEqual([a.id]);
    expect(library.attachedTo("outro", "caio")).toEqual([]);
    expect(library.grantedTo("outro").map((s) => s.id)).toEqual([a.id]);
    // setAgentSkills: só o liberado ao workspace (a skill Beta não foi liberada: 404).
    await expect(library.setAgentSkills("principal", "bia", [b.id])).rejects.toMatchObject({ statusCode: 404 });
    await expect(library.setAgentSkills("principal", "fantasma", [])).rejects.toMatchObject({ statusCode: 404 });
    await library.setGrants(b.id, { principal: { agentIds: [] } });
    const now = await library.setAgentSkills("principal", "bia", [a.id, b.id]);
    expect(now.map((s) => s.id)).toEqual([a.id, b.id]);
    // Lista inteira: trocar retira o que não está nela, sem tocar nos outros agentes.
    await library.setAgentSkills("principal", "bia", [b.id]);
    expect(library.attachedTo("principal", "bia").map((s) => s.id)).toEqual([b.id]);
    expect(library.attachedTo("principal", "ana").map((s) => s.id)).toEqual([a.id]);
    expect(changes.length).toBeGreaterThan(4);
  });

  it("retirar o workspace avisa o workspace que perdeu (dropped); agente e workspace excluídos saem das liberações", async () => {
    const { library, changes } = await setup();
    const a = await library.create({ content: md("Alfa") });
    await library.setGrants(a.id, { principal: { agentIds: ["ana", "bia"] }, outro: { agentIds: ["caio"] } });
    await library.setGrants(a.id, { principal: { agentIds: ["ana", "bia"] } });
    expect(changes.at(-1)).toMatchObject({ kind: "upserted", dropped: ["outro"] });
    await library.forgetAgent("principal", "bia");
    expect(library.get(a.id).grants.principal!.agentIds).toEqual(["ana"]);
    await library.forgetWorkspace("principal");
    expect(library.get(a.id).grants).toEqual({});
  });

  it("recordRead soma o uso", async () => {
    const { library } = await setup();
    const a = await library.create({ content: md("Lida") });
    await library.recordRead(a.id, "Ana", "principal");
    await library.recordRead(a.id, "Ana", "principal");
    expect(library.get(a.id).usage.reads).toBe(2);
    expect(library.get(a.id).usage.lastAt).toBeTruthy();
  });
});

describe("entrega ao agente: pasta do agente e índice no prompt", () => {
  const skill = (id: string, name: string, description: string, sourceDir: string, version = 1): AgentSkill => ({ id, name, description, sourceDir, revision: `${id}@${version}` });

  it("o índice: uma linha por skill (nome, id, quando usar até 200 caracteres, caminho), ordem estável por id", () => {
    const long = "x".repeat(300);
    const block = skillsIndexBlock([skill("zeta", "Zeta", "Use para Z.", "/a"), skill("alfa", "Alfa", long, "/b")]);
    const lines = block.split("\n");
    expect(lines[0]).toBe("## Skills (instruções prontas da Biblioteca)");
    const items = lines.filter((l) => l.startsWith("- "));
    expect(items.map((l) => l.split(":")[0])).toEqual(["- Alfa (alfa)", "- Zeta (zeta)"]);
    expect(items[0]).toMatch(/^- Alfa \(alfa\): x{199}… -> skills\/alfa\/SKILL\.md$/);
    expect(items[1]).toBe("- Zeta (zeta): Use para Z. -> skills/zeta/SKILL.md");
    // Mesmo conteúdo em outra ordem de entrada = mesmo texto.
    expect(skillsIndexBlock([skill("alfa", "Alfa", long, "/b"), skill("zeta", "Zeta", "Use para Z.", "/a")])).toBe(block);
    expect(skillIndexLine(skill("a", "A\nB", "duas\n\nlinhas   aqui", "/"))).toBe("- A B (a): duas linhas aqui -> skills/a/SKILL.md");
    // Nome igual ao id: sem repetir.
    expect(skillIndexLine(skill("pdf", "pdf", "Use para PDF.", "/"))).toBe("- pdf: Use para PDF. -> skills/pdf/SKILL.md");
  });

  it("sem skills o prompt fica exatamente como era; com skills o índice vai no fim", () => {
    expect(withSkillsIndex("# Ana\nregras", [])).toBe("# Ana\nregras");
    const out = withSkillsIndex("# Ana\nregras\n", [skill("alfa", "Alfa", "Use para A.", "/b")]);
    expect(out.startsWith("# Ana\nregras\n\n## Skills")).toBe(true);
    expect(out.endsWith("-> skills/alfa/SKILL.md")).toBe(true);
  });

  it("copia só as liberadas, atualiza quando a versão muda, não refaz quando nada mudou e apaga ao retirar", async () => {
    const root = await tempDir();
    const src = path.join(root, "lib", "alfa");
    await mkdir(path.join(src, "refs"), { recursive: true });
    await writeFile(path.join(src, "SKILL.md"), "v1");
    await writeFile(path.join(src, "refs", "a.md"), "apoio");
    const src2 = path.join(root, "lib", "beta");
    await mkdir(src2, { recursive: true });
    await writeFile(path.join(src2, "SKILL.md"), "beta");
    const agent = path.join(root, "agente");
    await mkdir(agent, { recursive: true });

    expect(await materializeAgentSkills(agent, [skill("alfa", "Alfa", "d", src)])).toBe(true);
    expect(await readFile(path.join(agent, "skills", "alfa", "SKILL.md"), "utf8")).toBe("v1");
    expect(await readFile(path.join(agent, "skills", "alfa", "refs", "a.md"), "utf8")).toBe("apoio");
    await expect(readFile(path.join(agent, "skills", "beta", "SKILL.md"))).rejects.toThrow();
    // Nada mudou: não refaz.
    expect(await materializeAgentSkills(agent, [skill("alfa", "Alfa", "d", src)])).toBe(false);
    // Versão nova: troca o conteúdo; a skill nova entra; arquivo que saiu da skill some.
    await writeFile(path.join(src, "SKILL.md"), "v2");
    await writeFile(path.join(agent, "skills", "alfa", "lixo-local.md"), "o agente escreveu aqui");
    expect(await materializeAgentSkills(agent, [skill("alfa", "Alfa", "d", src, 2), skill("beta", "Beta", "d", src2)])).toBe(true);
    expect(await readFile(path.join(agent, "skills", "alfa", "SKILL.md"), "utf8")).toBe("v2");
    expect((await readdir(path.join(agent, "skills", "alfa"))).sort()).toEqual(["SKILL.md", "refs"]);
    expect(await readFile(path.join(agent, "skills", "beta", "SKILL.md"), "utf8")).toBe("beta");
    // Retirada: a pasta some inteira; e de novo sem skills não faz nada.
    expect(await materializeAgentSkills(agent, [])).toBe(true);
    await expect(readdir(path.join(agent, "skills"))).rejects.toThrow();
    expect(await materializeAgentSkills(agent, [])).toBe(false);
  });
});
