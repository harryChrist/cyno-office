import { createAgentBodySchema, createRoomBodySchema, createTeamBodySchema, type Agent, type Room, type Team } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_AVATAR } from "./avatarOptions";
import {
  agentCreateBody,
  agentPatch,
  agentValues,
  isEmptyPatch,
  newAgentValues,
  newRoomValues,
  newTeamValues,
  roomCreateBody,
  roomPatch,
  roomValues,
  teamCreateBody,
  teamPatch,
  teamValues,
} from "./formModels";
import { hasErrors, validateAgentForm, validateRoomForm, validateTeamForm } from "./validation";

const room = { id: "lab", kind: "room", name: "Lab", theme: "ocean", gridPosition: { x: 0, y: 0 }, readsGlobalBrain: true, readsBrainsOf: [] } as unknown as Room;
const team: Team = { id: "t1", roomId: "lab", name: "Design", focus: "identidade visual" };
const agent: Agent = { id: "a1", teamId: "t1", name: "Zoe", role: "Ilustradora", instructions: "", avatar: DEFAULT_AVATAR, status: "idle" };

describe("formulário do quarto (criar = editar)", () => {
  it("criar: começa vazio no tema sugerido e manda o corpo completo (com trim)", () => {
    expect(newRoomValues("mint")).toEqual({ name: "", theme: "mint", size: "auto", purpose: "geral" });
    const body = roomCreateBody({ ...newRoomValues("mint"), name: "  Laboratório " });
    expect(body).toEqual({ name: "Laboratório", theme: "mint", size: "auto", purpose: "geral" });
    expect(createRoomBodySchema.safeParse(body).success).toBe(true);
  });

  it("editar: preenche com o quarto (padrões para tamanho e tipo ausentes) e manda só o que mudou", () => {
    const initial = roomValues(room);
    expect(initial).toEqual({ name: "Lab", theme: "ocean", size: "auto", purpose: "geral" });
    expect(isEmptyPatch(roomPatch(initial, { ...initial, name: " Lab " }))).toBe(true);
    expect(roomPatch(initial, { ...initial, size: "g", purpose: "dev" })).toEqual({ size: "g", purpose: "dev" });
  });

  it("a mesma validação nos dois modos", () => {
    expect(hasErrors(validateRoomForm(newRoomValues("mint")))).toBe(true);
    expect(hasErrors(validateRoomForm(roomValues(room)))).toBe(false);
  });
});

describe("formulário do time (criar = editar)", () => {
  it("criar manda roomId + campos com trim; editar só o que mudou", () => {
    const body = teamCreateBody("lab", { name: " Design ", focus: " visual " });
    expect(body).toEqual({ roomId: "lab", name: "Design", focus: "visual" });
    expect(createTeamBodySchema.safeParse(body).success).toBe(true);
    const initial = teamValues(team);
    expect(teamPatch(initial, { ...initial, focus: "marca" })).toEqual({ focus: "marca" });
    expect(isEmptyPatch(teamPatch(initial, initial))).toBe(true);
    expect(validateTeamForm(newTeamValues()).name).toBeDefined();
  });
});

