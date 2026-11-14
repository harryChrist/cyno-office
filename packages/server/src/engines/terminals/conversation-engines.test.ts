import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentChatStatus, AgentEngine, AgentLogEntry, CynoSnapshot, ModelDefaultsResponse, Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { API, useTestApp, type TestApp } from "../../dev/test-app";
import { useTempDirs } from "../../dev/test-utils";

const FAKE_OPENCLAW = fileURLToPath(new URL("./fake-openclaw.mjs", import.meta.url));
const FAKE_HERMES = fileURLToPath(new URL("./fake-hermes.mjs", import.meta.url));
const FAKE_FREEBUFF = fileURLToPath(new URL("../freebuff/fake-freebuff.mjs", import.meta.url));

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

/** App com o OpenClaw, o Hermes e o Freebuff trocados pelas CLIs falsas; o server ouve de verdade (as falsas chamam o MCP por HTTP). */
async function setup(existing?: { dir: string; dataDir: string }) {
  const dir = existing?.dir ?? (await tempDir());
  const port = await freePort();
  const runLog = path.join(dir, "runs.jsonl");
  const dataDir = existing?.dataDir ?? path.join(dir, "data");
  if (!existing) {
    await mkdir(dataDir, { recursive: true });
    const { seedDataDir } = await import("../../workspace/office/seed");
    await seedDataDir(dataDir);
  }
  await mkdir(path.join(dir, "bin"), { recursive: true });
  const bin = async (name: string, script: string) => {
    const file = path.join(dir, "bin", name);
    await writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    await chmod(file, 0o755);
    return file;
  };
  const home = path.join(dir, "manicode");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "credentials.json"), "{}");
  const testApp = await setupApp({
    dataDir,
    terminals: {
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
      idleMs: 0,
      maxRetries: 1,
      backoffMs: () => 10,
      stopGraceMs: 800,
      claude: { command: "/nao-existe/claude" },
      gemini: { command: "/nao-existe/agy" },
      openclaw: { command: await bin("openclaw", FAKE_OPENCLAW), homeDir: path.join(dataDir, "platform", "engines", "openclaw"), openrouterKey: () => "sk-or-v1-CHAVE-DE-TESTE-9876", defaultModel: "deepseek/deepseek-chat" },
      hermes: { command: await bin("hermes", FAKE_HERMES), homeDir: path.join(dataDir, "platform", "engines", "hermes"), openrouterKey: () => "sk-or-v1-CHAVE-DE-TESTE-9876", defaultModel: "deepseek/deepseek-chat" },
      env: { ...process.env, FAKE_CLI_STATE: path.join(dir, "fake-state"), FAKE_CLI_LOG: runLog },
    },
    freebuff: {
      command: process.execPath,
      prefixArgs: [FAKE_FREEBUFF],
      manicodeDir: home,
      env: { ...process.env, FAKE_FB_HOME: home, FAKE_FB_LOG: path.join(dir, "spawns.jsonl"), FAKE_FB_STATE: path.join(dir, "fb-state") },
      pollMs: 20,
      readyTimeoutMs: 5000,
      deliveryTimeoutMs: 1500,
      submitDelayMs: 40,
      settleMs: 30,
      settleCatalogMs: 500,
    },
  });
  await testApp.app.listen({ port, host: "127.0.0.1" });
  return { ...testApp, dir, dataDir, runLog };
}

const patchAgent = async (testApp: TestApp, id: string, body: Record<string, unknown>) => {
  const response = await testApp.app.inject({ method: "PATCH", url: `${API}/agents/${id}`, payload: body });
  expect(response.statusCode, response.body).toBe(200);
};
const say = (testApp: TestApp, text: string) => testApp.app.inject({ method: "POST", url: `${API}/maestro/messages`, payload: { text } });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitTask(testApp: TestApp, predicate: (task: Task) => boolean, timeoutMs = 20_000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = testApp.store.snapshot().tasks.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error("a tarefa esperada não chegou a tempo");
    await sleep(25);
  }
}

