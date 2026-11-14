import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEngine, EngineStatus, EngineStatusResponse, EngineVerifyResult, ProgramAccountInfo, Task } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { soloTeam } from "../../dev/test-api";
import { API, useTestApp, type TestApp } from "../../dev/test-app";
import { useTempDirs } from "../../dev/test-utils";
import { defaultProbe, type EngineProbe } from "./engines";
import { parseHermesAuthList, parseOpenClawModels, parseOpenClawStatus, programSetup } from "./program-account";

const FAKE_OPENCLAW = fileURLToPath(new URL("./fake-openclaw.mjs", import.meta.url));
const FAKE_HERMES = fileURLToPath(new URL("./fake-hermes.mjs", import.meta.url));

const tempDir = useTempDirs();
const setupApp = useTestApp();

const FAKE_KEY = "sk-or-v1-FAKEKEY0000000000000000";
const PANEL_KEY = "sk-or-v1-CHAVE-DO-PAINEL-9876";

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

const touched = ["FAKE_CLI_LOG", "FAKE_OC_PERSONAL_STATUS", "FAKE_HERMES_PERSONAL_AUTH", "FAKE_HERMES_PERSONAL_HOME"] as const;
afterEach(() => {
  for (const name of touched) delete process.env[name];
});

/** O --version é respondido de mentira; os comandos de estado rodam as CLIs falsas de verdade (o processo real, com o ambiente de cada forma de conta). */
const probe: EngineProbe = async (command, args, timeoutMs, env) => (args.includes("--version") ? { ok: true, stdout: `${path.basename(command)} 2026.11.3\n` } : defaultProbe(command, args, timeoutMs, env));

async function setup() {
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
  const home = path.join(dir, "home");
  await mkdir(home, { recursive: true });
  const roots = { openclaw: path.join(dataDir, "platform", "engines", "openclaw"), hermes: path.join(dataDir, "platform", "engines", "hermes") };
  const testApp = await setupApp({
    dataDir,
    engineTools: { probe, pathEnv: path.join(dir, "bin"), homeDir: home },
    terminals: {
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
      idleMs: 0,
      maxRetries: 1,
      backoffMs: () => 10,
      stopGraceMs: 500,
      claude: { command: "/nao-existe/claude" },
      gemini: { command: "/nao-existe/agy" },
      openclaw: { command: openclaw, homeDir: roots.openclaw, openrouterKey: () => PANEL_KEY },
      hermes: { command: hermes, homeDir: roots.hermes, openrouterKey: () => PANEL_KEY },
      env: { ...process.env, FAKE_CLI_STATE: path.join(dir, "fake-state"), FAKE_CLI_LOG: runLog, ANTHROPIC_API_KEY: "sk-ant-NAO-PODE" },
    },
  });
  await testApp.app.listen({ port, host: "127.0.0.1" });
  // Os comandos de estado (detecção) rodam com o ambiente do servidor: o registro das CLIs falsas também os pega.
  process.env.FAKE_CLI_LOG = runLog;
  return { ...testApp, runLog, dir, home, roots, dataDir };
}

type Run = { cli: string; argv: string[]; cwd: string; env: Record<string, string>; config?: unknown };
const runs = async (file: string) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Run);
const agentRuns = async (file: string) => (await runs(file)).filter((run) => run.argv.includes("exec") || run.argv.includes("chat"));

const put = async (testApp: TestApp, url: string, payload: object, status = 200) => {
  const response = await testApp.app.inject({ method: "PUT", url, payload });
  expect(response.statusCode, response.body).toBe(status);
  return response;
};
const post = async (testApp: TestApp, url: string, payload: object = {}, status = 200) => {
  const response = await testApp.app.inject({ method: "POST", url, payload });
  expect(response.statusCode, response.body).toBe(status);
  return response;
};
const statusOf = async (testApp: TestApp, id: string): Promise<EngineStatus> => ((await testApp.app.inject({ method: "GET", url: "/api/engines/status" })).json() as EngineStatusResponse).engines.find((engine) => engine.id === id)!;

async function agentOn(testApp: TestApp, name: string, engine: AgentEngine, model?: string) {
  const { room, team, agent } = await soloTeam(testApp.app, name);
  const response = await testApp.app.inject({ method: "PATCH", url: `${API}/agents/${agent.id}`, payload: { engine, ...(model ? { model } : {}) } });
  expect(response.statusCode).toBe(200);
  return { agentId: agent.id, roomId: room.id, teamId: team.id };
}

