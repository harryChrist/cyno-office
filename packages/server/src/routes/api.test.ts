import { access, readdir } from "node:fs/promises";
import path from "node:path";
import type { Agent, ApiErrorBody, Task, Room } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, createAgent, createTask, createTeam, createRoom, getOffice, soloTeam, TEST_AVATAR } from "../dev/test-api";
import { gatedSleep, testRunner, useTestApp } from "../dev/test-app";

const setupApp = useTestApp();

describe("API: validação", () => {
  it("400 com details quando o corpo é inválido", async () => {
    const { app } = await setupApp();
    const body = await call<ApiErrorBody>(app, "POST", "/api/w/principal/rooms", { name: "", theme: "roxo" }, 400);
    expect(body.error).toBe("Dados inválidos");
    expect(body.details?.map((issue) => issue.path).sort()).toEqual(["name", "theme"]);
  });

  it("400 para campos extras (ex.: status de agente) e tema do lobby", async () => {
    const { app } = await setupApp();
    const agent = { teamId: "projetox-frontend", name: "Zé", role: "Dev", instructions: "", avatar: TEST_AVATAR };
    await call(app, "POST", "/api/w/principal/agents", { ...agent, status: "working" }, 400);
    await call(app, "POST", "/api/w/principal/agents", { ...agent, avatar: { ...TEST_AVATAR, hair: "afro-gigante" } }, 400);
    await call(app, "POST", "/api/w/principal/rooms", { name: "Lobby 2", theme: "lobby" }, 400);
    await call(app, "PATCH", "/api/w/principal/rooms/projetox", { readsBrainsOf: ["projetoy"] }, 400);
    await call(app, "PATCH", "/api/w/principal/rooms/projetox", { hasLobbyDoor: true }, 400);
  });

  it("400 para ids inseguros na URL e na query", async () => {
    const { app } = await setupApp();
    await call(app, "PATCH", "/api/w/principal/rooms/Projeto%20X", { name: "x" }, 400);
    await call(app, "DELETE", "/api/w/principal/agents/..%2Fetc", undefined, 400);
    await call(app, "GET", "/api/w/principal/tasks?roomId=../x", undefined, 400);
  });

  it("404 para entidades inexistentes", async () => {
    const { app } = await setupApp();
    const body = await call<ApiErrorBody>(app, "PATCH", "/api/w/principal/teams/nao-existe", { name: "x" }, 404);
    expect(body).toEqual({ error: 'Time "nao-existe" não encontrado' });
    await call(app, "DELETE", "/api/w/principal/rooms/nao-existe", undefined, 404);
    await call(app, "POST", "/api/w/principal/teams", { roomId: "nao-existe", name: "T", focus: "x" }, 404);
    await call(app, "POST", "/api/w/principal/tasks/nao-existe/approval", { approved: true }, 404);
  });
});

