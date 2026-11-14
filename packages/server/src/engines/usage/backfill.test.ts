import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { UsageRecord } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { claudeProjectDirName } from "../../platform/retention/retention";
import { WriteQueue } from "../../store/write-queue";
import { useTempDirs } from "../../dev/test-utils";
import { backfillClaudeTranscripts } from "./backfill";
import { totalsOf, priceRecord } from "./usage-aggregate";
import { UsageHistory } from "./usage-history";

const tempDir = useTempDirs();
const SESSION = "05d1f9ee-0000-4000-8000-000000000001";
const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

/** Um workspace com o agente "eco", duas tarefas, os logs delas e as conversas do Claude Code (fixtures). */
async function setup() {
  const root = await tempDir();
  const workspaceDir = path.join(root, "workspaces", "ws");
  const projectsDir = path.join(root, "claude", "projects");
  const agentDir = path.join(workspaceDir, "agents", "eco");
  await mkdir(agentDir, { recursive: true });
  await mkdir(path.join(workspaceDir, "logs"), { recursive: true });
  const task = (id: string, prompt: string, projectId?: string) => ({
    id,
    roomId: "estudio",
    teamId: "time",
    agentId: "eco",
    ...(projectId ? { projectId } : {}),
    prompt,
    status: "done",
    createdAt: "2026-11-09T12:59:00.000Z",
    updatedAt: "2026-11-09T13:10:00.000Z",
  });
  await writeFile(path.join(workspaceDir, "tasks.json"), JSON.stringify([task("task-1", "Pesquisar o post do Lucas"), task("task-2", "Publicar o comentário", "task-1")]));
  const logLine = (taskId: string, at: string, extra: object) => JSON.stringify({ id: `${taskId}-${at}`, taskId, agentId: "eco", at, ...extra });
  await writeFile(
    path.join(workspaceDir, "logs", "task-1.jsonl"),
    [
      logLine("task-1", "2026-11-09T12:59:59.000Z", { provider: "claude", kind: "raw", stream: "stdout", text: `[init] sessão ${SESSION} · modelo claude-sonnet-5-5 · ferramentas: Read` }),
      logLine("task-1", "2026-11-09T13:00:06.000Z", { provider: "claude", kind: "tool", toolUseId: "toolu_1", name: "report_progress", status: "ok" }),
    ].join("\n"),
  );
  await writeFile(
    path.join(workspaceDir, "logs", "task-2.jsonl"),
    logLine("task-2", "2026-11-09T13:05:03.000Z", { provider: "claude", kind: "tool", toolUseId: "toolu_2", name: "Agent", status: "running" }),
  );
  const transcripts = path.join(projectsDir, claudeProjectDirName(agentDir)!);
  await mkdir(path.join(transcripts, SESSION, "subagents"), { recursive: true });
  await copyFile(fixture("claude-session.jsonl"), path.join(transcripts, `${SESSION}.jsonl`));
  await copyFile(fixture("claude-subagent.jsonl"), path.join(transcripts, SESSION, "subagents", "agent-a1.jsonl"));
  // O server já registrou ao vivo um turno do eco às 13:06: o que vem depois não é importado.
  const usage = path.join(workspaceDir, "usage");
  await mkdir(usage);
  const live: UsageRecord = { v: 1, id: "live-1", at: "2026-11-09T13:06:00.000Z", agentId: "eco", provider: "claude", source: "live", measured: false, costUsd: null, priceVersion: "x" };
  await writeFile(path.join(usage, "2026-11.jsonl"), `${JSON.stringify(live)}\n`);
  return { workspaceDir, projectsDir, usage };
}

const lines = async (file: string) =>
  (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as UsageRecord);

