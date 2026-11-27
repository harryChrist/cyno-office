import { DEFAULT_WORKSPACE_ACCESS, MAESTRO, MAESTRO_AVATAR, MAESTRO_SESSION_NAME_MAX, maestroSessionNameSchema, type CreateWorkspaceBody, type ModelChoice } from "@cyno/shared";
import { choiceFromValues, choiceValues } from "../pages/settings/settingsView";
import { toAvatarInput, type AvatarInput } from "./avatarOptions";
import type { EngineValues } from "./EngineFields";
import { compact, LIMITS, optional, required, type FieldErrors } from "./validation";

/** O Maestro do workspace novo, como está no formulário. */
export type MaestroDraft = {
  name: string;
  avatar: AvatarInput;
  /** null enquanto os padrões globais não chegaram (aí o server usa o padrão `maestro` global). */
  engine: EngineValues | null;
  instructions: string;
  /** Nome da sessão no Remote Control do Claude Code (vazio = "Maestro · <workspace>"). */
  sessionName: string;
};

/** Acesso dos agentes do workspace novo (os mesmos padrões das Configurações; o resto da política fica lá). */
export type AccessDraft = { internet: boolean; browser: boolean; terminal: boolean };

export type WorkspaceFormValues = { name: string; maestro: MaestroDraft; access: AccessDraft };

/** Formulário vazio: o Maestro com nome, visual e instruções padrão (o motor chega com os padrões globais). */
export function newWorkspaceValues(): WorkspaceFormValues {
  const { internet, browser, terminal } = DEFAULT_WORKSPACE_ACCESS;
  return { name: "", maestro: { name: MAESTRO.agentName, avatar: toAvatarInput(MAESTRO_AVATAR), engine: null, instructions: "", sessionName: "" }, access: { internet, browser, terminal } };
}

/** Motor/modelo/esforço padrão do Maestro (os globais) como valores dos campos. */
export function maestroEngineValues(defaults: ModelChoice): EngineValues {
  return choiceValues(defaults);
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function sameAvatar(a: AvatarInput, b: AvatarInput): boolean {
  const keys = ["skin", "hair", "hairColor", "shirt", "pants", "accessory"] as const;
  return keys.every((key) => (a[key] ?? null) === (b[key] ?? null));
}

/** O nome da sessão do Remote Control é válido? (vazio vale: é o padrão) */
export function sessionNameError(value: string): string | undefined {
  const parsed = maestroSessionNameSchema.safeParse(value);
  if (parsed.success) return undefined;
  return value.trim().length > MAESTRO_SESSION_NAME_MAX ? `Use no máximo ${MAESTRO_SESSION_NAME_MAX} caracteres.` : "Sem quebras de linha nem caracteres de controle.";
}

export function validateNewWorkspace(values: WorkspaceFormValues): FieldErrors<"name" | "maestroName" | "instructions" | "sessionName"> {
  return compact({
    name: required(values.name, LIMITS.workspaceName, "Dê um nome ao workspace."),
    maestroName: optional(values.maestro.name, LIMITS.agentName),
    instructions: optional(values.maestro.instructions, LIMITS.instructions),
    sessionName: sessionNameError(values.maestro.sessionName),
  });
}

/**
 * Corpo do POST /api/workspaces: só manda do Maestro o que difere do padrão (nome vazio = "Maestro";
 * motor igual ao padrão global = nada; instruções vazias = as padrão; nome da sessão vazio = o padrão)
 * e, do acesso dos agentes, só o que difere dos padrões. Sem nada diferente, só o nome.
 */
export function createWorkspaceBody(values: WorkspaceFormValues, defaults: ModelChoice | null): CreateWorkspaceBody {
  const draft = values.maestro;
  const maestro: NonNullable<CreateWorkspaceBody["maestro"]> = {};
  const name = draft.name.trim();
  if (name && name !== MAESTRO.agentName) maestro.name = name;
  if (!sameAvatar(draft.avatar, toAvatarInput(MAESTRO_AVATAR))) maestro.avatar = draft.avatar;
  if (draft.engine) {
    const choice = choiceFromValues(draft.engine);
    if (!defaults || !sameJson(choice, choiceFromValues(choiceValues(defaults)))) maestro.choice = choice;
  }
  const instructions = draft.instructions.trim();
  if (instructions) maestro.instructions = instructions;
  const sessionName = draft.sessionName.trim();
  if (sessionName) maestro.sessionName = sessionName;
  const access = Object.fromEntries((["internet", "browser", "terminal"] as const).filter((key) => values.access[key] !== DEFAULT_WORKSPACE_ACCESS[key]).map((key) => [key, values.access[key]]));
  return {
    name: values.name.trim(),
    ...(Object.keys(maestro).length > 0 ? { maestro } : {}),
    ...(Object.keys(access).length > 0 ? { access } : {}),
  };
}
