import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineInstallJob, EngineInstallPlan, EngineStatus, EngineStatusResponse, EngineVerifyResult, OpenRouterKeyInfo, OpenRouterModelsResponse } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { call as rawCall } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";
import { useTempDirs } from "../dev/test-utils";
import { ActivityLog } from "../workspace/activity/log";
import type { InstallRecipe } from "../engines/install/recipes";
import type { EngineProbe } from "../engines/terminals/engines";

// A pasta temporária é registrada ANTES do app: o vitest roda os afterEach ao contrário (o app fecha, depois a pasta some).
const tempDir = useTempDirs();
const setupApp = useTestApp();
/** As rotas daqui respondem 200 (POST e DELETE devolvem o estado novo). */
const call = <T = unknown>(app: Parameters<typeof rawCall>[0], method: Parameters<typeof rawCall>[1], url: string, payload?: object, status = 200) => rawCall<T>(app, method, url, payload, status);
const FAKE_OPENCLAW = fileURLToPath(new URL("../engines/terminals/fake-openclaw.mjs", import.meta.url));
const FAKE_HERMES = fileURLToPath(new URL("../engines/terminals/fake-hermes.mjs", import.meta.url));
const MODELS_FIXTURE = fileURLToPath(new URL("../platform/openrouter/fixtures/models.json", import.meta.url));

const GOOD_KEY = "sk-or-v1-CHAVE-BOA-0123456789abcd";
const BAD_KEY = "sk-or-v1-CHAVE-RUIM-0123456789wxyz";
const MANAGEMENT_KEY = "sk-or-v1-CHAVE-GERENCIA-0123456789mm";

/** OpenRouter falso: a lista de modelos (amostra real) e a consulta da chave (aceita só a GOOD_KEY). Nada vai à internet. */
let server: Server | undefined;
const keyCalls: string[] = [];
async function fakeOpenRouter(): Promise<string> {
  const models = await readFile(MODELS_FIXTURE, "utf8");
  server = createServer((request, response) => {
    if (request.url === "/models") return void response.writeHead(200, { "content-type": "application/json" }).end(models);
    if (request.url === "/key") {
      const auth = String(request.headers.authorization ?? "");
      keyCalls.push(auth);
      if (auth === `Bearer ${MANAGEMENT_KEY}`) return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { label: "m", limit: null, usage: 0, limit_remaining: null, is_free_tier: false, is_management_key: true, is_provisioning_key: true } }));
      if (auth !== `Bearer ${GOOD_KEY}`) return void response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "invalid" } }));
      return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { label: "x", limit: 10, usage: 2.5, limit_remaining: 7.5, is_free_tier: false } }));
    }
    response.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
