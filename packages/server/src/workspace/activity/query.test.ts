import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { activityQuerySchema, type ActivityEntry } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { queryActivity, readActivityRange, summarizeActivity } from "./query";
import { spIso } from "./time";

const tempDir = useTempDirs();

let seq = 0;
const entry = (at: string, partial: Partial<ActivityEntry>): ActivityEntry => ({
  id: `e${String(++seq).padStart(4, "0")}`,
  at: spIso(Date.parse(at)),
  category: "tarefa",
  action: "concluida",
  actor: "agente-1",
  summary: "Fulano concluiu “Tarefa”",
  ...partial,
});

async function seed(): Promise<string> {
  const dir = await tempDir();
  const days: Record<string, ActivityEntry[]> = {
    "2026-11-08": [entry("2026-11-08T15:00:00Z", { summary: "Ana concluiu “Post” em 3 min", actor: "ana" })],
    "2026-11-09": [
      entry("2026-11-09T15:00:00Z", { category: "aprovacao", action: "pedida", summary: "Ana pediu a sua aprovação: Post", actor: "ana" }),
      entry("2026-11-09T16:00:00Z", { category: "aprovacao", action: "aprovada", actor: "usuario", summary: "Você aprovou: Post" }),
    ],
    "2026-11-10": [
      entry("2026-11-10T13:00:00Z", { action: "concluida", data: { costUsd: 0.5, tokens: 1000 } }),
      entry("2026-11-10T14:00:00Z", { action: "falhou", summary: "Fulano não conseguiu concluir “Tarefa”" }),
      entry("2026-11-10T15:00:00Z", { category: "publicacao", action: "executada", summary: "Ana executou “Publicar” em linkedin.com", refs: { url: "https://linkedin.com/feed" }, actor: "ana" }),
      entry("2026-11-10T16:00:00Z", { category: "midia", action: "criada", summary: "Ana criou uma imagem “Capa”", actor: "ana" }),
    ],
  };
  await mkdir(dir, { recursive: true });
  for (const [day, list] of Object.entries(days)) await writeFile(path.join(dir, `${day}.jsonl`), `${list.map((item) => JSON.stringify(item)).join("\n")}\nlinha quebrada\n`);
  return dir;
}

const parse = (query: object) => activityQuerySchema.parse(query);

describe("queryActivity", () => {
  it("devolve mais novo primeiro, ignora linhas quebradas e pagina por cursor", async () => {
    const dir = await seed();
    const first = await queryActivity(dir, parse({ limit: 3 }));
    expect(first.entries.map((item) => item.action)).toEqual(["criada", "executada", "falhou"]);
    expect(first.nextCursor).toBeDefined();
    const second = await queryActivity(dir, parse({ limit: 3, cursor: first.nextCursor }));
    expect(second.entries.map((item) => item.action)).toEqual(["concluida", "aprovada", "pedida"]);
    const third = await queryActivity(dir, parse({ limit: 3, cursor: second.nextCursor }));
    expect(third.entries).toHaveLength(1);
    expect(third.nextCursor).toBeUndefined();
  });

  it("filtra por período (dias de São Paulo), categoria, ator e busca sem acento", async () => {
    const dir = await seed();
    expect((await queryActivity(dir, parse({ from: "2026-11-10", to: "2026-11-10" }))).entries).toHaveLength(4);
    expect((await queryActivity(dir, parse({ from: "2026-11-09", to: "2026-11-09" }))).entries).toHaveLength(2);
    expect((await queryActivity(dir, parse({ category: "aprovacao,midia" }))).entries).toHaveLength(3);
    expect((await queryActivity(dir, parse({ actor: "ana" }))).entries).toHaveLength(4);
    expect((await queryActivity(dir, parse({ q: "aprovacao" }))).entries.map((item) => item.action)).toEqual(["pedida"]);
    expect((await queryActivity(dir, parse({ q: "linkedin.com" }))).entries).toHaveLength(1);
  });

  it("pasta que não existe = vazio", async () => {
    expect(await queryActivity("/nao/existe", parse({}))).toEqual({ entries: [] });
  });
});

describe("summarizeActivity", () => {
  it("conta tarefas, aprovações, publicações, mídia e custo do período", async () => {
    const dir = await seed();
    const week = summarizeActivity(await readActivityRange(dir, "2026-11-08", "2026-11-10"), { from: "2026-11-08", to: "2026-11-10" });
    expect(week).toMatchObject({ total: 7, tasksDone: 2, tasksFailed: 1, publications: 1, media: 1, costUsd: 0.5, tokens: 1000 });
    expect(week.approvals).toEqual({ requested: 1, approved: 1, rejected: 0, answered: 0 });
    expect(week.byCategory).toMatchObject({ tarefa: 3, aprovacao: 2 });
    const today = summarizeActivity(await readActivityRange(dir, "2026-11-10", "2026-11-10"), { from: "2026-11-10", to: "2026-11-10" });
    expect(today.total).toBe(4);
  });
});