async function runTask(testApp: TestApp, where: { roomId: string; teamId: string }, prompt: string, status: Task["status"] = "done"): Promise<Task> {
  const response = await testApp.app.inject({ method: "POST", url: `${API}/tasks`, payload: { roomId: where.roomId, teamId: where.teamId, prompt } });
  expect(response.statusCode).toBe(201);
  const id = (response.json() as Task).id;
  const current = testApp.store.snapshot().tasks.find((task) => task.id === id);
  if (current?.status !== status) await testApp.log.waitFor((event) => event.type === "task:upserted" && event.task.id === id && event.task.status === status, 12_000);
  return testApp.store.snapshot().tasks.find((task) => task.id === id)!;
}

const writeJson = (file: string, data: unknown) => writeFile(file, JSON.stringify(data));

describe("leitura do que o programa diz (sem segredo)", () => {
  it("OpenClaw: o estado real conferido (openrouter com duas chaves) vira nome, tipo e contagem; rótulos com pedaço de chave são ignorados", () => {
    const parsed = parseOpenClawStatus({
      configPath: "/x/openclaw.json",
      resolvedDefault: "openai/gpt-6-astra",
      auth: {
        missingProvidersInUse: ["openai"],
        providersWithOAuth: ["openai-codex"],
        providers: [
          { provider: "openrouter", effective: { kind: "profiles", detail: `profiles=${FAKE_KEY}` }, profiles: { count: 2, oauth: 0, token: 0, apiKey: 2, labels: [`openrouter:a (api_key) ${FAKE_KEY}`] } },
          { provider: "ollama", effective: { kind: "missing" }, profiles: { count: 0, oauth: 0, token: 0, apiKey: 0, labels: [] } },
        ],
      },
    });
    expect(parsed).toEqual({
      providers: [
        { provider: "openrouter", kind: "api_key", profiles: 2 },
        { provider: "openai-codex", kind: "oauth" },
      ],
      defaultModel: "openai/gpt-6-astra",
      missing: ["openai"],
    });
    expect(JSON.stringify(parsed)).not.toContain("FAKEKEY");
    expect(parseOpenClawStatus({ nada: true })).toBeUndefined();
  });

  it("Hermes: `auth list` (formato do código-fonte) vira provedores e tipos; a linha com a chave não passa", () => {
    const text = [`openrouter (1 credentials):`, `  #1  OPENROUTER_API_KEY api_key id=ab12 priority=0 env:OPENROUTER_API_KEY ${FAKE_KEY} ←`, ``, `nous (2 credentials):`, `  #1  conta1 oauth id=cd34 priority=0 device_code`, `  #2  conta2 oauth id=ef56 priority=1 device_code`, ``].join("\n");
    const parsed = parseHermesAuthList(text);
    expect(parsed.providers).toEqual([
      { provider: "openrouter", kind: "api_key", profiles: 1 },
      { provider: "nous", kind: "oauth", profiles: 2 },
    ]);
    expect(JSON.stringify(parsed)).not.toContain("FAKEKEY");
    expect(parseHermesAuthList("").providers).toEqual([]);
  });

  it("a lista de modelos do OpenClaw aceita só provedor/modelo e tira repetidos", () => {
    expect(parseOpenClawModels({ models: [{ key: "openai/gpt-5.2", name: "GPT 5.2" }, { key: "openai/gpt-5.2" }, { id: "x", provider: "ollama" }, { key: "sem barra" }] })).toEqual([{ id: "openai/gpt-5.2", label: "GPT 5.2" }, { id: "ollama/x" }]);
    expect(parseOpenClawModels({ count: 0, models: [] })).toEqual([]);
  });

  it("os comandos do dono levam as variáveis da pasta do Cyno na frente; na pasta pessoal não há variável nenhuma", () => {
    const input = { engineRoot: "/dados/platform/engines/openclaw", homeDir: "/home/dono" };
    const cyno = programSetup("openclaw", { mode: "program", location: "cyno" }, input);
    expect(cyno.commands[0]).toBe("HOME='/dados/platform/engines/openclaw/home' OPENCLAW_STATE_DIR='/dados/platform/engines/openclaw/state' OPENCLAW_CONFIG_PATH='/dados/platform/engines/openclaw/openclaw.json' openclaw configure");
    expect(cyno.commands).toContain("HOME='/dados/platform/engines/openclaw/home' OPENCLAW_STATE_DIR='/dados/platform/engines/openclaw/state' OPENCLAW_CONFIG_PATH='/dados/platform/engines/openclaw/openclaw.json' openclaw models auth login --provider <provedor>");
    const personal = programSetup("openclaw", { mode: "program", location: "personal" }, input);
    expect(personal.commands).toEqual(["openclaw configure", "openclaw models auth login --provider <provedor>", "openclaw models status"]);
    expect(personal.dir).toBe("/home/dono/.openclaw");
    const hermes = programSetup("hermes", { mode: "program", location: "cyno" }, { engineRoot: "/dados/platform/engines/hermes", homeDir: "/home/dono" });
    expect(hermes.commands).toEqual(["HERMES_HOME='/dados/platform/engines/hermes/home' hermes setup", "HERMES_HOME='/dados/platform/engines/hermes/home' hermes auth add <provedor>", "HERMES_HOME='/dados/platform/engines/hermes/home' hermes model"]);
    expect(programSetup("hermes", { mode: "program", location: "personal" }, { engineRoot: "/x", homeDir: "/home/dono" }).commands[0]).toBe("hermes setup");
  });
});