afterEach(async () => {
  keyCalls.length = 0;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

const probe: EngineProbe = async (command, args) => (args.includes("--version") ? { ok: true, stdout: `${path.basename(command)} 2026.11.3\n` } : { ok: false, stdout: "" });

/** Um "executável" de verdade (script) que roda a CLI falsa. */
async function wrapper(dir: string, name: string, script: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  await chmod(file, 0o755);
  return file;
}

async function setup(extra: { hermes?: boolean; recipe?: (engine: "openclaw" | "hermes") => InstallRecipe; probe?: EngineProbe; fenceSupport?: () => { available: boolean; abi: number; python?: string; reason?: string } } = {}) {
  const dir = await tempDir();
  const base = await fakeOpenRouter();
  const openclawBin = await wrapper(path.join(dir, "bin"), "openclaw", FAKE_OPENCLAW);
  const hermesBin = await wrapper(path.join(dir, "bin"), "hermes", FAKE_HERMES);
  const dataDir = path.join(dir, "data");
  // Só grava quando o teste manda (`activity.flush()`): nada escreve na pasta depois de o teste acabar.
  const activity = new ActivityLog({ dataDir, flushMs: 1_000_000 });
  const test = await setupApp({
    activity,
    dataDir: await (async () => {
      await mkdir(dataDir, { recursive: true });
      const { seedDataDir } = await import("../workspace/office/seed");
      await seedDataDir(dataDir);
      return dataDir;
    })(),
    engineTools: { probe: extra.probe ?? probe, pathEnv: path.join(dir, "bin"), homeDir: path.join(dir, "home") },
    terminals: {
      claude: { command: "/nao-existe/claude" },
      gemini: { command: "/nao-existe/agy" },
      openclaw: { command: openclawBin, homeDir: path.join(dataDir, "platform", "engines", "openclaw"), stopGraceMs: 300 },
      hermes: { command: extra.hermes === false ? "/nao-existe/hermes" : hermesBin, homeDir: path.join(dataDir, "platform", "engines", "hermes"), stopGraceMs: 300 },
    },
    oneShot: { openrouter: { baseUrl: base }, ...(extra.fenceSupport ? { fenceSupport: extra.fenceSupport } : {}), ...(extra.recipe ? { recipe: extra.recipe } : {}), installFetch: async () => ({ ok: true, status: 200, text: async () => "#!/bin/sh\necho instalador falso\n" }) },
  });
  return { ...test, dir, dataDir, base, activity };
}

const statusOf = async (test: { app: Parameters<typeof call>[0] }, id: string): Promise<EngineStatus> => (await call<EngineStatusResponse>(test.app, "GET", "/api/engines/status")).engines.find((engine) => engine.id === id)!;

describe("a chave do OpenRouter (tela Motores)", () => {
  it("entra pelo painel, fica com modo 600 e NENHUMA rota devolve o valor", async () => {
    const test = await setup();
    // Formato inválido: recusa com mensagem.
    await call(test.app, "PUT", "/api/engines/openrouter/key", { key: "isto-nao-e-chave-nenhuma" }, 400);
    expect(await call<OpenRouterKeyInfo>(test.app, "GET", "/api/engines/openrouter/key")).toEqual({ configured: false });

    const saved = await call<OpenRouterKeyInfo>(test.app, "PUT", "/api/engines/openrouter/key", { key: GOOD_KEY });
    expect(saved).toMatchObject({ configured: true, last4: GOOD_KEY.slice(-4) });
    const file = path.join(test.dataDir, "platform", "openrouter-key.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    // Nenhuma resposta traz a chave: nem a da própria rota, nem o estado dos motores, nem a lista de modelos, nem o Verificar.
    await call(test.app, "POST", "/api/engines/openrouter/models", {});
    const bodies = [
      JSON.stringify(saved),
      JSON.stringify(await call(test.app, "GET", "/api/engines/openrouter/key")),
      JSON.stringify(await call(test.app, "GET", "/api/engines/status")),
      JSON.stringify(await call(test.app, "GET", "/api/engines/openrouter/models")),
      JSON.stringify(await call(test.app, "POST", "/api/engines/openclaw/verify", {})),
      JSON.stringify(await call(test.app, "GET", "/api/engines")),
    ];
    for (const body of bodies) expect(body).not.toContain(GOOD_KEY);
    expect(bodies.join("")).not.toContain("CHAVE-BOA");

    // A Atividade registra que a chave mudou, nunca o valor.
    await call(test.app, "PUT", "/api/engines/openrouter/key", { key: BAD_KEY });
    const activityDir = path.join(test.dataDir, "activity");
    const texts: string[] = [];
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) await walk(path.join(folder, entry.name));
        else texts.push(await readFile(path.join(folder, entry.name), "utf8"));
      }
    };
    await test.activity.flush();
    await walk(activityDir);
    await walk(path.join(test.dataDir, "platform"));
    const joined = texts.join("\n");
    expect(joined).toContain("openrouter_chave");
    // O único lugar com o valor é o arquivo da chave.
    const offenders = (await Promise.all([GOOD_KEY, BAD_KEY].map(async (key) => (joined.split(key).length - 1)))).reduce((a, b) => a + b, 0);
    expect(offenders).toBe(1);

    const removed = await call<OpenRouterKeyInfo>(test.app, "DELETE", "/api/engines/openrouter/key");
    expect(removed).toEqual({ configured: false });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({});
  });
});

