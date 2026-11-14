import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GatewaySlots } from "./gateway-slots";
import { HermesAdapter, HermesStreamParser } from "./hermes-adapter";
import { OneShotTerminal, type OneShotAdapter } from "./one-shot-terminal";
import { OpenClawEnvelopeParser, openclawAgentConfig, openclawAgentConfigPath } from "./openclaw-adapter";
import type { TerminalEvent, TerminalSpec } from "./types";

/** Correções da segunda revisão (M1): o texto da resposta do modelo nunca decide a classe da falha. */
const hasQuotaBlock = (events: TerminalEvent[]) => events.some((event) => event.type === "usage" && event.status === "rejected");

describe("classificação de falha só pelo erro estruturado (M1)", () => {
  it("OpenClaw: resposta com 'quota' e 'credit' e sem erro estruturado não bloqueia o motor", () => {
    const parser = new OpenClawEnvelopeParser();
    parser.parse(JSON.stringify({ ok: false, status: "error", final: "Falei da quota e do credit que sobrou, sem 429 nem billing." }));
    const events = parser.finish({ code: 1, stderr: "", timedOut: false });
    expect(hasQuotaBlock(events)).toBe(false);
    const end = events.find((event) => event.type === "turn_end");
    expect(end).toMatchObject({ ok: false });
    expect((end as { result: string }).result).not.toContain("está limitando");
  });

  it("OpenClaw: o erro estruturado de cota ainda bloqueia", () => {
    const parser = new OpenClawEnvelopeParser();
    parser.parse(JSON.stringify({ ok: false, status: "error", error: { kind: "exception", message: "429 rate limit exceeded" }, final: "tudo bem" }));
    expect(hasQuotaBlock(parser.finish({ code: 1, stderr: "", timedOut: false }))).toBe(true);
  });

  it("OpenClaw: sem erro estruturado vale a última linha do stderr", () => {
    const parser = new OpenClawEnvelopeParser();
    parser.parse(JSON.stringify({ ok: false, status: "error", final: "quota quota quota" }));
    expect(hasQuotaBlock(parser.finish({ code: 1, stderr: "linha qualquer\nHTTP 429 too many requests", timedOut: false }))).toBe(true);
  });

  it("Hermes: texto do modelo com 'quota' e exit_code 1 sem `error` não bloqueia; com `error` de 429 bloqueia", () => {
    const quiet = new HermesStreamParser();
    const events = quiet.parse(JSON.stringify({ type: "result", session_id: "local-1", exit_code: 1, text: "A quota e o credit do projeto estão ok." }));
    expect(hasQuotaBlock(events)).toBe(false);
    expect(events.find((event) => event.type === "turn_end")).toMatchObject({ ok: false, result: "A quota e o credit do projeto estão ok." });
    const loud = new HermesStreamParser();
    expect(hasQuotaBlock(loud.parse(JSON.stringify({ type: "result", session_id: "local-1", exit_code: 1, text: "", error: "HTTP 429: rate limit" })))).toBe(true);
  });
});

describe("OpenClaw: arquivos só na pasta de trabalho e configuração fora dela (G1)", () => {
  it("tools.fs.workspaceOnly fica ligado mesmo que a configuração do dono diga o contrário", () => {
    const config = openclawAgentConfig({ tools: { fs: { workspaceOnly: false }, exec: { applyPatch: { workspaceOnly: false } } } }, { mcpUrl: "http://127.0.0.1/mcp", token: "t", denied: ["group:ui"] }) as { tools: { fs: { workspaceOnly: boolean }; exec: { applyPatch: { workspaceOnly: boolean } }; deny: string[] } };
    expect(config.tools.fs.workspaceOnly).toBe(true);
    expect(config.tools.exec.applyPatch.workspaceOnly).toBe(true);
    expect(config.tools.deny).toEqual(["group:ui"]);
    const noMcp = openclawAgentConfig({}, { mcpUrl: "", token: "", denied: [] }) as { tools: { fs: { workspaceOnly: boolean } } };
    expect(noMcp.tools.fs.workspaceOnly).toBe(true);
  });

  it("o arquivo de configuração do agente (com o token do MCP) fica fora da pasta de trabalho", () => {
    const cwd = "/dados/workspaces/w1/agents/a1";
    const file = openclawAgentConfigPath("/dados/platform/engines/openclaw", cwd);
    expect(file.startsWith(`${cwd}${path.sep}`)).toBe(false);
    expect(file).toMatch(/\/agent-configs\/[0-9a-f]{16}\/openclaw\.json$/);
    expect(openclawAgentConfigPath("/dados/platform/engines/openclaw", cwd)).toBe(file);
    expect(openclawAgentConfigPath("/dados/platform/engines/openclaw", `${cwd}-outro`)).not.toBe(file);
  });
});

