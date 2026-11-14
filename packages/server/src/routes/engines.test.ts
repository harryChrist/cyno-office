import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineStatusResponse, EngineTestResult } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";
import type { EngineProbe } from "../engines/terminals/engines";

const setupApp = useTestApp();
const FAKE_CLI = fileURLToPath(new URL("../engines/terminals/fake-cli.mjs", import.meta.url));

const probe: EngineProbe = async (command, args) => {
  if (args.includes("--version")) return { ok: true, stdout: `${path.basename(command)} 1.2.3\n` };
  return { ok: false, stdout: "" };
};

async function fakeBin(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, "#!/bin/sh\nexit 0\n");
  await chmod(file, 0o755);
  return file;
}

describe("API: tela Motores (/api/engines/status, teste e caminho)", () => {
  it("lista os cinco motores com o estado detectado", async () => {
    const test = await setupApp({ engineTools: { probe, pathEnv: "/nao/existe", homeDir: "/nao/existe" } });
    const { engines } = await call<EngineStatusResponse>(test.app, "GET", "/api/engines/status");
    expect(engines.map((engine) => [engine.id, engine.supported, engine.state])).toEqual([
      ["claude", true, "not_installed"],
      ["gemini", true, "not_installed"],
      ["freebuff", true, "not_installed"],
      ["openclaw", true, "not_installed"],
      ["hermes", true, "not_installed"],
    ]);
  });

  it("o caminho escolhido na tela é validado, salvo, vale na hora e sobrevive a reiniciar", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cyno-bins-engines-"));
    const custom = await fakeBin(dir, "meu-claude");
    const test = await setupApp({ engineTools: { probe, pathEnv: "/nao/existe", homeDir: "/nao/existe" } });
    await call(test.app, "PUT", "/api/engines/claude/config", { path: path.join(dir, "nada") }, 400);
    await call(test.app, "PUT", "/api/engines/freebuff/config", { path: custom }, 404);
    const saved = await call<EngineStatusResponse>(test.app, "PUT", "/api/engines/claude/config", { path: custom });
    expect(saved.engines[0]).toMatchObject({ id: "claude", state: "installed", path: custom, pathSource: "config", configuredPath: custom, version: "meu-claude 1.2.3" });
    expect(JSON.parse(await readFile(path.join(test.dataDir, "platform", "engines.json"), "utf8"))).toMatchObject({ paths: { claude: custom } });

    await test.app.close();
    const again = await setupApp({ dataDir: test.dataDir, engineTools: { probe, pathEnv: "/nao/existe", homeDir: "/nao/existe" } });
    expect((await call<EngineStatusResponse>(again.app, "GET", "/api/engines/status")).engines[0]).toMatchObject({ pathSource: "config", path: custom });

    const reset = await call<EngineStatusResponse>(again.app, "PUT", "/api/engines/claude/config", { path: null });
    expect(reset.engines[0]).toMatchObject({ state: "not_installed", pathSource: "env" });
    expect(reset.engines[0]!.configuredPath).toBeUndefined();
  });

  it("Testar: grava o resultado (vira 'funcionando'), recusa teste em cima de teste e motor sem suporte", async () => {
    const test = await setupApp({
      terminals: { claude: { command: "node", prefixArgs: [FAKE_CLI] } },
      engineTools: { probe, pathEnv: path.dirname(process.execPath), homeDir: "/nao/existe", testMinGapMs: 60_000 },
    });
    const first = await call<{ result: EngineTestResult }>(test.app, "POST", "/api/engines/claude/test", {}, 200);
    expect(first.result).toMatchObject({ ok: true, model: "haiku" });
    // L10: o que o teste gastou entra no histórico de uso (o de Gastos), marcado como teste.
    await test.app.cyno.usageHistory.idle();
    const spent = await test.app.cyno.usageHistory.read();
    expect(spent).toHaveLength(1);
    expect(spent[0]).toMatchObject({ agentId: "engine-test", agentName: "Teste do motor Claude Code", provider: "claude", channel: "other", test: true, measured: true });
    expect(spent[0]!.tokens!.output).toBeGreaterThan(0);
    const again = await call<{ error: string }>(test.app, "POST", "/api/engines/claude/test", {}, 429);
    expect(again.error).toMatch(/Espere/);
    await call(test.app, "POST", "/api/engines/hermes/test", {}, 404);
    const status = await call<EngineStatusResponse>(test.app, "GET", "/api/engines/status");
    expect(status.engines[0]).toMatchObject({ state: "working", lastTest: { ok: true } });
  });

  it("Testar com o motor falhando devolve o erro claro no resultado (sem 'funcionando')", async () => {
    const test = await setupApp({
      engineTools: { probe, pathEnv: "/nao/existe", homeDir: "/nao/existe", testRunner: async () => ({ ok: false, ms: 40, at: new Date().toISOString(), error: "Sem login ou login expirado." }) },
    });
    const result = await call<{ result: EngineTestResult }>(test.app, "POST", "/api/engines/gemini/test", {}, 200);
    expect(result.result).toMatchObject({ ok: false, error: "Sem login ou login expirado." });
    expect((await call<EngineStatusResponse>(test.app, "GET", "/api/engines/status")).engines[1]!.lastTest?.ok).toBe(false);
  });
});
