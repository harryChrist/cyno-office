import type { Agent, Avatar, OfficeState, Room, Task, Team, Workspace } from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";

export const TEST_AVATAR: Avatar = { skin: "tone3", hair: "bun", hairColor: "wood-dark", shirt: "mint", pants: "denim" };

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Chamada à API via inject; confere o status esperado e devolve o corpo já lido. */
export async function call<T = unknown>(
  app: FastifyInstance,
  method: Method,
  url: string,
  payload?: object,
  expectedStatus = method === "POST" ? 201 : method === "DELETE" ? 204 : 200,
): Promise<T> {
  const response = await app.inject({ method, url, payload });
  expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(expectedStatus);
  return (response.body ? response.json() : undefined) as T;
}

/** Prefixo das rotas de um workspace (padrão: o "principal" do seed). */
export const wsApi = (ws = "principal") => `/api/w/${ws}`;

export const createWorkspace = (app: FastifyInstance, name: string) =>
  call<Workspace>(app, "POST", "/api/workspaces", { name });

export const createRoom = (app: FastifyInstance, name: string, extra: object = {}, ws?: string) =>
  call<Room>(app, "POST", `${wsApi(ws)}/rooms`, { name, theme: "mint", ...extra });

export const createTeam = (app: FastifyInstance, roomId: string, name: string, ws?: string) =>
  call<Team>(app, "POST", `${wsApi(ws)}/teams`, { roomId, name, focus: "testes" });

export const createAgent = (app: FastifyInstance, teamId: string, name: string, ws?: string) =>
  call<Agent>(app, "POST", `${wsApi(ws)}/agents`, { teamId, name, role: "Dev", instructions: "", avatar: TEST_AVATAR });

export const createTask = (app: FastifyInstance, roomId: string, teamId: string, prompt: string, ws?: string) =>
  call<Task>(app, "POST", `${wsApi(ws)}/tasks`, { roomId, teamId, prompt });

export const getOffice = (app: FastifyInstance, ws?: string) => call<OfficeState>(app, "GET", `${wsApi(ws)}/office`);

/** Quarto novo com um time de um agente só (a fila do agente fica previsível). */
export async function soloTeam(app: FastifyInstance, name = "Solo", ws?: string) {
  const room = await createRoom(app, name, {}, ws);
  const team = await createTeam(app, room.id, `Time ${name}`, ws);
  const agent = await createAgent(app, team.id, `Agente ${name}`, ws);
  return { room, team, agent };
}
