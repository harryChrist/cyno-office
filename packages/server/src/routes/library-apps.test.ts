import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { catalogSchema, type AppsListing, type InstallJob, type InstallPlan, type LibraryApp, type LibraryConnector, type ServerEvent } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { call, createAgent, createRoom, createTeam } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";
import { writeAuthFile } from "../platform/auth/store";
import type { McpClient } from "../library/connectors/mcp-client";
import type { MachineProbe } from "../library/apps/requirements";
import type { StepExecutors } from "../library/apps/steps";
import { setActivityLog, type ActivityLog } from "../workspace/activity/log";

const setupApp = useTestApp();
afterEach(() => setActivityLog(undefined));

const catalog = catalogSchema.parse([
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
    requires: [{ kind: "disk", spec: "10MB" }],
    recipe: [{ run: "venv", python: "3.12" }, { run: "pip-install", packages: ["fake-pkg==1.0.0"] }],
    provides: { connector: { name: "Fake", description: "Conector de teste", command: [".venv/bin/fake-mcp"], expectTools: ["do_it"] } },
    test: { tool: "do_it", args: {}, expect: { contains: "feito" }, timeoutSec: 10 },
    resources: { ramMB: 10, diskMB: 10 },
  },
  { id: "em-breve", name: "Em breve", area: "video", status: "em-breve", summary: "Depois.", repo: "https://github.com/exemplo/x", version: { kind: "npm", ref: "x" }, recipeVersion: "0", license: { spdx: "MIT", level: "livre" }, resources: { ramMB: 1, diskMB: 1 }, pending: "Fatia de vídeo." },
]);

const probe: MachineProbe = { platform: "linux", arch: "x64", totalMemMB: () => 8000, availMemMB: () => 6000, diskFreeMB: () => 50_000, which: () => undefined, nodeVersion: "26.0.0", runtimeInstalled: () => true };

const executors = (): StepExecutors => {
  const noop = async () => undefined;
  return {
    "download-runtime": noop,
    venv: async (_step, ctx) => {
      await mkdir(path.join(ctx.appDir, ".venv", "bin"), { recursive: true });
    },
    "pip-install": async (_step, ctx) => {
      await writeFile(path.join(ctx.appDir, ".venv", "bin", "fake-mcp"), "x");
    },
    "npm-install": noop,
    "git-clone": noop,
    download: noop,
    exec: noop,
    "write-file": noop,
    "require-system": noop,
  };
};

const fakeClient = (): McpClient => ({
  listTools: async () => [{ name: "do_it", description: "Faz", inputSchema: { type: "object", properties: {} } }],
  callTool: async () => ({ content: [{ type: "text", text: "feito!" }], isError: false }),
  close: async () => undefined,
});

const options = (allowStdio = true) => ({ connectors: { autoTest: false, allowStdio, gateway: { createClient: fakeClient } }, apps: { catalog, probe, executors: executors() } });

const APPS = "/api/library/apps";

/**
 * Espera o job de instalação terminar DE VERDADE, pelo sinal do próprio instalador (`idle()`): o estado
 * "instalado" e a fase "pronto" aparecem na lista um instante antes de o último evento sair e de a operação
 * ser liberada (o `DELETE` ainda bateria no 409). Esperar por tempo ou pela lista era a corrida.
 */
const jobTerminou = (test: { app: { apps: { idle(): Promise<void> } } }): Promise<void> => test.app.apps.idle();

