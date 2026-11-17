import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OfficeState } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { useTempDirs } from "../dev/test-utils";
import { WriteQueue } from "../store/write-queue";
import { BoardService } from "../workspace/board/board-service";
import { summarizeJson } from "./board-tools";
import { officeToolsFor, type OfficeToolsDeps } from "./office-tools";
import { handleMcpPayload } from "./protocol";

const STATE = {
  rooms: [{ id: "gerencia", name: "Sala do Maestro", kind: "maestro" }, { id: "c", name: "Conteúdo", kind: "team" }],
  teams: [{ id: "t-ger", roomId: "gerencia", name: "Gerência", focus: "x" }, { id: "t-c", roomId: "c", name: "Conteúdo", focus: "y" }],
  agents: [{ id: "maestro", teamId: "t-ger", name: "Maestro" }, { id: "clara", teamId: "t-c", name: "Clara" }],
  tasks: [],
} as unknown as OfficeState;

const tempDir = useTempDirs();
const queues: WriteQueue[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.idle()));
});

async function setup() {
  const dir = await tempDir();
  const queue = new WriteQueue();
  queues.push(queue);
  const boards = new BoardService({
    dir: path.join(dir, "boards"),
    file: path.join(dir, "boards", "boards.json"),
    boardDir: (id) => path.join(dir, "boards", id),
    queue,
    publish: () => undefined,
    log: { warn: () => undefined, error: () => undefined },
    now: () => new Date("2026-11-16T12:00:00.000Z"),
  });
  const work = path.join(dir, "work");
  await mkdir(work, { recursive: true });
  const agentDir = (id: string) => path.join(dir, "agents", id);
  await mkdir(agentDir("clara"), { recursive: true });
  const deps = { state: { read: () => STATE }, maestro: { requestApproval: () => "ok" }, runner: { requestApproval: () => "ok", hasActive: () => true, currentTaskId: () => "t" }, forYou: { list: () => [], update: async () => ({}), cancel: () => undefined }, forYouTypes: { list: () => [], define: () => undefined }, structure: {}, board: { boards, agentDir, readableFolders: () => [work] } } as unknown as OfficeToolsDeps;
  const call = async (agentId: string, name: string, args: Record<string, unknown> = {}) => {
    const response = (await handleMcpPayload({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, () => officeToolsFor(agentId, deps))) as { result?: { content: { text?: string }[]; isError: boolean }; error?: { message: string } };
    if (!response.result) throw new Error(response.error?.message);
    return { isError: response.result.isError, text: response.result.content.map((block) => block.text ?? "").join("\n") };
  };
  return { dir, work, boards, agentDir, call };
}

describe("ferramentas board_*", () => {
  it("existem para o agente e para o Maestro, em inglês", async () => {
    const { call } = await setup();
    for (const agent of ["clara", "maestro"]) {
      expect((await call(agent, "board_list")).text).toBe("No boards yet.");
      expect((await call(agent, "board_guide")).text).toContain("# Board guide");
    }
  });

  it("board_save cria (exige título, descrição e página), atualiza e aceita html_path; board_list mostra", async () => {
    const { call, boards, agentDir } = await setup();
    expect(await call("clara", "board_save", { title: "A", description: "d" })).toMatchObject({ isError: true, text: expect.stringContaining("page is required") });
    expect(await call("clara", "board_save", { description: "d", html: "<p/>" })).toMatchObject({ isError: true });
    const created = await call("clara", "board_save", { title: "Obras", description: "Catálogo", source: "rodar sync.py", html: "<p>1</p>" });
    expect(created.text).toContain("Q-0001");
    expect(boards.get("Q-0001")).toMatchObject({ createdBy: "clara", source: "rodar sync.py" });
    await writeFile(path.join(agentDir("clara"), "page.html"), "<p>2</p>");
    expect((await call("clara", "board_save", { id: "Q-0001", html_path: "page.html" })).isError).toBe(false);
    expect(await boards.readPage("Q-0001")).toBe("<p>2</p>");
    expect((await call("clara", "board_save", { id: "Q-0001", html: "a", html_path: "page.html" })).isError).toBe(true);
    expect(await call("clara", "board_save", { id: "Q-0009", title: "x" })).toMatchObject({ isError: true, text: expect.stringContaining("does not exist") });
    expect(await call("clara", "board_save", { id: "Q-0001" })).toMatchObject({ isError: true, text: expect.stringContaining("Nothing to change") });
    const list = await call("clara", "board_list");
    expect(list.text).toContain("Q-0001");
    expect(list.text).toContain("source: rodar sync.py");
  });

  it("board_set_data: json, caminho na pasta do agente, caminho em pasta de trabalho; recusa fora delas e JSON inválido", async () => {
    const { call, boards, agentDir, work, dir } = await setup();
    await call("clara", "board_save", { title: "Obras", description: "d", html: "<p/>" });
    expect((await call("clara", "board_set_data", { id: "Q-0001", json: '{"a":1}' })).isError).toBe(false);
    await writeFile(path.join(agentDir("clara"), "out.json"), '{"b":2}');
    await call("clara", "board_set_data", { id: "Q-0001", path: "out.json" });
    expect(await boards.readData("Q-0001")).toBe('{"b":2}');
    await writeFile(path.join(work, "w.json"), '{"c":3}');
    await call("clara", "board_set_data", { id: "Q-0001", path: path.join(work, "w.json") });
    expect(await boards.readData("Q-0001")).toBe('{"c":3}');
    await writeFile(path.join(dir, "fora.json"), "{}");
    expect(await call("clara", "board_set_data", { id: "Q-0001", path: path.join(dir, "fora.json") })).toMatchObject({ isError: true, text: expect.stringContaining("inside your own agent folder") });
    expect(await call("clara", "board_set_data", { id: "Q-0001", json: "{x" })).toMatchObject({ isError: true, text: expect.stringContaining("Invalid JSON") });
    expect((await call("clara", "board_set_data", { id: "Q-0001" })).isError).toBe(true);
    expect((await call("clara", "board_set_data", { id: "Q-0001", json: "{}", path: "out.json" })).isError).toBe(true);
    expect((await call("clara", "board_set_data", { id: "Q-0002", json: "{}" })).text).toContain("does not exist");
    expect(await boards.readData("Q-0001")).toBe('{"c":3}');
  });

  it("board_patch_data aplica merge patch (objeto ou texto) e recusa o que não é objeto", async () => {
    const { call, boards } = await setup();
    await call("clara", "board_save", { title: "Obras", description: "d", html: "<p/>" });
    await call("clara", "board_set_data", { id: "Q-0001", json: '{"works":{"w1":{"c":1},"w2":{"c":2}},"list":[1,2]}' });
    await call("clara", "board_patch_data", { id: "Q-0001", patch: { works: { w1: { c: 5 }, w2: null }, list: [9] } });
    expect(JSON.parse(await boards.readData("Q-0001"))).toEqual({ works: { w1: { c: 5 } }, list: [9] });
    await call("clara", "board_patch_data", { id: "Q-0001", patch: '{"extra":true}' });
    expect(JSON.parse(await boards.readData("Q-0001")).extra).toBe(true);
    expect((await call("clara", "board_patch_data", { id: "Q-0001", patch: "{oops" })).text).toContain("Invalid JSON");
    expect((await call("clara", "board_patch_data", { id: "Q-0001", patch: "[1]" })).isError).toBe(true);
  });

  it("board_read_data grava o arquivo na pasta do agente e devolve caminho relativo e resumo (com a página se pedir)", async () => {
    const { call, agentDir } = await setup();
    await call("clara", "board_save", { title: "Obras", description: "d", html: "<p>pg</p>" });
    const works = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`w${i}`, { name: `Obra ${i}`, status: "ok" }]));
    await call("clara", "board_set_data", { id: "Q-0001", json: JSON.stringify({ works, updatedAt: "2026-11-16" }) });
    const result = await call("clara", "board_read_data", { id: "Q-0001", include_page: true });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("quadro/Q-0001.data.json");
    expect(result.text).toContain("works: object with 300 keys");
    expect(result.text).toContain('"name":"Obra 0"');
    expect(result.text).toContain("quadro/Q-0001.page.html");
    expect(result.text).not.toContain(agentDir("clara"));
    expect(Object.keys(JSON.parse(await readFile(path.join(agentDir("clara"), "quadro", "Q-0001.data.json"), "utf8")).works)).toHaveLength(300);
    expect(await readFile(path.join(agentDir("clara"), "quadro", "Q-0001.page.html"), "utf8")).toBe("<p>pg</p>");
    expect((await call("clara", "board_read_data", { id: "Q-0007" })).isError).toBe(true);
  });

  it("summarizeJson resume listas, objetos e valores simples", () => {
    expect(summarizeJson({})).toContain("empty object");
    expect(summarizeJson([1, 2])).toContain("list of 2 items");
    expect(summarizeJson({ a: [{ x: 1 }], b: "t", c: { k: 1 } })).toMatch(/- a: list of 1 item; first item: \{"x":1\}\n- b: "t"\n- c: object with 1 key/);
  });
});
