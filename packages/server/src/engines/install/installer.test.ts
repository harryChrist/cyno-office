import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineInstaller } from "./installer";
import type { InstallRecipe } from "./recipes";

/** Instalador de motores (revisão 2, M2): o grupo de processos inteiro, o fechamento do servidor e a trava entre reinícios. */
describe("EngineInstaller", () => {
  const dirs: string[] = [];
  const installers: EngineInstaller[] = [];
  afterEach(async () => {
    for (const installer of installers.splice(0)) await installer.close();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  });
  const temp = async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cyno-installer-"));
    dirs.push(dir);
    return dir;
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
    const end = Date.now() + ms;
    while (!(await check()) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await check()).toBe(true);
  };
  /** Receita falsa: um shell que abre um neto (sleep) e grava o pid dele, depois espera. */
  const recipe = (pidFile: string): InstallRecipe => ({
    plan: { engine: "hermes", title: "x", summary: "x", steps: [], downloads: [], willDo: [], willNotDo: [], unverified: [] } as never,
    binaryCandidates: [],
    steps: [{ kind: "run", label: "dorme", command: "sh", args: ["-c", `sleep 60 & echo $! > ${pidFile}; wait`] }],
  });
  const make = (options: { lockFile?: string; stepTimeoutMs?: number } = {}) => {
    const installer = new EngineInstaller({ now: () => new Date(), ...options });
    installers.push(installer);
    return installer;
  };

  it("o tempo máximo mata o grupo inteiro (o neto também), não só o shell", async () => {
    const dir = await temp();
    const pidFile = path.join(dir, "neto.pid");
    const installer = make({ stepTimeoutMs: 600 });
    installer.start("hermes", recipe(pidFile));
    await until(() => existsSync(pidFile) && (readFileSyncSafe(pidFile) ?? "").trim() !== "");
    const grandchild = Number((await readFile(pidFile, "utf8")).trim());
    expect(alive(grandchild)).toBe(true);
    await installer.idle();
    expect(installer.current()?.status).toBe("failed");
    expect(installer.current()?.error).toMatch(/tempo máximo/);
    await until(() => !alive(grandchild));
  });

  it("fechar o servidor encerra a instalação em andamento (o grupo) e solta a trava", async () => {
    const dir = await temp();
    const pidFile = path.join(dir, "neto.pid");
    const lockFile = path.join(dir, "install.lock");
    const installer = make({ lockFile });
    installer.start("hermes", recipe(pidFile));
    await until(() => existsSync(pidFile) && (readFileSyncSafe(pidFile) ?? "").trim() !== "");
    const grandchild = Number((await readFile(pidFile, "utf8")).trim());
    expect(existsSync(lockFile)).toBe(true);
    await installer.close();
    await until(() => !alive(grandchild));
    expect(existsSync(lockFile)).toBe(false);
    expect(() => installer.start("hermes", recipe(pidFile))).toThrow(/fechando/);
  });

  it("a trava vale entre reinícios: pid vivo de outro processo bloqueia uma segunda instalação; pid morto não", async () => {
    const dir = await temp();
    const lockFile = path.join(dir, "install.lock");
    const other = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      await writeFile(lockFile, `${JSON.stringify({ pid: other.pid, at: new Date().toISOString() })}\n`);
      const installer = make({ lockFile });
      expect(() => installer.start("hermes", recipe(path.join(dir, "x.pid")))).toThrow(/em andamento/);
      other.kill("SIGKILL");
      await new Promise((resolve) => other.once("exit", resolve));
      await writeFile(lockFile, `${JSON.stringify({ pid: other.pid, at: new Date().toISOString() })}\n`);
      installer.start("hermes", recipe(path.join(dir, "y.pid")));
      await installer.close();
    } finally {
      other.kill("SIGKILL");
    }
  });
});

function readFileSyncSafe(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}
