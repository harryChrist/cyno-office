import type { LogPhrase, TaskStatus } from "@cyno/shared";
import { formatDateTime, formatTime, type StatusTone } from "../ui/format";

/**
 * Itens da linha do tempo de um agente ("o que ele está fazendo"). A mesma lista serve para:
 * - o Maestro: cada pedido do usuário e o que ele fez com ele (`request`);
 * - o trabalho de qualquer agente: passos curtos (`step`), hoje vindos do feed de atividade e,
 *   quando os agentes forem de verdade, do stream de trabalho deles (texto, ferramenta, progresso,
 *   aprovação, resultado). Um item novo entra aqui como mais um `kind`, e o `Timeline` o desenha.
 */
export type TimelineItem = RequestItem | StepItem;

/** Em que pé está um pedido ao Maestro. */
export type RequestStage = "queued" | "triage" | "routed" | "waiting_you" | "reviewing" | "done" | "failed";

/** Um pedido do usuário ao Maestro e a resposta dele (para quem mandou, por quê, como está). */
export type RequestItem = {
  kind: "request";
  /** Id da tarefa do Maestro. */
  id: string;
  /** Quando o pedido foi feito. */
  at: string;
  prompt: string;
  stage: RequestStage;
  /** Rótulo curto do estágio ("Triando", "Em andamento", "Concluído"…). */
  stageLabel: string;
  tone: StatusTone;
  /** Por que o Maestro escolheu o time (ou a pergunta, quando ele precisa de você). */
  reason?: string;
  team?: { id: string; name: string };
  room?: { id: string; name: string };
  /** Quem do time pegou a subtarefa; `roomId` é o quarto de casa (para o "Ver no mapa"). */
  agent?: { id: string; name: string; roomId?: string };
  subtaskId?: string;
  subtaskStatus?: TaskStatus;
  /** Progresso ao vivo (da subtarefa, se está andando; senão do próprio Maestro). */
  progress?: { value: number; message: string };
  /** Resultado (ou motivo da falha) quando terminou. */
  result?: string;
  /** Última mudança (vale como "terminou às" nos estágios finais). */
  updatedAt: string;
};

/** Estado de um passo: em andamento, deu certo, deu errado, pede você ou só informa. */
export type StepState = "running" | "ok" | "error" | "attention" | "info";

/** O que um passo representa (o `Timeline` desenha cada um do seu jeito). */
export type StepVariant = "event" | "text" | "tool" | "progress" | "approval" | "result" | "raw" | "subagent" | "delegation" | "status";

/** Chamada de ferramenta de um agente (nome, resumo, duração e a prévia da saída). */
export type StepTool = {
  name: string;
  summary: string;
  /** A frase de atividade ("📖 Lendo App.tsx"): a do servidor ou, em log antigo, calculada na hora. */
  phrase?: LogPhrase;
  durationMs?: number;
  /** Prévia (cortada) da saída. */
  output?: string;
  /** Input em JSON formatado (quando coube no log). */
  input?: string;
};

/**
 * Um passo curto do trabalho: uma transição do feed de atividade (`event`) ou uma entrada do log
 * de trabalho de um agente (texto, ferramenta, progresso, aprovação, resultado, linha crua…).
 */
export type StepItem = {
  kind: "step";
  id: string;
  at: string;
  text: string;
  detail?: string;
  state: StepState;
  variant?: StepVariant;
  /** 0..1, para `variant: "progress"`. */
  progress?: number;
  /** `text` é markdown (narração e resultado): no modo cartões vira texto formatado. */
  markdown?: boolean;
  tool?: StepTool;
  /** Linha crua: de qual saída do processo veio. */
  stream?: "stdout" | "stderr";
  /** Subagente a que o passo se refere (abre a thread dele). */
  threadId?: string;
  /** Agente a que o passo se refere (ex.: para quem o Maestro delegou), para abrir a tela dele. */
  agentId?: string;
  /** Rótulo curto antes do texto (ex.: o nome da ferramenta no terminal, "stderr"). */
  tag?: string;
};

/** Hora do item: só "14:03" se for de hoje; senão "07/11 14:03". */
export function clockLabel(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toDateString() === now.toDateString() ? formatTime(iso) : formatDateTime(iso, now);
}