/** As falas do Maestro na conversa do dia (da mais antiga para a mais nova). */
async function maestroReplies(testApp: TestApp): Promise<string[]> {
  const log = (await testApp.app.inject({ method: "GET", url: `${API}/agents/maestro/log` })).json() as { entries: AgentLogEntry[] };
  return log.entries.filter((entry) => entry.kind === "chat" && entry.from === "agent").map((entry) => (entry as { text: string }).text);
}

async function waitReplies(testApp: TestApp, count: number, timeoutMs = 25_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const replies = await maestroReplies(testApp);
    if (replies.length >= count) return replies;
    if (Date.now() > deadline) throw new Error(`o Maestro respondeu ${replies.length} de ${count} a tempo`);
    await sleep(40);
  }
}

describe.each([
  { engine: "openclaw" as const, label: "OpenClaw" },
  { engine: "hermes" as const, label: "Hermes" },
  { engine: "freebuff" as const, label: "Freebuff" },
])("o Maestro em $label (CLI falsa + MCP por HTTP)", ({ engine, label }) => {
  it("recebe um pedido, delega a um agente, recebe o aviso da entrega e responde ao dono", { timeout: 60_000 }, async () => {
    const testApp = await setup();
    await patchAgent(testApp, "maestro", { engine });
    // Clara fica no OpenClaw quando o Maestro está no Freebuff: o teto é de uma hora aberta ao mesmo tempo, e o Maestro acordado já segura a dele (o servidor avisa e não delega).
    await patchAgent(testApp, "clara", { engine: engine === "freebuff" ? "openclaw" : engine });
    const statuses: AgentChatStatus["status"][] = [];
    testApp.log.waitFor((event) => {
      if (event.type === "agent:chat-status") statuses.push(event.chat.status);
      return false;
    }, 60_000).catch(() => undefined);

    expect((await say(testApp, "[abrir] [delegar:clara] Escreva um slogan")).statusCode).toBe(202);
    const request = await waitTask(testApp, (task) => task.agentId === "maestro" && task.prompt.startsWith("Escreva um slogan"));
    const done = await waitTask(testApp, (task) => task.id === request.id && task.status === "done");
    expect(done.result).toContain("Resposta final do Maestro");
    const subtask = testApp.store.snapshot().tasks.find((task) => task.projectId === request.id)!;
    expect(subtask).toMatchObject({ agentId: "clara", status: "done" });
    expect(subtask.result).toBeTruthy();
    // O Maestro respondeu ao dono na conversa e a etiqueta da conversa foi acompanhada até o fim (agent:chat-status).
    expect((await waitReplies(testApp, 1)).length).toBeGreaterThanOrEqual(1);
    expect(statuses).toEqual(expect.arrayContaining(["queued", "delivered", "answered"]));
    // O terminal do Maestro é o do motor escolhido.
    expect(testApp.store.snapshot().agents.find((agent) => agent.id === "maestro")?.engine).toBe(engine);
    expect(label).toBeTruthy();
  });

  it("mensagens que chegam enquanto o Maestro trabalha não se perdem: todas são respondidas, na ordem", { timeout: 60_000 }, async () => {
    const testApp = await setup();
    await patchAgent(testApp, "maestro", { engine });
    await say(testApp, "[conversar] um");
    await say(testApp, "[conversar] dois");
    await say(testApp, "[conversar] tres");
    const replies = await waitReplies(testApp, 3);
    expect(replies.filter((text) => text.startsWith("Conversei:"))).toEqual(["Conversei: um", "Conversei: dois", "Conversei: tres"]);
  });

  it("a conversa continua depois de reiniciar o servidor", { timeout: 60_000 }, async () => {
    const first = await setup();
    await patchAgent(first, "maestro", { engine });
    await say(first, "[conversar] primeira");
    await waitReplies(first, 1);
    await first.app.close();

    const second = await setup({ dir: first.dir, dataDir: first.dataDir });
    await say(second, "[memoria] e agora?");
    const replies = await waitReplies(second, 2);
    const answer = replies.at(-1)!;
    if (engine === "openclaw") {
      // Sem retomada: o resumo corrido da conversa vai no começo do turno.
      expect(answer).toContain("memoria:");
      expect(answer).toContain("Resumo corrido da conversa");
      expect(answer).toContain("primeira");
    } else if (engine === "hermes") {
      // Com retomada: o segundo processo pede a MESMA sessão (--resume).
      const runs = (await readFile(first.runLog, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { cli: string; argv: string[] });
      const chats = runs.filter((run) => run.cli === "hermes" && run.argv.includes("chat"));
      expect(chats.length).toBeGreaterThanOrEqual(2);
      expect(chats.some((run) => run.argv.includes("--resume"))).toBe(true);
    } else {
      expect(answer).toBeTruthy();
    }
  });
});

describe("o Cyno em OpenClaw, Hermes e Freebuff responde uma pergunta", () => {
  it.each([{ engine: "openclaw" as const }, { engine: "hermes" as const }, { engine: "freebuff" as const }])("$engine: troca o motor do Cyno e a pergunta é respondida na conversa da plataforma", { timeout: 60_000 }, async ({ engine }) => {
    const testApp = await setup();
    const changed = await testApp.app.inject({ method: "PUT", url: "/api/cyno/model", payload: { choice: { engine } } });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((await testApp.app.inject({ method: "POST", url: "/api/cyno/messages", payload: { text: "[conversar] Cyno, tudo bem?" } })).statusCode).toBe(202);
    const deadline = Date.now() + 30_000;
    let reply: string | undefined;
    while (!reply && Date.now() < deadline) {
      const snapshot = (await testApp.app.inject({ method: "GET", url: "/api/cyno" })).json() as CynoSnapshot;
      reply = snapshot.entries.find((entry) => entry.kind === "chat" && entry.from === "agent" && entry.text.includes("Conversei: Cyno, tudo bem?"))?.["text" as never];
      if (!reply) await sleep(40);
    }
    expect(reply).toBeTruthy();
    // E ele usa as ferramentas da plataforma pelo MCP (token de plataforma).
    await testApp.app.inject({ method: "POST", url: "/api/cyno/messages", payload: { text: "[workspaces] quais workspaces existem?" } });
    const listed = Date.now() + 30_000;
    let found = false;
    while (!found && Date.now() < listed) {
      const snapshot = (await testApp.app.inject({ method: "GET", url: "/api/cyno" })).json() as CynoSnapshot;
      found = snapshot.entries.some((entry) => entry.kind === "chat" && entry.from === "agent" && entry.text.toLowerCase().includes("workspace"));
      if (!found) await sleep(40);
    }
    if (!found) console.log("DBGC", JSON.stringify(((await testApp.app.inject({ method: "GET", url: "/api/cyno" })).json() as CynoSnapshot).entries.map((e) => [e.kind, (e as { text?: string }).text?.slice(0, 150), (e as { message?: string }).message?.slice(0, 150)])));
    expect(found).toBe(true);
  });
});

describe("os seletores e as rotas aceitam os cinco motores nos três papéis", () => {
  it("modelos padrão (Maestro, agentes e Cyno), agente e Cyno aceitam claude, gemini, freebuff, openclaw e hermes", async () => {
    const testApp = await setup();
    const current = (await testApp.app.inject({ method: "GET", url: "/api/settings/models" })).json() as ModelDefaultsResponse;
    for (const engine of ["claude", "gemini", "freebuff", "openclaw", "hermes"] as AgentEngine[]) {
      const put = await testApp.app.inject({ method: "PUT", url: "/api/settings/models", payload: { defaults: { ...current.defaults, maestro: { engine }, agentes: { engine }, cyno: { engine } } } });
      expect(put.statusCode, `${engine}: ${put.body}`).toBe(200);
      await patchAgent(testApp, "maestro", { engine });
      await patchAgent(testApp, "clara", { engine });
      const cyno = await testApp.app.inject({ method: "PUT", url: "/api/cyno/model", payload: { choice: { engine } } });
      expect(cyno.statusCode, `${engine}: ${cyno.body}`).toBe(200);
    }
  });
});
