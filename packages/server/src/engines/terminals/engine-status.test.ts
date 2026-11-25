import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineTestResult, SubscriptionUsage } from "@cyno/shared";
import { detectEngineStatuses, findExecutable, npmPackageVersion, type EngineStatusDeps } from "./engine-status";
import type { EngineProbe } from "./engines";

let root: string;
let bin: string;
let marker: string;

async function script(file: string, body = "#!/bin/sh\nexit 0\n") {
  await writeFile(file, body);
  await chmod(file, 0o755);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "cyno-engine-status-"));
  bin = path.join(root, "bin");
  marker = path.join(root, "freebuff-rodou");
  await mkdir(bin, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }));

/** Uma sonda falsa: responde por comando e anota o que foi chamado. */
function fakeProbe(answers: Record<string, { ok: boolean; stdout?: string; error?: string }>) {
  const calls: string[] = [];
  const probe: EngineProbe = async (command, args) => {
    calls.push([command, ...args].join(" "));
    const answer = answers[`${path.basename(command)} ${args.join(" ")}`.trim()];
    return answer ? { ok: answer.ok, stdout: answer.stdout ?? "", ...(answer.error ? { error: answer.error } : {}) } : { ok: false, stdout: "", error: "sem resposta" };
  };
  return { probe, calls };
}

const NOW = Date.parse("2026-11-12T12:00:00Z");
function deps(overrides: Partial<EngineStatusDeps>, probe: EngineProbe): EngineStatusDeps {
  return {
    binaries: { claude: { command: "claude" }, gemini: { command: "agy" } },
    defaultCommands: { claude: "claude", gemini: "agy" },
    configured: {},
    pathEnv: bin,
    homeDir: root,
    probe,
    usage: () => [],
    tests: () => ({}),
    now: () => NOW,
    ...overrides,
  };
}

const byId = (list: Awaited<ReturnType<typeof detectEngineStatuses>>, id: string) => list.find((entry) => entry.id === id)!;

describe("detectEngineStatuses", () => {
  it("lista os cinco motores; sem nada no PATH, todos 'não instalado'", async () => {
    const { probe, calls } = fakeProbe({});
    const list = await detectEngineStatuses(deps({}, probe));
    expect(list.map((entry) => entry.id)).toEqual(["claude", "gemini", "freebuff", "openclaw", "hermes"]);
    expect(list.every((entry) => entry.state === "not_installed")).toBe(true);
    expect(list.filter((entry) => entry.supported).map((entry) => entry.id)).toEqual(["claude", "gemini"]);
    expect(calls).toEqual([]);
    expect(byId(list, "freebuff").notice).toMatch(/próxima entrega/);
  });

  it("Claude instalado: versão, caminho, login (auth status) e origem PATH", async () => {
    await script(path.join(bin, "claude"));
    const { probe } = fakeProbe({ "claude --version": { ok: true, stdout: "2.1.322 (Claude Code)\n" }, "claude auth status": { ok: true, stdout: JSON.stringify({ loggedIn: true, email: "x@y.z" }) } });
    const claude = byId(await detectEngineStatuses(deps({}, probe)), "claude");
    expect(claude).toMatchObject({ state: "installed", version: "2.1.322 (Claude Code)", path: path.join(bin, "claude"), pathSource: "path", loginCommand: "claude" });
    expect(JSON.stringify(claude)).not.toContain("x@y.z");
  });

  it("Claude sem login (loggedIn false) vira 'no_login'", async () => {
    await script(path.join(bin, "claude"));
    const { probe } = fakeProbe({ "claude --version": { ok: true, stdout: "2.1.322" }, "claude auth status": { ok: false, stdout: JSON.stringify({ loggedIn: false }) } });
    expect(byId(await detectEngineStatuses(deps({}, probe)), "claude").state).toBe("no_login");
  });

  it("'funcionando' só com teste ok das últimas 24 h; teste velho volta a 'instalado'", async () => {
    await script(path.join(bin, "agy"));
    const { probe } = fakeProbe({ "agy --version": { ok: true, stdout: "1.5.6" } });
    const fresh: EngineTestResult = { ok: true, ms: 1800, at: new Date(NOW - 3_600_000).toISOString(), text: "ok" };
    const old: EngineTestResult = { ...fresh, at: new Date(NOW - 30 * 3_600_000).toISOString() };
    const failed: EngineTestResult = { ok: false, ms: 10, at: fresh.at, error: "falhou" };
    expect(byId(await detectEngineStatuses(deps({ tests: () => ({ gemini: fresh }) }, probe)), "gemini")).toMatchObject({ state: "working", lastTest: fresh });
    expect(byId(await detectEngineStatuses(deps({ tests: () => ({ gemini: old }) }, probe)), "gemini").state).toBe("installed");
    expect(byId(await detectEngineStatuses(deps({ tests: () => ({ gemini: failed }) }, probe)), "gemini").state).toBe("installed");
  });

  it("sem cota: janela a 100% vira 'no_quota' com a hora de voltar", async () => {
    await script(path.join(bin, "claude"));
    const { probe } = fakeProbe({ "claude --version": { ok: true, stdout: "2.1.322" } });
    const resetsAt = new Date(NOW + 2 * 3_600_000).toISOString();
    const usage: SubscriptionUsage[] = [{ provider: "claude", windows: [{ id: "five_hour", utilization: 1, resetsAt, status: "rejected" }], status: "rejected", updatedAt: new Date(NOW).toISOString() }];
    const claude = byId(await detectEngineStatuses(deps({ usage: () => usage }, probe)), "claude");
    expect(claude).toMatchObject({ state: "no_quota", resetsAt });
  });

  it("Antigravity com o login expirado (poller) vira 'no_login'", async () => {
    await script(path.join(bin, "agy"));
    const { probe } = fakeProbe({ "agy --version": { ok: true, stdout: "1.5.6" } });
    const usage: SubscriptionUsage[] = [
      { provider: "gemini", windows: [], updatedAt: new Date(NOW).toISOString(), stale: { reason: "Login do Antigravity expirado — abra o agy para entrar de novo", since: new Date(NOW).toISOString() } },
    ];
    expect(byId(await detectEngineStatuses(deps({ usage: () => usage }, probe)), "gemini").state).toBe("no_login");
  });

  it("origem do caminho: escolhido na tela ('config') ou variável de ambiente ('env')", async () => {
    const custom = path.join(root, "meu-claude");
    await script(custom);
    const { probe } = fakeProbe({ "meu-claude --version": { ok: true, stdout: "9.9.9" } });
    const config = byId(await detectEngineStatuses(deps({ binaries: { claude: { command: custom }, gemini: { command: "agy" } }, configured: { claude: custom } }, probe)), "claude");
    expect(config).toMatchObject({ pathSource: "config", configuredPath: custom, path: custom, version: "9.9.9" });
    const env = byId(await detectEngineStatuses(deps({ binaries: { claude: { command: custom }, gemini: { command: "agy" } } }, probe)), "claude");
    expect(env).toMatchObject({ pathSource: "env", path: custom });
  });

  it("Freebuff: a versão vem do package.json do pacote e NENHUM processo freebuff é iniciado", async () => {
    const pkg = path.join(root, "lib", "node_modules", "freebuff");
    await mkdir(pkg, { recursive: true });
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "freebuff", version: "0.2.36" }));
    // Se alguém executar o lançador, ele deixa este arquivo (o real baixaria 50 MB).
    await script(path.join(pkg, "index.js"), `#!/bin/sh\ntouch "${marker}"\n`);
    await symlink(path.join("..", "lib", "node_modules", "freebuff", "index.js"), path.join(bin, "freebuff"));
    const { probe, calls } = fakeProbe({});
    const freebuff = byId(await detectEngineStatuses(deps({}, probe)), "freebuff");
    expect(freebuff).toMatchObject({ state: "installed", version: "0.2.36", supported: false });
    expect(freebuff.path).toBe(path.join(bin, "freebuff"));
    expect(calls.filter((call) => call.includes("freebuff"))).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  it("OpenClaw: roda só --version; Hermes: só acha o executável (nada é executado)", async () => {
    await script(path.join(bin, "openclaw"));
    await script(path.join(bin, "hermes"));
    const { probe, calls } = fakeProbe({ "openclaw --version": { ok: true, stdout: "openclaw 2026.11.3\n" } });
    const list = await detectEngineStatuses(deps({}, probe));
    expect(byId(list, "openclaw")).toMatchObject({ state: "installed", version: "openclaw 2026.11.3" });
    expect(byId(list, "hermes")).toMatchObject({ state: "installed", path: path.join(bin, "hermes") });
    expect(byId(list, "hermes").version).toBeUndefined();
    expect(calls).toEqual([`${path.join(bin, "openclaw")} --version`]);
  });
});

