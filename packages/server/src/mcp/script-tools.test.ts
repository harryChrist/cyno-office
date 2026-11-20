import path from "node:path";
import { mkdir } from "node:fs/promises";
import { workspaceAccess } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { useTempDirs } from "../dev/test-utils";
import { ScriptsService } from "../workspace/scripts/service";
import { scriptToolsFor, type ScriptToolsDeps } from "./script-tools";

const tempDir = useTempDirs();
const services: ScriptsService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stopAll()));
});

async function setup(access = workspaceAccess({ terminal: true })) {
  const root = await tempDir();
  const dirs = { clara: path.join(root, "clara"), bruno: path.join(root, "bruno") };
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
  const scripts = new ScriptsService({
    dir: path.join(root, "scripts"),
    publish: () => undefined,
    agent: async (id) => ({ agentId: id, agentName: id, cwd: dirs[id as keyof typeof dirs], folders: [], terminal: true }),
    graceMs: 200,
    drainMs: 30,
    flushMs: 30,
    log: { info: () => undefined, warn: () => undefined } as never,
    now: () => new Date(),
  });
  services.push(scripts);
  const deps: ScriptToolsDeps = { scripts, access: () => access, currentTaskId: () => "T7" };
  const tools = (agentId: string) => Object.fromEntries(scriptToolsFor(agentId, {}, deps).map((tool) => [tool.name, tool]));
  return { scripts, deps, tools };
}

const run = async (tool: { call: (args: unknown) => unknown; input: { parse: (args: unknown) => unknown } } | undefined, args: unknown) => (await tool!.call(tool!.input.parse(args))) as { text: string; isError?: boolean };

describe("ferramentas de script", () => {
  it("só existem para quem tem o terminal ligado (workspace E agente)", async () => {
    const { deps } = await setup();
    expect(scriptToolsFor("clara", {}, deps).map((tool) => tool.name)).toEqual(["start_script", "check_script", "stop_script", "list_scripts"]);
    expect(scriptToolsFor("clara", { terminal: false }, deps)).toEqual([]);
    expect(scriptToolsFor("clara", {}, { ...deps, access: () => workspaceAccess() })).toEqual([]);
    expect(scriptToolsFor("clara", {}, undefined)).toEqual([]);
  });

  it("start_script: primeira linha `Script <id> · running`, liga à tarefa; check_script espera o fim e traz o final da saída", async () => {
    const { tools, scripts } = await setup();
    const clara = tools("clara");
    const started = await run(clara.start_script, { command: "echo comecou; sleep 0.3; echo terminou", title: "Teste" });
    expect(started.text.split("\n")[0]).toBe("Script s1 · running");
    expect(started.text).toContain("Title: Teste");
    expect(started.text).toContain("check_script");
    expect(scripts.get("s1").taskId).toBe("T7");
    let checked = await run(clara.check_script, { id: "s1", wait_seconds: 5 });
    for (let i = 0; i < 20 && checked.text.startsWith("Script s1 · running"); i += 1) checked = await run(clara.check_script, { id: "s1", wait_seconds: 5 });
    expect(checked.text.split("\n")[0]).toBe("Script s1 · done");
    expect(checked.text).toContain("Exit code: 0");
    expect(checked.text).toMatch(/comecou\r?\nterminou/);
  });

  it("falha mostra o código; wait_seconds 0 responde na hora; parâmetros fora dos limites são recusados", async () => {
    const { tools } = await setup();
    const clara = tools("clara");
    await run(clara.start_script, { command: "echo ruim; exit 4", title: "Falha" });
    let checked = await run(clara.check_script, { id: "s1", wait_seconds: 5 });
    for (let i = 0; i < 20 && checked.text.startsWith("Script s1 · running"); i += 1) checked = await run(clara.check_script, { id: "s1", wait_seconds: 5 });
    expect(checked.text.split("\n")[0]).toBe("Script s1 · failed");
    expect(checked.text).toContain("Exit code: 4");
    await run(clara.start_script, { command: "sleep 5", title: "Longo" });
    const now = await run(clara.check_script, { id: "s2", wait_seconds: 0 });
    expect(now.text.split("\n")[0]).toBe("Script s2 · running");
    expect(now.text).toContain("Still running");
    expect(() => clara.check_script!.input.parse({ id: "s2", wait_seconds: 9999 })).toThrow();
    expect(() => clara.check_script!.input.parse({ id: "../x" })).toThrow();
  });

  it("stop_script para o próprio script (`Script <id> · stopped`) e list_scripts mostra só os do agente", async () => {
    const { tools } = await setup();
    const clara = tools("clara");
    await run(clara.start_script, { command: "sleep 30", title: "Longo" });
    await run(tools("bruno").start_script, { command: "sleep 30", title: "Do Bruno" });
    const list = await run(clara.list_scripts, {});
    expect(list.text).toContain("Script s1 · running · Longo");
    expect(list.text).not.toContain("Do Bruno");
    const stopped = await run(clara.stop_script, { id: "s1" });
    expect(stopped.text.split("\n")[0]).toBe("Script s1 · stopped");
    expect(stopped.text).toContain("You stopped it");
    expect((await run(tools("bruno").list_scripts, {})).text).toContain("Script s2 · running");
    expect((await run(tools("clara").list_scripts, {})).text).toContain("Script s1 · stopped");
  });

  it("um agente não enxerga nem para o script de outro", async () => {
    const { tools, scripts } = await setup();
    await run(tools("bruno").start_script, { command: "sleep 30", title: "Do Bruno" });
    await expect(run(tools("clara").check_script, { id: "s1", wait_seconds: 0 })).rejects.toThrow(/not found among your scripts/);
    await expect(run(tools("clara").stop_script, { id: "s1" })).rejects.toThrow(/not found among your scripts/);
    await expect(run(tools("clara").check_script, { id: "s77" })).rejects.toThrow(/not found among your scripts/);
    expect(scripts.get("s1").status).toBe("running");
    expect((await run(tools("clara").list_scripts, {})).text).toBe("You have no scripts.");
  });

  it("erros do serviço (pasta fora, limite) chegam como erro para o agente", async () => {
    const { tools } = await setup();
    const clara = tools("clara");
    await expect(run(clara.start_script, { command: "pwd", title: "x", cwd: "/tmp" })).rejects.toThrow(/outside your folder/);
    await run(clara.start_script, { command: "sleep 5", title: "a" });
    await run(clara.start_script, { command: "sleep 5", title: "b" });
    await expect(run(clara.start_script, { command: "sleep 5", title: "c" })).rejects.toThrow(/already have 2 scripts running/);
  });
});

