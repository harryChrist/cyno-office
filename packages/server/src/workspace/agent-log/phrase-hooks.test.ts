import { type ServerEvent, type Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { dataPaths } from "../../store/paths";
import { WriteQueue } from "../../store/write-queue";
import { useTempDirs } from "../../dev/test-utils";
import { runnerLogHooks } from "./hooks";
import { AgentLogService } from "./service";

const tempDir = useTempDirs();
const TASK_ID = "11111111-2222-3333-4444-555555555555";

async function setup() {
  const dir = await tempDir();
  const events: ServerEvent[] = [];
  const task: Task = { id: TASK_ID, roomId: "a", teamId: "t", agentId: "ana", prompt: "x", status: "in_progress", createdAt: "2026-11-08T09:00:00.000Z", updatedAt: "2026-11-08T09:00:00.000Z" };
  const service = new AgentLogService({
    paths: dataPaths(dir),
    queue: new WriteQueue(),
    publish: (event) => events.push(event),
    tasks: () => [task],
    log: { error: () => undefined },
    now: () => new Date("2026-11-08T10:00:00.000Z"),
  });
  const logged = () => events.flatMap((event) => (event.type === "agent:log" ? [event.entry] : []));
  return { hooks: runnerLogHooks(service, { taskId: TASK_ID, agentId: "ana", provider: "gemini" }, () => true), logged };
}

describe("frase de atividade no registro de trabalho", () => {
  it("a entrada de ferramenta leva a frase, nos nomes do Claude Code e do Antigravity", async () => {
    const { hooks, logged } = await setup();
    hooks.log({ kind: "tool", toolUseId: "a", name: "Read", input: { file_path: "/x/package.json" } });
    hooks.log({ kind: "tool", toolUseId: "b", name: "view_file", input: { AbsolutePath: "/x/notas.txt" } });
    hooks.log({ kind: "tool", toolUseId: "c", name: "mcp__office__save_note", input: { title: "Café", content: "…" } });
    const tools = logged().filter((entry) => entry.kind === "tool");
    expect(tools.map((entry) => entry.kind === "tool" && entry.phrase)).toEqual([
      { icon: "📖", text: "Lendo package.json" },
      { icon: "📖", text: "Lendo notas.txt" },
      { icon: "🧠", text: "Anotando “Café” no Cérebro" },
    ]);
  });

  it("segredo no input não vaza na frase nem no resumo", async () => {
    const { hooks, logged } = await setup();
    hooks.log({ kind: "tool", toolUseId: "a", name: "Grep", input: { pattern: "sk-ant-api03-TESTE-0000000000000000000000000000" } });
    const [entry] = logged();
    expect(entry && entry.kind === "tool" && JSON.stringify([entry.phrase, entry.summary])).not.toContain("TESTE");
  });
});
