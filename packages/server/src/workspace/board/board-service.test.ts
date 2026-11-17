import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { BOARD_LIMITS, type ServerEvent } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { WriteQueue } from "../../store/write-queue";
import { BoardService, BoardToolError, readBoardInputFile } from "./board-service";

const tempDir = useTempDirs();
const queues: WriteQueue[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.idle()));
});

async function setup() {
  const dir = await tempDir();
  const events: ServerEvent[] = [];
  const queue = new WriteQueue();
  queues.push(queue);
  const make = () =>
    new BoardService({
      dir: path.join(dir, "boards"),
      file: path.join(dir, "boards", "boards.json"),
      boardDir: (id) => path.join(dir, "boards", id),
      queue,
      publish: (event) => events.push(event),
      log: { warn: () => undefined, error: () => undefined },
      now: () => new Date("2026-11-16T12:00:00.000Z"),
    });
  return { dir, events, boards: make(), make };
}

const base = { title: "Obras", description: "Catálogo das obras", html: "<p>oi</p>", createdBy: "clara" };

describe("BoardService", () => {
  it("cria com id sequencial, grava página, dados {} e índice, e avisa", async () => {
    const { dir, events, boards, make } = await setup();
    const a = await boards.create({ ...base, source: "script x" });
    const b = await boards.create({ ...base, title: "Estudos" });
    expect([a.id, b.id]).toEqual(["Q-0001", "Q-0002"]);
    expect(a).toMatchObject({ createdBy: "clara", source: "script x", pageBytes: 9, dataBytes: 2 });
    expect(await readFile(path.join(dir, "boards", "Q-0001", "page.html"), "utf8")).toBe("<p>oi</p>");
    expect(await boards.readData("Q-0001")).toBe("{}");
    expect(events[0]).toMatchObject({ type: "board:upserted", created: true, changed: ["meta", "page", "data"] });
    // Recarrega do disco.
    const again = make();
    await again.load();
    expect(again.list().map((item) => item.id).sort()).toEqual(["Q-0001", "Q-0002"]);
  });

  it("setData guarda compacto, patchData faz merge e dois patches ao mesmo tempo não se perdem", async () => {
    const { boards, events } = await setup();
    await boards.create(base);
    await boards.setData("Q-0001", { text: '{ "works": { "w1": { "n": "A", "c": 1 } }, "updatedAt": "x" }' });
    expect(await boards.readData("Q-0001")).toBe('{"works":{"w1":{"n":"A","c":1}},"updatedAt":"x"}');
    await Promise.all([boards.patchData("Q-0001", { works: { w1: { c: 2 } } }), boards.patchData("Q-0001", { works: { w2: { n: "B" } } }), boards.patchData("Q-0001", { updatedAt: null })]);
    expect(JSON.parse(await boards.readData("Q-0001"))).toEqual({ works: { w1: { n: "A", c: 2 }, w2: { n: "B" } } });
    const last = events.at(-1) as Extract<ServerEvent, { type: "board:upserted" }>;
    expect(last.changed).toEqual(["data"]);
    expect(boards.get("Q-0001").dataBytes).toBe((await boards.readData("Q-0001")).length);
  });

  it("save troca a página e/ou detalhes e diz o que mudou; source vazio apaga", async () => {
    const { boards, events } = await setup();
    await boards.create({ ...base, source: "s" });
    await boards.save("Q-0001", { html: "<b>novo</b>" });
    expect((events.at(-1) as { changed: string[] }).changed).toEqual(["page"]);
    await boards.save("Q-0001", { title: "Outro", source: "" });
    expect((events.at(-1) as { changed: string[] }).changed).toEqual(["meta"]);
    expect(boards.get("Q-0001")).toMatchObject({ title: "Outro", pageBytes: 11 });
    expect(boards.get("Q-0001").source).toBeUndefined();
    const count = events.length;
    await boards.save("Q-0001", { title: "Outro" });
    expect(events.length).toBe(count);
    expect(await boards.readPage("Q-0001")).toBe("<b>novo</b>");
  });

  it("erros claros em inglês: JSON inválido, id inexistente, grande demais, vazio, limite de quadros", async () => {
    const { boards } = await setup();
    await boards.create(base);
    await expect(boards.setData("Q-0001", { text: "{oops" })).rejects.toThrow(/Invalid JSON/);
    await expect(boards.setData("Q-0009", { text: "{}" })).rejects.toThrow(/does not exist/);
    await expect(boards.setData("Q-0001", { text: `{"a":"${"x".repeat(BOARD_LIMITS.dataBytes + 10)}"}` })).rejects.toThrow(/too large/);
    await expect(boards.save("Q-0001", { html: "x".repeat(BOARD_LIMITS.pageBytes + 1) })).rejects.toThrow(/page is too large/);
    await expect(boards.save("Q-0001", { html: "  " })).rejects.toBeInstanceOf(BoardToolError);
    await expect(boards.create({ ...base, title: " " })).rejects.toThrow(/title/);
    expect(await boards.readData("Q-0001")).toBe("{}");
  });

  it("rename e delete do dono (pt-BR, 404 se não existe) apagam a pasta", async () => {
    const { boards, dir, events } = await setup();
    await boards.create(base);
    expect(await boards.rename("Q-0001", { title: "Novo" })).toMatchObject({ title: "Novo", description: "Catálogo das obras" });
    await expect(boards.rename("Q-0005", { title: "x" })).rejects.toMatchObject({ statusCode: 404 });
    await boards.delete("Q-0001");
    expect(events.at(-1)).toEqual({ type: "board:deleted", id: "Q-0001" });
    expect(boards.list()).toEqual([]);
    await expect(readFile(path.join(dir, "boards", "Q-0001", "page.html"))).rejects.toThrow();
    await expect(boards.delete("Q-0001")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("readBoardInputFile", () => {
  it("lê da pasta do agente (relativo) e de pasta de trabalho (absoluto), e recusa o resto", async () => {
    const dir = await tempDir();
    const agent = path.join(dir, "agent");
    const work = path.join(dir, "work");
    const other = path.join(dir, "other");
    for (const folder of [agent, work, other]) await mkdir(folder, { recursive: true });
    await writeFile(path.join(agent, "a.json"), '{"a":1}');
    await writeFile(path.join(work, "w.json"), '{"w":1}');
    await writeFile(path.join(other, "o.json"), '{"o":1}');
    await symlink(path.join(other, "o.json"), path.join(agent, "link.json"));
    expect(await readBoardInputFile(agent, [work], "a.json", 1000)).toBe('{"a":1}');
    expect(await readBoardInputFile(agent, [work], path.join(work, "w.json"), 1000)).toBe('{"w":1}');
    await expect(readBoardInputFile(agent, [work], path.join(other, "o.json"), 1000)).rejects.toThrow(/inside your own agent folder/);
    await expect(readBoardInputFile(agent, [work], "../other/o.json", 1000)).rejects.toThrow(/inside your own agent folder/);
    await expect(readBoardInputFile(agent, [work], "link.json", 1000)).rejects.toThrow(/inside your own agent folder/);
    await expect(readBoardInputFile(agent, [], path.join(work, "w.json"), 1000)).rejects.toThrow(/inside your own agent folder/);
    await expect(readBoardInputFile(agent, [work], "nope.json", 1000)).rejects.toThrow(/File not found/);
    await expect(readBoardInputFile(agent, [work], "a.json", 3)).rejects.toThrow(/too large/);
    await expect(readBoardInputFile(agent, [work], ".", 1000)).rejects.toThrow(/not a file/);
  });
});