describe("formulário do agente (criar = editar)", () => {
  it("criar: motor simulado e modelo padrão ficam de fora do corpo", () => {
    const values = { ...newAgentValues("t1", DEFAULT_AVATAR), name: " Zoe ", role: "Ilustradora" };
    const body = agentCreateBody(values);
    expect(body).toEqual({ teamId: "t1", name: "Zoe", role: "Ilustradora", instructions: "", avatar: DEFAULT_AVATAR });
    expect(createAgentBodySchema.safeParse(body).success).toBe(true);
    expect(agentCreateBody({ ...values, engine: "claude", model: " sonnet " })).toMatchObject({ engine: "claude", model: "sonnet" });
    expect(hasErrors(validateAgentForm(values))).toBe(false);
  });

  it("editar: preenche time, motor e modelo; modelo apagado vira null", () => {
    const initial = agentValues({ ...agent, engine: "claude", model: "sonnet" });
    expect(initial).toMatchObject({ teamId: "t1", engine: "claude", model: "sonnet" });
    expect(agentPatch(initial, { ...initial, model: "" })).toEqual({ model: null });
    expect(agentPatch(initial, { ...initial, teamId: "t2", role: "Chefe " })).toEqual({ teamId: "t2", role: "Chefe" });
    expect(isEmptyPatch(agentPatch(initial, initial))).toBe(true);
    expect(agentValues(agent)).toMatchObject({ engine: "mock", model: "", effort: "" });
    const withEffort = agentValues({ ...agent, engine: "claude", effort: "high" });
    expect(agentPatch(withEffort, { ...withEffort, effort: "" })).toEqual({ effort: null });
    expect(agentPatch(withEffort, { ...withEffort, effort: "low" })).toEqual({ effort: "low" });
  });

  it("acesso: agente novo segue o workspace (nada no corpo); só o que foi desligado vai; editar manda a troca", () => {
    const values = { ...newAgentValues("t1", DEFAULT_AVATAR), name: "Zoe", role: "Ilustradora", engine: "claude" as const };
    expect(values).toMatchObject({ internet: true, browser: true, terminal: true });
    expect(agentCreateBody(values)).not.toHaveProperty("internet");
    const body = agentCreateBody({ ...values, internet: false, terminal: false });
    expect(body).toMatchObject({ internet: false, terminal: false });
    expect(body).not.toHaveProperty("browser");
    expect(createAgentBodySchema.safeParse(body).success).toBe(true);
    const initial = agentValues({ ...agent, engine: "claude", internet: false });
    expect(initial).toMatchObject({ internet: false, browser: true, terminal: true });
    expect(agentPatch(initial, { ...initial, internet: true })).toEqual({ internet: true });
  });

  it("pastas de trabalho: agente novo segue o workspace (nada no corpo); o ajuste vai no corpo e no PATCH, e voltar ao padrão manda {}", () => {
    const values = { ...newAgentValues("t1", DEFAULT_AVATAR), name: "Zoe", role: "Ilustradora", engine: "claude" as const };
    expect(values.folders).toEqual({});
    expect(agentCreateBody(values)).not.toHaveProperty("folders");
    const body = agentCreateBody({ ...values, folders: { "vault-1a2b": "off" } });
    expect(body).toMatchObject({ folders: { "vault-1a2b": "off" } });
    expect(createAgentBodySchema.safeParse(body).success).toBe(true);
    const initial = agentValues({ ...agent, engine: "claude", folders: { "vault-1a2b": "off", "app-3c4d": "read" } });
    expect(initial.folders).toEqual({ "vault-1a2b": "off", "app-3c4d": "read" });
    expect(isEmptyPatch(agentPatch(initial, { ...initial }))).toBe(true);
    expect(agentPatch(initial, { ...initial, folders: { "vault-1a2b": "off" } })).toEqual({ folders: { "vault-1a2b": "off" } });
    expect(agentPatch(initial, { ...initial, folders: {} })).toEqual({ folders: {} });
  });

  it("agente novo nasce com o padrão de agentes do workspace (só o valor inicial)", () => {
    const values = newAgentValues("t1", DEFAULT_AVATAR, { engine: "claude", model: "sonnet", effort: "medium" });
    expect(values).toMatchObject({ engine: "claude", model: "sonnet", effort: "medium" });
    const body = agentCreateBody({ ...values, name: "Zoe", role: "Ilustradora" });
    expect(body).toMatchObject({ engine: "claude", model: "sonnet", effort: "medium" });
    expect(createAgentBodySchema.safeParse(body).success).toBe(true);
    // Padrão simulado (ou nenhum): sem motor, modelo nem esforço.
    expect(newAgentValues("t1", DEFAULT_AVATAR, { engine: "mock", model: "x" })).toMatchObject({ engine: "mock", model: "", effort: "" });
    expect(newAgentValues("t1", DEFAULT_AVATAR)).toMatchObject({ engine: "mock", model: "", effort: "" });
    // Trocou para simulado no formulário: modelo/esforço que sobraram não vão.
    expect(agentCreateBody({ ...values, name: "Zoe", role: "x", engine: "mock" })).not.toHaveProperty("model");
  });
});
