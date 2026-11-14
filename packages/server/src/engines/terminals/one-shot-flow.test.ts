import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEngine, AgentLogEntry, AgentUsageResponse, EngineStatusResponse, Task, TaskLogResponse } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { soloTeam } from "../../dev/test-api";
import { API, useTestApp, type TestApp } from "../../dev/test-app";
import { useTempDirs } from "../../dev/test-utils";

const FAKE_OPENCLAW = fileURLToPath(new URL("./fake-openclaw.mjs", import.meta.url));
const FAKE_HERMES = fileURLToPath(new URL("./fake-hermes.mjs", import.meta.url));

// A pasta temporária é registrada ANTES do app: o vitest roda os afterEach ao contrário.
const tempDir = useTempDirs();
const setupApp = useTestApp();

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

/** App com o OpenClaw e o Hermes trocados pelas CLIs falsas e o server ouvindo de verdade (as CLIs falsas chamam o MCP por HTTP). */
async function setup(): Promise<TestApp & { runLog: string }> {
  const dir = await tempDir();
  const port = await freePort();
  const runLog = path.join(dir, "runs.jsonl");
  const dataDir = path.join(dir, "data");
  await mkdir(dataDir, { recursive: true });
  const { seedDataDir } = await import("../../workspace/office/seed");
  await seedDataDir(dataDir);
  await mkdir(path.join(dir, "bin"), { recursive: true });
  const bin = async (name: string, script: string) => {
    const file = path.join(dir, "bin", name);
    await writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    await chmod(file, 0o755);
    return file;
  };
  const openclaw = await bin("openclaw", FAKE_OPENCLAW);
  const hermes = await bin("hermes", FAKE_HERMES);
  const testApp = await setupApp({
    dataDir,
    terminals: {
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
      idleMs: 0,
      maxRetries: 1,
      backoffMs: () => 10,
      stopGraceMs: 500,
      claude: { command: "/nao-existe/claude" },
      gemini: { command: "/nao-existe/agy" },
      openclaw: { command: openclaw, homeDir: path.join(dataDir, "platform", "engines", "openclaw"), openrouterKey: () => "sk-or-v1-CHAVE-DE-TESTE-9876", defaultModel: "deepseek/deepseek-chat" },
      hermes: { command: hermes, homeDir: path.join(dataDir, "platform", "engines", "hermes"), openrouterKey: () => "sk-or-v1-CHAVE-DE-TESTE-9876", defaultModel: "deepseek/deepseek-chat" },
      env: { ...process.env, FAKE_CLI_STATE: path.join(dir, "fake-state"), FAKE_CLI_LOG: runLog, ANTHROPIC_API_KEY: "sk-ant-NAO-PODE" },
    },
  });
  await testApp.app.listen({ port, host: "127.0.0.1" });
  return { ...testApp, runLog };
}

const patchAgent = (testApp: TestApp, id: string, body: Record<string, unknown>) => testApp.app.inject({ method: "PATCH", url: `${API}/agents/${id}`, payload: body });

async function taskLog(testApp: TestApp, taskId: string): Promise<AgentLogEntry[]> {
  const response = await testApp.app.inject({ method: "GET", url: `${API}/tasks/${taskId}/log` });
  return (response.json() as TaskLogResponse).entries;
}

async function waitTask(testApp: TestApp, id: string, status: Task["status"], timeoutMs = 12_000): Promise<Task> {
  const current = testApp.store.snapshot().tasks.find((task) => task.id === id);
  if (current?.status !== status) await testApp.log.waitFor((event) => event.type === "task:upserted" && event.task.id === id && event.task.status === status, timeoutMs);
  return testApp.store.snapshot().tasks.find((task) => task.id === id)!;
}

async function agentOn(testApp: TestApp, name: string, engine: AgentEngine) {
  const { room, team, agent } = await soloTeam(testApp.app, name);
  expect((await patchAgent(testApp, agent.id, { engine, model: "deepseek/deepseek-chat" })).statusCode).toBe(200);
  return { agentId: agent.id, roomId: room.id, teamId: team.id };
}

