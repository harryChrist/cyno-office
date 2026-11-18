import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ForYouItem } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../dev/test-utils";
import { readForYouDir } from "./files";
import { ForYouArchive } from "./for-you-archive";
import { WriteQueue } from "./write-queue";

const tempDir = useTempDirs();

function item(id: string, over: Partial<ForYouItem> = {}): ForYouItem {
  return { id, taskId: `t-${id.toLowerCase()}`, agentId: "a", roomId: "r", type: "post", status: "aprovado", meta: {}, text: `texto ${id}`, editedByUser: false, createdAt: "2026-10-01T10:00:00.000Z", decidedAt: "2026-10-02T10:00:00.000Z", ...over };
}

async function open(dir?: string) {
  const root = dir ?? path.join(await tempDir(), "archive");
  return { root, archive: await ForYouArchive.open(root, new WriteQueue()) };
}

describe("ForYouArchive", () => {
  it("pasta ausente = vazio, e o próximo id segue a lista viva", async () => {
    const { archive } = await open();
    expect(archive.summary(7)).toEqual({ liveDays: 7, months: [] });
    expect(archive.nextId([])).toBe("A-0001");
    expect(archive.nextId([item("A-0004")])).toBe("A-0005");
    expect(await archive.readMonth("2026-10")).toEqual([]);
    expect(await archive.find({ taskId: "x" })).toEqual([]);
  });

  it("acrescenta pelo mês da decisão, sem repetir id, e o resumo vem do mais novo para o mais antigo", async () => {
    const { root, archive } = await open();
    await archive.append([item("A-0001"), item("A-0002", { decidedAt: "2026-11-03T10:00:00.000Z" }), item("A-0003", { status: "pendente", decidedAt: undefined })]);
    await archive.append([item("A-0001", { text: "outro texto" }), item("A-0004")]);
    expect((await readdir(root)).sort()).toEqual(["2026-10.json", "2026-11.json"]);
    expect(archive.summary(14)).toEqual({ liveDays: 14, months: [{ month: "2026-11", count: 1 }, { month: "2026-10", count: 3 }] });
    const october = await archive.readMonth("2026-10");
    expect(october.map((entry) => entry.id)).toEqual(["A-0003", "A-0001", "A-0004"]);
    expect(october.find((entry) => entry.id === "A-0001")?.text).toBe("texto A-0001");
    // Sem decisão, vale o mês da criação.
    expect(JSON.parse(await readFile(path.join(root, "2026-10.json"), "utf8"))).toHaveLength(3);
    expect(await archive.readMonth("2025-01")).toEqual([]);
    expect(await archive.readMonth("lixo")).toEqual([]);
  });

  it("acha por taskId e/ou id, do mês mais novo ao mais antigo", async () => {
    const { archive } = await open();
    await archive.append([item("A-0001", { taskId: "t1" }), item("A-0002", { taskId: "t1", decidedAt: "2026-11-03T10:00:00.000Z" }), item("A-0003", { taskId: "t2" })]);
    expect((await archive.find({ taskId: "t1" })).map((entry) => entry.id)).toEqual(["A-0002", "A-0001"]);
    expect((await archive.find({ id: "A-0003" })).map((entry) => entry.id)).toEqual(["A-0003"]);
    expect((await archive.find({ taskId: "t2", id: "A-0001" })).map((entry) => entry.id).sort()).toEqual(["A-0001", "A-0003"]);
    expect(await archive.find({})).toEqual([]);
    expect(archive.has("A-0002")).toBe(true);
    expect(archive.has("A-0009")).toBe(false);
  });

  it("a marca d'água do id vem do arquivo, também depois de reabrir: nunca reaproveita um id arquivado", async () => {
    const { root, archive } = await open();
    await archive.append([item("A-0007"), item("A-0003")]);
    expect(archive.nextId([])).toBe("A-0008");
    expect(archive.nextId([item("A-0002")])).toBe("A-0008");
    expect(archive.nextId([item("A-0012")])).toBe("A-0013");
    const reopened = await ForYouArchive.open(root, new WriteQueue());
    expect(reopened.nextId([])).toBe("A-0008");
    expect(reopened.has("A-0003")).toBe(true);
  });

  it("retype troca o tipo dos itens arquivados e devolve quantos mudaram", async () => {
    const { archive } = await open();
    await archive.append([item("A-0001", { type: "convite" }), item("A-0002", { type: "post" }), item("A-0003", { type: "convite", decidedAt: "2026-11-03T10:00:00.000Z" })]);
    expect(await archive.retype("convite", "mensagem")).toBe(2);
    expect((await archive.readMonth("2026-10")).map((entry) => entry.type)).toEqual(["mensagem", "post"]);
    expect((await archive.readMonth("2026-11"))[0]?.type).toBe("mensagem");
    expect(await archive.retype("convite", "outro")).toBe(0);
  });

  it("arquivo mal formado no boot falha com mensagem clara (não perde a marca d'água em silêncio)", async () => {
    const root = path.join(await tempDir(), "archive");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "2026-10.json"), JSON.stringify([{ id: 1 }]), "utf8");
    await expect(ForYouArchive.open(root, new WriteQueue())).rejects.toThrow(/inválido/);
  });

  it("a leitura mensal da lista viva ignora a subpasta archive/", async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, "archive"), { recursive: true });
    await writeFile(path.join(dir, "archive", "2026-10.json"), JSON.stringify([item("A-0001")]), "utf8");
    await writeFile(path.join(dir, "2026-11.json"), JSON.stringify([item("A-0002", { createdAt: "2026-11-01T10:00:00.000Z" })]), "utf8");
    expect((await readForYouDir(dir)).map((entry) => entry.id)).toEqual(["A-0002"]);
  });
});