describe("modelos do OpenRouter e escolha por motor", () => {
  it("a lista vem do OpenRouter sob demanda, fica em disco, e o modelo escolhido é validado e guardado", async () => {
    const test = await setup();
    expect(await call<OpenRouterModelsResponse>(test.app, "GET", "/api/engines/openrouter/models")).toEqual({ models: [], readAt: "" });
    const listed = await call<OpenRouterModelsResponse>(test.app, "POST", "/api/engines/openrouter/models", {});
    expect(listed.models.length).toBeGreaterThan(20);
    const free = listed.models.filter((model) => model.price.free);
    expect(free.length).toBeGreaterThan(0);
    expect(free.every((model) => model.id.endsWith(":free"))).toBe(true);
    const deepseek = listed.models.find((model) => model.id === "deepseek/deepseek-v4-flash")!;
    expect(deepseek.price).toEqual({ free: false, promptPerM: 0.09, completionPerM: 0.18 });
    expect(JSON.parse(await readFile(path.join(test.dataDir, "platform", "openrouter-models.json"), "utf8")).models.length).toBe(listed.models.length);

    // Id com formato inválido: recusa. Modelo da lista: guarda, aparece no estado com o preço.
    await call(test.app, "PUT", "/api/engines/openclaw/config", { model: "sem-barra" }, 400);
    await call(test.app, "PUT", "/api/engines/openclaw/config", { model: "dois/barras/demais:" }, 400);
    const saved = await call<EngineStatusResponse>(test.app, "PUT", "/api/engines/openclaw/config", { model: "deepseek/deepseek-v4-flash", effort: "low" });
    const openclaw = saved.engines.find((engine) => engine.id === "openclaw")!;
    expect(openclaw.choices).toEqual({ model: "deepseek/deepseek-v4-flash", effort: "low" });
    expect(openclaw.modelPrice).toEqual({ free: false, promptPerM: 0.09, completionPerM: 0.18 });
    expect(openclaw.models?.some((model) => model.id === "deepseek/deepseek-v4-flash" && /US\$/.test(model.label ?? ""))).toBe(true);
    // O Hermes não tem esforço; cada motor guarda a própria escolha.
    const hermes = (await call<EngineStatusResponse>(test.app, "PUT", "/api/engines/hermes/config", { model: free[0]!.id, effort: "high" })).engines.find((engine) => engine.id === "hermes")!;
    expect(hermes.choices).toEqual({ model: free[0]!.id });
    expect(hermes.modelPrice).toEqual({ free: true, promptPerM: 0, completionPerM: 0 });
  });
});

describe("chave de gerenciamento do OpenRouter", () => {
  it("ao guardar, avisa que ela não roda modelos (e guarda assim mesmo); a chave comum não traz aviso", async () => {
    const test = await setup();
    const saved = await call<OpenRouterKeyInfo>(test.app, "PUT", "/api/engines/openrouter/key", { key: MANAGEMENT_KEY });
    expect(saved).toMatchObject({ configured: true, last4: MANAGEMENT_KEY.slice(-4) });
    expect(saved.warning).toContain("chave de gerenciamento");
    expect(saved.warning).toContain("crie uma chave de API comum");
    expect(JSON.stringify(saved)).not.toContain(MANAGEMENT_KEY);
    expect((await call<OpenRouterKeyInfo>(test.app, "GET", "/api/engines/openrouter/key")).warning).toBeUndefined();
    const good = await call<OpenRouterKeyInfo>(test.app, "PUT", "/api/engines/openrouter/key", { key: GOOD_KEY });
    expect(good.warning).toBeUndefined();
  });

  it("o Verificar falha na checagem da chave com o que fazer, e o turno de teste não roda", async () => {
    const test = await setup();
    await call(test.app, "PUT", "/api/engines/openrouter/key", { key: MANAGEMENT_KEY });
    await call(test.app, "POST", "/api/engines/openrouter/models", {});
    const free = (await call<OpenRouterModelsResponse>(test.app, "GET", "/api/engines/openrouter/models")).models.find((model) => model.price.free)!;
    await call(test.app, "PUT", "/api/engines/openclaw/config", { model: free.id });
    const { result } = await call<{ result: EngineVerifyResult }>(test.app, "POST", "/api/engines/openclaw/verify", { confirm: true });
    const key = result.checks.find((check) => check.id === "account")!;
    expect(key.ok).toBe(false);
    expect(key.detail).toBe("Esta é uma chave de gerenciamento do OpenRouter (serve para criar e administrar outras chaves). Ela não roda modelos.");
    expect(key.fix).toContain("crie uma chave de API comum");
    expect(result.ok).toBe(false);
    expect(result.turn).toBeUndefined();
    expect(result.pendingTurn).toBeUndefined();
  });
});

