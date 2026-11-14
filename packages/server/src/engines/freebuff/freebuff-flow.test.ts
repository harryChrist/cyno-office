import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentLogEntry, EngineStatusResponse, SubscriptionUsage, Task, TaskLogResponse } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { soloTeam } from "../../dev/test-api";
import { API, useTestApp, type TestApp } from "../../dev/test-app";
import { useTempDirs } from "../../dev/test-utils";
import type { AppDeps } from "../../app";

const FAKE_FREEBUFF = fileURLToPath(new URL("./fake-freebuff.mjs", import.meta.url));

const setupApp = useTestApp();
const tempDir = useTempDirs();

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

type Env = { root: string; home: string; spawnLog: string };

/** App com o Freebuff trocado pela TUI falsa e o server ouvindo de verdade (a TUI falsa chama o MCP por HTTP). */
async function setup(options: { env?: Record<string, string>; dataDir?: string; root?: string; freebuff?: Partial<NonNullable<AppDeps["freebuff"]>>; engineTools?: AppDeps["engineTools"] } = {}): Promise<TestApp & Env> {
  const root = options.root ?? (await tempDir());
  const home = path.join(root, "manicode");
  const spawnLog = path.join(root, "spawns.jsonl");
  const port = await freePort();
  // Só a existência do arquivo de credenciais conta como "logado" (o Cyno nunca lê o conteúdo).
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "credentials.json"), "{}");
  const testApp = await setupApp({
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    terminals: { mcpUrl: `http://127.0.0.1:${port}/mcp`, idleMs: 0, maxRetries: 1, backoffMs: () => 10, stopGraceMs: 2000, claude: { command: "/nao-existe/claude" }, gemini: { command: "/nao-existe/agy" } },
    freebuff: {
      command: process.execPath,
      prefixArgs: [FAKE_FREEBUFF],
      manicodeDir: home,
      env: { ...process.env, FAKE_FB_HOME: home, FAKE_FB_LOG: spawnLog, FAKE_FB_STATE: path.join(root, "fake-state"), ANTHROPIC_API_KEY: "sk-ant-NAO-PODE", ...options.env },
      pollMs: 20,
      readyTimeoutMs: 5000,
      deliveryTimeoutMs: 1500,
      submitDelayMs: 40,
      settleMs: 30,
      settleCatalogMs: 500,
      ...options.freebuff,
    },
    ...(options.engineTools ? { engineTools: options.engineTools } : {}),
  });
  await testApp.app.listen({ port, host: "127.0.0.1" });
  return { ...testApp, root, home, spawnLog };
}

async function patchAgent(testApp: TestApp, id: string, body: Record<string, unknown>) {
  const response = await testApp.app.inject({ method: "PATCH", url: `${API}/agents/${id}`, payload: body });
  return response;
}

async function taskLog(testApp: TestApp, taskId: string): Promise<AgentLogEntry[]> {
  const response = await testApp.app.inject({ method: "GET", url: `${API}/tasks/${taskId}/log` });
  return (response.json() as TaskLogResponse).entries;
}

async function waitTask(testApp: TestApp, id: string, status: Task["status"], timeoutMs = 12_000): Promise<Task> {
  const current = testApp.store.snapshot().tasks.find((task) => task.id === id);
  if (current?.status !== status) await testApp.log.waitFor((event) => event.type === "task:upserted" && event.task.id === id && event.task.status === status, timeoutMs);
  return testApp.store.snapshot().tasks.find((task) => task.id === id)!;
}

type Where = { agentId: string; roomId: string; teamId: string; name: string };

/** Um agente de Freebuff num time só dele (a fila do agente fica previsível: o roteador não tem escolha). */
async function freebuffAgent(testApp: TestApp, name: string): Promise<Where> {
  const { room, team, agent } = await soloTeam(testApp.app, name);
  expect((await patchAgent(testApp, agent.id, { engine: "freebuff" })).statusCode).toBe(200);
  return { agentId: agent.id, roomId: room.id, teamId: team.id, name: agent.name };
}

async function createTask(testApp: TestApp, prompt: string, where: Where): Promise<Task> {
  const response = await testApp.app.inject({ method: "POST", url: `${API}/tasks`, payload: { roomId: where.roomId, teamId: where.teamId, prompt } });
  expect(response.statusCode).toBe(201);
  const task = response.json() as Task;
  expect(task.agentId).toBe(where.agentId);
  return task;
}