describe("API: Biblioteca > Apps", () => {
  it("lista o catálogo (instalável e em breve), mostra o plano e instala do clique ao 'instalado e testado'", async () => {
    const test = await setupApp(options());
    const platform: ServerEvent[] = [];
    test.workspaces.listHub.subscribe((event) => platform.push(structuredClone(event)));
    const listing = await call<AppsListing>(test.app, "GET", APPS);
    expect(listing.stdioAllowed).toBe(true);
    expect(listing.cards.map((card) => [card.entry.id, card.entry.status, card.app?.state])).toEqual([["fake", "disponivel", undefined], ["em-breve", "em-breve", undefined]]);

    const plan = await call<InstallPlan>(test.app, "GET", `${APPS}/fake/plan`);
    expect(plan).toMatchObject({ canInstall: true, repo: "https://github.com/exemplo/fake" });
    expect((await call<InstallPlan>(test.app, "GET", `${APPS}/em-breve/plan`)).canInstall).toBe(false);
    await call(test.app, "POST", `${APPS}/em-breve/install`, {}, 409);
    await call(test.app, "GET", `${APPS}/nao-existe/plan`, undefined, 404);

    const started = await call<{ app: LibraryApp; job: InstallJob }>(test.app, "POST", `${APPS}/fake/install`, {}, 202);
    expect(started.app.state).toBe("instalando");
    await jobTerminou(test);
    const done = await call<AppsListing>(test.app, "GET", APPS);
    expect(done.cards[0]!.app?.state).toBe("instalado");
    expect(done.cards[0]!.app).toMatchObject({ lastTest: { ok: true, tool: "do_it" }, provides: { connectorIds: ["fake"] } });
    expect(done.cards[0]!.job).toMatchObject({ phase: "pronto" });
    expect(platform.some((event) => event.type === "library:job" && event.job.phase === "pronto")).toBe(true);
    expect(platform.some((event) => event.type === "library:app" && event.app.state === "instalado")).toBe(true);

    // O conector nasceu na Biblioteca, do app, sem liberação a ninguém.
    const connectors = await call<LibraryConnector[]>(test.app, "GET", "/api/library/connectors");
    expect(connectors).toMatchObject([{ id: "fake", origin: "app", appId: "fake", kind: "stdio", grants: {}, uses: [], enabled: true, warnings: [] }]);
    expect(connectors[0]!.command).toBe(path.join(test.dataDir, "platform", "apps", "fake", ".venv", "bin", "fake-mcp"));
    const log = await test.app.inject({ method: "GET", url: `${APPS}/jobs/${started.job.id}/log` });
    expect(log.statusCode).toBe(200);
    expect(log.body).toMatch(/Pronto: Fake instalado e testado/);
  });

  it("conectores locais desligados: o plano avisa, instalar é 403 e nada é criado", async () => {
    const test = await setupApp(options(false));
    expect((await call<AppsListing>(test.app, "GET", APPS)).stdioAllowed).toBe(false);
    expect(await call<InstallPlan>(test.app, "GET", `${APPS}/fake/plan`)).toMatchObject({ canInstall: false, stdioAllowed: false });
    await call(test.app, "POST", `${APPS}/fake/install`, {}, 403);
    expect((await call<AppsListing>(test.app, "GET", APPS)).cards[0]!.app).toBeUndefined();
    await expect(stat(path.join(test.dataDir, "platform", "apps", "fake"))).rejects.toThrow();
  });

  it("desinstalar remove a pasta, o conector e as liberações (o agente perde a ferramenta); instalar de novo recomeça limpo", async () => {
    const test = await setupApp(options());
    const room = await createRoom(test.app, "Sala");
    const team = await createTeam(test.app, room.id, "Time");
    const clara = await createAgent(test.app, team.id, "Clara");
    await call(test.app, "POST", `${APPS}/fake/install`, {}, 202);
    await jobTerminou(test);
    await call(test.app, "PUT", "/api/library/connectors/fake/grants", { grants: { principal: { agentIds: [clara.id] } } }, 200);
    expect(test.workspaces.get("principal").officeTools(clara.id).map((tool) => tool.name)).toContain("fake__do_it");

    await call(test.app, "DELETE", `${APPS}/fake`, undefined, 204);
    expect(await call<LibraryConnector[]>(test.app, "GET", "/api/library/connectors")).toEqual([]);
    expect(test.workspaces.get("principal").officeTools(clara.id).map((tool) => tool.name)).not.toContain("fake__do_it");
    await expect(stat(path.join(test.dataDir, "platform", "apps", "fake"))).rejects.toThrow();
    expect((await call<AppsListing>(test.app, "GET", APPS)).cards[0]!.app).toBeUndefined();
    await call(test.app, "DELETE", `${APPS}/fake`, undefined, 404);

    await call(test.app, "POST", `${APPS}/fake/install`, {}, 202);
    await jobTerminou(test);
    expect((await call<AppsListing>(test.app, "GET", APPS)).cards[0]!.app?.state).toBe("instalado");
    expect(await call<LibraryConnector[]>(test.app, "GET", "/api/library/connectors")).toMatchObject([{ id: "fake", grants: {} }]);
  });

  it("registra na Atividade da plataforma", async () => {
    const test = await setupApp(options());
    const entries: { action: string; summary: string }[] = [];
    setActivityLog({ record: (input: { action: string; summary: string }) => void entries.push(input) } as unknown as ActivityLog);
    await call(test.app, "POST", `${APPS}/fake/install`, {}, 202);
    await jobTerminou(test);
    await call(test.app, "DELETE", `${APPS}/fake`, undefined, 204);
    const actions = entries.map((entry) => entry.action);
    expect(actions).toEqual(expect.arrayContaining(["app-instalacao-iniciada", "conector-criado", "app-instalado", "conector-removido", "app-desinstalado"]));
  });

  it("atrás da senha: sem sessão é 401 em todas as rotas, e o token de um agente (MCP) não instala nada", async () => {
    const test = await setupApp(options());
    await writeAuthFile(test.dataDir, "senha-de-teste-1");
    for (const [method, url] of [["GET", APPS], ["GET", `${APPS}/fake/plan`], ["POST", `${APPS}/fake/install`], ["POST", `${APPS}/fake/resume`], ["POST", `${APPS}/fake/cancel`], ["POST", `${APPS}/fake/update`], ["POST", `${APPS}/fake/test`], ["DELETE", `${APPS}/fake`], ["GET", `${APPS}/jobs/J-0001/log`], ["GET", "/api/library/runtimes"], ["POST", "/api/library/runtimes/clean"]] as const) {
      expect((await test.app.inject({ method, url, payload: method === "POST" ? {} : undefined })).statusCode, `${method} ${url}`).toBe(401);
    }
    const bearer = await test.app.inject({ method: "POST", url: `${APPS}/fake/install`, headers: { authorization: "Bearer tok-de-agente" }, payload: {} });
    expect(bearer.statusCode).toBe(401);
    await expect(stat(path.join(test.dataDir, "platform", "apps", "fake"))).rejects.toThrow();
    // Logado: lista.
    const login = await test.app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "senha-de-teste-1" } });
    const cookie = String(([] as string[]).concat(login.headers["set-cookie"] as string)[0]).split(";")[0]!;
    expect((await test.app.inject({ method: "GET", url: APPS, headers: { cookie } })).statusCode).toBe(200);
  });

  it("nenhuma ferramenta MCP de agente instala, atualiza ou desinstala apps", async () => {
    const test = await setupApp(options());
    const room = await createRoom(test.app, "Sala");
    const team = await createTeam(test.app, room.id, "Time");
    const clara = await createAgent(test.app, team.id, "Clara");
    const names = test.workspaces.get("principal").officeTools(clara.id).map((tool) => tool.name);
    expect(names.filter((name) => /install_app|uninstall|update_app|^apps?_/i.test(name))).toEqual([]);
  });
});
