import {
  agentEngine,
  isCliEngine,
  type Agent,
  type AgentFolders,
  type AgentEffort,
  type AgentEngine,
  type ModelChoice,
  type CreateAgentBody,
  type CreateRoomBody,
  type CreateTeamBody,
  type Room,
  type RoomPurpose,
  type RoomSize,
  type RoomThemeId,
  type Team,
  type UpdateAgentBody,
  type UpdateRoomBody,
  type UpdateTeamBody,
} from "@cyno/shared";
import { toAvatarInput, type AvatarInput } from "./avatarOptions";
import { changedFields } from "./validation";

/**
 * Modelos dos formulários de quarto, time e agente. Criar e editar usam o MESMO formulário: o
 * modo só muda os valores iniciais, o botão ("Criar …" ou "Salvar") e o que vai para a API
 * (corpo completo no POST, só o que mudou no PATCH).
 */
export type FormMode = "create" | "edit";

// ---------- Quarto ----------

export type RoomFormValues = { name: string; theme: string; size: RoomSize; purpose: RoomPurpose };

export function newRoomValues(theme: string): RoomFormValues {
  return { name: "", theme, size: "auto", purpose: "geral" };
}

export function roomValues(room: Room): RoomFormValues {
  return { name: room.name, theme: room.theme, size: room.size ?? "auto", purpose: room.purpose ?? "geral" };
}

export function roomCreateBody(values: RoomFormValues): CreateRoomBody {
  return { name: values.name.trim(), theme: values.theme as RoomThemeId, size: values.size, purpose: values.purpose };
}

export function roomPatch(initial: RoomFormValues, values: RoomFormValues): UpdateRoomBody {
  return changedFields(initial, values) as UpdateRoomBody;
}

// ---------- Time ----------

export type TeamFormValues = { name: string; focus: string };

export function newTeamValues(): TeamFormValues {
  return { name: "", focus: "" };
}

export function teamValues(team: Team): TeamFormValues {
  return { name: team.name, focus: team.focus };
}

export function teamCreateBody(roomId: string, values: TeamFormValues): CreateTeamBody {
  return { roomId, name: values.name.trim(), focus: values.focus.trim() };
}

export function teamPatch(initial: TeamFormValues, values: TeamFormValues): UpdateTeamBody {
  return changedFields(initial, values);
}

// ---------- Agente ----------

/** `model` vazio = o padrão da CLI; `effort` vazio = o padrão do server. */
export type AgentFormValues = {
  name: string;
  role: string;
  instructions: string;
  avatar: AvatarInput;
  teamId: string;
  engine: AgentEngine;
  model: string;
  effort: AgentEffort | "";
  /** Acesso do agente: true = segue o workspace; false = desligado só para ele. */
  internet: boolean;
  browser: boolean;
  terminal: boolean;
  /** Ajuste por pasta de trabalho do workspace (id -> "off" | "read"); ausente = como no workspace. */
  folders: AgentFolders;
};

/**
 * Agente novo: motor, modelo e esforço já preenchidos com o padrão `agentes` do workspace (só o
 * valor inicial do formulário; o agente guarda os dele e nada muda depois se o padrão mudar).
 */
export function newAgentValues(teamId: string, avatar: AvatarInput, defaults?: ModelChoice): AgentFormValues {
  const cli = defaults && isCliEngine(defaults.engine) ? defaults : undefined;
  return {
    name: "",
    role: "",
    instructions: "",
    avatar,
    teamId,
    engine: cli?.engine ?? "mock",
    model: cli?.model ?? "",
    effort: cli?.effort ?? "",
    internet: true,
    browser: true,
    terminal: true,
    folders: {},
  };
}

export function agentValues(agent: Agent): AgentFormValues {
  return {
    name: agent.name,
    role: agent.role,
    instructions: agent.instructions,
    avatar: toAvatarInput(agent.avatar),
    teamId: agent.teamId,
    engine: agentEngine(agent),
    model: agent.model ?? "",
    effort: agent.effort ?? "",
    internet: agent.internet !== false,
    browser: agent.browser !== false,
    terminal: agent.terminal !== false,
    folders: { ...(agent.folders ?? {}) },
  };
}

/** Corpo do POST: o motor simulado e o modelo padrão ficam de fora (são o padrão do server). */
export function agentCreateBody(values: AgentFormValues): CreateAgentBody {
  const model = values.model.trim();
  return {
    teamId: values.teamId,
    name: values.name.trim(),
    role: values.role.trim(),
    instructions: values.instructions.trim(),
    avatar: values.avatar,
    ...(values.engine !== "mock" ? { engine: values.engine } : {}),
    ...(model && values.engine !== "mock" ? { model } : {}),
    ...(values.effort && values.engine !== "mock" ? { effort: values.effort } : {}),
    // Acesso: só o que foi desligado vai (o resto segue o workspace).
    ...(values.internet ? {} : { internet: false }),
    ...(values.browser ? {} : { browser: false }),
    ...(values.terminal ? {} : { terminal: false }),
    ...(Object.keys(values.folders).length > 0 ? { folders: values.folders } : {}),
  };
}

/** Corpo do PATCH: só o que mudou; modelo/esforço apagados viram `null` (voltam ao padrão). */
export function agentPatch(initial: AgentFormValues, values: AgentFormValues): UpdateAgentBody {
  const { model, effort, ...rest } = changedFields(initial, values);
  return { ...rest, ...(model !== undefined ? { model: model || null } : {}), ...(effort !== undefined ? { effort: effort || null } : {}) };
}

export function isEmptyPatch(patch: object): boolean {
  return Object.keys(patch).length === 0;
}
