import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeAgentEngineData, sweepEngineHomes } from "./engine-homes";
import { HermesAdapter, hermesAgentHomeOf } from "./hermes-adapter";
import { OpenClawAdapter, openclawAgentConfigPath, openclawAgentTmpOf } from "./openclaw-adapter";
import type { TerminalSpec } from "./types";

/** Pastas de motor por agente (revisão 2, M4): apagadas com o agente, na troca de motor e na varredura do início. */
describe("pastas de motor por agente (M4)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  });
  const temp = async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cyno-engine-homes-"));
    dirs.push(dir);
    return dir;
  };
  const spec = (cwd: string): TerminalSpec => ({ agentId: "ag", cwd, systemPrompt: "x", mcpConfigFile: path.join(cwd, "mcp.json"), tools: [] });

  it("os dois adaptadores gravam o marcador que liga a pasta de motor à pasta de trabalho do agente", async () => {
    const root = await temp();
    const cwd = path.join(root, "agents", "a1");
    const hermes = new HermesAdapter({ homeDir: path.join(root, "hermes") });
    const hermesMarker = hermes.agentFiles({ spec: spec(cwd), mcpUrl: "http://x/mcp", token: "t" }).find((file) => file.path.endsWith(".cyno-cwd"));
    expect(hermesMarker?.path).toBe(path.join(hermesAgentHomeOf(path.join(root, "hermes"), cwd), ".cyno-cwd"));
    expect(hermesMarker?.content.trim()).toBe(cwd);
    const openclaw = new OpenClawAdapter({ homeDir: path.join(root, "openclaw") });
    const ocMarker = openclaw.agentFiles({ spec: spec(cwd), mcpUrl: "", token: "" }).find((file) => file.path.endsWith(".cyno-cwd"));
    expect(ocMarker?.path).toBe(path.join(path.dirname(openclawAgentConfigPath(path.join(root, "openclaw"), cwd)), ".cyno-cwd"));
  });

  const seed = async (root: string, cwd: string) => {
    const home = hermesAgentHomeOf(path.join(root, "hermes"), cwd);
    const config = openclawAgentConfigPath(path.join(root, "openclaw"), cwd);
    for (const dir of [home, path.dirname(config)]) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, ".cyno-cwd"), `${cwd}\n`);
    }
    await writeFile(path.join(home, "config.yaml"), "token: segredo-antigo");
    await writeFile(config, '{"token":"segredo-antigo"}');
    return { home, config };
  };

  it("agente removido ou que trocou de motor: as pastas de motor dele somem (o token antigo não fica em disco)", async () => {
    const root = await temp();
    const roots = { hermes: path.join(root, "hermes"), openclaw: path.join(root, "openclaw") };
    const keep = await seed(root, path.join(root, "agents", "fica"));
    const gone = await seed(root, path.join(root, "agents", "sai"));
    await removeAgentEngineData(roots, path.join(root, "agents", "sai"));
    expect(existsSync(gone.home)).toBe(false);
    expect(existsSync(path.dirname(gone.config))).toBe(false);
    expect(existsSync(keep.home)).toBe(true);
    expect(existsSync(keep.config)).toBe(true);
  });

  it("o temporário do agente do OpenClaw (da cerca) some com o agente e na varredura, e o de quem fica não", async () => {
    const root = await temp();
    const roots = { hermes: path.join(root, "hermes"), openclaw: path.join(root, "openclaw") };
    const keepCwd = path.join(root, "agents", "fica");
    const goneCwd = path.join(root, "agents", "sai");
    const orphanCwd = path.join(root, "agents", "orfao");
    await mkdir(keepCwd, { recursive: true });
    for (const cwd of [keepCwd, goneCwd, orphanCwd]) {
      await seed(root, cwd);
      await mkdir(openclawAgentTmpOf(roots.openclaw, cwd), { recursive: true });
    }
    await removeAgentEngineData(roots, goneCwd);
    expect(existsSync(openclawAgentTmpOf(roots.openclaw, goneCwd))).toBe(false);
    expect(existsSync(openclawAgentTmpOf(roots.openclaw, keepCwd))).toBe(true);
    // `orfao` nunca teve pasta de trabalho: a varredura apaga a pasta de motor e o temporário dele; `fica` (a pasta existe) continua.
    await sweepEngineHomes(roots);
    expect(existsSync(openclawAgentTmpOf(roots.openclaw, orphanCwd))).toBe(false);
    expect(existsSync(openclawAgentTmpOf(roots.openclaw, keepCwd))).toBe(true);
  });

  it("a varredura do início apaga a pasta de agente que não existe mais e deixa a dos que existem e a sem marcador", async () => {
    const root = await temp();
    const roots = { hermes: path.join(root, "hermes"), openclaw: path.join(root, "openclaw") };
    const alive = path.join(root, "agents", "vivo");
    await mkdir(alive, { recursive: true });
    const kept = await seed(root, alive);
    const dead = await seed(root, path.join(root, "agents", "morto"));
    await mkdir(path.join(roots.hermes, "agent-homes", "sem-marcador"), { recursive: true });
    const removed = await sweepEngineHomes(roots);
    expect(removed.sort()).toEqual([dead.home, path.dirname(dead.config)].sort());
    expect(existsSync(kept.home)).toBe(true);
    expect(await readdir(path.join(roots.hermes, "agent-homes"))).toContain("sem-marcador");
  });
});
