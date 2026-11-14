import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { findMaestroRoom, type ApiErrorBody, type CalendarEvent, type ForYouItem, type RoomDeletionPreview } from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { seedDataDir } from "./seed";
import { call, createTask, getOffice, soloTeam } from "../../dev/test-api";
import { API, principalDir, useTestApp } from "../../dev/test-app";
import { useTempDirs } from "../../dev/test-utils";
import { MAESTRO_RULES } from "./maestro";

const setupApp = useTestApp();
const tempDir = useTempDirs();

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

function forYouItem(id: string, fields: Partial<ForYouItem> & Pick<ForYouItem, "agentId" | "roomId">): ForYouItem {
  return {
    id,
    type: "mensagem",
    status: "pendente",
    meta: {},
    text: "rascunho",
    originalText: "rascunho",
    editedByUser: false,
    createdAt: "2026-11-08T10:00:00.000Z",
    ...fields,
  };
}

/** Grava itens do "Para você" direto no estado do workspace "principal". */
async function seedForYou(app: FastifyInstance, items: ForYouItem[]): Promise<void> {
  const runtime = app.workspaces.get("principal");
  await runtime.state.commit({ forYou: [...runtime.forYou.list(), ...items], events: [] });
}

/** Pasta de agente de CLI como o TerminalManager deixa (CLAUDE.md, mcp.json, session.json). */
async function fakeAgentDir(app: FastifyInstance, agentId: string): Promise<string> {
  const dir = app.workspaces.get("principal").store.paths.agentDir(agentId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "CLAUDE.md"), "instruções\n");
  await writeFile(path.join(dir, "mcp.json"), "{}\n");
  await writeFile(path.join(dir, "session.json"), '{"sessionId":"x"}\n');
  return dir;
}

/** Um quarto com time, agente, tarefa concluída (com log), nota no Cérebro, evento, itens e pasta do agente. */
async function busyRoom(app: FastifyInstance, log: { waitForTask: (id: string, status: "done") => Promise<unknown> }) {
  const { room, team, agent } = await soloTeam(app, "Cascata");
  const task = await createTask(app, room.id, team.id, "Escrever o resumo");
  await log.waitForTask(task.id, "done");
  const runtime = app.workspaces.get("principal");
  const paths = runtime.store.paths;
  await writeFile(path.join(paths.brainDir(room.id), "briefing.md"), "# Briefing\n");
  const event = await call<CalendarEvent>(app, "POST", `${API}/calendar`, { title: "Reunião", date: "2026-11-10", roomId: room.id });
  const other = await call<CalendarEvent>(app, "POST", `${API}/calendar`, { title: "Outro quarto", date: "2026-11-10", roomId: "projetox" });
  await seedForYou(app, [
    forYouItem("A-0901", { taskId: task.id, agentId: agent.id, roomId: room.id, status: "aprovado" }),
    forYouItem("A-0902", { agentId: "lia", roomId: "projetox" }),
  ]);
  const agentDir = await fakeAgentDir(app, agent.id);
  await runtime.store.flush();
  return { room, team, agent, task, event, other, agentDir, paths };
}