describe("a lista inteira e o id digitado", () => {
  it("guarda todos os campos úteis da amostra real (provedor, contexto, preços, modalidades, ferramentas, data)", async () => {
    const test = await setup();
    const listed = await call<OpenRouterModelsResponse>(test.app, "POST", "/api/engines/openrouter/models", {});
    const fixture = JSON.parse(await readFile(MODELS_FIXTURE, "utf8")).data as { id: string }[];
    expect(listed.models.length).toBe(fixture.length);
    expect(listed.models.length).toBeGreaterThan(150);
    const deepseek = listed.models.find((model) => model.id === "deepseek/deepseek-v4-flash")!;
    expect(deepseek).toMatchObject({ provider: "deepseek", contextLength: expect.any(Number), tools: true, price: { free: false, promptPerM: 0.09, completionPerM: 0.18 } });
    expect(deepseek.inputModalities).toContain("text");
    expect(deepseek.created).toBeGreaterThan(1_600_000_000);
    expect(listed.models.every((model) => model.provider === model.id.split("/")[0]!.replace(/^~/, ""))).toBe(true);
    expect(listed.models.some((model) => model.tools === false)).toBe(true);
    // Os apelidos "~vendor/…-latest" também vêm (antes eram descartados).
    expect(listed.models.find((model) => model.id === "~deepseek/deepseek-flash-latest")).toMatchObject({ provider: "deepseek" });
    expect(listed.models.some((model) => model.inputModalities?.includes("image"))).toBe(true);
    // O que veio pela rota é o que foi para o disco.
    const onDisk = JSON.parse(await readFile(path.join(test.dataDir, "platform", "openrouter-models.json"), "utf8")) as OpenRouterModelsResponse;
    expect(onDisk.models).toEqual(listed.models);
  });

  it("id fora da lista é aceito (com ou sem openrouter/), fica marcado como não conferido e o Verificar diz que não existe", async () => {
    const test = await setup();
    await call(test.app, "PUT", "/api/engines/openrouter/key", { key: GOOD_KEY });
    await call(test.app, "POST", "/api/engines/openrouter/models", {});
    const saved = await call<EngineStatusResponse>(test.app, "PUT", "/api/engines/openclaw/config", { model: "openrouter/inventado/modelo-novo:beta" });
    expect(saved.engines.find((engine) => engine.id === "openclaw")!.choices).toEqual({ model: "inventado/modelo-novo:beta", unlisted: true });
    expect(JSON.parse(await readFile(path.join(test.dataDir, "platform", "engines.json"), "utf8")).choices.openclaw).toMatchObject({ unlisted: true });

    const { result } = await call<{ result: EngineVerifyResult }>(test.app, "POST", "/api/engines/openclaw/verify", {});
    const check = result.checks.find((item) => item.id === "model")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("não está na lista atual");
    expect(check.fix).toContain("openrouter.ai/models");
    expect((await statusOf(test, "openclaw")).choices?.unlisted).toBe(true);

    // Trocar por um modelo da lista tira a marca; sem lista nenhuma, o id digitado também é aceito.
    const listedChoice = await call<EngineStatusResponse>(test.app, "PUT", "/api/engines/openclaw/config", { model: "deepseek/deepseek-v4-flash" });
    expect(listedChoice.engines.find((engine) => engine.id === "openclaw")!.choices).toEqual({ model: "deepseek/deepseek-v4-flash" });
    const other = await setup();
    const typed = await call<EngineStatusResponse>(other.app, "PUT", "/api/engines/hermes/config", { model: "deepseek/deepseek-v4-flash" });
    expect(typed.engines.find((engine) => engine.id === "hermes")!.choices).toEqual({ model: "deepseek/deepseek-v4-flash", unlisted: true });
  });

  it("o Verificar acha um id que só entrou na lista depois da última leitura (lê de novo antes de concluir) e tira a marca", async () => {
    const test = await setup();
    await call(test.app, "PUT", "/api/engines/openrouter/key", { key: GOOD_KEY });
    await call(test.app, "PUT", "/api/engines/hermes/config", { model: "deepseek/deepseek-v4-flash" });
    expect((await statusOf(test, "hermes")).choices?.unlisted).toBe(true);
    const { result } = await call<{ result: EngineVerifyResult }>(test.app, "POST", "/api/engines/hermes/verify", {});
    expect(result.checks.find((item) => item.id === "model")).toMatchObject({ ok: true });
    expect((await statusOf(test, "hermes")).choices).toEqual({ model: "deepseek/deepseek-v4-flash" });
  });
});

