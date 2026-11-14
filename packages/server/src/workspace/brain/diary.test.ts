import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { AgentDiary, diaryEntry } from "./diary";
import { DIARY_LIMITS } from "./limits";

const tempDir = useTempDirs();
const at = new Date(2026, 10, 8, 14, 3);

describe("diário do agente", () => {
  it("entrada curta: data, pedido e o começo da entrega (sem markdown), com teto", () => {
    const entry = diaryEntry({ id: "abcdef12-3456", prompt: "Escreva\n o slogan" }, { status: "done", result: "# Slogans\n\n- **Pizza** que abraça\n- Outro\n- Mais\n- Fora" }, at);
    expect(entry).toBe("- 2026-11-08 14:03 · “Escreva o slogan” → entregue: Slogans / Pizza que abraça / Outro (tarefa abcdef12)");
    expect(diaryEntry({ id: "x", prompt: "p" }, { status: "failed", result: "Recusado pelo usuário" }, at)).toContain("→ falhou: Recusado pelo usuário");
    expect(diaryEntry({ id: "x", prompt: "p".repeat(500) }, { status: "done", result: "r".repeat(5000) }, at).length).toBeLessThanOrEqual(DIARY_LIMITS.entryChars);
  });

  it("guarda as últimas entradas e devolve as mais recentes com teto de caracteres", async () => {
    const dir = await tempDir();
    const diary = new AgentDiary((agentId) => path.join(dir, "agents", agentId));
    expect(await diary.recent("redator")).toBe("");
    await Promise.all(Array.from({ length: DIARY_LIMITS.keep + 5 }, (_, i) => diary.append("redator", `- 2026-11-08 10:${String(i % 60).padStart(2, "0")} · entrada ${i}`)));
    const file = await readFile(path.join(dir, "agents", "redator", "diario.md"), "utf8");
    const lines = file.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(DIARY_LIMITS.keep);
    expect(lines.at(-1)).toContain(`entrada ${DIARY_LIMITS.keep + 4}`);
    const recent = (await diary.recent("redator")).split("\n");
    expect(recent).toHaveLength(DIARY_LIMITS.recent);
    expect(recent.at(-1)).toContain(`entrada ${DIARY_LIMITS.keep + 4}`);

    const long = new AgentDiary((agentId) => path.join(dir, "outro", agentId));
    for (let i = 0; i < 5; i++) await long.append("a", `- 2026-11-08 10:0${i} · ${"x".repeat(DIARY_LIMITS.entryChars - 30)}`);
    expect((await long.recent("a")).length).toBeLessThanOrEqual(DIARY_LIMITS.recentChars);
  });
});
