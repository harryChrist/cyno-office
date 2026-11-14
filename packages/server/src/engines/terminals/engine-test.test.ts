import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineTestResult } from "@cyno/shared";
import { describeTestFailure, EngineTester, runEngineTest } from "./engine-test";

const FAKE_CLI = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url));
const FAKE_AGY = fileURLToPath(new URL("./fake-agy.mjs", import.meta.url));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "cyno-engine-test-"));
});
afterEach(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }));

const env = () => ({ ...process.env, FAKE_CLI_STATE: path.join(root, "state") });

describe("runEngineTest", () => {
  it("Claude Code (CLI falsa): sucesso com o texto, o tempo e o modelo barato", async () => {
    const result = await runEngineTest({ engine: "claude", command: "node", prefixArgs: [FAKE_CLI], workDir: path.join(root, "work"), env: env() });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("eco:");
    expect(result.model).toBe("haiku");
    expect(result.ms).toBeGreaterThanOrEqual(0);
    expect(Date.parse(result.at)).not.toBeNaN();
    // A pasta temporária some no fim.
    expect(await readdir(path.join(root, "work"))).toEqual([]);
  });

  it("avisa quanto o teste gastou (para o histórico de uso), sem mudar o resultado, mesmo se quem registra falhar", async () => {
    const spent: { model: string; output: number }[] = [];
    const ok = await runEngineTest({ engine: "claude", command: "node", prefixArgs: [FAKE_CLI], workDir: path.join(root, "work"), env: env(), onUsage: (s) => void spent.push({ model: s.model, output: s.usage.outputTokens }) });
    expect(ok.ok).toBe(true);
    expect(spent).toHaveLength(1);
    expect(spent[0]!.model).toBe("haiku");
    expect(spent[0]!.output).toBeGreaterThan(0);
    const broken = await runEngineTest({
      engine: "claude",
      command: "node",
      prefixArgs: [FAKE_CLI],
      workDir: path.join(root, "work"),
      env: env(),
      onUsage: () => {
        throw new Error("disco cheio");
      },
    });
    expect(broken.ok).toBe(true);
  });

  it("Antigravity (CLI falsa): sucesso no modelo flash", async () => {
    const result = await runEngineTest({ engine: "gemini", command: "node", prefixArgs: [FAKE_AGY], workDir: path.join(root, "work"), env: env() });
    expect(result).toMatchObject({ ok: true, model: "gemini-3.8-flash-low" });
    expect(result.text).toContain("eco:");
  });

  it("erro do motor (limite) vira mensagem clara", async () => {
    const result = await runEngineTest({ engine: "claude", command: "node", prefixArgs: [FAKE_CLI], workDir: path.join(root, "work"), message: "[cota] teste", env: env() });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cota da assinatura acabou/);
  });

  it("o processo cai sem responder: erro com o código de saída", async () => {
    const result = await runEngineTest({ engine: "claude", command: "node", prefixArgs: [FAKE_CLI], workDir: path.join(root, "work"), message: "[crash] teste", env: env() });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("tempo esgotado: para o processo e avisa", async () => {
    const result = await runEngineTest({ engine: "claude", command: "node", prefixArgs: [FAKE_CLI], workDir: path.join(root, "work"), message: "[lento] teste", timeoutMs: 600, env: env() });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/tempo esgotado/);
    expect(result.ms).toBeGreaterThanOrEqual(500);
  });

  it("executável inexistente: mensagem de caminho, sem lançar", async () => {
    const result = await runEngineTest({ engine: "gemini", command: path.join(root, "nao-existe"), workDir: path.join(root, "work"), env: env() });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/executável/);
  });
});

describe("describeTestFailure", () => {
  it("reconhece login, limite e comando ausente", () => {
    expect(describeTestFailure("Error: not logged in", "claude")).toMatch(/claude/);
    expect(describeTestFailure("Please sign in", "gemini")).toMatch(/agy/);
    expect(describeTestFailure("429 rate limit", "claude")).toMatch(/cota/);
    expect(describeTestFailure("spawn x ENOENT", "claude")).toMatch(/executável/);
    expect(describeTestFailure("", "claude")).toBe("O motor não respondeu.");
  });
});

describe("EngineTester", () => {
  const ok = (): EngineTestResult => ({ ok: true, ms: 5, at: "2026-11-12T12:00:00.000Z", text: "ok" });

  it("um teste por vez, em todos os motores", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const saved: string[] = [];
    const tester = new EngineTester(
      async () => {
        await gate;
        return ok();
      },
      (engine) => void saved.push(engine),
    );
    const first = tester.test("claude");
    const second = await tester.test("gemini");
    expect(second).toMatchObject({ blocked: "busy" });
    release();
    expect(await first).toMatchObject({ result: { ok: true } });
    expect(saved).toEqual(["claude"]);
  });

  it("intervalo mínimo entre testes do mesmo motor (e outro motor passa)", async () => {
    let now = 1_000_000;
    const tester = new EngineTester(async () => ok(), () => undefined, () => now, 20_000);
    expect(await tester.test("claude")).toMatchObject({ result: { ok: true } });
    now += 5000;
    const early = await tester.test("claude");
    expect(early).toMatchObject({ blocked: "too_soon", retryAfterMs: 15_000 });
    expect("message" in early && early.message).toMatch(/15 s/);
    expect(await tester.test("gemini")).toMatchObject({ result: { ok: true } });
    now += 20_000;
    expect(await tester.test("claude")).toMatchObject({ result: { ok: true } });
  });
});