describe("vagas de gateway (M3)", () => {
  it("passa do teto, espera na fila em ordem, diz o motivo e acorda quando uma vaga abre", async () => {
    const slots = new GatewaySlots(() => 2);
    const first = await slots.acquire();
    const second = await slots.acquire();
    expect(slots.inUse()).toBe(2);
    const waits: string[] = [];
    const third = slots.acquire({ onWait: (wait) => waits.push(`${wait.inUse}/${wait.cap}#${wait.position}`) });
    const fourth = slots.acquire({ onWait: (wait) => waits.push(`${wait.inUse}/${wait.cap}#${wait.position}`) });
    await Promise.resolve();
    expect(waits).toEqual(["2/2#1", "2/2#2"]);
    expect(slots.waiting()).toBe(2);
    first!();
    const thirdRelease = await third;
    expect(thirdRelease).toBeTypeOf("function");
    expect(slots.waiting()).toBe(1);
    second!();
    expect(await fourth).toBeTypeOf("function");
    thirdRelease!();
    expect(slots.inUse()).toBe(1);
  });

  it("quem desiste (cancelou) sai da fila e o teto maior acorda os que esperam", async () => {
    let cap = 1;
    const slots = new GatewaySlots(() => cap);
    await slots.acquire();
    const controller = new AbortController();
    const quitter = slots.acquire({ signal: controller.signal });
    const patient = slots.acquire();
    controller.abort();
    expect(await quitter).toBeUndefined();
    expect(slots.waiting()).toBe(1);
    cap = 2;
    slots.drain();
    expect(await patient).toBeTypeOf("function");
  });
});

