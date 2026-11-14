import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAESTRO, type LibrarySkillView, type Task } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { call } from "../../dev/test-api";
import { API, useTestApp, type TestApp } from "../../dev/test-app";
import { useTempDirs } from "../../dev/test-utils";
import type { McpTool } from "../../mcp/protocol";
import type { TerminalsConfig } from "./manager";
import { FAKE_CLI } from "./process-terminal.test";

const FAKE_AGY = fileURLToPath(new URL("./fake-agy.mjs", import.meta.url));
const setupApp = useTestApp();
const tempDir = useTempDirs();
const SKILLS = "/api/library/skills";
const md = (name: string, description: string, body = "Corpo da skill.\n") => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

/** Porta livre para o server (a URL do MCP vai na configuração antes do listen). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

/** App com a CLI falsa (claude e agy) e nenhum acesso à rede: a entrega de skills acontece na subida, antes da CLI. */
async function setup(extra: Partial<TerminalsConfig> = {}): Promise<TestApp & { spawnLog: string }> {
  const dir = await tempDir();
  const port = await freePort();
  const spawnLog = path.join(dir, "spawns.jsonl");
  const testApp = await setupApp({
    terminals: {
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
      idleMs: 0,
      maxRetries: 1,
      backoffMs: () => 10,
      stopGraceMs: 2000,
      claude: { command: process.execPath, prefixArgs: [FAKE_CLI] },
      gemini: { command: process.execPath, prefixArgs: [FAKE_AGY] },
      env: { ...process.env, FAKE_CLI_STATE: path.join(dir, "fake-state"), FAKE_CLI_LOG: spawnLog },
      ...extra,
    },
  });
  await testApp.app.listen({ port, host: "127.0.0.1" });
  return { ...testApp, spawnLog };
}

async function patchAgent(testApp: TestApp, id: string, body: Record<string, unknown>) {
  expect((await testApp.app.inject({ method: "PATCH", url: `${API}/agents/${id}`, payload: body })).statusCode).toBe(200);
}

/** Roda uma tarefa de ponta a ponta (a CLI falsa responde) e espera terminar. */
async function runTask(testApp: TestApp, teamId: string, roomId: string): Promise<Task> {
  const response = await testApp.app.inject({ method: "POST", url: `${API}/tasks`, payload: { roomId, teamId, prompt: "[entregar] faça algo" } });
  const task = response.json() as Task;
  await testApp.log.waitFor((event) => event.type === "task:upserted" && event.task.id === task.id && event.task.status === "done", 8000);
  return task;
}

const agentFile = (testApp: TestApp, agentId: string, file: string) => path.join(testApp.dir, "agents", agentId, file);
const readOrNull = (file: string) => readFile(file, "utf8").catch(() => null);

