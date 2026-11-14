import { avatarSchema, isRoomThemeId, type Avatar } from "@cyno/shared";

/** Limites dos campos (os mesmos dos schemas zod do shared; o teste confere). */
export const LIMITS = {
  workspaceName: 40,
  roomName: 40,
  teamName: 40,
  focus: 120,
  agentName: 24,
  role: 60,
  instructions: 2000,
  prompt: 100_000,
} as const;

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

export function required(value: string, max: number, empty: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return empty;
  if (trimmed.length > max) return `Use no máximo ${max} caracteres (agora: ${trimmed.length}).`;
  return undefined;
}

export function optional(value: string, max: number): string | undefined {
  const length = value.trim().length;
  return length > max ? `Use no máximo ${max} caracteres (agora: ${length}).` : undefined;
}

export function compact<K extends string>(errors: Record<K, string | undefined>): FieldErrors<K> {
  const out: FieldErrors<K> = {};
  for (const key of Object.keys(errors) as K[]) if (errors[key]) out[key] = errors[key];
  return out;
}

export function hasErrors(errors: FieldErrors<string>): boolean {
  return Object.keys(errors).length > 0;
}

export type WorkspaceForm = { name: string };
export function validateWorkspaceForm(form: WorkspaceForm): FieldErrors<keyof WorkspaceForm> {
  return compact({ name: required(form.name, LIMITS.workspaceName, "Dê um nome ao workspace.") });
}

export type RoomFormInput = { name: string; theme: string };
export function validateRoomForm(form: RoomFormInput): FieldErrors<keyof RoomFormInput> {
  return compact({
    name: required(form.name, LIMITS.roomName, "Dê um nome à sala."),
    theme: isRoomThemeId(form.theme) ? undefined : "Escolha um tema.",
  });
}

export type TeamFormInput = { name: string; focus: string };
export function validateTeamForm(form: TeamFormInput): FieldErrors<keyof TeamFormInput> {
  return compact({
    name: required(form.name, LIMITS.teamName, "Dê um nome ao time."),
    focus: required(form.focus, LIMITS.focus, "Diga em que o time foca (ex.: APIs e dados)."),
  });
}

export type AgentFormInput = { name: string; role: string; instructions: string; avatar: Avatar };
export function validateAgentForm(form: AgentFormInput): FieldErrors<keyof AgentFormInput> {
  return compact({
    name: required(form.name, LIMITS.agentName, "Dê um nome ao agente."),
    role: required(form.role, LIMITS.role, "Diga o papel do agente (ex.: Revisora de código)."),
    instructions: optional(form.instructions, LIMITS.instructions),
    avatar: avatarSchema.safeParse(form.avatar).success ? undefined : "Avatar inválido: escolha as opções de novo.",
  });
}

/** Conversa com o Maestro: sem limite de tamanho, só não pode ser vazia. */
export function validateMessage(text: string): string | undefined {
  return text.trim() ? undefined : "Escreva a mensagem.";
}

export function validatePrompt(prompt: string): string | undefined {
  return required(prompt, LIMITS.prompt, "Escreva o pedido.");
}

/** Só os campos que mudaram (para o PATCH). Compara depois do trim, como o server. */
export function changedFields<T extends Record<string, unknown>>(before: T, after: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(after) as (keyof T)[]) {
    const a = before[key];
    const b = after[key];
    const same = typeof a === "string" && typeof b === "string" ? a.trim() === b.trim() : JSON.stringify(a) === JSON.stringify(b);
    if (!same) out[key] = (typeof b === "string" ? b.trim() : b) as T[keyof T];
  }
  return out;
}
