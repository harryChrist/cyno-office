import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { catalogSchema, type CatalogApp, type RecipeStep, type ServerEvent } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { WriteQueue } from "../../store/write-queue";
import { AppInstaller, type AppConnectorInput, type AppLibraryPort, type MiniTestResult } from "./installer";
import { appsPaths } from "./paths";
import type { MachineProbe } from "./requirements";
import { AppsStore } from "./store";
import { defaultExecutors, NeedsOwnerError, type StepContext, type StepExecutors } from "./steps";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 })));
});

const RECIPE_V1: RecipeStep[] = [
  { run: "download-runtime", runtime: "uv", label: "Baixar o uv" },
  { run: "venv", python: "3.12" },
  { run: "pip-install", packages: ["fake-pkg==1.0.0"], timeoutSec: 30 },
];

function fakeApp(over: Partial<CatalogApp> = {}): CatalogApp {
  return catalogSchema.parse([
    {
      id: "fake",
      name: "Fake",
      area: "documentos",
      status: "disponivel",
      summary: "App de mentira.",
      repo: "https://github.com/exemplo/fake",
      version: { kind: "pypi", ref: "fake-pkg 1.0.0" },
      recipeVersion: "1",
      license: { spdx: "MIT", level: "livre" },
      warnings: ["Aviso de teste"],
      requires: [{ kind: "python", spec: ">=3.12", provision: "uv-python" }, { kind: "disk", spec: "100MB" }],
      recipe: RECIPE_V1,
      provides: { connector: { name: "Fake", description: "Conector de teste", command: [".venv/bin/fake-mcp"], expectTools: ["do_it"] } },
      test: { tool: "do_it", args: { x: 1 }, expect: { contains: "ok" }, timeoutSec: 10 },
      resources: { ramMB: 100, diskMB: 50 },
      ...over,
    },
  ])[0]!;
}

type World = Awaited<ReturnType<typeof setup>>;

async function setup(options: { catalog?: CatalogApp[]; stdio?: boolean; disk?: number; writeFiles?: boolean } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cyno-apps-"));
  dirs.push(dataDir);
  const paths = appsPaths(dataDir);
  const store = await AppsStore.open(paths, new WriteQueue());
  const events: ServerEvent[] = [];
  const records: { action: string; summary: string }[] = [];
  const connectors = new Map<string, AppConnectorInput & { enabled: boolean }>();
  const calls: string[] = [];
  const testArgs: Record<string, unknown>[] = [];
  const skills: { appId: string; appPath: string }[] = [];
  const removedSkills: string[] = [];
  const behavior = { test: { ok: true, tool: "do_it", detail: "ok", ms: 5 } as MiniTestResult, steps: {} as Record<string, (step: RecipeStep, appDir: string) => Promise<void>> };
  const port: AppLibraryPort = {
    stdioAllowed: () => options.stdio ?? true,
    upsertAppConnector: async (input) => {
      const id = input.appId;
      connectors.set(id, { ...input, enabled: true });
      return id;
    },
    removeAppConnectors: async (appId) => {
      const removed = [...connectors.keys()].filter((id) => connectors.get(id)!.appId === appId);
      for (const id of removed) connectors.delete(id);
      return removed;
    },
    setConnectorEnabled: async (id, enabled) => void (connectors.has(id) && (connectors.get(id)!.enabled = enabled)),
    connectorExists: (id) => connectors.has(id),
    registerAppSkill: async (appId, appPath) => {
      skills.push({ appId, appPath });
      return `${appId}-${appPath.replace(/\W+/g, "-")}`;
    },
    removeAppSkills: async (appId) => {
      removedSkills.push(appId);
      return [];
    },
    stopApp: async () => undefined,
    miniTest: async (_id, test) => {
      testArgs.push(test.args);
      return behavior.test;
    },
  };
  const probe: MachineProbe = { platform: "linux", arch: "x64", totalMemMB: () => 8000, availMemMB: () => 5000, diskFreeMB: () => options.disk ?? 50_000, which: (bin) => (bin === "python3" ? "/usr/bin/python3" : undefined), nodeVersion: "26.0.0", runtimeInstalled: () => false };
  // Executores falsos: cada um cria o que o passo de verdade criaria (nada de rede, nada de processo).
  const make = (run: RecipeStep["run"]) => async (step: RecipeStep, ctx: { appDir: string; runtimesRoot: string; createdRuntimes: Set<string> }) => {
    calls.push(run);
    if (ctx.createdRuntimes && run === "download-runtime") {
      await mkdir(path.join(ctx.runtimesRoot, "uv", "bin"), { recursive: true });
      await writeFile(path.join(ctx.runtimesRoot, "uv", "bin", "uv"), "x");
      ctx.createdRuntimes.add("uv");
    }
    if (run === "venv") {
      await mkdir(path.join(ctx.appDir, ".venv", "bin"), { recursive: true });
      await writeFile(path.join(ctx.appDir, ".venv", "bin", "python"), "x");
    }
    if (run === "pip-install") await writeFile(path.join(ctx.appDir, ".venv", "bin", "fake-mcp"), "x".repeat(1000));
    if (run === "write-file" && options.writeFiles) await defaultExecutors["write-file"](step as never, ctx as unknown as StepContext);
    await behavior.steps[run]?.(step, ctx.appDir);
  };
  const executors = Object.fromEntries((["download-runtime", "venv", "pip-install", "npm-install", "git-clone", "download", "write-file", "exec", "require-system"] as const).map((run) => [run, make(run)])) as unknown as StepExecutors;
  const installer = new AppInstaller({
    paths,
    catalog: options.catalog ?? [fakeApp()],
    store,
    port,
    probe,
    executors,
    publish: (event) => events.push(structuredClone(event)),
    record: (action, summary) => records.push({ action, summary }),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date("2026-11-11T12:00:00Z"),
  });
  return { dataDir, paths, store, installer, events, records, connectors, calls, behavior, port, probe, executors, testArgs, skills, removedSkills };
}

