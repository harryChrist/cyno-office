import { z } from "zod";
import { MAX_ID_LENGTH } from "./ids";

/**
 * Projeto conjunto: um trabalho que envolve mais de um workspace. Uma PARTE em cada workspace (cada
 * uma um Projeto normal, `origin:"cyno"`), ligadas por este registro da plataforma
 * (`data/platform/joint/J-0001.json`); uma parte pode esperar outra. O coordenador (servidor, por código)
 * libera a parte seguinte quando a anterior conclui, levando as entregas dela.
 */

export const JOINT_ID_PATTERN = /^J-\d{4,}$/;
export const JOINT_STATUSES = ["ativo", "concluido", "cancelado", "travado"] as const;
export const JOINT_PART_STATUSES = ["esperando", "em-andamento", "concluida", "falhou", "cancelada", "bloqueada"] as const;
export type JointPartStatus = (typeof JOINT_PART_STATUSES)[number];

/** Limites do que o Cyno monta (e do que vai de uma parte para a seguinte). */
export const JOINT_LIMITS = { parts: 6, summaryChars: 2000, mediaPerPart: 8, briefChars: 12_000 } as const;

/** O que uma parte recebeu das partes anteriores quando foi liberada. */
export const jointReceivedSchema = z.object({
  at: z.iso.datetime(),
  items: z
    .array(
      z.object({
        /** A parte de onde veio ("P1"). */
        from: z.string().regex(/^P\d{1,2}$/),
        workspace: z.string().max(MAX_ID_LENGTH),
        summary: z.string().max(JOINT_LIMITS.summaryChars).default(""),
        /** Mídias copiadas para a biblioteca desta parte (id novo e título). */
        media: z.array(z.object({ mediaId: z.string().max(16), title: z.string().max(200) })).default([]),
      }),
    )
    .default([]),
});
export type JointReceived = z.output<typeof jointReceivedSchema>;

export const jointPartSchema = z.object({
  ref: z.string().regex(/^P\d{1,2}$/),
  workspace: z.string().max(MAX_ID_LENGTH),
  /** Projeto desta parte no workspace (nasce quando a parte é liberada; antes há só o marcador pausado). */
  projectId: z.string().max(80).optional(),
  /** Projeto pausado que segura o lugar da parte enquanto ela espera (some quando a parte é liberada). */
  placeholderId: z.string().max(80).optional(),
  title: z.string().max(200),
  briefing: z.string().max(JOINT_LIMITS.briefChars),
  dependsOn: z.array(z.string()).default([]),
  expects: z.string().max(500).optional(),
  doneWhen: z.array(z.string().max(300)).max(10).optional(),
  dueAt: z.iso.datetime().optional(),
  status: z.enum(JOINT_PART_STATUSES).default("esperando"),
  /** Mídias (ids da biblioteca do workspace da parte) que a parte entregou ao concluir. */
  deliverables: z.array(z.string().max(40)).default([]),
  /** O resumo do que a parte entregou (a resposta final do Maestro), guardado quando conclui. */
  summary: z.string().max(JOINT_LIMITS.summaryChars).optional(),
  /** Por que a parte está bloqueada ("A parte P1 falhou"). */
  blockedReason: z.string().max(400).optional(),
  received: jointReceivedSchema.optional(),
  startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
});
export type JointPart = z.output<typeof jointPartSchema>;

export const jointProjectSchema = z.object({
  id: z.string().regex(JOINT_ID_PATTERN),
  title: z.string().max(200),
  brief: z.string().max(JOINT_LIMITS.briefChars),
  status: z.enum(JOINT_STATUSES).default("ativo"),
  /** O dono pausou o conjunto: as partes em andamento pausam e nenhuma parte nova é liberada. */
  paused: z.boolean().optional(),
  parts: z.array(jointPartSchema).min(1),
  createdAt: z.iso.datetime(),
  dueAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
});
export type JointProject = z.output<typeof jointProjectSchema>;

// ---------- Como a tela vê (calculado por código a partir dos projetos de cada workspace) ----------

/** O estado de uma parte como o dono lê. */
export const JOINT_PART_STATES = ["esperando", "enviado", "andando", "esperando_voce", "pausado", "concluida", "falhou", "cancelada", "bloqueada"] as const;
export type JointPartState = (typeof JOINT_PART_STATES)[number];

export const JOINT_PART_STATE_LABELS: Record<JointPartState, string> = {
  esperando: "esperando",
  enviado: "enviado, o Maestro está distribuindo",
  andando: "andando",
  esperando_voce: "esperando você",
  pausado: "pausada",
  concluida: "concluída",
  falhou: "falhou",
  cancelada: "cancelada",
  bloqueada: "bloqueada",
};

export type JointPartView = {
  ref: string;
  workspace: string;
  workspaceName: string;
  title: string;
  dependsOn: string[];
  state: JointPartState;
  /** Etapa atual em texto curto, quando está andando. */
  stage?: string;
  tasksDone?: number;
  tasksTotal?: number;
  /** Partes de que esta ainda espera ("P1"). */
  waitingFor: string[];
  projectId?: string;
  blockedReason?: string;
  summary?: string;
  /** O que recebeu das partes anteriores. */
  received?: JointReceived;
};

export type JointView = {
  id: string;
  title: string;
  status: JointProject["status"];
  paused: boolean;
  createdAt: string;
  dueAt?: string;
  finishedAt?: string;
  parts: JointPartView[];
};

export const JOINT_PATH = "/api/cyno/joints";
export type JointsResponse = { joints: JointView[] };
/** POST /api/cyno/joints/:id/cancel */
export const jointCancelBodySchema = z.strictObject({ reason: z.string().trim().max(400).optional() });

/** O conjunto mudou (a lista inteira, pequena): o cartão do chat e a tela Trabalho atualizam ao vivo. */
export type JointServerEvent = { type: "cyno:joints"; joints: JointView[] };
export const JOINT_EVENT_TYPES = ["cyno:joints"] as const;

const JOINT_MARK = /^\[\[conjunto:(J-\d{4,})\]\]\s*(.*)$/s;

/** `status "started"`: o Cyno montou um projeto conjunto (o chat mostra o cartão ao vivo). */
export function jointMarker(id: string, title: string): string {
  return `[[conjunto:${id}]] ${title.replace(/\s+/g, " ").trim().slice(0, 160)}`;
}

export function parseJointMarker(message: string): { jointId: string; title: string } | undefined {
  const match = JOINT_MARK.exec(message);
  return match ? { jointId: match[1]!, title: match[2] ?? "" } : undefined;
}
