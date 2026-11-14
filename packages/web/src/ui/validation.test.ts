import {
  createAgentBodySchema,
  createTaskBodySchema,
  createTeamBodySchema,
  createRoomBodySchema,
  createWorkspaceBodySchema,
} from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_AVATAR } from "./avatarOptions";
import { changedFields, hasErrors, LIMITS, validateAgentForm, validatePrompt, validateRoomForm, validateTeamForm, validateWorkspaceForm } from "./validation";

const repeat = (n: number) => "a".repeat(n);

describe("limites iguais aos schemas do shared", () => {
  it("o máximo passa no schema e o máximo+1 não", () => {
    const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => schema.safeParse(value).success;
    expect(ok(createWorkspaceBodySchema, { name: repeat(LIMITS.workspaceName) })).toBe(true);
    expect(ok(createWorkspaceBodySchema, { name: repeat(LIMITS.workspaceName + 1) })).toBe(false);
    expect(validateWorkspaceForm({ name: "  " }).name).toBeDefined();
    expect(hasErrors(validateWorkspaceForm({ name: "LinkedIn" }))).toBe(false);
    expect(ok(createRoomBodySchema, { name: repeat(LIMITS.roomName), theme: "mint" })).toBe(true);
    expect(ok(createRoomBodySchema, { name: repeat(LIMITS.roomName + 1), theme: "mint" })).toBe(false);
    expect(ok(createTeamBodySchema, { roomId: "x", name: repeat(LIMITS.teamName), focus: repeat(LIMITS.focus) })).toBe(true);
    expect(ok(createTeamBodySchema, { roomId: "x", name: "t", focus: repeat(LIMITS.focus + 1) })).toBe(false);
    const agent = { teamId: "t", name: repeat(LIMITS.agentName), role: repeat(LIMITS.role), instructions: repeat(LIMITS.instructions), avatar: DEFAULT_AVATAR };
    expect(ok(createAgentBodySchema, agent)).toBe(true);
    expect(ok(createAgentBodySchema, { ...agent, name: repeat(LIMITS.agentName + 1) })).toBe(false);
    expect(ok(createAgentBodySchema, { ...agent, role: repeat(LIMITS.role + 1) })).toBe(false);
    expect(ok(createAgentBodySchema, { ...agent, instructions: repeat(LIMITS.instructions + 1) })).toBe(false);
    expect(ok(createTaskBodySchema, { roomId: "x", teamId: "t", prompt: repeat(LIMITS.prompt) })).toBe(true);
    expect(ok(createTaskBodySchema, { roomId: "x", teamId: "t", prompt: repeat(LIMITS.prompt + 1) })).toBe(false);
  });
});

describe("validação dos formulários", () => {
  it("quarto: nome obrigatório, limite e tema válido", () => {
    expect(validateRoomForm({ name: "Lab", theme: "ocean" })).toEqual({});
    expect(validateRoomForm({ name: "   ", theme: "ocean" }).name).toBe("Dê um nome à sala.");
    expect(validateRoomForm({ name: repeat(41), theme: "ocean" }).name).toMatch(/no máximo 40/);
    expect(validateRoomForm({ name: "Lab", theme: "lobby" }).theme).toBe("Escolha um tema.");
  });

  it("time: nome e foco obrigatórios", () => {
    expect(validateTeamForm({ name: "Design", focus: "visual" })).toEqual({});
    const errors = validateTeamForm({ name: "", focus: "" });
    expect(Object.keys(errors).sort()).toEqual(["focus", "name"]);
    expect(hasErrors(errors)).toBe(true);
    expect(hasErrors({})).toBe(false);
  });

  it("agente: nome/papel obrigatórios, instruções opcionais e avatar válido", () => {
    const base = { name: "Zoe", role: "Ilustradora", instructions: "", avatar: DEFAULT_AVATAR };
    expect(validateAgentForm(base)).toEqual({});
    expect(validateAgentForm({ ...base, name: repeat(25) }).name).toMatch(/no máximo 24 caracteres \(agora: 25\)/);
    expect(validateAgentForm({ ...base, role: " " }).role).toBeTruthy();
    expect(validateAgentForm({ ...base, instructions: repeat(2001) }).instructions).toBeTruthy();
    expect(validateAgentForm({ ...base, avatar: { ...DEFAULT_AVATAR, shirt: "neon" as never } }).avatar).toBeTruthy();
  });

  it("pedido da tarefa", () => {
    expect(validatePrompt("Revisar login")).toBeUndefined();
    expect(validatePrompt("  \n ")).toBe("Escreva o pedido.");
    expect(validatePrompt(repeat(4001))).toBeUndefined();
    expect(validatePrompt(repeat(LIMITS.prompt + 1))).toMatch(/100000/);
  });
});

describe("changedFields", () => {
  it("só o que mudou, com trim, e objetos comparados por valor", () => {
    const before = { name: "Zoe", role: "Ilustradora", avatar: { skin: "tone1" } };
    expect(changedFields(before, { ...before, name: " Zoe " })).toEqual({});
    expect(changedFields(before, { ...before, role: " Designer " })).toEqual({ role: "Designer" });
    expect(changedFields(before, { ...before, avatar: { skin: "tone2" } })).toEqual({ avatar: { skin: "tone2" } });
  });
});
