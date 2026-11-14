import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { AGENT_LOG_LIMITS, type AgentLogEntry, type ServerEvent, type Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { dataPaths } from "../../store/paths";
import { WriteQueue } from "../../store/write-queue";
import { useTempDirs } from "../../dev/test-utils";
import { runnerLogHooks } from "./hooks";
import { AgentLogService } from "./service";

const tempDir = useTempDirs();

const TASK_ID = "11111111-2222-3333-4444-555555555555";
const ref = { taskId: TASK_ID, agentId: "ana" };

function task(id: string, agentId: string, createdAt: string): Task {
  return { id, roomId: "a", teamId: "t", agentId, prompt: "x", status: "in_progress", createdAt, updatedAt: createdAt };
}

async function setup(options: { tasks?: Task[]; dir?: string } = {}) {
  const dir = options.dir ?? (await tempDir());
  const paths = dataPaths(dir);
  const queue = new WriteQueue();
  const events: ServerEvent[] = [];
  let ms = Date.parse("2026-11-08T10:00:00.000Z");
  const clock = { advance: (by: number) => (ms += by) };
  const service = new AgentLogService({
    paths,
    queue,
    publish: (event) => events.push(event),
    tasks: () => options.tasks ?? [task(TASK_ID, "ana", "2026-11-08T09:00:00.000Z")],
    log: { error: () => undefined },
    now: () => new Date(ms),
  });
  const logged = () => events.flatMap((event) => (event.type === "agent:log" ? [event.entry] : []));
  return { dir, paths, queue, service, events, logged, clock };
}

describe("AgentLogService: ferramenta que sobrou depois de um restart", () => {
  it("closeInterrupted fecha como interrompida a ferramenta e o subagente que ficaram 'running' no arquivo", async () => {
    const first = await setup();
    first.service.append(ref, { kind: "tool", toolUseId: "t1", name: "search_web", summary: "busca", status: "running" });
    first.service.append(ref, { kind: "subagent", phase: "started", subagentId: "s1", label: "Pesquisa", goal: "x" });
    await first.queue.idle();
    // Processo novo (restart): o log da tarefa não está aberto em memória.
    const second = await setup({ dir: first.dir });
    second.clock.advance(60_000);
    await second.service.closeInterrupted([TASK_ID]);
    const read = await second.service.readTask(TASK_ID);
    const tool = read!.entries.find((entry) => entry.kind === "tool");
    expect(tool).toMatchObject({ status: "error", output: "Interrompida: o servidor reiniciou" });
    expect(read!.entries.some((entry) => entry.kind === "subagent" && entry.phase === "finished" && entry.subagentId === "s1")).toBe(true);
    expect(second.service.isOpen(TASK_ID)).toBe(false);
  });
});

describe("AgentLogService", () => {
  it("append: publica agent:log, grava uma linha por entrada e lê na ordem (ids ordenáveis)", async () => {
    const { service, paths, queue, logged } = await setup();
    service.append(ref, { kind: "status", status: "started", message: "Começou" });
    service.append(ref, { kind: "text", text: "Lendo" });
    service.append(ref, { kind: "text", text: "Escrevendo" });
    await queue.idle();
    const lines = (await readFile(paths.taskLogFile(TASK_ID), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    const ids = logged().map((entry) => entry.id);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(3);
    const read = await service.readTask(TASK_ID);
    expect(read!.entries.map((entry) => entry.kind)).toEqual(["status", "text", "text"]);
    expect(read!.entries[0]).toMatchObject({ taskId: TASK_ID, agentId: "ana", at: "2026-11-08T10:00:00.000Z" });
  });

  it("ferramenta: atualização no lugar (mesmo id, nova linha; a última ganha) com duração", async () => {
    const { service, queue, paths, clock, logged } = await setup();
    const hooks = runnerLogHooks(service, { ...ref, provider: "mock" }, () => true);
    hooks.log({ kind: "tool", toolUseId: "t-1", name: "web_search", input: { query: "agentes" } });
    clock.advance(1500);
    hooks.toolResult("t-1", { status: "ok", output: "3 resultados" });
    hooks.toolResult("t-1", { status: "error" }); // já fechada: ignorada
    await queue.idle();
    expect(logged()).toHaveLength(2);
    expect(logged()[0]!.id).toBe(logged()[1]!.id);
    expect((await readFile(paths.taskLogFile(TASK_ID), "utf8")).trim().split("\n")).toHaveLength(2);
    const { entries } = (await service.readTask(TASK_ID))!;
    expect(entries).toEqual([
      expect.objectContaining({
        kind: "tool",
        provider: "mock",
        name: "web_search",
        summary: "agentes",
        status: "ok",
        output: "3 resultados",
        durationMs: 1500,
      }),
    ]);
  });

  it("corta textos longos e descarta input grande demais (fica o summary)", async () => {
    const { service } = await setup();
    const text = service.append(ref, { kind: "text", text: "x".repeat(AGENT_LOG_LIMITS.text + 50) });
    expect(text).toMatchObject({ kind: "text" });
    expect(text!.kind === "text" && text!.text.length).toBe(AGENT_LOG_LIMITS.text);
    const tool = service.append(ref, {
      kind: "tool",
      toolUseId: "t",
      name: "write_draft",
      summary: "",
      input: { path: "a.md", content: "y".repeat(AGENT_LOG_LIMITS.inputJson) },
      status: "running",
    });
    expect(tool).toMatchObject({ summary: "a.md" });
    expect(tool).not.toHaveProperty("input");
  });

  it("progresso sem repetir: só quando a mensagem muda ou anda 10% (ou chega a 1)", async () => {
    const { service, logged } = await setup();
    service.progress(ref, 0.1, "Lendo");
    service.progress(ref, 0.12, "Lendo");
    service.progress(ref, 0.2, "Lendo");
    service.progress(ref, 0.25, "Escrevendo");
    service.progress(ref, 0.25, "Escrevendo");
    service.progress(ref, 1, "Escrevendo");
    expect(logged().map((entry) => entry.kind === "progress" && [entry.progress, entry.message])).toEqual([
      [0.1, "Lendo"],
      [0.2, "Lendo"],
      [0.25, "Escrevendo"],
      [1, "Escrevendo"],
    ]);
  });

  it("limite por tarefa: a narração para (com um aviso) e as entradas essenciais continuam", async () => {
    const { service, queue, paths } = await setup();
    for (let i = 0; i < AGENT_LOG_LIMITS.perTask + 10; i++) service.append(ref, { kind: "text", text: `linha ${i}` });
    const final = service.append(ref, { kind: "status", status: "done", message: "Concluída" });
    expect(final).toBeDefined();
    await queue.idle();
    const { entries } = (await service.readTask(TASK_ID))!;
    expect(entries.length).toBeLessThanOrEqual(AGENT_LOG_LIMITS.perTask);
    expect(entries.at(-2)).toMatchObject({ kind: "text", text: expect.stringContaining("Log cortado") });
    expect(entries.at(-1)).toMatchObject({ kind: "status", status: "done" });
    const lines = (await readFile(paths.taskLogFile(TASK_ID), "utf8")).trim().split("\n");
    expect(lines.length).toBe(entries.length);
  });

  it("limite exato no disco, mesmo depois de um reinício (contagem em memória zerada)", async () => {
    const { dir, paths } = await setup();
    await mkdir(paths.logsDir, { recursive: true });
    const old = Array.from({ length: AGENT_LOG_LIMITS.perTask }, (_, i) =>
      JSON.stringify({ id: `000000000-${i.toString(36).padStart(4, "0")}`, taskId: TASK_ID, agentId: "ana", at: "2026-11-08T09:00:00.000Z", kind: "text", text: `${i}` }),
    );
    await writeFile(paths.taskLogFile(TASK_ID), `${old.join("\n")}\n`);
    const { service, queue } = await setup({ dir });
    service.append(ref, { kind: "status", status: "started", message: "De novo" });
    await queue.idle();
    expect((await service.readTask(TASK_ID))!.entries).toHaveLength(AGENT_LOG_LIMITS.perTask);
  });

  it("arquivo ausente: log vazio para tarefa que existe; undefined se nem a tarefa existe", async () => {
    const { service } = await setup();
    expect(await service.readTask(TASK_ID)).toEqual({ taskId: TASK_ID, entries: [], threads: [] });
    expect(await service.readTask("nao-existe")).toBeUndefined();
  });

  it("ignora linhas quebradas ou inválidas no .jsonl", async () => {
    const { service, queue, paths } = await setup();
    service.append(ref, { kind: "text", text: "ok" });
    await queue.idle();
    await appendFile(paths.taskLogFile(TASK_ID), '{"quebrado\n{"id":"x","kind":"nada"}\n');
    const { entries } = (await service.readTask(TASK_ID))!;
    expect(entries.map((entry) => entry.kind === "text" && entry.text)).toEqual(["ok"]);
  });

  it("subagentes: entradas com thread, lista de threads, filtro ?thread= e resumo com subagentes ativos", async () => {
    const { service, queue } = await setup();
    const hooks = runnerLogHooks(service, ref, () => true);
    hooks.log({ kind: "text", text: "Vou dividir" });
    const a = hooks.subagent({ label: "Ana · pesquisa", goal: "pesquisar" });
    const b = hooks.subagent({ label: "Ana · notas", goal: "ler notas", id: "toolu_01/abc" });
    expect(b.id).toBe("toolu_01abc");
    a.log({ kind: "text", text: "pesquisando" });
    b.log({ kind: "tool", toolUseId: "b-1", name: "brain.search", input: { query: "x" } });
    a.progress(0.5, "Metade");
    expect(service.summary("ana")).toEqual({ activeTaskId: TASK_ID, activeSubagents: 2 });

    a.finish({ status: "ok", result: "3 achados" });
    a.log({ kind: "text", text: "depois de fechar" }); // ignorada
    expect(service.summary("ana").activeSubagents).toBe(1);

    // A tarefa acaba com o subagente B aberto: ferramenta e subagente fecham com erro.
    service.close(ref, "Interrompida", { kind: "status", status: "canceled", message: "Cancelada" });
    expect(service.summary("ana")).toEqual({ activeSubagents: 0 });
    await queue.idle();

    const all = (await service.readTask(TASK_ID))!;
    expect(all.threads).toEqual([
      expect.objectContaining({ id: a.id, label: "Ana · pesquisa", goal: "pesquisar", status: "ok", finishedAt: expect.any(String) }),
      expect.objectContaining({ id: "toolu_01abc", label: "Ana · notas", status: "error" }),
    ]);
    expect(all.entries.at(-1)).toMatchObject({ kind: "status", status: "canceled" });
    expect(all.entries.find((entry) => entry.kind === "tool")).toMatchObject({ thread: "toolu_01abc", status: "error", output: "Interrompida" });

    const onlyA = (await service.readTask(TASK_ID, a.id))!;
    expect(onlyA.entries.map((entry) => entry.kind)).toEqual(["text", "progress", "result"]);
    expect(onlyA.entries.every((entry) => entry.thread === a.id)).toBe(true);
    expect(onlyA.threads).toHaveLength(2);

    const main = (await service.readTask(TASK_ID, "main"))!;
    expect(main.entries.every((entry) => entry.thread === undefined)).toBe(true);
    expect(main.entries.map((entry) => (entry.kind === "subagent" ? `${entry.phase}:${entry.subagentId}` : entry.kind))).toEqual([
      "text",
      `started:${a.id}`,
      "started:toolu_01abc",
      `finished:${a.id}`,
      "finished:toolu_01abc",
      "status",
    ]);
  });

  it("ganchos inativos (tarefa cancelada) não escrevem nada", async () => {
    const { service, logged } = await setup();
    const hooks = runnerLogHooks(service, ref, () => false);
    hooks.log({ kind: "text", text: "x" });
    const sub = hooks.subagent({ label: "s", goal: "g" });
    sub.log({ kind: "text", text: "y" });
    sub.finish({ status: "ok" });
    expect(logged()).toEqual([]);
  });

  it("log do agente: buffer em memória e, depois de um reinício, lido do disco (mais novas por último)", async () => {
    const otherTask = "99999999-2222-3333-4444-555555555555";
    const tasks = [task(TASK_ID, "ana", "2026-11-08T09:00:00.000Z"), task(otherTask, "ana", "2026-11-08T09:30:00.000Z")];
    const first = await setup({ tasks });
    first.service.append(ref, { kind: "text", text: "um" });
    first.clock.advance(10);
    first.service.append({ taskId: otherTask, agentId: "ana" }, { kind: "text", text: "dois" });
    first.clock.advance(10);
    first.service.append({ taskId: otherTask, agentId: "bia" }, { kind: "text", text: "de outra" });
    const texts = (entries: AgentLogEntry[]) => entries.map((entry) => entry.kind === "text" && entry.text);
    expect(texts(await first.service.recentForAgent("ana", 10))).toEqual(["um", "dois"]);
    expect(texts(await first.service.recentForAgent("ana", 1))).toEqual(["dois"]);
    await first.queue.idle();

    const second = await setup({ tasks, dir: first.dir });
    second.clock.advance(60_000);
    second.service.append(ref, { kind: "text", text: "três" });
    expect(texts(await second.service.recentForAgent("ana", 10))).toEqual(["um", "dois", "três"]);
    expect(await second.service.recentForAgent("ninguem", 10)).toEqual([]);
  });
});