describe("API: quartos", () => {
  it("cria com id seguro (slug + dedupe), célula livre automática e pasta do Cérebro", async () => {
    const { app, dir } = await setupApp();
    const first = await createRoom(app, "Laboratório Ágil");
    const second = await createRoom(app, "Laboratório Ágil");
    expect([first.id, second.id]).toEqual(["laboratorio-agil", "laboratorio-agil-2"]);
    expect(first).toMatchObject({ theme: "mint", readsGlobalBrain: false, readsBrainsOf: [] });
    const cells = (await getOffice(app)).rooms.map((ws) => `${ws.gridPosition.x},${ws.gridPosition.y}`);
    expect(new Set(cells).size).toBe(cells.length);
    expect(cells).not.toContain("0,0");
    await access(path.join(dir, "brains", first.id));
  });

  it("nunca usa ids reservados", async () => {
    const { app } = await setupApp();
    const lobby = await createRoom(app, "Lobby");
    const global = await createRoom(app, "Global");
    expect([lobby.id, global.id]).toEqual(["lobby-2", "global-2"]);
  });

  it("409 para célula ocupada ou do lobby", async () => {
    const { app } = await setupApp();
    const [projetox] = (await getOffice(app)).rooms;
    await call(app, "POST", "/api/w/principal/rooms", { name: "X", theme: "sand", gridPosition: projetox!.gridPosition }, 409);
    await call(app, "POST", "/api/w/principal/rooms", { name: "X", theme: "sand", gridPosition: { x: 0, y: 0 } }, 409);
    await call(app, "PATCH", "/api/w/principal/rooms/projetoy", { gridPosition: projetox!.gridPosition }, 409);
  });

  it("PATCH muda nome, tema, posição e a leitura do Cérebro global", async () => {
    const { app } = await setupApp();
    const updated = await call<Room>(app, "PATCH", "/api/w/principal/rooms/projetoy", {
      name: "Projeto Ypsilon",
      theme: "ocean",
      gridPosition: { x: 5, y: 5 },
      readsGlobalBrain: true,
    });
    expect(updated).toMatchObject({ id: "projetoy", name: "Projeto Ypsilon", theme: "ocean", readsGlobalBrain: true });
  });

  it("DELETE em cascata: times, agentes e tarefas saem; quem lia o Cérebro dele deixa de ler; o Cérebro também", async () => {
    const { app, dir } = await setupApp();
    const extra = await createRoom(app, "Vizinho");
    await call(app, "PATCH", `/api/w/principal/rooms/${extra.id}/brain-sharing`, { readsBrainsOf: ["projetoy"] });
    await createTask(app, "projetoy", "projetoy-pesquisa", "Pesquisar algo");
    await call(app, "DELETE", "/api/w/principal/rooms/projetoy");

    const office = await getOffice(app);
    expect(office.rooms.map((ws) => ws.id)).toEqual(["projetox", "sala-do-maestro", extra.id]);
    expect(office.teams.every((team) => team.roomId !== "projetoy")).toBe(true);
    expect(office.agents.map((agent) => agent.teamId).every((id) => !id.startsWith("projetoy"))).toBe(true);
    expect(office.tasks).toEqual([]);
    expect(office.rooms.find((ws) => ws.id === extra.id)!.readsBrainsOf).toEqual([]);
    await expect(access(path.join(dir, "brains", "projetoy"))).rejects.toThrow();

    // Um quarto novo com o mesmo nome começa com o Cérebro vazio (as notas antigas foram apagadas).
    const reborn = await createRoom(app, "ProjetoY");
    expect(reborn.id).toBe("projetoy");
    // Só os fixos novos (regras, índice e briefing), sem nenhuma nota antiga.
    expect((await readdir(path.join(dir, "brains", "projetoy"))).sort()).toEqual(["_briefing.md", "_indice.md", "_regras.md"]);
  });
});

