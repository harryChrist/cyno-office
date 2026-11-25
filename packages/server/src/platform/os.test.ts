import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  defaultShell,
  detachedSpawnOptions,
  dirSymlinkType,
  executableCandidates,
  homeEnvFor,
  isPathInside,
  isProcessAlive,
  isWindows,
  killProcessTree,
  pathDelimiter,
  pathExtensions,
  pathKey,
  readPathEnv,
  samePath,
  userHomeDir,
} from "./os";

describe("platform/os (portabilidade Linux e Windows)", () => {
  it("identifica plataforma, separador e chave de PATH", () => {
    expect(isWindows("win32")).toBe(true);
    expect(isWindows("linux")).toBe(false);
    expect(isWindows("darwin")).toBe(false);

    expect(pathDelimiter("win32")).toBe(";");
    expect(pathDelimiter("linux")).toBe(":");

    expect(pathKey({ Path: "C:\\bin;C:\\tools" }, "win32")).toBe("Path");
    expect(pathKey({ PATH: "C:\\bin" }, "win32")).toBe("PATH");
    expect(pathKey({}, "win32")).toBe("PATH");
    expect(pathKey({ Path: "/ignorado", PATH: "/usr/bin" }, "linux")).toBe("PATH");

    expect(readPathEnv({ Path: "C:\\bin;C:\\tools" }, "win32")).toBe("C:\\bin;C:\\tools");
    expect(readPathEnv({ PATH: "/usr/bin:/bin" }, "linux")).toBe("/usr/bin:/bin");
  });

  it("userHomeDir e homeEnvFor isolam a pasta pessoal por plataforma", () => {
    expect(userHomeDir({ USERPROFILE: "C:\\Users\\Ana", HOME: "/ignorado" }, "win32")).toBe("C:\\Users\\Ana");
    expect(userHomeDir({ HOME: "C:\\Users\\Fallback" }, "win32")).toBe("C:\\Users\\Fallback");
    expect(userHomeDir({ HOME: "/home/ana", USERPROFILE: "C:\\ignorado" }, "linux")).toBe("/home/ana");

    expect(homeEnvFor("/tmp/conta", "linux")).toEqual({ HOME: "/tmp/conta" });
    expect(homeEnvFor("/tmp/conta", "win32")).toEqual({
      USERPROFILE: "/tmp/conta",
      HOME: "/tmp/conta",
      APPDATA: path.join("/tmp/conta", "AppData", "Roaming"),
      LOCALAPPDATA: path.join("/tmp/conta", "AppData", "Local"),
    });
  });

  it("defaultShell devolve bash no Linux e powershell.exe no Windows", () => {
    expect(defaultShell("command", "linux", () => true)).toEqual({ command: "/bin/bash", args: ["-c"] });
    expect(defaultShell("command", "linux", () => false)).toEqual({ command: "bash", args: ["-c"] });
    expect(defaultShell("file", "linux", () => true)).toEqual({ command: "/bin/bash", args: [] });

    expect(defaultShell("command", "win32")).toEqual({ command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-Command"] });
    expect(defaultShell("file", "win32")).toEqual({ command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-File"] });
  });

  it("detachedSpawnOptions usa detached no Linux e windowsHide sem detached no Windows", () => {
    expect(detachedSpawnOptions("linux")).toEqual({ detached: true });
    expect(detachedSpawnOptions("win32")).toEqual({ detached: false, windowsHide: true });
  });

  it("killProcessTree usa process.kill(-pid) no Linux (com fallback para pid) e taskkill /T /F no Windows", () => {
    const linuxKill = vi.fn();
    killProcessTree(4321, "SIGTERM", { platform: "linux", kill: linuxKill as unknown as typeof process.kill });
    expect(linuxKill).toHaveBeenCalledTimes(1);
    expect(linuxKill).toHaveBeenCalledWith(-4321, "SIGTERM");

    const fallbackKill = vi.fn((target: number) => {
      if (target < 0) throw new Error("ESRCH");
      return true;
    });
    killProcessTree(4321, "SIGKILL", { platform: "linux", kill: fallbackKill as unknown as typeof process.kill });
    expect(fallbackKill).toHaveBeenNthCalledWith(1, -4321, "SIGKILL");
    expect(fallbackKill).toHaveBeenNthCalledWith(2, 4321, "SIGKILL");

    const winExecFile = vi.fn();
    killProcessTree(9876, "SIGTERM", { platform: "win32", execFile: winExecFile as unknown as typeof import("node:child_process").execFile });
    expect(winExecFile).toHaveBeenCalledTimes(1);
    expect(winExecFile).toHaveBeenCalledWith("taskkill", ["/pid", "9876", "/T", "/F"], { windowsHide: true }, expect.any(Function));

    // PID inválido ou <= 1 nunca chama nada.
    const untouched = vi.fn();
    killProcessTree(0, "SIGKILL", { platform: "linux", kill: untouched as unknown as typeof process.kill });
    killProcessTree(1, "SIGKILL", { platform: "win32", execFile: untouched as unknown as typeof import("node:child_process").execFile });
    expect(untouched).not.toHaveBeenCalled();
  });

  it("isProcessAlive respeita grupo no Linux e sempre usa pid positivo no Windows", () => {
    const calls: [number, number | string | undefined][] = [];
    const fakeKill = ((pid: number, sig?: number | string) => {
      calls.push([pid, sig]);
      return true;
    }) as unknown as typeof process.kill;

    expect(isProcessAlive(555, { platform: "linux", group: true, kill: fakeKill })).toBe(true);
    expect(isProcessAlive(555, { platform: "win32", group: true, kill: fakeKill })).toBe(true);
    expect(calls).toEqual([
      [-555, 0],
      [555, 0],
    ]);

    const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" });
    expect(isProcessAlive(555, { platform: "linux", kill: (() => { throw eperm; }) as unknown as typeof process.kill })).toBe(true);

    const esrch = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    expect(isProcessAlive(555, { platform: "win32", kill: (() => { throw esrch; }) as unknown as typeof process.kill })).toBe(false);
    expect(isProcessAlive(undefined, { platform: "linux", kill: fakeKill })).toBe(false);
    expect(isProcessAlive(1, { platform: "linux", kill: fakeKill })).toBe(false);
  });

  it("pathExtensions e executableCandidates consideram PATHEXT no Windows e não mexem no Linux", () => {
    expect(pathExtensions({}, "linux")).toEqual([]);
    expect(executableCandidates("claude", {}, "linux")).toEqual(["claude"]);

    expect(pathExtensions({}, "win32")).toEqual([".exe", ".cmd", ".bat", ".com"]);
    expect(pathExtensions({ PATHEXT: ".EXE;.CMD;.BAT" }, "win32")).toEqual([".exe", ".cmd", ".bat"]);
    expect(executableCandidates("claude", { PATHEXT: ".EXE;.CMD;.BAT" }, "win32")).toEqual(["claude.exe", "claude.cmd", "claude.bat", "claude"]);
    // Já tem extensão conhecida: não duplica.
    expect(executableCandidates("claude.EXE", { PATHEXT: ".EXE;.CMD" }, "win32")).toEqual(["claude.EXE"]);
  });

  it("dirSymlinkType devolve junction no Windows e undefined no Linux", () => {
    expect(dirSymlinkType("win32")).toBe("junction");
    expect(dirSymlinkType("linux")).toBeUndefined();
  });

  it("isPathInside e samePath normalizam maiúsculas/minúsculas e rejeitam escapes no Windows e no Linux", () => {
    // Linux (case-sensitive)
    expect(isPathInside("/srv/proj/sub", "/srv/proj", { platform: "linux" })).toBe(true);
    expect(isPathInside("/srv/proj", "/srv/proj", { platform: "linux" })).toBe(true);
    expect(isPathInside("/srv/proj", "/srv/proj", { platform: "linux", strict: true })).toBe(false);
    expect(isPathInside("/srv/proj/..oculto", "/srv/proj", { platform: "linux" })).toBe(true);
    expect(isPathInside("/srv/proj2", "/srv/proj", { platform: "linux" })).toBe(false);
    expect(isPathInside("/srv/Proj/sub", "/srv/proj", { platform: "linux" })).toBe(false);
    expect(samePath("/srv/Proj", "/srv/proj", "linux")).toBe(false);

    // Windows (case-insensitive + letras de unidade)
    expect(isPathInside("c:\\Users\\Ana\\Projeto\\src", "C:\\Users\\Ana\\Projeto", { platform: "win32" })).toBe(true);
    expect(isPathInside("C:\\Users\\Ana\\Projeto", "c:\\users\\ana\\projeto", { platform: "win32" })).toBe(true);
    expect(isPathInside("C:\\Users\\Ana\\Projeto", "c:\\users\\ana\\projeto", { platform: "win32", strict: true })).toBe(false);
    expect(isPathInside("C:\\Users\\Ana\\Projeto2", "C:\\Users\\Ana\\Projeto", { platform: "win32" })).toBe(false);
    expect(isPathInside("D:\\Users\\Ana\\Projeto\\src", "C:\\Users\\Ana\\Projeto", { platform: "win32" })).toBe(false);
    expect(samePath("C:\\Users\\Ana\\Dados", "c:\\users\\ana\\dados", "win32")).toBe(true);
  });
});
