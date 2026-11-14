import { describe, expect, it } from "vitest";
import { makeAgent, makeLogEntry as entry } from "../test-fixtures";
import { engineLabel, entriesToSteps, entryToStep, formatDuration, lastActivity, latestProvider } from "./agentLogTimeline";

describe("entryToStep", () => {
  it("texto e resultado são markdown; resultado fica ok", () => {
    expect(entryToStep(entry("e1", { kind: "text", text: "**Oi**" }))).toMatchObject({ kind: "step", id: "e1", variant: "text", state: "info", text: "**Oi**", markdown: true });
    expect(entryToStep(entry("e2", { kind: "result", text: "## Feito" }))).toMatchObject({ variant: "result", state: "ok", markdown: true });
  });

  it("ferramenta: nome, resumo, estado, duração, saída e input formatado", () => {
    const step = entryToStep(
      entry("e1", { kind: "tool", toolUseId: "tu1", name: "Read", summary: "src/a.ts", input: { file: "src/a.ts" }, status: "ok", output: "linha 1", durationMs: 1200 }),
    );
    expect(step).toMatchObject({ variant: "tool", state: "ok", text: "src/a.ts", tag: "Read" });
    expect(step.tool).toEqual({ name: "Read", summary: "src/a.ts", phrase: { icon: "📖", text: "Lendo a.ts" }, durationMs: 1200, output: "linha 1", input: '{\n  "file": "src/a.ts"\n}' });
    const running = entryToStep(entry("e2", { kind: "tool", toolUseId: "tu2", name: "Bash", summary: "", status: "running" }));
    expect(running).toMatchObject({ state: "running", text: "Bash" });
    expect(running.tool).toEqual({ name: "Bash", summary: "", phrase: { icon: "💻", text: "Rodando um comando no terminal" } });
  });

  it("linha crua: stderr vira erro", () => {
    expect(entryToStep(entry("e1", { kind: "raw", stream: "stderr", text: "boom" }))).toMatchObject({ variant: "raw", state: "error", stream: "stderr", tag: "stderr" });
    expect(entryToStep(entry("e2", { kind: "raw", stream: "stdout", text: "ok" }))).toMatchObject({ state: "info", tag: undefined });
  });

  it("aprovação, delegação, subagente e status", () => {
    expect(entryToStep(entry("a", { kind: "approval", phase: "asked", question: "Publicar?" }))).toMatchObject({ state: "attention", text: "Pediu sua aprovação: Publicar?" });
    expect(entryToStep(entry("b", { kind: "approval", phase: "decided", approved: false, note: "não" }))).toMatchObject({ state: "error", text: "Você recusou", detail: "não" });
    expect(
      entryToStep(entry("c", { kind: "delegation", teamId: "v", teamName: "Vídeo", toAgentId: "rafa", toAgentName: "Rafa", reason: "fala de vídeo", subtaskId: "s1" })),
    ).toMatchObject({ variant: "delegation", text: "Mandou para o time Vídeo com Rafa", detail: "fala de vídeo", agentId: "rafa" });
    expect(entryToStep(entry("d", { kind: "subagent", phase: "started", subagentId: "sa1", label: "Ana · pesquisa", goal: "achar" }))).toMatchObject({
      state: "running",
      threadId: "sa1",
      detail: "achar",
    });
    // Subagente de CLI com o modelo (o que o agente pediu ou o padrão dos subagentes).
    expect(entryToStep(entry("d2", { kind: "subagent", phase: "started", subagentId: "sa2", label: "Revisão", goal: "revisar", model: "haiku" }))).toMatchObject({
      text: "Subagente: Revisão (haiku)",
    });
    expect(entryToStep(entry("e", { kind: "subagent", phase: "finished", subagentId: "sa1", label: "Ana · pesquisa", status: "error" }))).toMatchObject({
      state: "error",
      text: "Subagente falhou: Ana · pesquisa",
    });
    expect(entryToStep(entry("f", { kind: "status", status: "waiting", message: "Esperando sua aprovação" }))).toMatchObject({ state: "attention", tag: "esperando" });
    expect(entryToStep(entry("g", { kind: "status", status: "done", message: "Concluída" }))).toMatchObject({ state: "ok" });
  });
});

describe("entriesToSteps", () => {
  it("progressos seguidos da mesma tarefa viram o mais novo; de outra tarefa, não", () => {
    const steps = entriesToSteps([
      entry("e1", { kind: "progress", progress: 0.2, message: "a" }),
      entry("e2", { kind: "progress", progress: 0.5, message: "b" }),
      entry("e3", { kind: "progress", progress: 0.1, message: "c" }, { taskId: "t2" }),
      entry("e4", { kind: "text", text: "oi" }),
      entry("e5", { kind: "progress", progress: 0.9, message: "d" }),
    ]);
    expect(steps.map((step) => step.id)).toEqual(["e2", "e3", "e4", "e5"]);
    expect(steps[0]).toMatchObject({ progress: 0.5, text: "b" });
  });

  it("o 'começou' de um subagente que já terminou para de pulsar", () => {
    const steps = entriesToSteps([
      entry("e1", { kind: "subagent", phase: "started", subagentId: "sa1", label: "x", goal: "" }),
      entry("e2", { kind: "subagent", phase: "started", subagentId: "sa2", label: "y", goal: "" }),
      entry("e3", { kind: "subagent", phase: "finished", subagentId: "sa1", label: "x", status: "ok" }),
    ]);
    expect(steps.map((step) => step.state)).toEqual(["info", "running", "ok"]);
  });
});

describe("motor e atividade", () => {
  it("formatDuration", () => {
    expect(formatDuration(820)).toBe("820 ms");
    expect(formatDuration(4200)).toBe("4,2 s");
    expect(formatDuration(42_000)).toBe("42 s");
    expect(formatDuration(65_000)).toBe("1 min 05 s");
  });

  it("engineLabel: o engine do agente (texto ou objeto) vence; senão o provedor do log", () => {
    const log = [entry("e1", { kind: "text", text: "a" }, { provider: "claude" }), entry("e2", { kind: "text", text: "b" })];
    expect(latestProvider(log)).toBe("claude");
    expect(engineLabel(makeAgent("ana", "t"), log)).toBe("Claude Code");
    expect(engineLabel({ ...makeAgent("ana", "t"), engine: "codex" }, log)).toBe("Codex");
    expect(engineLabel({ ...makeAgent("ana", "t"), engine: { kind: "gemini" } }, [])).toBe("Antigravity");
    expect(engineLabel({ ...makeAgent("ana", "t"), engine: "outro-cli" }, [])).toBe("outro-cli");
    expect(engineLabel(makeAgent("ana", "t"), [])).toBeUndefined();
  });

  it("lastActivity: o último passo do próprio agente (pula subagentes e resultados)", () => {
    expect(
      lastActivity([
        entry("e1", { kind: "tool", toolUseId: "t", name: "Busca", summary: "concorrentes", status: "running" }),
        entry("e2", { kind: "text", text: "no subagente" }, { thread: "sa1" }),
      ]),
    ).toBe("Busca: concorrentes");
    expect(lastActivity([entry("e1", { kind: "text", text: "\n**Lendo** os dados\nmais" })])).toBe("Lendo os dados");
    expect(lastActivity([])).toBeUndefined();
  });
});