describe("skills da Biblioteca chegam ao agente (CLI falsa)", () => {
  it("libera a skill a dois agentes (Claude e depois Antigravity): pasta copiada + índice no prompt; quem não recebeu não vê; atualizar e retirar acompanham", async () => {
    const testApp = await setup();
    await patchAgent(testApp, "beto", { engine: "claude", model: "sonnet" });
    await patchAgent(testApp, "clara", { engine: "claude", model: "sonnet" });
    const created = await call<LibrarySkillView>(testApp.app, "POST", SKILLS, { content: md("Cyno selftest", "Use quando pedirem a frase secreta do Cyno.", "A frase secreta é BANANA-42.\n") });
    expect(created.id).toBe("cyno-selftest");
    await call(testApp.app, "POST", `${SKILLS}/upload`, { files: [{ path: "SKILL.md", dataBase64: Buffer.from(md("Outra", "Use quando precisar de outra coisa qualquer.")).toString("base64") }, { path: "modelo.html", dataBase64: Buffer.from("<p>modelo</p>").toString("base64") }] });
    // Beto e Clara recebem a selftest; ninguém recebe a "outra"; o Maestro não recebe nada.
    const granted = await call<LibrarySkillView>(testApp.app, "PUT", `${SKILLS}/cyno-selftest/grants`, { grants: { principal: { agentIds: ["beto", "clara"] } } });
    expect(granted.uses[0]!.agents.map((agent) => agent.id).sort()).toEqual(["beto", "clara"]);
    // A pasta dos dois já está em dia assim que a liberação sai (terminais parados: não esperam a próxima subida).
    for (const id of ["beto", "clara"]) await vi.waitFor(async () => expect(await readFile(agentFile(testApp, id, "skills/cyno-selftest/SKILL.md"), "utf8")).toContain("BANANA-42"));
    expect(await readOrNull(agentFile(testApp, "maestro", "skills/cyno-selftest/SKILL.md"))).toBeNull();

    const first = await runTask(testApp, "projetoy-conteudo", "projetoy");
    const claudeMd = await readFile(agentFile(testApp, first.agentId!, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("## Skills (instruções prontas da Biblioteca)");
    expect(claudeMd).toContain("- Cyno selftest (cyno-selftest): Use quando pedirem a frase secreta do Cyno. -> skills/cyno-selftest/SKILL.md");
    expect(claudeMd).not.toContain("(outra)");
    expect(await readdir(agentFile(testApp, first.agentId!, "skills"))).toContain("cyno-selftest");
    // O mesmo texto foi no --append-system-prompt da CLI.
    const spawn = JSON.parse((await readFile(testApp.spawnLog, "utf8")).split("\n")[0]!) as { argv: string[] };
    expect(spawn.argv.some((arg) => arg.includes("skills/cyno-selftest/SKILL.md"))).toBe(true);

    // Antigravity: os dois trocados para o agy recebem o índice no GEMINI.md (a cópia continua a mesma).
    await patchAgent(testApp, "beto", { engine: "gemini", model: "gemini-3.8-flash-medium" });
    await patchAgent(testApp, "clara", { engine: "gemini", model: "gemini-3.8-flash-medium" });
    const second = await runTask(testApp, "projetoy-conteudo", "projetoy");
    const geminiMd = await readFile(agentFile(testApp, second.agentId!, "GEMINI.md"), "utf8");
    expect(geminiMd).toContain("-> skills/cyno-selftest/SKILL.md");

    // Nova versão da skill: a cópia dos agentes é atualizada (terminais ociosos reiniciam).
    await call(testApp.app, "PUT", `${SKILLS}/cyno-selftest`, { content: md("Cyno selftest", "Use quando pedirem a frase secreta do Cyno.", "A frase secreta é MAMAO-77.\n") });
    for (const id of ["beto", "clara"]) await vi.waitFor(async () => expect(await readFile(agentFile(testApp, id, "skills/cyno-selftest/SKILL.md"), "utf8")).toContain("MAMAO-77"));

    // Retirar a liberação: a pasta some e o índice sai do prompt da próxima subida.
    await call(testApp.app, "PUT", `${SKILLS}/cyno-selftest/grants`, { grants: { principal: { agentIds: ["beto"] } } });
    await vi.waitFor(async () => expect(await readOrNull(agentFile(testApp, "clara", "skills/cyno-selftest/SKILL.md"))).toBeNull());
    expect(await readOrNull(agentFile(testApp, "beto", "skills/cyno-selftest/SKILL.md"))).not.toBeNull();
    await call(testApp.app, "PUT", `${SKILLS}/cyno-selftest/grants`, { grants: {} });
    await vi.waitFor(async () => expect(await readOrNull(agentFile(testApp, "beto", "skills/cyno-selftest/SKILL.md"))).toBeNull());
    const third = await runTask(testApp, "projetoy-conteudo", "projetoy");
    expect(await readFile(agentFile(testApp, third.agentId!, "GEMINI.md"), "utf8")).not.toContain("## Skills");
  });
});

describe("set_agent_skills (Maestro)", () => {
  it("só entrega o que foi liberado ao workspace, sem user_confirmed, mostra no get_team e avisa dos limites", async () => {
    const testApp = await setupApp();
    const runtime = testApp.workspaces.get("principal");
    const tool = (name: string): McpTool => runtime.officeTools(MAESTRO.agentId).find((candidate) => candidate.name === name)!;
    const callTool = (name: string, args: Record<string, unknown>) => tool(name).call(tool(name).input.parse(args));
    const a = await call<LibrarySkillView>(testApp.app, "POST", SKILLS, { content: md("Alfa", "Use quando for o caso da skill Alfa.") });
    await call<LibrarySkillView>(testApp.app, "POST", SKILLS, { content: md("Beta", "Use quando for o caso da skill Beta.") });
    // Sem liberação ao workspace: a ferramenta recusa e lista o que há.
    expect((await callTool("set_agent_skills", { agent: "clara", skill_ids: [a.id] })).isError).toBe(true);
    await call(testApp.app, "PUT", `${SKILLS}/alfa/grants`, { grants: { principal: { agentIds: [] } } });
    const done = await callTool("set_agent_skills", { agent: "Clara", skill_ids: ["Alfa"] });
    expect(done.text).toContain("Clara now has the skills: Alfa.");
    expect(runtime.skills.list().find((skill) => skill.id === "alfa")!.agentIds).toEqual(["clara"]);
    // beta não foi liberada ao workspace: erro, e nada muda.
    const refused = await callTool("set_agent_skills", { agent: "clara", skill_ids: ["alfa", "beta"] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('Skill "beta" not found in this workspace');
    expect(runtime.skills.list().find((skill) => skill.id === "alfa")!.agentIds).toEqual(["clara"]);
    // get_team (nota) mostra a skill e quem usa.
    expect(runtime.skills.teamNote()).toMatch(/Alfa \(id: alfa\).*used by: Clara/);
    // Lista vazia tira.
    await callTool("set_agent_skills", { agent: "clara", skill_ids: [] });
    expect(runtime.skills.list().find((skill) => skill.id === "alfa")!.agentIds).toEqual([]);
    // A ferramenta não pede user_confirmed (é reversível e só texto).
    expect(Object.keys(tool("set_agent_skills").input.shape)).toEqual(["agent", "skill_ids"]);
  });
});