describe("API: times e agentes", () => {
  it("CRUD de time e agente; agente sempre nasce idle", async () => {
    const { app } = await setupApp();
    const team = await createTeam(app, "projetox", "Dados");
    expect(team).toMatchObject({ id: "projetox-dados", roomId: "projetox", name: "Dados" });
    const agent = await createAgent(app, team.id, "Lia");
    expect(agent).toMatchObject({ id: "lia-2", teamId: team.id, status: "idle" });

    const renamed = await call(app, "PATCH", `/api/w/principal/agents/${agent.id}`, { name: "Lia Nova", role: "Analista" });
    expect(renamed).toMatchObject({ id: "lia-2", name: "Lia Nova", role: "Analista", status: "idle" });
    await call(app, "PATCH", `/api/w/principal/teams/${team.id}`, { focus: "métricas" });
    await call(app, "PATCH", `/api/w/principal/agents/${agent.id}`, { teamId: "nao-existe" }, 404);

    await call(app, "DELETE", `/api/w/principal/teams/${team.id}`);
    const office = await getOffice(app);
    expect(office.teams.some((candidate) => candidate.id === team.id)).toBe(false);
    expect(office.agents.some((candidate) => candidate.id === agent.id)).toBe(false);
  });

  it("mover agente para um time de outro quarto: o histórico fica no quarto antigo e as tarefas novas vêm do time novo", async () => {
    const { app, log } = await setupApp();
    const { team, agent } = await soloTeam(app);
    const old = await createTask(app, team.roomId, team.id, "Tarefa antes da mudança");
    await log.waitForTask(old.id, "done");

    const moved = await call<Agent>(app, "PATCH", `/api/w/principal/agents/${agent.id}`, { teamId: "projetoy-pesquisa" });
    expect(moved).toMatchObject({ id: agent.id, teamId: "projetoy-pesquisa" });
    await log.waitFor((event) => event.type === "agent:upserted" && event.agent.id === agent.id && event.agent.teamId === "projetoy-pesquisa");
    const office = await getOffice(app);
    expect(office.tasks.find((task) => task.id === old.id)).toMatchObject({ roomId: team.roomId, teamId: team.id, agentId: agent.id });

    // O time antigo ficou sem agentes (422); o novo quarto já pode mandar trabalho para ele.
    await call(app, "POST", "/api/w/principal/tasks", { roomId: team.roomId, teamId: team.id, prompt: "x" }, 422);
    const pesquisa = office.agents.filter((candidate) => candidate.teamId === "projetoy-pesquisa").map((candidate) => candidate.id);
    expect(pesquisa).toContain(agent.id);
  });

  it("409 ao mudar de time/quarto com tarefas em andamento", async () => {
    const gate = gatedSleep();
    const { app } = await setupApp({ runner: testRunner({ sleep: gate.sleep }) });
    const { team, agent } = await soloTeam(app);
    await createTask(app, team.roomId, team.id, "Trabalho longo");
    await call(app, "PATCH", `/api/w/principal/agents/${agent.id}`, { teamId: "projetox-frontend" }, 409);
    await call(app, "PATCH", `/api/w/principal/teams/${team.id}`, { roomId: "projetox" }, 409);
    gate.open();
  });
});

describe("API: tarefas", () => {
  it("POST cria queued com agente escolhido; GET filtra por quarto e agente", async () => {
    const gate = gatedSleep();
    const { app } = await setupApp({ runner: testRunner({ sleep: gate.sleep }) });
    const task = await createTask(app, "projetox", "projetox-frontend", "Tela de login");
    expect(task).toMatchObject({ status: "queued", roomId: "projetox", teamId: "projetox-frontend" });
    expect(task.agentId).toBeTruthy();
    await createTask(app, "projetoy", "projetoy-pesquisa", "Pesquisa");

    expect(await call<Task[]>(app, "GET", "/api/w/principal/tasks?roomId=projetox")).toHaveLength(1);
    expect(await call<Task[]>(app, "GET", `/api/w/principal/tasks?agentId=${task.agentId}`)).toHaveLength(1);
    expect(await call<Task[]>(app, "GET", "/api/w/principal/tasks")).toHaveLength(2);
    gate.open();
  });

  it("400 time de outro quarto; 422 time sem agentes; 409 aprovação fora de hora", async () => {
    const { app, log } = await setupApp();
    const otherRoom = await call<ApiErrorBody>(app, "POST", "/api/w/principal/tasks", { roomId: "projetox", teamId: "projetoy-pesquisa", prompt: "x" }, 400);
    expect(otherRoom.details).toBeUndefined();
    const empty = await createTeam(app, "projetox", "Vazio");
    await call(app, "POST", "/api/w/principal/tasks", { roomId: "projetox", teamId: empty.id, prompt: "x" }, 422);
    await call(app, "POST", "/api/w/principal/tasks", { roomId: "projetox", teamId: "projetox-frontend", prompt: "   " }, 400);

    const task = await createTask(app, "projetox", "projetox-frontend", "Rápida");
    await log.waitForTask(task.id, "done");
    await call(app, "POST", `/api/w/principal/tasks/${task.id}/approval`, { approved: true }, 409);
    await call(app, "POST", `/api/w/principal/tasks/${task.id}/approval`, { approved: "sim" }, 400);
  });
});