async function usageOf(testApp: TestApp): Promise<SubscriptionUsage | undefined> {
  return testApp.workspaces.usage.snapshot().find((usage) => usage.provider === "freebuff");
}

async function spawns(file: string): Promise<{ argv: string[]; cwd: string }[]> {
  return (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { argv: string[]; cwd: string });
}

describe("Freebuff de ponta a ponta (TUI falsa + MCP por HTTP)", () => {
  it("agente de time em Freebuff: o pedido vai como texto, o agente entrega pelo MCP e o log mostra as ferramentas", async () => {
    const testApp = await setup();
    const beto = await freebuffAgent(testApp, "Beto");
    const task = await createTask(testApp, "[submit] [ferramenta] Escreva um haicai", beto);
    const done = await waitTask(testApp, task.id, "done");
    expect(done.result).toContain("Entregue pelo falso");
    expect(done.ranWith).toMatchObject({ engine: "freebuff" });
    const entries = await taskLog(testApp, task.id);
    expect(entries.some((entry) => entry.provider === "freebuff")).toBe(true);
    expect(entries.some((entry) => entry.kind === "tool" && entry.name === "write_file" && entry.status === "ok")).toBe(true);
    expect(entries.some((entry) => entry.kind === "tool" && entry.name === "mcp__office__submit_result" && entry.status === "ok")).toBe(true);
    // A pasta de trabalho tem nome único e leva as instruções e o MCP do agente.
    const [spawn] = await spawns(testApp.spawnLog);
    expect(path.basename(spawn!.cwd)).toMatch(/^fb-principal-agente-beto-[0-9a-f]{6}$/);
    expect(spawn!.cwd).toContain(path.join("agents", beto.agentId));
    const agents = await readFile(path.join(spawn!.cwd, "AGENTS.md"), "utf8");
    expect(agents).toContain("Você é Agente Beto");
    expect(agents).toContain("office__submit_result");
    const mcp = JSON.parse(await readFile(path.join(spawn!.cwd, ".agents", "mcp.json"), "utf8")) as { mcpServers: { office: { type: string; url: string; headers: { Authorization: string } } } };
    expect(mcp.mcpServers.office).toMatchObject({ type: "http", url: expect.stringMatching(/\/mcp$/), headers: { Authorization: expect.stringMatching(/^Bearer /) } });
    // As chaves de API nunca chegam ao processo.
    // A hora abriu e aparece no uso da assinatura do provedor "freebuff".
    const usage = await usageOf(testApp);
    expect(usage?.freebuff?.sessions).toHaveLength(1);
    expect(usage?.freebuff?.sessions[0]).toMatchObject({ agentId: beto.agentId, workspaceId: "principal", multiplier: 2, hasProcess: true });
    expect(usage?.freebuff?.hours).toMatchObject({ total: 21, remaining: 19 });
  });

  it("o Maestro aceita o Freebuff como motor (sem bloqueio por papel)", async () => {
    const testApp = await setup();
    const response = await patchAgent(testApp, "maestro", { engine: "freebuff" });
    expect(response.statusCode).toBe(200);
  });

  it("teto de uma hora aberta: o segundo agente espera na fila com o motivo visível e anda quando o teto sobe", async () => {
    const testApp = await setup();
    const ana = await freebuffAgent(testApp, "Ana");
    const caio = await freebuffAgent(testApp, "Caio");
    const first = await createTask(testApp, "[submit] [muito-lento] primeiro", ana);
    await testApp.log.waitFor((event) => event.type === "task:upserted" && event.task.id === first.id && event.task.status === "in_progress", 8000);
    // O pedido da Ana ainda está subindo (a hora não abriu): ele já conta para o teto.
    const second = await createTask(testApp, "[submit] segundo", caio);
    await waitTask(testApp, first.id, "done");
    // O primeiro agente tem a hora aberta (ela dura 1 h): a tarefa do outro espera.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(testApp.store.snapshot().tasks.find((task) => task.id === second.id)!.status).toBe("queued");
    const waiting = (await taskLog(testApp, second.id)).find((entry) => entry.kind === "status" && entry.status === "waiting");
    expect(waiting && "message" in waiting ? waiting.message : "").toMatch(/esperando a hora do Freebuff de Agente Ana acabar/);
    // O teto é configurável na tela Motores: com 2 horas abertas ao mesmo tempo, o outro agente anda.
    const settings = await testApp.app.inject({ method: "PUT", url: "/api/engines/freebuff/settings", payload: { maxOpenHours: 2 } });
    expect(settings.statusCode).toBe(200);
    const done = await waitTask(testApp, second.id, "done");
    expect(done.result).toContain("Entregue pelo falso");
    expect((await usageOf(testApp))?.freebuff?.sessions).toHaveLength(2);
  }, 40_000);

  it("sem horas no dia: o agente fica sem cota, com a hora em que o dia vira, e anda quando um modelo mais barato cabe no saldo", async () => {
    const testApp = await setup({ env: { FAKE_FB_TOTAL: "1", FAKE_FB_WALLET: "0" } });
    const beto = await freebuffAgent(testApp, "Beto");
    // O saldo do dia é lido da tela do Freebuff (1 hora, sem carteira): o modelo de 2x não cabe.
    expect((await testApp.app.inject({ method: "POST", url: "/api/engines/freebuff/models/refresh" })).statusCode).toBe(200);
    const task = await createTask(testApp, "[submit] sem saldo", beto);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(testApp.store.snapshot().tasks.find((candidate) => candidate.id === task.id)!.status).toBe("queued");
    const waiting = (await taskLog(testApp, task.id)).find((entry) => entry.kind === "status" && entry.status === "waiting");
    expect(waiting && "message" in waiting ? waiting.message : "").toMatch(/sem cota · volta às/);
    // O modelo de 1x cabe em 1 hora: a fila anda sozinha.
    await testApp.app.inject({ method: "PUT", url: "/api/engines/freebuff/settings", payload: { model: "DeepSeek V4.1 Flash Slow" } });
    const done = await waitTask(testApp, task.id, "done");
    expect(done.result).toContain("Entregue pelo falso");
    expect((await usageOf(testApp))?.freebuff?.sessions[0]).toMatchObject({ multiplier: 1, model: "DeepSeek V4.1 Flash Slow" });
  }, 30_000);

  it("a tela Motores: estado do Freebuff, ler os modelos pela tela, escolher o modelo e o teste só com a confirmação", async () => {
    const testApp = await setup();
    const before = (await testApp.app.inject({ method: "GET", url: "/api/engines/status" })).json<EngineStatusResponse>();
    expect(before.engines.find((engine) => engine.id === "freebuff")).toMatchObject({
      supported: true,
      label: "Freebuff",
      freebuff: { settings: { model: "DeepSeek V4.1 Flash", effort: "high", maxOpenHours: 1 }, multiplier: 2, models: [] },
    });
    // "Atualizar modelos": abre uma sondagem, digita /model, lê a lista e fecha sem mandar mensagem (nenhuma hora aberta).
    const refresh = await testApp.app.inject({ method: "POST", url: "/api/engines/freebuff/models/refresh" });
    expect(refresh.statusCode).toBe(200);
    const after = refresh.json<EngineStatusResponse>().engines.find((engine) => engine.id === "freebuff")!;
    expect(after.freebuff?.models.map((model) => model.name)).toContain("DeepSeek V4.1 Flash Slow");
    expect(after.freebuff?.models.find((model) => model.name === "DeepSeek V4.1 Flash")).toMatchObject({ multiplier: 2, efforts: ["low", "high"], defaultEffort: "high" });
    expect(after.freebuff?.modelsReadAt).toBeTruthy();
    expect(after.freebuff?.sessions).toHaveLength(0);
    expect(after.freebuff?.hours).toMatchObject({ total: 21, remaining: 21 });
    // O seletor de modelo do agente enxerga a lista.
    const engines = (await testApp.app.inject({ method: "GET", url: "/api/engines" })).json<{ engines: { engine: string; models: { id: string; label?: string }[] }[] }>();
    expect(engines.engines.find((engine) => engine.engine === "freebuff")?.models.some((model) => model.id === "DeepSeek V4.1 Flash" && model.label === "DeepSeek V4.1 Flash · 2x")).toBe(true);
    // Escolher o modelo da plataforma (e recusar o que não existe).
    const slow = await testApp.app.inject({ method: "PUT", url: "/api/engines/freebuff/settings", payload: { model: "DeepSeek V4.1 Flash Slow" } });
    expect(slow.statusCode).toBe(200);
    expect(slow.json<EngineStatusResponse>().engines.find((engine) => engine.id === "freebuff")?.freebuff).toMatchObject({ settings: { model: "DeepSeek V4.1 Flash Slow", effort: "low" }, multiplier: 1 });
    expect((await testApp.app.inject({ method: "PUT", url: "/api/engines/freebuff/settings", payload: { model: "Modelo X" } })).statusCode).toBe(400);
    expect((await testApp.app.inject({ method: "PUT", url: "/api/engines/freebuff/settings", payload: { model: "DeepSeek V4.1 Flash", effort: "xhigh" } })).statusCode).toBe(400);
    // "Testar" abre uma hora: sem confirmação não roda e diz quanto gasta.
    const noConfirm = await testApp.app.inject({ method: "POST", url: "/api/engines/freebuff/test", payload: {} });
    expect(noConfirm.statusCode).toBe(409);
    expect(noConfirm.json<{ error: string }>().error).toMatch(/abre uma hora do Freebuff: gasta 1 hora/);
    const ran = await testApp.app.inject({ method: "POST", url: "/api/engines/freebuff/test", payload: { confirm: true } });
    expect(ran.statusCode).toBe(200);
    expect(ran.json<{ result: { ok: boolean; text?: string; model?: string } }>().result).toMatchObject({ ok: true, text: expect.stringContaining("Feito"), model: "DeepSeek V4.1 Flash Slow · low" });
    const final = (await testApp.app.inject({ method: "GET", url: "/api/engines/status" })).json<EngineStatusResponse>().engines.find((engine) => engine.id === "freebuff")!;
    expect(final.state).toBe("working");
    // O teste gastou 1 hora (modelo de 1x) e nenhum agente ficou com a hora dele.
    expect(final.freebuff?.hours.remaining).toBe(20);
    expect(final.freebuff?.sessions).toHaveLength(0);
  }, 40_000);

  it("reinício do servidor DENTRO da hora: a hora continua contando e o Cyno reassume a conversa com --continue", async () => {
    const root = await tempDir();
    const first = await setup({ root });
    const beto = await freebuffAgent(first, "Beto");
    const task = await createTask(first, "[submit] antes do reinício", beto);
    await waitTask(first, task.id, "done");
    const before = (await usageOf(first))!.freebuff!.sessions[0]!;
    await first.app.close();
    // Sobe de novo na mesma pasta de dados: a hora aberta estava gravada em platform/engine-sessions.json.
    const second = await setup({ root, dataDir: first.dataDir });
    const after = await (async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const all = await spawns(second.spawnLog);
        if (all.length >= 2) return all;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return spawns(second.spawnLog);
    })();
    expect(after).toHaveLength(2);
    expect(after[1]!.argv).toContain("--continue");
    expect((await usageOf(second))!.freebuff!.sessions[0]).toMatchObject({ agentId: beto.agentId, endsAt: before.endsAt, multiplier: 2 });
    // A tarefa seguinte usa a mesma hora (sem outra hora no saldo).
    const next = await createTask(second, "[submit] depois do reinício", beto);
    await waitTask(second, next.id, "done");
    expect((await usageOf(second))!.freebuff!.hours.remaining).toBe(19);
  }, 40_000);

  it("reinício do servidor FORA da hora: nada é reassumido e a próxima tarefa abre uma hora nova", async () => {
    const root = await tempDir();
    const first = await setup({ root, env: { FAKE_FB_HOUR_MS: "600" } });
    const beto = await freebuffAgent(first, "Beto");
    const task = await createTask(first, "[submit] hora curta", beto);
    await waitTask(first, task.id, "done");
    // A hora (600 ms) acaba e o Cyno fecha o processo.
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect((await usageOf(first))!.freebuff!.sessions).toHaveLength(0);
    await first.app.close();
    const second = await setup({ root, dataDir: first.dataDir, env: { FAKE_FB_HOUR_MS: "600" } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await spawns(second.spawnLog)).toHaveLength(1);
    const next = await createTask(second, "[submit] hora nova", beto);
    await waitTask(second, next.id, "done");
    expect(await spawns(second.spawnLog)).toHaveLength(2);
    expect((await spawns(second.spawnLog))[1]!.argv).not.toContain("--continue");
  }, 40_000);
});