describe("o passo a passo e o Verificar", () => {
  it("sem chave nem modelo: as etapas dizem a da vez; o Verificar mostra o que falta e o que fazer", async () => {
    const test = await setup();
    const before = await statusOf(test, "openclaw");
    expect(before).toMatchObject({ supported: true, state: "no_login", version: "2026.11.3" });
    expect(before.steps?.map((step) => [step.id, step.state])).toEqual([
      ["install", "done"],
      ["key", "current"],
      ["model", "todo"],
      ["verify", "todo"],
    ]);
    const { result } = await call<{ result: EngineVerifyResult }>(test.app, "POST", "/api/engines/openclaw/verify", {});
    expect(result.ok).toBe(false);
    const byId = Object.fromEntries(result.checks.map((check) => [check.id, check]));
    expect(byId.exe).toMatchObject({ ok: true });
    expect(byId.version).toMatchObject({ ok: true });
    expect(byId.account).toMatchObject({ ok: false, fix: expect.stringContaining("Conta") });
    expect(byId.model).toMatchObject({ ok: false, fix: expect.stringContaining("modelo") });
    expect(byId.mcp?.ok).toBe(true);
    expect(byId.turn).toMatchObject({ ok: null });
  });

  it("com tudo certo: pede a confirmação do turno de teste, roda de verdade (CLI falsa) e põe o motor em Funcionando", async () => {
    const test = await setup();
    await call(test.app, "PUT", "/api/engines/openrouter/key", { key: GOOD_KEY });
    await call(test.app, "POST", "/api/engines/openrouter/models", {});
    const free = (await call<OpenRouterModelsResponse>(test.app, "GET", "/api/engines/openrouter/models")).models.find((model) => model.price.free)!;
    await call(test.app, "PUT", "/api/engines/openclaw/config", { model: free.id });

    const first = (await call<{ result: EngineVerifyResult }>(test.app, "POST", "/api/engines/openclaw/verify", {})).result;
    expect(first.checks.filter((check) => check.id !== "turn").every((check) => check.ok === true)).toBe(true);
    expect(first.checks.find((check) => check.id === "account")?.detail).toContain("Saldo da chave: US$ 7,50 de US$ 10,00");
    expect(first.ok).toBe(false);
    expect(first.pendingTurn).toMatchObject({ model: free.id, price: { free: true } });
    expect(first.pendingTurn!.notice).toContain("gratuito: custo zero");
    expect((await statusOf(test, "openclaw")).state).toBe("installed");

    const second = (await call<{ result: EngineVerifyResult }>(test.app, "POST", "/api/engines/openclaw/verify", { confirm: true })).result;
    expect(second.ok).toBe(true);
    expect(second.turn).toMatchObject({ ok: true, model: free.id });
    expect(second.checks.find((check) => check.id === "turn")).toMatchObject({ ok: true });
    const after = await statusOf(test, "openclaw");
    expect(after.state).toBe("working");
    expect(after.steps?.every((step) => step.state === "done")).toBe(true);
    expect(after.lastTest).toMatchObject({ ok: true });
    // O turno de teste gastou: entra no histórico como teste.
    await test.app.cyno.usageHistory.idle();
    expect((await test.app.cyno.usageHistory.read()).find((record) => record.provider === "openclaw")).toMatchObject({ agentName: "Verificar o motor OpenClaw", test: true });
  });

  it("chave recusada pelo OpenRouter: a checagem falha com o que fazer, a etapa vira erro e o turno não roda", async () => {
    const test = await setup();
    await call(test.app, "PUT", "/api/engines/openrouter/key", { key: BAD_KEY });
    await call(test.app, "POST", "/api/engines/openrouter/models", {});
    const model = (await call<OpenRouterModelsResponse>(test.app, "GET", "/api/engines/openrouter/models")).models[0]!;
    await call(test.app, "PUT", "/api/engines/hermes/config", { model: model.id });
    const { result } = await call<{ result: EngineVerifyResult }>(test.app, "POST", "/api/engines/hermes/verify", { confirm: true });
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === "account")).toMatchObject({ ok: false, detail: expect.stringContaining("recusou"), fix: expect.stringContaining("Trocar") });
    expect(result.checks.find((check) => check.id === "turn")).toMatchObject({ ok: null });
    expect(result.turn).toBeUndefined();
    expect((await statusOf(test, "hermes")).steps?.find((step) => step.id === "key")).toMatchObject({ state: "error" });
  });

  it("Hermes: o Verificar roda o turno pela CLI falsa (HERMES_HOME do Cyno, --provider openrouter, chave só no ambiente)", async () => {
    const test = await setup();
    await call(test.app, "PUT", "/api/engines/openrouter/key", { key: GOOD_KEY });
    await call(test.app, "POST", "/api/engines/openrouter/models", {});
    const free = (await call<OpenRouterModelsResponse>(test.app, "GET", "/api/engines/openrouter/models")).models.find((model) => model.price.free)!;
    await call(test.app, "PUT", "/api/engines/hermes/config", { model: free.id });
    const { result } = await call<{ result: EngineVerifyResult }>(test.app, "POST", "/api/engines/hermes/verify", { confirm: true });
    expect(result).toMatchObject({ ok: true, turn: { ok: true } });
    expect((await statusOf(test, "hermes")).state).toBe("working");
    await test.app.cyno.usageHistory.idle();
    // O config.yaml do HERMES_HOME do Cyno nunca ganha a chave.
    const home = path.join(test.dataDir, "platform", "engines", "hermes", "home");
    const yaml = await readFile(path.join(home, "config.yaml"), "utf8").catch(() => "");
    expect(yaml).not.toContain("sk-or");
  });
});

