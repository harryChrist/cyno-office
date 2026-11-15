import { z } from "zod";
import { MAX_ID_LENGTH, SAFE_ID_PATTERN } from "./ids";

/**
 * Pastas de trabalho de um workspace (Configurações › workspace › Pastas de trabalho): pastas reais
 * do computador (um projeto de código, um vault do Obsidian…) que os agentes do workspace usam. O
 * workspace cadastra e escolhe, por pasta, "só leitura" ou "leitura e escrita"; cada agente só pode
 * REDUZIR (por pasta: "off" = sem acesso, "read" = só leitura), nunca ganhar mais que o workspace.
 * Nenhuma pasta é especial: o campo "para que serve" (`purpose`) vai nas instruções e é ele que diz
 * aos agentes como usar cada uma. A pasta do Cérebro do workspace é outra coisa e não entra aqui.
 */
export const WORK_FOLDER_MODES = ["read", "write"] as const;
export type WorkFolderMode = (typeof WORK_FOLDER_MODES)[number];

/** Limites das pastas (quantidade e tamanho dos textos). */
export const WORK_FOLDER_LIMITS = { max: 12, name: 60, path: 1024, purpose: 500 } as const;

const folderIdSchema = z.string().max(MAX_ID_LENGTH).regex(SAFE_ID_PATTERN, "id inválido");
const folderNameSchema = z.string().trim().min(1, "Dê um nome para a pasta.").max(WORK_FOLDER_LIMITS.name, `O nome pode ter até ${WORK_FOLDER_LIMITS.name} caracteres.`);
const folderPurposeSchema = z.string().trim().max(WORK_FOLDER_LIMITS.purpose, `O texto de "para que serve" pode ter até ${WORK_FOLDER_LIMITS.purpose} caracteres.`);

/** Uma pasta como fica gravada no workspace (caminho absoluto, já normalizado pelo servidor). */
export const workFolderSchema = z.object({
  id: folderIdSchema,
  name: folderNameSchema,
  path: z.string().min(1).max(WORK_FOLDER_LIMITS.path),
  purpose: folderPurposeSchema.optional(),
  mode: z.enum(WORK_FOLDER_MODES),
});
export type WorkFolder = z.infer<typeof workFolderSchema>;

/** O que o agente pode fazer com uma pasta do workspace: "off" = sem acesso, "read" = só leitura (ausente = como no workspace). */
export const AGENT_FOLDER_ACCESS = ["off", "read"] as const;
export type AgentFolderAccess = (typeof AGENT_FOLDER_ACCESS)[number];
export const agentFoldersSchema = z.record(folderIdSchema, z.enum(AGENT_FOLDER_ACCESS));
/** Ajuste por pasta do agente: id da pasta do workspace -> "off" | "read". */
export type AgentFolders = z.infer<typeof agentFoldersSchema>;

/** POST /api/workspaces/:ws/folders. */
export const addWorkFolderBodySchema = z.strictObject({
  name: folderNameSchema,
  path: z.string().trim().min(1, "Digite o caminho da pasta.").max(WORK_FOLDER_LIMITS.path, `O caminho pode ter até ${WORK_FOLDER_LIMITS.path} caracteres.`),
  purpose: folderPurposeSchema.optional(),
  mode: z.enum(WORK_FOLDER_MODES).default("read"),
});
export type AddWorkFolderBody = z.input<typeof addWorkFolderBodySchema>;

/** PATCH /api/workspaces/:ws/folders/:id: nome, "para que serve" e modo (o caminho não muda: tire a pasta e cadastre de novo). */
export const updateWorkFolderBodySchema = z
  .strictObject({ name: folderNameSchema.optional(), purpose: folderPurposeSchema.optional(), mode: z.enum(WORK_FOLDER_MODES).optional() })
  .refine((body) => Object.values(body).some((value) => value !== undefined), { message: "Nada para mudar" });
export type UpdateWorkFolderBody = z.input<typeof updateWorkFolderBodySchema>;

export const workFoldersPath = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/folders`;
export const workFolderPath = (workspaceId: string, folderId: string) => `${workFoldersPath(workspaceId)}/${encodeURIComponent(folderId)}`;

/** Uma pasta como um agente específico a recebe (já com workspace E agente aplicados). */
export type EffectiveFolder = { id: string; name: string; path: string; purpose?: string; write: boolean };

/**
 * As pastas de um agente: as do workspace, menos as que ele desligou ("off"), com a escrita tirada
 * onde ele pôs "read" e onde o workspace só dá leitura. O agente nunca ganha mais que o workspace:
 * pasta que não existe no workspace, mesmo citada no agente, não aparece.
 */
export function effectiveFolders(workspace: { folders?: readonly WorkFolder[] } | readonly WorkFolder[] | undefined, agent: { folders?: AgentFolders } | undefined): EffectiveFolder[] {
  const list = Array.isArray(workspace) ? (workspace as readonly WorkFolder[]) : ((workspace as { folders?: readonly WorkFolder[] } | undefined)?.folders ?? []);
  const own = agent?.folders ?? {};
  const out: EffectiveFolder[] = [];
  for (const folder of list) {
    const choice = own[folder.id];
    if (choice === "off") continue;
    out.push({ id: folder.id, name: folder.name, path: folder.path, ...(folder.purpose ? { purpose: folder.purpose } : {}), write: folder.mode === "write" && choice !== "read" });
  }
  return out;
}

/** Texto curto (pt-BR) do que o agente tem de pastas: "2 pastas (1 com escrita)". */
export function folderSummary(folders: readonly EffectiveFolder[]): string {
  if (folders.length === 0) return "Sem pastas de trabalho";
  const writable = folders.filter((folder) => folder.write).length;
  return `${folders.length} ${folders.length === 1 ? "pasta" : "pastas"}${writable > 0 ? ` (${writable} com escrita)` : " (só leitura)"}`;
}

/**
 * Aviso curto (pt-BR) de onde "só leitura" NÃO é trava de verdade num motor (null = é trava, sem aviso).
 * - Claude Code e Antigravity: a regra vale para as ferramentas de arquivo; com o terminal ligado, um comando pode alterar a pasta;
 * - Hermes: só com a cerca de arquivos ligada (Landlock, vale até para comandos); sem ela é só orientação;
 * - OpenClaw: as pastas só abrem com a cerca ligada e o terminal desligado; aí "só leitura" é trava do sistema;
 * - Freebuff: o motor não limita por pasta; "só leitura" é só orientação nas instruções.
 */
export function folderEngineNote(engine: string, terminal: boolean): string | null {
  if (engine === "claude" || engine === "gemini") return terminal ? "Com o terminal ligado, só leitura vale para as ferramentas de arquivo, mas um comando ainda pode alterar a pasta." : null;
  if (engine === "hermes") return "Neste motor, só leitura só é trava com a cerca de arquivos ligada (Configurações, Motores); sem ela é só orientação.";
  if (engine === "openclaw") return "Neste motor as pastas só abrem com a cerca de arquivos ligada e o terminal desligado; sem isso o agente não as alcança.";
  if (engine === "freebuff") return "Este motor não limita por pasta: só leitura é só orientação nas instruções.";
  return null;
}