describe("cascata ao excluir um quarto", () => {
  it("GET deletion-preview conta tudo o que vai junto", async () => {
    const { app, log } = await setupApp();
    const { room } = await busyRoom(app, log);
    const preview = await call<RoomDeletionPreview>(app, "GET", `${API}/rooms/${room.id}/deletion-preview`);
    expect(preview).toMatchObject({ teams: 1, agents: 1, tasks: 1, activeTasks: 0, forYouItems: 1, calendarEvents: 1, logs: 1 });
    // A tarefa concluída também grava a nota dela no Cérebro do quarto.
    expect(preview.brainNotes).toBeGreaterThanOrEqual(1);
    await call(app, "GET", `${API}/rooms/nao-existe/deletion-preview`, undefined, 404);
  });

  it("DELETE apaga Cérebro, itens do Para você, eventos, logs e a pasta dos agentes (e avisa os clientes)", async () => {
    const { app, log, dir } = await setupApp();
    const { room, agent, task, event, other, agentDir, paths } = await busyRoom(app, log);
    expect(await exists(paths.taskLogFile(task.id))).toBe(true);

    await call(app, "DELETE", `${API}/rooms/${room.id}`);

    expect(await exists(paths.brainDir(room.id))).toBe(false);
    expect(await exists(paths.taskLogFile(task.id))).toBe(false);
    expect(await exists(agentDir)).toBe(false);
    // O resto do workspace fica intacto.
    expect(await exists(paths.brainDir("projetox"))).toBe(true);
    expect(await exists(paths.brainDir("global"))).toBe(true);
    expect(await exists(path.join(dir, "office.json"))).toBe(true);

    const calendar = await call<CalendarEvent[]>(app, "GET", `${API}/calendar`);
    expect(calendar.map((item) => item.id)).toEqual([other.id]);
    const forYou = await call<ForYouItem[]>(app, "GET", `${API}/for-you`);
    expect(forYou.map((item) => item.id)).toEqual(["A-0902"]);
    expect(log.events).toContainEqual({ type: "foryou:deleted", id: "A-0901" });
    expect(log.events).toContainEqual({ type: "calendar:deleted", id: event.id });
    expect(log.events).toContainEqual({ type: "agent:deleted", id: agent.id });
    expect((await getOffice(app)).tasks.some((candidate) => candidate.id === task.id)).toBe(false);
  });

  it("sobras de quartos, agentes e tarefas removidos antes somem ao abrir o workspace", async () => {
    const dataDir = await tempDir();
    await seedDataDir(dataDir);
    const dir = principalDir(dataDir);
    // Sobras de quartos, agentes e tarefas removidos antes da cascata existir.
    for (const orphan of ["b", "c"]) await mkdir(path.join(dir, "brains", orphan), { recursive: true });
    await writeFile(path.join(dir, "brains", "b", "nota.md"), "# velha\n");
    await mkdir(path.join(dir, "agents", "fantasma"), { recursive: true });
    await mkdir(path.join(dir, "logs"), { recursive: true });
    await writeFile(path.join(dir, "logs", "tarefa-que-nao-existe.jsonl"), "{}\n");

    await setupApp({ dataDir });
    const brains = await readdir(path.join(dir, "brains"));
    expect(brains).toEqual(expect.arrayContaining(["global", "projetox", "projetoy"]));
    expect(brains).not.toContain("b");
    expect(brains).not.toContain("c");
    expect(await readdir(path.join(dir, "agents"))).toEqual([]);
    expect(await readdir(path.join(dir, "logs"))).toEqual([]);
  });

  it("a Sala do Maestro continua protegida (DELETE e preview: 409; nada é apagado)", async () => {
    const { app } = await setupApp();
    const room = findMaestroRoom(await getOffice(app))!;
    const paths = app.workspaces.get("principal").store.paths;
    await mkdir(paths.brainDir(room.id), { recursive: true });
    await writeFile(path.join(paths.brainDir(room.id), "regras.md"), "# Regras\n");
    for (const method of ["DELETE", "GET"] as const) {
      const url = method === "GET" ? `${API}/rooms/${room.id}/deletion-preview` : `${API}/rooms/${room.id}`;
      const response = await call<ApiErrorBody>(app, method, url, undefined, 409);
      expect(response.error).toBe(MAESTRO_RULES.deleteRoom);
    }
    expect(await exists(paths.brainDir(room.id))).toBe(true);
  });
});

describe("cascata ao excluir agente ou time", () => {
  it("agente: a pasta e os pedidos pendentes somem; histórico e logs das tarefas ficam", async () => {
    const { app, log } = await setupApp();
    const { room, team, agent } = await soloTeam(app, "Solo");
    const task = await createTask(app, room.id, team.id, "Algo");
    await log.waitForTask(task.id, "done");
    await seedForYou(app, [
      forYouItem("A-0801", { agentId: agent.id, roomId: room.id }),
      forYouItem("A-0802", { taskId: task.id, agentId: agent.id, roomId: room.id, status: "aprovado" }),
    ]);
    const agentDir = await fakeAgentDir(app, agent.id);
    const paths = app.workspaces.get("principal").store.paths;

    await call(app, "DELETE", `${API}/agents/${agent.id}`);

    expect(await exists(agentDir)).toBe(false);
    expect(await exists(paths.taskLogFile(task.id))).toBe(true);
    expect((await call<ForYouItem[]>(app, "GET", `${API}/for-you`)).map((item) => item.id)).toEqual(["A-0802"]);
    expect(log.events).toContainEqual({ type: "foryou:deleted", id: "A-0801" });
    expect((await getOffice(app)).tasks.some((candidate) => candidate.id === task.id)).toBe(true);
  });

  it("time: as pastas dos agentes e os pedidos pendentes do time somem", async () => {
    const { app } = await setupApp();
    const { room, team, agent } = await soloTeam(app, "Time");
    await seedForYou(app, [forYouItem("A-0701", { agentId: agent.id, roomId: room.id })]);
    const agentDir = await fakeAgentDir(app, agent.id);

    await call(app, "DELETE", `${API}/teams/${team.id}`);

    expect(await exists(agentDir)).toBe(false);
    expect(await call<ForYouItem[]>(app, "GET", `${API}/for-you`)).toEqual([]);
  });
});