const exists = (file: string) => stat(file).then(() => true, () => false);
const jobsOf = (world: World) => world.events.filter((event): event is Extract<ServerEvent, { type: "library:job" }> => event.type === "library:job").map((event) => event.job);

describe("AppInstaller: plano", () => {
  it("monta o plano por código: requisitos nesta máquina, downloads, passos, tamanho e o que entrega; nada liberado", async () => {
    const world = await setup();
    const plan = world.installer.plan("fake");
    expect(plan).toMatchObject({ appId: "fake", canInstall: true, blockers: [], diskMB: 50, ramMB: 100, stdioAllowed: true, license: { spdx: "MIT" }, warnings: ["Aviso de teste"] });
    expect(plan.requirements.map((r) => [r.kind, r.status])).toEqual([["python", "baixa"], ["disk", "ok"]]);
    expect(plan.downloads.map((d) => d.from).join(" ")).toContain("github.com/astral-sh/uv");
    expect(plan.steps).toEqual(["Baixar o uv", "Criar o ambiente Python 3.12", "Instalar fake-pkg==1.0.0", "Registrar o conector na Biblioteca", "Mini teste: subir o MCP e chamar uma ferramenta"]);
    expect(plan.provides).toMatch(/Nada é liberado a ninguém/);
  });

  it("bloqueia: conectores locais desligados, pouco disco, app em breve", async () => {
    const off = await setup({ stdio: false });
    expect(off.installer.plan("fake")).toMatchObject({ canInstall: false, stdioAllowed: false });
    expect(off.installer.plan("fake").blockers[0]).toMatch(/CONNECTORS_STDIO=1/);
    await expect(off.installer.install("fake")).rejects.toMatchObject({ statusCode: 403 });
    const small = await setup({ disk: 10 });
    expect(small.installer.plan("fake")).toMatchObject({ canInstall: false });
    expect(small.installer.plan("fake").blockers.join(" ")).toMatch(/Espaço em disco/);
    const soon = await setup({ catalog: [fakeApp({ status: "em-breve", recipe: [], provides: {}, test: undefined, pending: "Chega depois." })] });
    expect(soon.installer.plan("fake")).toMatchObject({ canInstall: false, blockers: ["Chega depois."] });
    await expect(soon.installer.install("fake")).rejects.toMatchObject({ statusCode: 409 });
    await expect(soon.installer.install("nao-existe")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("licença restrita só instala com o aceite, e registra a data", async () => {
    const restricted = fakeApp({ license: { spdx: "Custom", level: "restrita", notice: "Paga acima de 3 funcionários", mustAccept: true } });
    const world = await setup({ catalog: [restricted] });
    await expect(world.installer.install("fake", { acceptLicense: false })).rejects.toMatchObject({ statusCode: 400 });
    const { app } = await world.installer.install("fake", { acceptLicense: true });
    expect(app.license.acceptedAt).toBe("2026-11-11T12:00:00.000Z");
    await world.installer.idle();
  });
});

describe("AppInstaller: conector com {app} e skills do app", () => {
  it("{app} nos argumentos e nas variáveis vira o caminho da pasta do app (o MCP roda em outra pasta); o teste também", async () => {
    const world = await setup({ catalog: [fakeApp({ provides: { connector: { name: "Fake", description: "x", command: [".venv/bin/fake-mcp", "{app}/src/server.py"], env: { DADOS: "{app}/dados" }, expectTools: ["do_it"] } }, test: { tool: "do_it", args: { arquivo: "{app}/test/a.mp4", lista: ["{app}/x"] }, expect: {}, timeoutSec: 10 } })] });
    await world.installer.install("fake", {});
    await world.installer.idle();
    const appDir = world.paths.appDir("fake");
    const connector = world.connectors.get("fake")!;
    expect(connector.args).toEqual([`${appDir}/src/server.py`]);
    expect(connector.env.DADOS).toBe(`${appDir}/dados`);
    expect(world.testArgs.at(-1)).toEqual({ arquivo: `${appDir}/test/a.mp4`, lista: [`${appDir}/x`] });
  });

  it("cada skill do app é copiada (só o permitido), registrada sem liberação, e some na desinstalação; o job ganha o passo", async () => {
    const skill = { from: "src/skills/demo", include: ["SKILL.md", "references/*.md"] };
    const world = await setup({
      catalog: [
        fakeApp({
          recipe: [...RECIPE_V1, { run: "write-file", to: "src/skills/demo/SKILL.md", content: "---\nname: demo\ndescription: Demo.\n---\n# demo" }, { run: "write-file", to: "src/skills/demo/references/a.md", content: "a" }, { run: "write-file", to: "src/skills/demo/assets/x.html", content: "x" }],
          provides: { connector: { name: "Fake", description: "x", command: [".venv/bin/fake-mcp"], env: {}, expectTools: ["do_it"] }, skills: [skill] },
        }),
      ],
      writeFiles: true,
    });
    const { job } = await world.installer.install("fake", {});
    expect(job.steps.map((step) => step.label)).toEqual(expect.arrayContaining(["Registrar as skills do app na Biblioteca"]));
    await world.installer.idle();
    expect(world.skills).toEqual([{ appId: "fake", appPath: "src/skills/demo" }]);
    const staged = path.join(world.paths.appDir("fake"), ".skills", "0");
    expect(await readFile(path.join(staged, "references", "a.md"), "utf8")).toBe("a");
    await expect(stat(path.join(staged, "assets"))).rejects.toThrow();
    expect(world.store.get("fake")!.provides.skillIds).toEqual(["fake-src-skills-demo"]);
    await world.installer.uninstall("fake");
    expect(world.removedSkills).toEqual(["fake"]);
  });
});

describe("AppInstaller: instalar", () => {
  it("do clique ao 'instalado e testado': passos na ordem, fases, conector sem liberação, log e Atividade", async () => {
    const world = await setup();
    const { app, job } = await world.installer.install("fake", {});
    expect(app.state).toBe("instalando");
    expect(job.kind).toBe("install");
    await world.installer.idle();
    expect(world.calls).toEqual(["download-runtime", "venv", "pip-install"]);
    const done = world.store.get("fake")!;
    expect(done).toMatchObject({ state: "instalado", recipeVersion: "1", provides: { connectorIds: ["fake"] }, lastTest: { ok: true, tool: "do_it" } });
    expect(done.sizeBytes).toBeGreaterThan(1000);
    // O conector nasce na Biblioteca com o comando DENTRO da pasta do app e os caches do app; ninguém recebe.
    const connector = world.connectors.get("fake")!;
    expect(connector.command).toBe(path.join(world.paths.appDir("fake"), ".venv", "bin", "fake-mcp"));
    expect(connector.env.UV_CACHE_DIR).toBe(path.join(world.paths.appDir("fake"), ".cache", "uv"));
    expect(connector.warnings).toEqual(["Aviso de teste"]);
    // Fases mostradas ao dono.
    const phases = jobsOf(world).map((j) => j.phase);
    expect(phases).toEqual(expect.arrayContaining(["checando", "baixando", "construindo", "registrando", "testando", "pronto"]));
    expect(phases.at(-1)).toBe("pronto");
    const log = await world.installer.log(job.id);
    expect(log).toMatch(/Instalando Fake/);
    expect(log).toMatch(/\[1\/5\] Baixar o uv/);
    expect(log).toMatch(/Pronto: Fake instalado e testado/);
    expect(world.events.some((event) => event.type === "library:job-log")).toBe(true);
    expect(world.records.map((r) => r.action)).toEqual(["app-instalacao-iniciada", "app-instalado"]);
    // apps.json e jobs persistem.
    expect(await exists(world.paths.appsFile)).toBe(true);
    expect(await exists(path.join(world.paths.jobsDir, `${job.id}.json`))).toBe(true);
    // Já instalado: não instala de novo.
    await expect(world.installer.install("fake")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("mini teste que falha: instalado com problema, conector desligado, e 'Testar de novo' conserta", async () => {
    const world = await setup();
    world.behavior.test = { ok: false, tool: "do_it", detail: "a resposta não tem ok", ms: 3 };
    await world.installer.install("fake");
    await world.installer.idle();
    expect(world.store.get("fake")).toMatchObject({ state: "instalado", lastTest: { ok: false, detail: "a resposta não tem ok" } });
    expect(world.connectors.get("fake")!.enabled).toBe(false);
    expect(world.records.map((r) => r.action)).toContain("app-instalado-com-problema");
    world.behavior.test = { ok: true, tool: "do_it", detail: "ok agora", ms: 4 };
    const fixed = await world.installer.retest("fake");
    expect(fixed.lastTest).toMatchObject({ ok: true, detail: "ok agora" });
    expect(world.connectors.get("fake")!.enabled).toBe(true);
  });

  it("falha num passo: 'falhou' com o motivo; retoma do passo que parou sem refazer os anteriores", async () => {
    const world = await setup();
    let attempts = 0;
    world.behavior.steps["pip-install"] = async () => {
      if (++attempts === 1) throw new Error("rede caiu");
    };
    await world.installer.install("fake");
    await world.installer.idle();
    expect(world.store.get("fake")).toMatchObject({ state: "falhou", error: "rede caiu" });
    expect(world.calls).toEqual(["download-runtime", "venv", "pip-install"]);
    const failed = jobsOf(world).at(-1)!;
    expect(failed).toMatchObject({ phase: "falhou", error: "rede caiu", stepIndex: 2 });
    expect(failed.steps.map((s) => s.status)).toEqual(["feito", "feito", "falhou", "pendente", "pendente"]);
    expect(world.connectors.size).toBe(0);

    await world.installer.resume("fake");
    await world.installer.idle();
    // Só o passo que falhou rodou de novo.
    expect(world.calls).toEqual(["download-runtime", "venv", "pip-install", "pip-install"]);
    expect(world.store.get("fake")).toMatchObject({ state: "instalado", lastTest: { ok: true } });
    expect(world.store.get("fake")!.error).toBeUndefined();
    await expect(world.installer.resume("fake")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("passo que precisa do dono: espera com o comando exato; 'Já rodei, continuar' retoma dali", async () => {
    const world = await setup();
    let installed = false;
    world.behavior.steps.venv = async () => {
      if (!installed) throw new NeedsOwnerError("sudo apt install libfoo", "Falta a biblioteca libfoo no sistema.");
    };
    await world.installer.install("fake");
    await world.installer.idle();
    const waiting = world.store.get("fake")!;
    expect(waiting.state).toBe("precisa-do-dono");
    expect(waiting.needs).toEqual({ command: "sudo apt install libfoo", reason: "Falta a biblioteca libfoo no sistema." });
    expect(jobsOf(world).at(-1)).toMatchObject({ phase: "precisa-do-dono", needs: { command: "sudo apt install libfoo" } });
    expect(world.calls).toEqual(["download-runtime", "venv"]);
    // O instalador NUNCA roda o comando: nenhum executor recebeu "sudo".
    expect(world.records.map((r) => r.action)).toContain("app-precisa-do-dono");

    installed = true;
    await world.installer.resume("fake");
    await world.installer.idle();
    expect(world.calls).toEqual(["download-runtime", "venv", "venv", "pip-install"]);
    const done = world.store.get("fake")!;
    expect(done.state).toBe("instalado");
    expect(done.needs).toBeUndefined();
  });

  it("tempo limite do passo vem da receita (e o padrão do tipo); o erro do passo aparece no log", async () => {
    const seen: number[] = [];
    const world = await setup();
    const original = world.executors["pip-install"];
    world.executors["pip-install"] = async (step, ctx) => {
      seen.push(ctx.timeoutMs);
      return original(step, ctx);
    };
    world.executors.venv = async (step, ctx) => {
      seen.push(ctx.timeoutMs);
      throw new Error("passou do tempo limite (300 s)");
    };
    const { job } = await world.installer.install("fake");
    await world.installer.idle();
    expect(seen).toEqual([300_000]);
    expect(await world.installer.log(job.id)).toMatch(/FALHOU: passou do tempo limite/);
  });

  it("cancelar no meio apaga tudo: pasta do app, conector e runtimes baixados por ela", async () => {
    const world = await setup();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (entered = resolve));
    world.behavior.steps.venv = async () => {
      entered();
      await gate;
    };
    const starting = world.installer.install("fake");
    const { job } = await starting;
    // Espera o passo travado começar de verdade (um tempo fixo falhava em máquina lenta, como a do CI).
    await reached;
    expect(await exists(world.paths.appDir("fake"))).toBe(true);
    expect(await exists(path.join(world.paths.runtimesRoot, "uv"))).toBe(true);
    const cancelling = world.installer.cancel("fake");
    release();
    await cancelling;
    expect(await exists(world.paths.appDir("fake"))).toBe(false);
    expect(await exists(path.join(world.paths.runtimesRoot, "uv"))).toBe(false);
    expect(world.store.get("fake")).toBeUndefined();
    expect(world.connectors.size).toBe(0);
    expect(world.events.some((event) => event.type === "library:app-removed" && event.id === "fake")).toBe(true);
    expect(world.store.job(job.id)).toMatchObject({ phase: "cancelado" });
    expect(world.records.map((r) => r.action)).toContain("app-instalacao-cancelada");
    await expect(world.installer.cancel("fake")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("uma instalação por vez: a segunda espera a primeira", async () => {
    const other = fakeApp({ id: "outro", name: "Outro", provides: { connector: { name: "Outro", description: "x", command: [".venv/bin/o"], env: {}, expectTools: [] } } });
    const world = await setup({ catalog: [fakeApp(), other] });
    const order: string[] = [];
    world.behavior.steps["pip-install"] = async (_step, appDir) => {
      order.push(`start ${path.basename(appDir)}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
      order.push(`end ${path.basename(appDir)}`);
    };
    await Promise.all([world.installer.install("fake"), world.installer.install("outro")]);
    await world.installer.idle();
    expect(order).toEqual(["start fake", "end fake", "start outro", "end outro"]);
  });

  it("servidor reiniciado no meio: o app vira 'falhou' e dá para retomar", async () => {
    const world = await setup();
    await world.store.put({ id: "fake", catalogId: "fake", name: "Fake", version: "x", dir: "apps/fake", state: "instalando", requires: [], license: { spdx: "MIT", level: "livre" }, provides: { connectorIds: [], skillIds: [] }, installedAt: "2026-11-11T12:00:00.000Z" });
    await world.installer.recover();
    expect(world.store.get("fake")).toMatchObject({ state: "falhou" });
    expect(world.store.get("fake")!.error).toMatch(/reinício/);
  });
});

describe("AppInstaller: desinstalar e atualizar", () => {
  async function installed(world: World) {
    await world.installer.install("fake");
    await world.installer.idle();
    return world.store.get("fake")!;
  }

  it("desinstalar para os processos, remove conector e liberações, apaga a pasta e limpa o runtime que ninguém usa", async () => {
    const world = await setup();
    await installed(world);
    expect(await exists(world.paths.appDir("fake"))).toBe(true);
    await world.installer.uninstall("fake");
    expect(world.connectors.size).toBe(0);
    expect(await exists(world.paths.appDir("fake"))).toBe(false);
    expect(await readdir(world.paths.appsRoot)).toEqual([]);
    expect(await exists(path.join(world.paths.runtimesRoot, "uv"))).toBe(false);
    expect(world.store.get("fake")).toBeUndefined();
    expect(world.events.some((event) => event.type === "library:app-removed")).toBe(true);
    expect(world.records.at(-1)!.action).toBe("app-desinstalado");
    await expect(world.installer.uninstall("fake")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("os runtimes compartilhados ficam se outro app usa", async () => {
    const other = fakeApp({ id: "outro", name: "Outro", provides: { connector: { name: "Outro", description: "x", command: [".venv/bin/o"], env: {}, expectTools: [] } } });
    const world = await setup({ catalog: [fakeApp(), other] });
    await world.installer.install("fake");
    await world.installer.idle();
    await world.installer.install("outro");
    await world.installer.idle();
    await world.installer.uninstall("fake");
    expect(await exists(path.join(world.paths.runtimesRoot, "uv", "bin", "uv"))).toBe(true);
    expect(await exists(world.paths.appDir("outro"))).toBe(true);
    const runtimes = await world.installer.runtimes();
    expect(runtimes).toMatchObject([{ id: "uv", usedBy: ["outro"] }]);
    await world.installer.uninstall("outro");
    expect(await exists(path.join(world.paths.runtimesRoot, "uv"))).toBe(false);
  });

  it("nunca escreve nem apaga fora de data/platform/apps e runtimes", async () => {
    const world = await setup();
    const sentinel = path.join(world.dataDir, "platform", "library", "guarda.txt");
    await mkdir(path.dirname(sentinel), { recursive: true });
    await writeFile(sentinel, "fica");
    const outside = path.join(world.dataDir, "workspaces", "w", "dado.txt");
    await mkdir(path.dirname(outside), { recursive: true });
    await writeFile(outside, "fica");
    await installed(world);
    await world.installer.uninstall("fake");
    expect(await exists(sentinel)).toBe(true);
    expect(await exists(outside)).toBe(true);
    // O id do app é validado na pasta (nada de "../").
    expect(() => world.paths.appDir("../workspaces")).toThrow();
    expect(() => world.paths.appDir("a/b")).toThrow();
  });

  it("atualizar: receita nova do catálogo mantém o conector (mesmo id) e refaz o mini teste", async () => {
    const world = await setup();
    await installed(world);
    // O catálogo muda: versão nova da receita.
    const v2 = fakeApp({ recipeVersion: "2", version: { kind: "pypi", ref: "fake-pkg 2.0.0" }, recipe: [...RECIPE_V1.slice(0, 2), { run: "pip-install", packages: ["fake-pkg==2.0.0"] }] });
    const catalog = (world.installer as unknown as { deps: { catalog: CatalogApp[] } }).deps.catalog;
    catalog[0] = v2;
    const listing = await world.installer.listing();
    expect(listing.cards[0]!.update).toEqual({ from: "fake-pkg 1.0.0", to: "fake-pkg 2.0.0" });
    const { job } = await world.installer.update("fake");
    expect(job.kind).toBe("update");
    await world.installer.idle();
    expect(world.store.get("fake")).toMatchObject({ state: "instalado", version: "fake-pkg 2.0.0", recipeVersion: "2", provides: { connectorIds: ["fake"] } });
    expect(world.connectors.size).toBe(1);
    expect((await world.installer.listing()).cards[0]!.update).toBeUndefined();
    await expect(world.installer.update("fake")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("não desinstala nem atualiza com operação em andamento", async () => {
    const world = await setup();
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => (entered = resolve));
    world.behavior.steps.venv = () =>
      new Promise<void>((resolve) => {
        release = resolve;
        entered();
      });
    await world.installer.install("fake");
    // Espera o passo começar de verdade (um tempo fixo falhava em máquina lenta, como a do CI).
    await reached;
    await expect(world.installer.uninstall("fake")).rejects.toMatchObject({ statusCode: 409 });
    await expect(world.installer.update("fake")).rejects.toMatchObject({ statusCode: 409 });
    release();
    await world.installer.idle();
  });
});

describe("AppInstaller: o instalador não faz o que a receita não lista", () => {
  it("o catálogo real não tem passos de shell ou sudo, e todo `exec` fica dentro da pasta do app", async () => {
    const { APP_CATALOG } = await import("./catalog");
    for (const app of APP_CATALOG) for (const step of app.recipe) expect(["download-runtime", "venv", "pip-install", "npm-install", "git-clone", "download", "write-file", "exec", "require-system"]).toContain(step.run);
  });
});