describe("findExecutable e npmPackageVersion", () => {
  it("acha pelo PATH e por ~/.local/bin; recusa arquivo sem permissão de execução", async () => {
    await script(path.join(bin, "um"));
    await writeFile(path.join(bin, "sem-x"), "x");
    await mkdir(path.join(root, ".local", "bin"), { recursive: true });
    await script(path.join(root, ".local", "bin", "dois"));
    expect(await findExecutable("um", bin, root)).toBe(path.join(bin, "um"));
    expect(await findExecutable("dois", "/nao/existe", root)).toBe(path.join(root, ".local", "bin", "dois"));
    expect(await findExecutable("sem-x", bin, root)).toBeUndefined();
    expect(await findExecutable("nada", bin, root)).toBeUndefined();
  });

  it("no Windows (win32), usa separador `;` e PATHEXT (.exe, .cmd, .bat) sem exigir bit +x", async () => {
    const dirA = path.join(root, "win-a");
    const dirB = path.join(root, "win-b");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    // Simula npm no Windows: shim sem extensão + .cmd lado a lado; deve preferir .cmd.
    await writeFile(path.join(dirA, "claude"), "#!/bin/sh\n");
    await writeFile(path.join(dirA, "claude.cmd"), "@echo off\n");
    await writeFile(path.join(dirB, "agy.exe"), "fake-pe");
    const winPath = `${dirA};${dirB}`;
    const env = { PATHEXT: ".EXE;.CMD;.BAT" };

    expect(await findExecutable("claude", winPath, root, { platform: "win32", env })).toBe(path.join(dirA, "claude.cmd"));
    expect(await findExecutable("agy", winPath, root, { platform: "win32", env })).toBe(path.join(dirB, "agy.exe"));
    expect(await findExecutable("inexistente", winPath, root, { platform: "win32", env })).toBeUndefined();
  });

  it("não confunde com outro pacote nem estoura com link quebrado", async () => {
    const pkg = path.join(root, "outro");
    await mkdir(pkg, { recursive: true });
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "outro", version: "1.0.0" }));
    await script(path.join(pkg, "x.js"));
    expect(await npmPackageVersion(path.join(pkg, "x.js"), "freebuff")).toBeUndefined();
    expect(await npmPackageVersion(path.join(root, "nao-existe"), "freebuff")).toBeUndefined();
  });
});
