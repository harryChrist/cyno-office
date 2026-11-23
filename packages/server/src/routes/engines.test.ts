import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  engineInstallPath,
  engineInstallPlanPath,
  type EngineInstallJob,
  type EngineInstallPlan,
  type EngineStatusResponse,
  type EngineTestResult,
} from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { call } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";
import { useTempDirs } from "../dev/test-utils";
import type { InstallRecipe } from "../engines/install/recipes";
import type { EngineProbe } from "../engines/terminals/engines";
import { ActivityLog, setActivityLog } from "../workspace/activity/log";
import { seedDataDir } from "../workspace/office/seed";

const setupApp = useTestApp();
const tempDir = useTempDirs();
const FAKE_CLI = fileURLToPath(new URL("../engines/terminals/fake-cli.mjs", import.meta.url));

afterEach(() => {
  setActivityLog(undefined);
});

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

  it("rotas de instalação privada para claude e gemini: plano, 409 sem confirm, job, cópia privada preferida e Atividade", async () => {
    const root = await tempDir();
    const dataDir = path.join(root, "data");
    await seedDataDir(dataDir);
    const activityLog = new ActivityLog({ dataDir, flushMs: 1_000_000 });

    const claudeBin = path.join(dataDir, "platform", "engines", "claude", "node_modules", ".bin", "claude");
    const agyBin = path.join(dataDir, "platform", "engines", "gemini", "home", ".local", "bin", "agy");

    const makeRecipe = (engine: "claude" | "gemini", bin: string): InstallRecipe => {
      const script = `const fs=require("fs"),p=require("path");fs.mkdirSync(p.dirname(${JSON.stringify(bin)}),{recursive:true});fs.writeFileSync(${JSON.stringify(bin)},"#!/bin/sh\\necho ${engine}-privado 2.0.0\\n",{mode:0o755});console.log("${engine} privado instalado");`;
      return {
        plan: {
          engine,
          title: `Instalar ${engine} (falso)`,
          command: `node -e <cria ${bin}>`,
          steps: [`Instala ${engine} privado.`],
          downloads: [],
          destination: path.dirname(bin),
          needsSudo: false,
          sudoNote: "Sem sudo.",
          touches: [],
          unverified: [],
        },
        steps: [{ kind: "run", label: `Instalando ${engine}`, command: process.execPath, args: ["-e", script] }],
        binaryCandidates: [bin],
      };
    };

    const test = await setupApp({
      dataDir,
      activity: activityLog,
      engineTools: { probe, pathEnv: "/nao/existe", homeDir: "/nao/existe" },
      installRecipe: (engine) => {
        if (engine === "claude") return makeRecipe("claude", claudeBin);
        if (engine === "gemini") return makeRecipe("gemini", agyBin);
        return makeRecipe("claude", claudeBin);
      },
    });

    try {
      for (const [engine, expectedBin] of [["claude", claudeBin], ["gemini", agyBin]] as const) {
        const { plan } = await call<{ plan: EngineInstallPlan }>(test.app, "POST", engineInstallPlanPath(engine), {}, 200);
        expect(plan.engine).toBe(engine);
        expect(plan.needsSudo).toBe(false);

        // Sem confirm: 409 e nada roda.
        const refused = await call<{ error: string }>(test.app, "POST", engineInstallPath(engine), {}, 409);
        expect(refused.error).toMatch(/confirme/i);
        await call(test.app, "POST", engineInstallPath(engine), { confirm: false }, 409);

        // Com confirm: true -> inicia job e termina com a cópia privada detectada.
        const { job } = await call<{ job: EngineInstallJob }>(test.app, "POST", engineInstallPath(engine), { confirm: true }, 200);
        expect(job).toMatchObject({ engine, status: "running" });

        let current: EngineInstallJob | null = job;
        for (let i = 0; i < 100 && current?.status === "running"; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          current = (await call<{ job: EngineInstallJob | null }>(test.app, "GET", engineInstallPath(engine), undefined, 200)).job;
        }
        expect(current).toMatchObject({ engine, status: "done" });
        expect(current?.log.join("\n")).toContain(`${engine} privado instalado`);

        const statuses = (await call<EngineStatusResponse>(test.app, "GET", "/api/engines/status")).engines;
        const entry = statuses.find((item) => item.id === engine)!;
        expect(entry).toMatchObject({ state: "installed", path: expectedBin });
      }

      await activityLog.flush();
      const texts: string[] = [];
      const walk = async (folder: string): Promise<void> => {
        for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
          if (entry.isDirectory()) await walk(path.join(folder, entry.name));
          else texts.push(await readFile(path.join(folder, entry.name), "utf8"));
        }
      };
      await walk(path.join(dataDir, "activity"));
      const joined = texts.join("\n");
      expect(joined).toContain("motor_instalacao_confirmada");
      expect(joined).toContain("motor_instalado");
    } finally {
      await activityLog.close();
    }
  });
});