describe("backfillClaudeTranscripts", () => {
  it("importa cada mensagem com tokens (modelo, hora, tarefa, cache 1 h) e é idempotente", async () => {
    const { workspaceDir, projectsDir, usage } = await setup();
    const first = await backfillClaudeTranscripts({ workspaceDir, projectsDir });
    expect(first).toMatchObject({ agents: 1, files: 2, messages: 6, imported: 5, duplicates: 0, afterLive: 1, withTask: 5, unpriced: 0, months: { "2026-11": 5 } });

    const records = await lines(path.join(usage, "backfill-2026-11.jsonl"));
    const byId = new Map(records.map((record) => [record.id, record]));
    expect([...byId.keys()].sort()).toEqual(["claude-msg:msg_A", "claude-msg:msg_B", "claude-msg:msg_C", "claude-msg:msg_D", "claude-msg:msg_F"]);
    // O mesmo id em várias linhas (um bloco por linha) vira uma mensagem só, com o maior número de cada campo.
    expect(byId.get("claude-msg:msg_A")).toMatchObject({
      at: "2026-11-09T13:00:05.000Z",
      agentId: "eco",
      provider: "claude",
      model: "claude-sonnet-5-5",
      modelSource: "cli",
      taskId: "task-1",
      rootTaskId: "task-1",
      taskTitle: "Pesquisar o post do Lucas",
      sessionId: SESSION,
      source: "backfill",
      measured: true,
      tokens: { input: 2, output: 180, cacheRead: 0, cacheCreation: 25923, cacheCreation5m: 0, cacheCreation1h: 25923 },
      promptTokens: 25925,
      speed: "standard",
    });
    expect(byId.get("claude-msg:msg_A")!.turns).toBeUndefined(); // primeira mensagem do pedido = 1 turno
    expect(byId.get("claude-msg:msg_B")).toMatchObject({ taskId: "task-1", turns: 0 });
    // Segundo pedido: a ferramenta toolu_2 está no log da task-2 (subtarefa da task-1).
    expect(byId.get("claude-msg:msg_C")).toMatchObject({ taskId: "task-2", parentTaskId: "task-1", rootTaskId: "task-1" });
    expect(byId.get("claude-msg:msg_C")!.turns).toBeUndefined();
    // Subagente (na conversa e no arquivo à parte): o modelo dele, sem contar turno.
    expect(byId.get("claude-msg:msg_D")).toMatchObject({ model: "claude-haiku-5-5", taskId: "task-2", turns: 0 });
    expect(byId.get("claude-msg:msg_F")).toMatchObject({ model: "claude-haiku-5-5", taskId: "task-1", turns: 0 });

    // Rodar de novo não duplica nada; o arquivo do server nunca é tocado.
    const second = await backfillClaudeTranscripts({ workspaceDir, projectsDir });
    expect(second).toMatchObject({ imported: 0, duplicates: 5, afterLive: 1 });
    expect(await lines(path.join(usage, "backfill-2026-11.jsonl"))).toHaveLength(5);
    expect(await lines(path.join(usage, "2026-11.jsonl"))).toHaveLength(1);

    // A leitura do histórico junta o ao vivo e o importado.
    const history = new UsageHistory({ dir: usage, queue: new WriteQueue(), agents: () => [], tasks: () => [], log: { warn: () => undefined }, now: () => new Date() });
    const all = await history.read();
    expect(all).toHaveLength(6);
    const totals = totalsOf(all.filter((record) => record.source === "backfill").map((record) => priceRecord(record)), 5);
    expect(totals.turns).toBe(2);
    expect(totals.costUsd).toBeGreaterThan(0);
  });

  it("simulação não grava; workspace sem conversas não importa nada", async () => {
    const { workspaceDir, projectsDir, usage } = await setup();
    const dry = await backfillClaudeTranscripts({ workspaceDir, projectsDir, dryRun: true });
    expect(dry.imported).toBe(5);
    expect(await readdir(usage)).toEqual(["2026-11.jsonl"]);
    const none = await backfillClaudeTranscripts({ workspaceDir, projectsDir: path.join(projectsDir, "vazio") });
    expect(none).toMatchObject({ agents: 0, files: 0, imported: 0 });
  });
});