describe("OpenClaw: as duas formas de conta, ponta a ponta com a CLI falsa", () => {
  it("chave do painel (como sempre), configuração do Cyno e configuração pessoal: argumentos e ambiente de cada uma", async () => {
    const testApp = await setup();
    const ana = await agentOn(testApp, "Ana", "openclaw");
    await put(testApp, "/api/engines/openclaw/config", { model: "deepseek/deepseek-chat" });
    // Padrão: a chave do painel, isolada na pasta do Cyno (o dado antigo continua valendo sem refazer nada).
    expect((await statusOf(testApp, "openclaw")).account).toEqual({ mode: "openrouter", location: "cyno" });
    await runTask(testApp, ana, "Diga olá");
    let [run] = await agentRuns(testApp.runLog);
    expect(run!.env.OPENROUTER_API_KEY).toBe(PANEL_KEY);
    expect(run!.argv).toContain("--state-dir");
    expect(run!.argv).toContain("openrouter/deepseek/deepseek-chat");
    expect(run!.argv).not.toContain("--no-auth-env-only");

    // Configuração do próprio programa, na pasta do Cyno: nenhuma chave injetada; o modelo vai como veio (qualquer provedor).
    await put(testApp, "/api/engines/openclaw/account", { mode: "program", location: "cyno" });
    await put(testApp, "/api/engines/openclaw/config", { model: "openai/gpt-5.2" });
    await runTask(testApp, ana, "Diga olá de novo");
    let all = await agentRuns(testApp.runLog);
    run = all.at(-1)!;
    expect(run.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(run.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(run.env.OPENCLAW_STATE_DIR).toBe(path.join(testApp.roots.openclaw, "state"));
    expect(run.argv).toContain("--no-auth-env-only");
    expect(run.argv[run.argv.indexOf("--model") + 1]).toBe("openai/gpt-5.2");

    // Configuração pessoal do dono: sem HOME/estado do Cyno, sem --state-dir; só o arquivo do agente por --config; nada criado no ~/.openclaw.
    await put(testApp, "/api/engines/openclaw/account", { location: "personal" });
    await runTask(testApp, ana, "Mais uma");
    all = await agentRuns(testApp.runLog);
    run = all.at(-1)!;
    expect(run.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(run.env.OPENCLAW_STATE_DIR).toBeUndefined();
    expect(run.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
    expect(run.env.HOME).toBe(process.env.HOME);
    expect(run.argv).not.toContain("--state-dir");
    expect(run.argv).toContain("--no-auth-env-only");
    const config = run.argv[run.argv.indexOf("--config") + 1]!;
    // A configuração do agente fica FORA da pasta de trabalho (o token do MCP não está ao alcance das ferramentas de arquivo).
    expect(path.dirname(config).startsWith(run.cwd)).toBe(false);
    expect(config).toContain(path.join("agent-configs"));
    expect(config.endsWith("openclaw.json")).toBe(true);
    expect(JSON.parse(await readFile(config, "utf8")).mcp.servers.office.url).toContain("/mcp");
    await expect(stat(path.join(testApp.home, ".openclaw"))).rejects.toThrow();

    // Voltando à chave do painel, o local volta a ser o do Cyno.
    await put(testApp, "/api/engines/openclaw/account", { mode: "openrouter" });
    expect((await statusOf(testApp, "openclaw")).account).toEqual({ mode: "openrouter", location: "cyno" });
  });

  it("detecta os provedores ligados (pasta pessoal e pasta do Cyno) sem vazar a chave que o programa imprime", async () => {
    const testApp = await setup();
    const personalFile = path.join(testApp.dir, "personal-oc.json");
    process.env.FAKE_OC_PERSONAL_STATUS = personalFile;
    await writeJson(personalFile, { providers: [{ provider: "openrouter", count: 2, apiKey: 2 }, { provider: "openai-codex", count: 1, oauth: 1 }], defaultModel: "openai/gpt-6-astra", missing: ["openai"] });
    await mkdir(testApp.roots.openclaw, { recursive: true });
    await writeJson(path.join(testApp.roots.openclaw, "fake-status.json"), { providers: [] });

    await put(testApp, "/api/engines/openclaw/account", { mode: "program", location: "personal" });
    const personal = ((await post(testApp, "/api/engines/openclaw/program/detect")).json() as { program: ProgramAccountInfo }).program;
    expect(personal).toMatchObject({ ok: true, location: "personal", verified: true, command: "openclaw models status --json", defaultModel: "openai/gpt-6-astra", missing: ["openai"] });
    expect(personal.providers).toEqual([
      { provider: "openrouter", kind: "api_key", profiles: 2 },
      { provider: "openai-codex", kind: "oauth", profiles: 1 },
    ]);

    await put(testApp, "/api/engines/openclaw/account", { location: "cyno" });
    const cyno = ((await post(testApp, "/api/engines/openclaw/program/detect")).json() as { program: ProgramAccountInfo }).program;
    expect(cyno).toMatchObject({ ok: true, location: "cyno", providers: [] });

    // Nenhuma resposta (estado, detecção, Verificar) leva o texto da chave que o programa imprimiu.
    await put(testApp, "/api/engines/openclaw/account", { location: "personal" });
    const bodies = [JSON.stringify(personal), (await testApp.app.inject({ method: "GET", url: "/api/engines/status" })).body, (await post(testApp, "/api/engines/openclaw/verify")).body, (await post(testApp, "/api/engines/openclaw/program/detect")).body];
    for (const body of bodies) {
      expect(body).not.toContain("FAKEKEY");
      expect(body).not.toContain("sk-or-v1");
    }
    // A detecção rodou o comando de estado com o ambiente de cada forma: o pessoal sem OPENCLAW_*, o do Cyno com a pasta própria.
    const state = (await runs(testApp.runLog)).filter((run) => run.argv[0] === "models" && run.argv[1] === "status");
    expect(state.some((run) => run.env.OPENCLAW_STATE_DIR === undefined)).toBe(true);
    expect(state.some((run) => run.env.OPENCLAW_STATE_DIR === path.join(testApp.roots.openclaw, "state"))).toBe(true);
  });

  it("modelo de outro provedor: a lista do programa e a digitação livre; o Verificar confere o provedor e diz de onde sai o custo", async () => {
    const testApp = await setup();
    await mkdir(testApp.roots.openclaw, { recursive: true });
    await writeJson(path.join(testApp.roots.openclaw, "fake-status.json"), { providers: [{ provider: "openai", count: 1, oauth: 1 }], models: ["openai/gpt-5.2", "openai/gpt-5.2-mini"], defaultModel: "openai/gpt-5.2" });
    await put(testApp, "/api/engines/openclaw/account", { mode: "program", location: "cyno" });

    const models = (await testApp.app.inject({ method: "GET", url: "/api/engines/openclaw/program/models" })).json() as { models: { id: string }[]; source: string };
    expect(models.source).toBe("program");
    expect(models.models.map((model) => model.id)).toEqual(["openai/gpt-5.2", "openai/gpt-5.2-mini"]);

    // Formato inválido: recusa; de qualquer provedor: aceita.
    await put(testApp, "/api/engines/openclaw/config", { model: "semprovedor" }, 400);
    await put(testApp, "/api/engines/openclaw/config", { model: "anthropic/claude-sonnet-4" });
    let verify = ((await post(testApp, "/api/engines/openclaw/verify")).json() as { result: EngineVerifyResult }).result;
    expect(verify.checks.find((check) => check.id === "account")).toMatchObject({ ok: true, detail: expect.stringContaining("openai (assinatura (OAuth))") });
    expect(verify.checks.find((check) => check.id === "model")).toMatchObject({ ok: false, detail: expect.stringContaining('"anthropic"') });
    expect(verify.pendingTurn).toBeUndefined();

    await put(testApp, "/api/engines/openclaw/config", { model: "openai/gpt-5.2" });
    verify = ((await post(testApp, "/api/engines/openclaw/verify")).json() as { result: EngineVerifyResult }).result;
    expect(verify.checks.find((check) => check.id === "model")).toMatchObject({ ok: true });
    expect(verify.pendingTurn?.notice).toContain("sai da sua assinatura no provedor openai");
    // O turno de teste de verdade (CLI falsa): confirma e responde.
    verify = ((await post(testApp, "/api/engines/openclaw/verify", { confirm: true })).json() as { result: EngineVerifyResult }).result;
    expect(verify.turn).toMatchObject({ ok: true });
    expect(verify.ok).toBe(true);
    expect((await statusOf(testApp, "openclaw")).state).toBe("working");
    // O turno de teste também roda sem chave do painel.
    const last = (await agentRuns(testApp.runLog)).at(-1)!;
    expect(last.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(last.argv[last.argv.indexOf("--model") + 1]).toBe("openai/gpt-5.2");
  });

  it("sem provedor ligado: o Verificar para na conta e mostra o comando exato; o estado diz 'sem conta'", async () => {
    const testApp = await setup();
    await mkdir(testApp.roots.openclaw, { recursive: true });
    await writeJson(path.join(testApp.roots.openclaw, "fake-status.json"), { providers: [] });
    await put(testApp, "/api/engines/openclaw/account", { mode: "program", location: "cyno" });
    const verify = ((await post(testApp, "/api/engines/openclaw/verify")).json() as { result: EngineVerifyResult }).result;
    const account = verify.checks.find((check) => check.id === "account");
    expect(account).toMatchObject({ ok: false });
    expect(account!.fix).toContain(`HOME='${path.join(testApp.roots.openclaw, "home")}'`);
    expect(account!.fix).toContain("openclaw configure");
    const status = await statusOf(testApp, "openclaw");
    expect(status.state).toBe("no_login");
    expect(status.programSetup?.commands[0]).toContain("openclaw configure");
    expect(status.steps?.find((step) => step.id === "key")).toMatchObject({ label: "Conta", state: "current" });
  });
});

describe("Hermes: as duas formas de conta, ponta a ponta com a CLI falsa", () => {
  it("chave do painel, configuração do Cyno (provedor/modelo de qualquer provedor) e a pasta pessoal só é lida (cada agente tem o seu HERMES_HOME)", { timeout: 30_000 }, async () => {
    const testApp = await setup();
    const beto = await agentOn(testApp, "Beto", "hermes");
    await put(testApp, "/api/engines/hermes/config", { model: "deepseek/deepseek-chat" });
    await runTask(testApp, beto, "Diga olá");
    let run = (await agentRuns(testApp.runLog)).at(-1)!;
    expect(run.env.OPENROUTER_API_KEY).toBe(PANEL_KEY);
    expect(run.argv).toContain("--provider");
    expect(run.argv[run.argv.indexOf("--provider") + 1]).toBe("openrouter");
    expect(run.env.HERMES_HOME).toContain(path.join(testApp.roots.hermes, "agent-homes"));

    // Configuração do programa na pasta do Cyno: sem chave; provedor e modelo separados da referência.
    await put(testApp, "/api/engines/hermes/account", { mode: "program", location: "cyno" });
    await put(testApp, "/api/engines/hermes/config", { model: "anthropic/claude-sonnet-4" });
    await runTask(testApp, beto, "Diga olá de novo");
    run = (await agentRuns(testApp.runLog)).at(-1)!;
    expect(run.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(run.env.HERMES_HOME).toContain(path.join(testApp.roots.hermes, "agent-homes"));
    expect(run.argv[run.argv.indexOf("--provider") + 1]).toBe("anthropic");
    expect(run.argv[run.argv.indexOf("-m") + 1]).toBe("claude-sonnet-4");

    // Pasta pessoal: o Cyno só LÊ o config.yaml do dono (nunca escreve nele) e não há nada a confirmar; cada agente tem o HERMES_HOME dele.
    const personalHome = path.join(testApp.home, ".hermes");
    await mkdir(personalHome, { recursive: true });
    const original = "model:\n  default: x\nmcp_servers:\n  do-dono:\n    url: http://dono\n";
    await writeFile(path.join(personalHome, "config.yaml"), original);
    process.env.FAKE_HERMES_PERSONAL_HOME = personalHome;
    await put(testApp, "/api/engines/hermes/account", { location: "personal" });
    const status = await statusOf(testApp, "hermes");
    // A confirmação da escrita no config.yaml pessoal foi removida (código morto desde o HERMES_HOME por agente): nada no estado, nada no Verificar.
    expect((status as Record<string, unknown>).personalConfig).toBeUndefined();
    await runTask(testApp, beto, "Pasta pessoal");
    run = (await agentRuns(testApp.runLog)).at(-1)!;
    expect(run.env.HERMES_HOME).toContain(path.join(testApp.roots.hermes, "agent-homes"));
    expect(run.env.HOME).toBe(path.join(testApp.roots.hermes, "userhome"));
    expect(run.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(await readFile(path.join(personalHome, "config.yaml"), "utf8")).toBe(original);
    // O config.yaml do agente parte do do dono, sem os servidores MCP dele, e leva o MCP "office" e as travas.
    const generated = (await agentRuns(testApp.runLog)).at(-1)!.config as unknown as string;
    expect(generated).toContain("default: x");
    expect(generated).not.toContain("do-dono");
    expect(generated).toContain("mcp_servers:");
    expect(generated).toContain("adopt_external_logins: false");
    const verify = ((await post(testApp, "/api/engines/hermes/verify")).json() as { result: EngineVerifyResult }).result;
    expect(verify.checks.find((check) => check.id === "personal-config")).toBeUndefined();
  });

  it("detecta os provedores do `auth list` (pessoal e do Cyno) sem mostrar a chave, e a leitura vem marcada como verificada com o programa de verdade", async () => {
    const testApp = await setup();
    const personalFile = path.join(testApp.dir, "personal-auth.txt");
    process.env.FAKE_HERMES_PERSONAL_AUTH = personalFile;
    await writeFile(personalFile, `openrouter (1 credentials):\n  #1  OPENROUTER_API_KEY api_key id=ab12 priority=0 env:OPENROUTER_API_KEY ${FAKE_KEY} ←\n\nnous (1 credentials):\n  #1  conta oauth id=cd34 priority=0 device_code\n`);
    await mkdir(path.join(testApp.roots.hermes, "home"), { recursive: true });
    await put(testApp, "/api/engines/hermes/account", { mode: "program", location: "personal" });
    const response = await post(testApp, "/api/engines/hermes/program/detect");
    const program = (response.json() as { program: ProgramAccountInfo }).program;
    expect(program).toMatchObject({ ok: true, verified: true, command: "hermes auth list" });
    expect(program.providers).toEqual([
      { provider: "openrouter", kind: "api_key", profiles: 1 },
      { provider: "nous", kind: "oauth", profiles: 1 },
    ]);
    expect(response.body).not.toContain("FAKEKEY");
    // Sem lista de modelos no Hermes: só a digitação livre.
    const models = (await testApp.app.inject({ method: "GET", url: "/api/engines/hermes/program/models" })).json() as { source: string; models: unknown[]; note?: string };
    expect(models).toMatchObject({ source: "none", models: [] });
    expect(models.note).toContain("provedor/modelo");
    // O Verificar na pasta do Cyno (sem provedor lá) para na conta.
    await put(testApp, "/api/engines/hermes/account", { location: "cyno" });
    const verify = ((await post(testApp, "/api/engines/hermes/verify")).json() as { result: EngineVerifyResult }).result;
    expect(verify.checks.find((check) => check.id === "account")).toMatchObject({ ok: false });
  });
});

describe("dados existentes não quebram", () => {
  it("engines.json antigo (sem account) segue na chave do painel, e o `account` guardado sobrevive a um reinício", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "engines.json");
    await writeFile(file, JSON.stringify({ paths: {}, tests: {}, choices: { openclaw: { model: "deepseek/deepseek-chat" } }, spent: {}, verify: {}, personalConfig: { hermes: { confirmedAt: "2026-11-12T00:00:00.000Z" } } }));
    const { EngineSettingsStore } = await import("../../platform/models/engine-settings");
    const old = await EngineSettingsStore.load(file);
    expect(old.account("openclaw")).toEqual({ mode: "openrouter", location: "cyno" });
    expect(old.choices("openclaw").model).toBe("deepseek/deepseek-chat");
    await old.setAccount("hermes", { mode: "program", location: "personal" });
    await old.flush();
    const again = await EngineSettingsStore.load(file);
    expect(again.account("hermes")).toEqual({ mode: "program", location: "personal" });
    expect(again.account("openclaw")).toEqual({ mode: "openrouter", location: "cyno" });
  });
});