describe("instalar o Hermes pelo painel (receita falsa, sem rede)", () => {
  /** Receita falsa: o "instalador" só cria um executável falso numa pasta do Cyno. */
  function fakeRecipe(root: string): (engine: "openclaw" | "hermes") => InstallRecipe {
    const bin = path.join(root, "instalado", "hermes");
    const script = `const fs=require("fs");fs.mkdirSync(require("path").dirname(${JSON.stringify(bin)}),{recursive:true});fs.writeFileSync(${JSON.stringify(bin)},"#!/bin/sh\\nexec ${process.execPath} ${FAKE_HERMES} \\"$@\\"\\n",{mode:0o755});console.log("hermes falso instalado");`;
    return (engine) => ({
      plan: {
        engine,
        title: `Instalar o ${engine} (receita falsa)`,
        command: `node -e <cria ${bin}>`,
        steps: ["Cria um executável falso."],
        downloads: [],
        destination: path.dirname(bin),
        needsSudo: false,
        sudoNote: "Sem sudo.",
        touches: [],
        unverified: [],
      },
      steps: [
        { kind: "download", label: "Baixando (falso)", url: "https://exemplo.invalido/install.sh", to: path.join(root, "install.sh") },
        { kind: "run", label: "Instalando (falso)", command: process.execPath, args: ["-e", script] },
      ],
      binaryCandidates: [bin],
    });
  }

  it("mostra o plano, RECUSA sem confirmação (nada é instalado) e instala depois do OK, com a saída e na Atividade", async () => {
    const dir = await tempDir();
    const test = await setup({ hermes: false, recipe: fakeRecipe(dir) });
    const before = await statusOf(test, "hermes");
    expect(before).toMatchObject({ state: "not_installed", installable: true });
    expect(before.steps?.[0]).toMatchObject({ id: "install", label: "Instalar", state: "current" });

    const { plan } = await call<{ plan: EngineInstallPlan }>(test.app, "POST", "/api/engines/hermes/install/plan", {});
    expect(plan).toMatchObject({ engine: "hermes", needsSudo: false, destination: path.dirname(path.join(dir, "instalado", "hermes")) });

    // Sem `confirm: true`: 409 e nada roda.
    const refused = await call<{ error: string }>(test.app, "POST", "/api/engines/hermes/install", {}, 409);
    expect(refused.error).toContain("confirme");
    await call(test.app, "POST", "/api/engines/hermes/install", { confirm: false }, 409);
    expect(await stat(path.join(dir, "instalado", "hermes")).then(() => true, () => false)).toBe(false);
    expect((await call<{ job: EngineInstallJob | null }>(test.app, "GET", "/api/engines/hermes/install")).job).toBeNull();

    const { job } = await call<{ job: EngineInstallJob }>(test.app, "POST", "/api/engines/hermes/install", { confirm: true });
    expect(job).toMatchObject({ engine: "hermes", status: "running" });
    // Espera o fim: o estado passa a "instalado" (achou o executável novo) e a saída fica guardada.
    let status = await statusOf(test, "hermes");
    for (let i = 0; i < 100 && status.installJob?.status === "running"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = await statusOf(test, "hermes");
    }
    expect(status.installJob).toMatchObject({ status: "done" });
    expect(status.installJob?.log.join("\n")).toContain("hermes falso instalado");
    expect(status).toMatchObject({ state: "no_login", path: path.join(dir, "instalado", "hermes") });
    expect(status.steps?.map((step) => step.state)).toEqual(["done", "current", "todo", "todo"]);

    const walk = async (folder: string): Promise<string[]> => {
      const out: string[] = [];
      for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) out.push(entry.isDirectory() ? (await walk(path.join(folder, entry.name))).join("\n") : await readFile(path.join(folder, entry.name), "utf8"));
      return out;
    };
    await test.activity.flush();
    const written = (await walk(path.join(test.dataDir, "activity"))).join("\n");
    expect(written).toContain("motor_instalacao_confirmada");
    expect(written).toContain("motor_instalado");
  });
});