async function createTask(testApp: TestApp, prompt: string, where: { roomId: string; teamId: string; agentId: string }): Promise<Task> {
  const response = await testApp.app.inject({ method: "POST", url: `${API}/tasks`, payload: { roomId: where.roomId, teamId: where.teamId, prompt } });
  expect(response.statusCode).toBe(201);
  expect((response.json() as Task).agentId).toBe(where.agentId);
  return response.json() as Task;
}

const runs = async (file: string) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { cli: string; argv: string[]; cwd: string; env: Record<string, string> });

describe.each([
  { engine: "openclaw" as const, label: "OpenClaw", done: "Feito pelo OpenClaw falso", toolName: "mcp.office.submit_result" },
  { engine: "hermes" as const, label: "Hermes", done: "Feito pelo Hermes falso", toolName: "mcp_office_submit_result" },
])("$label de ponta a ponta (CLI falsa + MCP por HTTP)", ({ engine, label, done: doneText }) => {
  it("agente de time: a tarefa vira um turno, o agente entrega pelo submit_result do MCP e o log mostra o trabalho", async () => {
    const testApp = await setup();
    const beto = await agentOn(testApp, "Beto", engine);
    const task = await createTask(testApp, "[entregar] Escreva um haicai", beto);
    const done = await waitTask(testApp, task.id, "done");
    expect(done.result).toContain(doneText);
    expect(done.ranWith).toMatchObject({ engine, model: "deepseek/deepseek-chat" });
    const entries = await taskLog(testApp, task.id);
    expect(entries.some((entry) => entry.provider === engine)).toBe(true);
    expect(entries.some((entry) => entry.kind === "progress" && entry.message === `Metade feita (${engine})`)).toBe(true);
    // O processo recebeu só a chave do OpenRouter (a do Claude não passa).
    const [run] = await runs(testApp.runLog);
    expect(run!.cli).toBe(engine);
    expect(run!.env.OPENROUTER_API_KEY).toBe("sk-or-v1-CHAVE-DE-TESTE-9876");
    expect(run!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(run!.cwd).toContain(path.join("agents", beto.agentId));
    // Os tokens do turno entram no "Por agente" do uso.
    const usage = (await testApp.app.inject({ method: "GET", url: `${API}/usage/agents` })).json() as AgentUsageResponse;
    expect(usage.agents.find((agent) => agent.agentId === beto.agentId)).toMatchObject({ provider: engine, turns: 1, measuredTurns: 1 });
  });

  it("sem nada a entregar: a resposta do turno vira o resultado; erro do modelo falha a tarefa com a mensagem", async () => {
    const testApp = await setup();
    const ana = await agentOn(testApp, "Ana", engine);
    const ok = await waitTask(testApp, (await createTask(testApp, "Diga olá", ana)).id, "done");
    expect(ok.result).toMatch(/^eco: /);
    const failed = await waitTask(testApp, (await createTask(testApp, "[erro] vai falhar", ana)).id, "failed");
    expect(failed.result).toContain("falha simulada do modelo");
  });

  it(`o Maestro aceita o ${label} como motor (sem bloqueio por papel)`, async () => {
    const testApp = await setup();
    const response = await patchAgent(testApp, "maestro", { engine });
    expect(response.statusCode).toBe(200);
  });
});

describe("a tela Motores com os dois motores", () => {
  it("o estado lista OpenClaw e Hermes como motores de verdade (com as etapas)", async () => {
    const testApp = await setup();
    const { engines } = (await testApp.app.inject({ method: "GET", url: "/api/engines/status" })).json() as EngineStatusResponse;
    for (const id of ["openclaw", "hermes"]) {
      const info = engines.find((engine) => engine.id === id)!;
      expect(info.supported).toBe(true);
      expect(info.steps?.map((step) => step.id)).toEqual(["install", "key", "model", "verify"]);
      expect(info.unverified?.length).toBeGreaterThan(0);
    }
  });
});
