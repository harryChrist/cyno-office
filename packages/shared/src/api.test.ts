import { describe, expect, it } from "vitest";
import {
  agentSchema,
  createAgentBodySchema,
  createTaskBodySchema,
  createRoomBodySchema,
  taskSchema,
  toValidationIssues,
  updateAgentBodySchema,
  updateBrainSharingBodySchema,
  roomSchema,
  roomThemeSchema,
  updateRoomBodySchema,
} from "./api";
import { makeOffice } from "./test-fixtures";
import { ROOM_THEME_IDS } from "./themes";

const avatar = { skin: "tone1", hair: "long", hairColor: "wood", shirt: "rose", pants: "navy" };

describe("schemas de entidade", () => {
  it("aceitam as entidades do fixture", () => {
    const office = makeOffice();
    for (const ws of office.rooms) expect(roomSchema.parse(ws)).toEqual(ws);
    for (const agent of office.agents) expect(agentSchema.parse(agent)).toEqual(agent);
  });

  it("rejeitam tema de lobby, id reservado e posição não inteira", () => {
    const ws = makeOffice().rooms[0]!;
    expect(roomSchema.safeParse({ ...ws, theme: "lobby" }).success).toBe(false);
    expect(roomSchema.safeParse({ ...ws, id: "global" }).success).toBe(false);
    expect(roomSchema.safeParse({ ...ws, gridPosition: { x: 1.5, y: 0 } }).success).toBe(false);
  });

  it("rejeitam avatar fora das opções", () => {
    const agent = makeOffice().agents[0]!;
    const bad = { ...agent, avatar: { ...agent.avatar, shirt: "#ff0000" } };
    expect(agentSchema.safeParse(bad).success).toBe(false);
    const badAccessory = { ...agent, avatar: { ...agent.avatar, accessory: "crown" } };
    expect(agentSchema.safeParse(badAccessory).success).toBe(false);
  });

  it("agente: motor, modelo e esforço são opcionais (office.json antigo continua válido)", () => {
    const agent = makeOffice().agents[0]!;
    expect(agentSchema.parse(agent).engine).toBeUndefined();
    expect(agentSchema.parse({ ...agent, engine: "claude", model: "sonnet", effort: "low" })).toMatchObject({ engine: "claude", model: "sonnet", effort: "low" });
    expect(agentSchema.safeParse({ ...agent, engine: "gpt" }).success).toBe(false);
    expect(agentSchema.safeParse({ ...agent, model: "--dangerously-skip-permissions" }).success).toBe(false);
    expect(agentSchema.safeParse({ ...agent, model: "claude-opus-4-1[1m]" }).success).toBe(true);
    expect(updateAgentBodySchema.parse({ model: null, effort: null })).toEqual({ model: null, effort: null });
  });

  it("validam datas ISO das tarefas", () => {
    const task = {
      id: "t1",
      roomId: "a",
      teamId: "a-time",
      prompt: "Fazer algo",
      status: "queued",
      createdAt: "2026-01-01T10:00:00.000Z",
      updatedAt: "2026-01-01T10:00:00.000Z",
    };
    expect(taskSchema.safeParse(task).success).toBe(true);
    expect(taskSchema.safeParse({ ...task, createdAt: "ontem" }).success).toBe(false);
    expect(taskSchema.safeParse({ ...task, status: "paused" }).success).toBe(false);
  });
});

describe("schemas de requisição", () => {
  it("criação de agente não aceita status", () => {
    const body = { teamId: "a-time", name: "Ana", role: "QA", instructions: "", avatar };
    expect(createAgentBodySchema.safeParse(body).success).toBe(true);
    expect(createAgentBodySchema.safeParse({ ...body, status: "working" }).success).toBe(false);
  });

  it("criação de quarto apara o nome e exige tema de quarto", () => {
    const parsed = createRoomBodySchema.parse({ name: "  Novo  ", theme: "sand" });
    expect(parsed).toEqual({ name: "Novo", theme: "sand" });
    expect(createRoomBodySchema.safeParse({ name: "", theme: "sand" }).success).toBe(false);
    expect(createRoomBodySchema.safeParse({ name: "X", theme: "neon" }).success).toBe(false);
  });

  it("aceita todos os temas de quarto (inclusive os novos) e recusa o lobby e temas desconhecidos", () => {
    for (const theme of ROOM_THEME_IDS) expect(roomThemeSchema.safeParse(theme).success, theme).toBe(true);
    expect(createRoomBodySchema.safeParse({ name: "X", theme: "cyber" }).success).toBe(true);
    expect(updateRoomBodySchema.safeParse({ theme: "industrial" }).success).toBe(true);
    for (const theme of ["lobby", "plasma", "", "Grafite"]) expect(roomThemeSchema.safeParse(theme).success, theme).toBe(false);
  });

  it("Cérebros lidos só aceitam ids de quarto válidos; os campos antigos de porta são recusados", () => {
    expect(updateBrainSharingBodySchema.safeParse({ readsBrainsOf: ["projetoy"] }).success).toBe(true);
    expect(updateBrainSharingBodySchema.safeParse({ readsGlobalBrain: true }).success).toBe(true);
    expect(updateBrainSharingBodySchema.safeParse({ readsBrainsOf: ["lobby"] }).success).toBe(false);
    expect(updateBrainSharingBodySchema.safeParse({ readsBrainsOf: ["../x"] }).success).toBe(false);
    expect(updateBrainSharingBodySchema.safeParse({ hasLobbyDoor: true }).success).toBe(false);
    expect(updateBrainSharingBodySchema.safeParse({ connections: [] }).success).toBe(false);
  });

  it("tarefa exige prompt não vazio e gera detalhes legíveis", () => {
    const result = createTaskBodySchema.safeParse({ roomId: "a", teamId: "a-time", prompt: "   " });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = toValidationIssues(result.error);
      expect(issues[0]?.path).toBe("prompt");
      expect(issues[0]?.message).toBeTruthy();
    }
  });
});
