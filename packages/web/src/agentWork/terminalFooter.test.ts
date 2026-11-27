import type { AgentLogEntry } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { sinceLabel, terminalFooter } from "./terminalFooterLogic";

const AT = "2026-11-12T12:00:00.000Z";
let seq = 0;
const entry = (body: Record<string, unknown>, extra: Partial<AgentLogEntry> = {}): AgentLogEntry =>
  ({ id: `f${++seq}`, taskId: "11111111-2222-3333-4444-555555555555", agentId: "rafa", at: AT, ...body, ...extra }) as AgentLogEntry;

describe("terminalFooter", () => {
  it("sem nada no log", () => {
    expect(terminalFooter([], false)).toEqual({ kind: "idle", text: "Aguardando um pedido" });
    expect(terminalFooter([], true)).toMatchObject({ kind: "working" });
  });

  it("ferramenta rodando mostra a frase de atividade", () => {
    const footer = terminalFooter([entry({ kind: "tool", toolUseId: "t", name: "Read", summary: "src/App.tsx", input: { file_path: "src/App.tsx" }, status: "running" })], true);
    expect(footer).toMatchObject({ kind: "tool", since: AT });
    expect(footer.text).toMatch(/App\.tsx/);
    expect(footer.icon).toBeTruthy();
  });

  it("usa a frase gravada no log quando existe", () => {
    const footer = terminalFooter([entry({ kind: "tool", toolUseId: "t", name: "X", summary: "", phrase: { icon: "🔎", text: "Procurando" }, status: "running" })], true);
    expect(footer).toMatchObject({ icon: "🔎", text: "Procurando" });
  });

  it("aprovação em aberto: esperando você; decidida, não", () => {
    const asked = entry({ kind: "approval", phase: "asked", question: "Posso publicar?" });
    expect(terminalFooter([asked], true)).toMatchObject({ kind: "waiting", text: "Esperando você: Posso publicar?" });
    expect(terminalFooter([asked, entry({ kind: "approval", phase: "decided", approved: true })], true).kind).toBe("working");
  });

  it("falhou, trabalhando e parado", () => {
    expect(terminalFooter([entry({ kind: "status", status: "failed", message: "Caiu" })], false)).toMatchObject({ kind: "failed", text: "Caiu" });
    expect(terminalFooter([entry({ kind: "text", text: "x" })], true)).toMatchObject({ kind: "working", text: "Trabalhando…", since: AT });
    expect(terminalFooter([entry({ kind: "text", text: "x" })], false)).toMatchObject({ kind: "idle", text: "Aguardando" });
  });

  it("ignora o que é de subagente", () => {
    const footer = terminalFooter([entry({ kind: "text", text: "meu" }), entry({ kind: "tool", toolUseId: "t", name: "Read", summary: "x", status: "running" }, { thread: "s1" })], true);
    expect(footer.kind).toBe("working");
  });

  it("sinceLabel", () => {
    expect(sinceLabel(500)).toBe("agora");
    expect(sinceLabel(12_000)).toBe("há 12 s");
    expect(sinceLabel(180_000)).toBe("há 3 min");
    expect(sinceLabel(7_300_000)).toBe("há 2 h");
  });
});