/** Terminal de um processo por turno com um adaptador mínimo (o processo é um node que não acaba sozinho). */
describe("cortar o turno em qualquer fase (M6) e o que fica de fora do grupo (G2)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  });

  const build = async (extra: Partial<OneShotAdapter> = {}, options: { prepare?: () => Promise<void>; turnTimeoutMs?: number } = {}) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cyno-oneshot-hardening-"));
    dirs.push(cwd);
    const spec: TerminalSpec = { agentId: "ag", cwd, systemPrompt: "x", mcpConfigFile: path.join(cwd, "mcp.json"), tools: [] };
    const calls = { spawned: 0, afterCut: 0 };
    const adapter: OneShotAdapter = {
      provider: "openclaw",
      resumable: false,
      command: () => ({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }),
      composeMessage: (_spec, input) => input.text,
      agentFiles: () => [],
      env: (base) => base,
      createParser: () => ({ parse: () => [], takePartialUsage: () => undefined, finish: () => [] }),
      newSessionId: () => "sessao",
      afterCut: async () => {
        calls.afterCut += 1;
      },
      ...extra,
    };
    const terminal = new OneShotTerminal({
      adapter,
      spec,
      env: process.env,
      turnTimeoutMs: options.turnTimeoutMs ?? 60_000,
      stopGraceMs: 200,
      ...(options.prepare ? { prepare: async () => (await options.prepare!(), spec) } : {}),
      spawn: (command, args, spawnOptions) => {
        calls.spawned += 1;
        return nodeSpawn(command, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"], detached: true });
      },
    });
    const events: TerminalEvent[] = [];
    terminal.onEvent((event) => events.push(event));
    return { terminal, events, calls };
  };
  const until = async (check: () => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(check()).toBe(true);
  };

  it("interromper durante a preparação: o processo nem sobe e o turno vira Interrompido", async () => {
    const { terminal, events, calls } = await build({}, { prepare: () => new Promise((resolve) => setTimeout(resolve, 300)) });
    terminal.send("faça", "t1");
    terminal.interrupt();
    await until(() => events.some((event) => event.type === "dropped"));
    expect(calls.spawned).toBe(0);
    expect(events.filter((event) => event.type === "turn_start")).toHaveLength(1);
    expect(events.find((event) => event.type === "dropped")).toMatchObject({ tag: "t1", reason: "Interrompido" });
    expect(events.some((event) => event.type === "turn_end")).toBe(false);
  });

  it("cancelar pela etiqueta durante a preparação também impede o processo; parar também", async () => {
    const one = await build({}, { prepare: () => new Promise((resolve) => setTimeout(resolve, 300)) });
    one.terminal.send("faça", "t1");
    one.terminal.cancel("t1");
    await until(() => one.events.some((event) => event.type === "dropped"));
    expect(one.calls.spawned).toBe(0);
    const two = await build({}, { prepare: () => new Promise((resolve) => setTimeout(resolve, 300)) });
    two.terminal.send("faça", "t2");
    await two.terminal.stop("Terminal parado");
    expect(two.calls.spawned).toBe(0);
    expect(two.events.find((event) => event.type === "dropped")).toMatchObject({ reason: "Terminal parado" });
  });

  it("interromper, parar e o tempo máximo encerram também o que o programa deixou fora do grupo (afterCut)", async () => {
    const interrupted = await build();
    interrupted.terminal.send("faça", "t1");
    await until(() => interrupted.calls.spawned === 1);
    interrupted.terminal.interrupt();
    await until(() => interrupted.events.some((event) => event.type === "dropped"));
    await until(() => interrupted.calls.afterCut >= 1);

    const stopped = await build();
    stopped.terminal.send("faça", "t1");
    await until(() => stopped.calls.spawned === 1);
    await stopped.terminal.stop();
    expect(stopped.calls.afterCut).toBeGreaterThanOrEqual(1);

    const slow = await build({}, { turnTimeoutMs: 400 });
    slow.terminal.send("faça", "t1");
    await until(() => slow.events.some((event) => event.type === "turn_end"));
    expect(slow.events.find((event) => event.type === "turn_end")).toMatchObject({ ok: false });
    expect(slow.calls.afterCut).toBeGreaterThanOrEqual(1);
  });

  it("o .turn-<id>.txt que sobrou de uma queda é apagado no começo do turno seguinte (L13)", async () => {
    const { terminal, events, calls } = await build();
    const cwd = (terminal as unknown as { options: { spec: TerminalSpec } }).options.spec.cwd;
    const stale = path.join(cwd, ".turn-deadbeef.txt");
    await writeFile(stale, "texto de um turno que morreu");
    await writeFile(path.join(cwd, "notas.txt"), "fica");
    terminal.send("faça", "t1");
    await until(() => calls.spawned === 1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(path.join(cwd, "notas.txt"))).toBe(true);
    terminal.interrupt();
    await until(() => events.some((event) => event.type === "dropped"));
  });

  it("sem vaga, o turno espera dizendo o motivo, e cancelar acorda e desiste", async () => {
    const slots = new GatewaySlots(() => 1);
    const held = await slots.acquire();
    const wait = await build({
      acquireSlot: async (_spec, input) => {
        const release = await slots.acquire({ signal: input.signal, onWait: () => input.onWait("Esperando vaga no Hermes: 1 de 1 gateway em uso (1º da fila).") });
        return release;
      },
    });
    wait.terminal.send("faça", "t1");
    await until(() => wait.events.some((event) => event.type === "raw" && /Esperando vaga no Hermes/.test(event.text)));
    expect(wait.calls.spawned).toBe(0);
    // O turno já está aberto na espera (o registro do agente só mostra as linhas de um turno aberto): o motivo aparece depois do turn_start.
    const types = wait.events.map((event) => event.type);
    expect(types.indexOf("turn_start")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("turn_start")).toBeLessThan(types.indexOf("raw"));
    wait.terminal.interrupt();
    await until(() => wait.events.some((event) => event.type === "dropped"));
    expect(wait.calls.spawned).toBe(0);
    expect(wait.events.filter((event) => event.type === "turn_start")).toHaveLength(1);
    expect(slots.waiting()).toBe(0);
    held!();
  });

  it("a última linha do stderr e as linhas cruas passam por maskSecrets antes de ir à mensagem e ao registro (L1)", async () => {
    const secret = "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef";
    const { terminal, events } = await build({ command: () => ({ command: process.execPath, args: ["-e", `console.error("falhou com a chave ${secret}"); process.exit(3)`] }) });
    terminal.send("faça", "t1");
    await until(() => events.some((event) => event.type === "turn_end"));
    const end = events.find((event) => event.type === "turn_end") as { result: string };
    expect(end.result).not.toContain(secret);
    expect(end.result).toContain("sem dar resposta");
    const raw = events.filter((event) => event.type === "raw").map((event) => (event as { text: string }).text).join("\n");
    expect(raw).toContain("falhou com a chave");
    expect(raw).not.toContain(secret);
  });
});

describe("Hermes: só a mensagem exata de sessão inexistente zera a sessão (L3)", () => {
  const hermes = new HermesAdapter({ homeDir: "/x" });
  it("casa a do programa de verdade e nada mais", () => {
    expect(hermes.isMissingSession("No session found matching 'local-abc'. Use 'hermes sessions list' to see them.")).toBe(true);
    expect(hermes.isMissingSession("Erro:\nNo session found matching 'x'.")).toBe(true);
    for (const text of ["Connection error: session not found on proxy", "unknown session token", "API error: 401", "O modelo disse: the session does not exist"]) expect(hermes.isMissingSession(text)).toBe(false);
  });
});
