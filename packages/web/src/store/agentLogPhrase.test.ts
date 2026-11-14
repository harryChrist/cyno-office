import { describe, expect, it } from "vitest";
import { withLivePhrases } from "../hud/hoje/todayView";
import { makeLogEntry as entry } from "../test-fixtures";
import { livePhrase, maskToolEntry, mergeEntry, mergeHistory, phraseOfTool } from "./agentLog";

const KEY = "sk-ant-api03-TESTE-0000000000000000000000000000";
const AT = "2026-11-12T10:00:00.000Z";
const NOW = Date.parse(AT);

const tool = (id: string, extra: Record<string, unknown> = {}, extraEntry: Record<string, unknown> = {}) =>
  entry(id, { kind: "tool", toolUseId: `tu-${id}`, name: "Read", summary: "src/App.tsx", input: { file_path: "src/App.tsx" }, status: "running", ...extra }, { at: AT, ...extraEntry });

describe("máscara de segredos no que a tela mostra de uma ferramenta", () => {
  it("resumo, entrada e saída saem mascarados; o resto da entrada fica", () => {
    const masked = maskToolEntry(tool("e1", { summary: `chave ${KEY}`, input: { command: `echo ${KEY}`, n: 2 }, output: `ANTHROPIC_API_KEY=${KEY}`, status: "ok" }));
    expect(JSON.stringify(masked)).not.toContain("TESTE");
    expect(masked).toMatchObject({ kind: "tool", name: "Read", status: "ok", input: { n: 2 } });
    expect(masked.kind === "tool" && masked.output).toBe("ANTHROPIC_API_KEY=***");
  });

  it("vale ao vivo (mergeEntry) e no histórico (mergeHistory); texto de conversa não é mexido", () => {
    const live = mergeEntry([], tool("e1", { output: KEY, status: "ok" }));
    expect(JSON.stringify(live)).not.toContain("TESTE");
    const history = mergeHistory([], [tool("e2", { summary: KEY })]);
    expect(JSON.stringify(history)).not.toContain("TESTE");
    const text = entry("e3", { kind: "text", text: `fala ${KEY}` });
    expect(maskToolEntry(text)).toBe(text);
  });
});

describe("a frase de uma ferramenta e a frase de agora", () => {
  it("usa a gravada pelo servidor; log antigo é calculado na hora (inclusive nomes do Antigravity)", () => {
    expect(phraseOfTool(tool("e1", { phrase: { icon: "🧠", text: "Anotando no Cérebro" } }) as never)).toEqual({ icon: "🧠", text: "Anotando no Cérebro" });
    expect(phraseOfTool(tool("e2", { name: "view_file", input: { AbsolutePath: "/p/notas.txt" } }) as never)).toEqual({ icon: "📖", text: "Lendo notas.txt" });
  });

  it("livePhrase: ferramenta rodando, ou terminada há pouco; some depois; ignora subagente e fim de tarefa", () => {
    expect(livePhrase([tool("e1")], NOW)).toEqual({ icon: "📖", text: "Lendo App.tsx" });
    expect(livePhrase([tool("e1", { status: "ok" })], NOW + 2_000)).toEqual({ icon: "📖", text: "Lendo App.tsx" });
    expect(livePhrase([tool("e1", { status: "ok" })], NOW + 60_000)).toBeUndefined();
    expect(livePhrase([tool("e1"), entry("e2", { kind: "result", text: "fim" })], NOW)).toBeUndefined();
    expect(livePhrase([tool("e1"), tool("e2", { name: "Grep", input: { pattern: "x" } }, { thread: "sa-1" })], NOW)).toEqual({ icon: "📖", text: "Lendo App.tsx" });
    expect(livePhrase([], NOW)).toBeUndefined();
  });
});
describe("onde a frase aparece", () => {

  it("Hoje, bloco Agora: a linha ganha a frase do agente; na fila, não", () => {
    const rows = [
      { taskId: "t1", title: "Pesquisar", agentId: "ana", since: AT, queued: false },
      { taskId: "t2", title: "Esperar", agentId: "ana", since: AT, queued: true },
      { taskId: "t3", title: "Outra", agentId: "bia", since: AT, queued: false },
    ];
    const out = withLivePhrases(rows, { ana: [tool("e1")] }, NOW);
    expect(out[0]!.phrase).toEqual({ icon: "📖", text: "Lendo App.tsx" });
    expect(out[1]!.phrase).toBeUndefined();
    expect(out[2]!.phrase).toBeUndefined();
  });
});
