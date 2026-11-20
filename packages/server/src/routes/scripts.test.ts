import path from "node:path";
import { mkdir } from "node:fs/promises";
import { scriptDownloadPath, scriptOutputPath, scriptPath, scriptsPath, scriptStopPath, type ScriptOutputResponse, type ScriptRun, type ScriptsState } from "@cyno/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { useTempDirs } from "../dev/test-utils";
import { installErrorHandlers } from "../platform/http/errors";
import { ScriptsService } from "../workspace/scripts/service";
import { registerScriptRoutes, scriptFileName } from "./scripts";

const tempDir = useTempDirs();
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function setup() {
  const root = await tempDir();
  const cwd = path.join(root, "agent");
  await mkdir(cwd, { recursive: true });
  const scripts = new ScriptsService({
    dir: path.join(root, "scripts"),
    publish: () => undefined,
    agent: async () => ({ agentId: "clara", agentName: "Clara", cwd, folders: [], terminal: true }),
    graceMs: 200,
    drainMs: 30,
    flushMs: 30,
    log: { info: () => undefined, warn: () => undefined } as never,
    now: () => new Date(),
  });
  closers.push(() => scripts.stopAll());
  const app: FastifyInstance = Fastify();
  installErrorHandlers(app);
  await app.register(async (scope) => registerScriptRoutes(scope, () => scripts), { prefix: "/api/w/:ws" });
  closers.push(() => app.close());
  return { app, scripts };
}

const waitEnd = async (scripts: ScriptsService, id: string) => {
  for (let i = 0; i < 50; i += 1) if ((await scripts.wait(id, 1)).status !== "running") return;
};

describe("rotas de scripts", () => {
  it("lista, detalhe, saída em pedaços e download com a saída sem cores", async () => {
    const { app, scripts } = await setup();
    expect((await app.inject({ method: "GET", url: scriptsPath("w") })).json<ScriptsState>()).toEqual({ runs: [] });
    await scripts.start({ agentId: "clara", title: "Baixar capítulos", command: "printf '\\033[31mvermelho\\033[0m\\nbarra 10%%\\rbarra 100%%\\n'" });
    await waitEnd(scripts, "s1");
    const list = (await app.inject({ method: "GET", url: scriptsPath("w") })).json<ScriptsState>();
    expect(list.runs.map((run) => run.id)).toEqual(["s1"]);
    expect((await app.inject({ method: "GET", url: scriptPath("w", "s1") })).json<ScriptRun>()).toMatchObject({ id: "s1", status: "done", title: "Baixar capítulos" });
    const output = (await app.inject({ method: "GET", url: scriptOutputPath("w", "s1", 0) })).json<ScriptOutputResponse>();
    expect(output.data).toContain("\u001b[31mvermelho");
    expect(output).toMatchObject({ from: 0, done: true });
    const download = await app.inject({ method: "GET", url: scriptDownloadPath("w", "s1") });
    expect(download.headers["content-type"]).toContain("text/plain");
    expect(download.headers["content-disposition"]).toContain("s1-baixar-capitulos.txt");
    expect(download.body).toBe("vermelho\nbarra 100%\n");
    expect(scriptFileName({ id: "s2", title: "" })).toBe("s2.txt");
  });

  it("POST stop para o script como `user`", async () => {
    const { app, scripts } = await setup();
    await scripts.start({ agentId: "clara", title: "Longo", command: "sleep 30" });
    const response = await app.inject({ method: "POST", url: scriptStopPath("w", "s1") });
    expect(response.statusCode).toBe(200);
    expect(response.json<ScriptRun>()).toMatchObject({ status: "stopped", stoppedBy: "user" });
  });

  it("id desconhecido volta 404 e id malformado 400", async () => {
    const { app } = await setup();
    for (const url of [scriptPath("w", "s9"), scriptOutputPath("w", "s9"), scriptDownloadPath("w", "s9")]) expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(404);
    expect((await app.inject({ method: "POST", url: scriptStopPath("w", "s9") })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: scriptPath("w", "abc") })).statusCode).toBe(400);
  });
});