describe("teto de gateways do Hermes e primeira consulta lenta (revisão 2)", () => {
  it("o teto padrão é 2, a tela muda (1 a 8) e o valor fica guardado", async () => {
    const test = await setup();
    expect((await statusOf(test, "hermes")).gateways).toEqual({ max: 2, inUse: 0, waiting: 0 });
    expect((await statusOf(test, "openclaw")).gateways).toBeUndefined();
    await call(test.app, "PUT", "/api/engines/hermes/config", { maxGateways: 4 });
    expect((await statusOf(test, "hermes")).gateways?.max).toBe(4);
    await call(test.app, "PUT", "/api/engines/hermes/config", { maxGateways: 0 }, 400);
    await call(test.app, "PUT", "/api/engines/hermes/config", { maxGateways: 9 }, 400);
    expect((await statusOf(test, "hermes")).gateways?.max).toBe(4);
  });

  it("a cerca de arquivos: estado, opção da tela e o que a tela diz de cada caso", async () => {
    const fenceSupport = () => ({ available: true, abi: 8, python: "/usr/bin/python3" });
    const test = await setup({ fenceSupport });
    const hermes = await statusOf(test, "hermes");
    expect(hermes.fence).toEqual({ enabled: true, available: true, active: true, abi: 8 });
    expect(hermes.unverified?.join("\n")).toContain("Cerca de arquivos (Landlock), provada com o Hermes");
    expect(hermes.unverified?.join("\n")).not.toContain("NÃO CONFINADO");
    expect((await statusOf(test, "openclaw")).fence).toMatchObject({ enabled: true, active: true });
    expect((await call<{ engines: { engine: string; fenced?: boolean }[] }>(test.app, "GET", "/api/engines")).engines.filter((info) => info.fenced).map((info) => info.engine).sort()).toEqual(["hermes", "openclaw"]);

    // Desligar vale para o motor escolhido e volta ao aviso antigo.
    await call(test.app, "PUT", "/api/engines/hermes/config", { fence: false });
    const off = await statusOf(test, "hermes");
    expect(off.fence).toEqual({ enabled: false, available: true, active: false, abi: 8 });
    expect(off.unverified?.join("\n")).toContain("NÃO CONFINADO");
    expect((await statusOf(test, "openclaw")).fence?.active).toBe(true);
    await call(test.app, "PUT", "/api/engines/hermes/config", { fence: "sim" }, 400);
    await call(test.app, "PUT", "/api/engines/hermes/config", { fence: true });
    expect((await statusOf(test, "hermes")).fence?.active).toBe(true);
  });

  it("sem Landlock neste computador a cerca não existe, a opção fica guardada e a tela diz o motivo", async () => {
    const test = await setup({ fenceSupport: () => ({ available: false, abi: 0, reason: "Este computador não tem Landlock ligado." }) });
    const hermes = await statusOf(test, "hermes");
    expect(hermes.fence).toEqual({ enabled: true, available: false, active: false, reason: "Este computador não tem Landlock ligado." });
    expect(hermes.unverified?.join("\n")).toContain("NÃO CONFINADO");
    expect((await call<{ engines: { engine: string; fenced?: boolean }[] }>(test.app, "GET", "/api/engines")).engines.some((info) => info.fenced)).toBe(false);
  });

  it("o OpenClaw na pasta pessoal do dono roda sem cerca, e a tela diz por quê", async () => {
    const test = await setup({ fenceSupport: () => ({ available: true, abi: 8, python: "/usr/bin/python3" }) });
    await call(test.app, "PUT", "/api/engines/openclaw/account", { mode: "program", location: "personal" });
    const openclaw = await statusOf(test, "openclaw");
    expect(openclaw.fence).toMatchObject({ enabled: true, available: true, active: false });
    expect(openclaw.fence?.reason).toMatch(/pasta pessoal/);
  });

  it("o `--version` que passa do tempo não vira 'não instalado': mostra instalado, preparando, e a consulta seguinte acha a versão", async () => {
    let calls = 0;
    const slowFirst: EngineProbe = async (command, args, timeoutMs) => {
      if (!args.includes("--version") || !command.endsWith("hermes")) return args.includes("--version") ? { ok: true, stdout: "openclaw 2026.11.3\n" } : { ok: false, stdout: "" };
      calls += 1;
      // A primeira consulta (10 s) estoura; a segunda, com mais tempo, responde.
      if (timeoutMs <= 10_000) return { ok: false, stdout: "", error: "tempo esgotado", timedOut: true };
      await new Promise((resolve) => setTimeout(resolve, 600));
      return { ok: true, stdout: "Hermes Agent v0.23.1\n" };
    };
    const test = await setup({ probe: slowFirst });
    const first = await statusOf(test, "hermes");
    expect(first.state).not.toBe("not_installed");
    expect(first.notice).toMatch(/preparando/);
    expect(first.version).toBeUndefined();
    // Dá a vez à tentativa longa, em segundo plano.
    await new Promise((resolve) => setTimeout(resolve, 900));
    const second = await statusOf(test, "hermes");
    expect(second.state).not.toBe("not_installed");
    expect(second.version).toBe("v0.23.1");
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
