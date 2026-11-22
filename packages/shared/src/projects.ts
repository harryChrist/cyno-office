import { parseAddress } from "./address";
import type { Sprint } from "./sprints";
import { effectiveDeps } from "./task-flow";
import { completedRefs, dependencyCycle, leafTasks } from "./task-tree";
import type { Agent, Task } from "./types";

/**
 * Projeto (antes "Plano"): o Maestro divide um pedido em tarefas (`create_plan`), cada uma com um
 * dono, uma sequência de etapas (quem faz o quê, em ordem: o resultado de uma etapa passa sozinho
 * para a próxima), dependências e prioridade. O usuário aprova o plano antes de qualquer coisa
 * começar; depois o servidor distribui as tarefas (veja ProjectService) e só chama o Maestro de novo
 * quando tudo termina ou quando algo precisa de uma decisão dele.
 *
 * O id do Projeto é o MESMO id do pedido do Maestro (a `Task` com `role: "request"`), então logs,
 * itens do "Para você" e a sessão do Maestro continuam valendo. Toda tarefa avulsa também é um
 * Projeto, de `kind: "tarefa"` (1 tarefa e 1 etapa, sem aprovação de plano).
 *
 * Cada etapa em execução é uma Task comum (com `projectId` e `work`), executada pelo orquestrador
 * como qualquer outra: log, aprovações, Cérebro e cota valem igual.
 */

/** projeto = vários passos, aprovado pelo usuário; tarefa = avulsa (1 tarefa, 1 etapa). */
export const PROJECT_KINDS = ["projeto", "tarefa"] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

/** Quem pediu. */
export const PROJECT_ORIGINS = ["usuario", "maestro", "rotina", "cyno"] as const;
export type ProjectOrigin = (typeof PROJECT_ORIGINS)[number];

/**
 * proposto = esperando o usuário aprovar (nada roda); ajustando = o usuário pediu ajustes e o
 * Maestro está refazendo; ativo = aprovado, o servidor distribui; pausado = não distribui; concluido
 * = todas as tarefas terminaram; cancelado = o usuário (ou o fim do pedido) cancelou.
 */
export const PROJECT_STATUSES = ["proposto", "ajustando", "ativo", "pausado", "concluido", "cancelado"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  proposto: "Esperando sua aprovação",
  ajustando: "O Maestro está ajustando",
  ativo: "Em execução",
  pausado: "Pausado",
  concluido: "Concluído",
  cancelado: "Cancelado",
};

/**
 * backlog = alguma dependência não terminou; a_fazer = pronta, esperando a vez (vaga, agente livre
 * ou cota); em_andamento = uma etapa rodando (ou passando para a próxima); esperando_voce = a etapa
 * pediu aprovação ou informação ao usuário; concluida; falhou (o Maestro decide); cancelada.
 */
export const PROJECT_TASK_STATUSES = ["backlog", "a_fazer", "em_andamento", "esperando_voce", "concluida", "falhou", "cancelada"] as const;
export type ProjectTaskStatus = (typeof PROJECT_TASK_STATUSES)[number];

export const PROJECT_STEP_STATUSES = ["pendente", "em_andamento", "feita", "falhou"] as const;
export type ProjectStepStatus = (typeof PROJECT_STEP_STATUSES)[number];

export const PROJECT_PRIORITIES = ["alta", "normal", "baixa"] as const;
export type ProjectPriority = (typeof PROJECT_PRIORITIES)[number];

export const PROJECT_PRIORITY_LABELS: Record<ProjectPriority, string> = { alta: "Alta", normal: "Normal", baixa: "Baixa" };

/** Prioridade como o Maestro manda pelo MCP (contrato em inglês) -> a gravada no projeto. */
export const PROJECT_INPUT_PRIORITIES = ["high", "normal", "low"] as const;
export type ProjectInputPriority = (typeof PROJECT_INPUT_PRIORITIES)[number];
const PRIORITY_FROM_INPUT: Record<ProjectInputPriority, ProjectPriority> = { high: "alta", normal: "normal", low: "baixa" };

/** Liberação como o Maestro manda pelo MCP (contrato em inglês): "now" = liberada, "later" = Planejada. */
export const PROJECT_INPUT_RELEASES = ["now", "later"] as const;
export type ProjectInputRelease = (typeof PROJECT_INPUT_RELEASES)[number];

/** Escolha de aprovação do Maestro em `create_project` (contrato MCP, em inglês): "ask" = pedir OK, "skip" = começar sem pedir. */
export const PROJECT_INPUT_APPROVALS = ["ask", "skip"] as const;
export type ProjectInputApproval = (typeof PROJECT_INPUT_APPROVALS)[number];

/** Regra de aprovação de projetos do workspace: "maestro" (padrão), "always" (sempre pedir) ou "never" (nunca pedir). */
export const PLAN_APPROVAL_RULES = ["maestro", "always", "never"] as const;
export type PlanApprovalRule = (typeof PLAN_APPROVAL_RULES)[number];
export const DEFAULT_PLAN_APPROVAL: PlanApprovalRule = "maestro";
export const PLAN_APPROVAL_LABELS: Record<PlanApprovalRule, string> = {
  maestro: "o Maestro decide",
  always: "sempre pedir",
  never: "nunca pedir",
};

/** Quem gravou a nota da regra de aprovação do workspace. */
export const PLAN_APPROVAL_NOTE_BY = ["dono", "maestro"] as const;
export type PlanApprovalNoteBy = (typeof PLAN_APPROVAL_NOTE_BY)[number];
export type PlanApprovalNote = { quote: string; at: string; by: PlanApprovalNoteBy };

/** Regra efetiva de aprovação do workspace (ausente = "maestro"). */
export function planApprovalRule(value: PlanApprovalRule | undefined): PlanApprovalRule {
  return value ?? DEFAULT_PLAN_APPROVAL;
}

/** Resposta de GET/PUT /api/w/:ws/settings/plan-approval. */
export type PlanApprovalSettings = { rule: PlanApprovalRule; note?: PlanApprovalNote };

/** Quem aprovou ou dispensou a aprovação do projeto ("dono" = cartão; "regra" = workspace "never"; "maestro" = escolha "skip"). */
export const PROJECT_APPROVAL_BY = ["dono", "regra", "maestro"] as const;
export type ProjectApprovalBy = (typeof PROJECT_APPROVAL_BY)[number];
export type ProjectApproval = { by: ProjectApprovalBy; at: string; quote?: string };

/** Uma etapa: um participante e o que ele faz. `taskId` = a subtarefa que executa a etapa (quando começa). */
export type ProjectStep = {
  agentId: string;
  /** "workspace/agente" (derivado ao gravar; veja agentAddress em address.ts). */
  address?: string;
  what: string;
  status: ProjectStepStatus;
  taskId?: string;
  result?: string;
  startedAt?: string;
  finishedAt?: string;
};

/** Pedido de ajuda de um agente (`request_help`): vira uma sugestão para o Maestro. */
export const HELP_KINDS = ["skill", "access"] as const;
export type HelpKind = (typeof HELP_KINDS)[number];
export type ProjectHelp = { agentId: string; what: string; suggestedAgentId?: string; kind?: HelpKind; at: string };

/** Item de "pronto quando…" (critério de pronto da tarefa ou do projeto). */
export type DoneItem = { id: string; text: string; met?: boolean; note?: string };

/** Por que a tarefa está parada: você, outro agente, cota ou acesso. */
export const BLOCKED_TYPES = ["voce", "agente", "cota", "acesso"] as const;
export type BlockedType = (typeof BLOCKED_TYPES)[number];
export type Blocked = { type: BlockedType; /** Endereço de quem bloqueia (ex.: "linkedin/eco"). */ by?: string; note: string; since: string };

/** Um bloqueio que já acabou: por que a tarefa ficou parada e por quanto tempo (histórico da Gestão). */
export type BlockedSpan = { type: BlockedType; by?: string; since: string; until: string };
/** Quantos bloqueios encerrados ficam gravados por tarefa (os mais recentes). */
export const BLOCKED_SPANS_MAX = 20;

/**
 * Encerra o bloqueio da tarefa em `until`: guarda o trecho em `blockedSpans` (os últimos 20) e limpa `blocked`.
 * Sem bloqueio, não faz nada. Trecho de duração zero ou negativa não é gravado.
 */
export function clearBlocked(task: Pick<ProjectTask, "blocked" | "blockedSpans">, until: string): void {
  const blocked = task.blocked;
  if (!blocked) return;
  delete task.blocked;
  if (!(Date.parse(until) > Date.parse(blocked.since))) return;
  const spans = [...(task.blockedSpans ?? []), { type: blocked.type, ...(blocked.by ? { by: blocked.by } : {}), since: blocked.since, until }];
  task.blockedSpans = spans.slice(-BLOCKED_SPANS_MAX);
}

/** Troca o bloqueio da tarefa: se o anterior era outro (`since` diferente), ele vira um trecho encerrado em `at`. */
export function setBlocked(task: Pick<ProjectTask, "blocked" | "blockedSpans">, next: Blocked, at: string): void {
  if (task.blocked && task.blocked.since !== next.since) clearBlocked(task, at);
  task.blocked = next;
}

/** Retrabalho: quantas vezes uma aprovação foi recusada e o último motivo. */
export type Rework = { count: number; last?: { reason: string; at: string; itemId?: string } };

/** Passagem de bastão entre agentes (fatia 6). */
export const HANDOFF_INTENTS = ["pass_on", "ask", "fyi"] as const;
export type HandoffIntent = (typeof HANDOFF_INTENTS)[number];
export type TaskOrigin = {
  fromAddress: string;
  fromRef: string;
  intent: HandoffIntent;
  /** Tamanho da cadeia de repasses até aqui (o primeiro repasse é 1). */
  hops: number;
  /** Quando o repasse foi criado (ISO): base do limite por hora. */
  at?: string;
  /** Resposta de um `ask` voltando para quem perguntou (não conta como novo pedido de repasse). */
  reply?: boolean;
};

/** Limites contra laço entre agentes (servidor: `handoff`). */
export const HANDOFF_LIMITS = { hops: 6, openPerTask: 3, perProject: 30, perHour: 20, pingPong: 4 } as const;

/** "Crivo passou para Eco" / "Eco perguntou a Radar" / "Radar avisou Eco" / "Eco respondeu a Radar" (de quem para quem, vista da tarefa criada). */
export function handoffLabel(origin: Pick<TaskOrigin, "intent" | "reply">, from: string, to: string): string {
  if (origin.reply) return `${from} respondeu a ${to}`;
  if (origin.intent === "ask") return `${from} perguntou a ${to}`;
  if (origin.intent === "fyi") return `${from} avisou ${to}`;
  return `${from} passou para ${to}`;
}

/** Ritmo: horas por dia, janela de horário (local do servidor) e etapas em paralelo. */
export type Pace = { hoursPerDay?: number; window?: { from: string; to: string }; maxParallel?: number };

/** Permissão do Modo Automático: só o usuário grava `approvedAt`. */
export type AutoGrant = { actions: string[]; sites?: string[]; connectors?: string[]; dailyCap?: number; approvedAt: string };

export type ProjectMode = { kind: "pede-ok" } | { kind: "automatico"; grant: AutoGrant };
export type ModeProposal = { grant: AutoGrant; by: "maestro" | "cyno"; at: string };

export type ProjectTask = {
  /** Apelido curto e único no projeto (ex.: "T1"): é o que `depends_on` cita. */
  ref: string;
  title: string;
  briefing: string;
  /** Responsável pela tarefa (quase sempre um dos participantes). */
  ownerId: string;
  steps: ProjectStep[];
  /** Índice da etapa atual (a que roda ou a próxima a rodar). */
  current: number;
  dependsOn: string[];
  priority: ProjectPriority;
  /** Herdam do projeto se ausentes. */
  startAt?: string;
  dueAt?: string;
  /** "Pronto quando…" (padrão []). */
  doneWhen: DoneItem[];
  status: ProjectTaskStatus;
  /** Pulada pelo Maestro (`resolve_task` skip): fica "concluida" para destravar as dependentes, mas não conta como concluída de verdade. */
  skipped?: boolean;
  /** Id do tipo de aprovação do entregável (o agente recebe o limite de caracteres). */
  approvalType?: string;
  /** Resultado da última etapa (tarefa concluída). */
  result?: string;
  /** Motivo da falha. */
  failure?: string;
  /** Por que está parada agora (ex.: "Beto sem cota", "esperando vaga"); some quando anda. */
  note?: string;
  blocked?: Blocked;
  /** Bloqueios que já acabaram (os últimos 20): "travada por quê e por quanto tempo". Ausente em tarefas antigas. */
  blockedSpans?: BlockedSpan[];
  /** Quando a tarefa entrou na fila (`a_fazer`): com `startedAt`, o tempo na fila exato. Ausente em tarefas antigas. */
  queuedAt?: string;
  rework: Rework;
  origin?: TaskOrigin;
  /** Desde quando espera (a vez, o agente da próxima etapa, o usuário): base do aviso de parada. */
  waitingSince?: string;
  /** O Maestro já foi avisado de que esta tarefa está parada (uma vez por espera). */
  stallWarned?: boolean;
  help?: ProjectHelp[];
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  // ---------- Árvore e sprints (todos opcionais: o que já está gravado continua valendo) ----------
  /** `ref` do pai; ausente = filha direta do projeto. */
  parent?: string;
  /** Posição entre irmãos (passo de 1000); ausente = a ordem da lista. */
  order?: number;
  /** MÓDULO (antes "entregável"): em qualquer profundidade, sem `steps`, nunca executa (o estado dele é calculado das filhas); pode conter módulos. */
  group?: true;
  /** Sprint da folha (id em `Project.sprints`); o pai mostra as sprints das filhas. */
  sprintId?: string;
  /** Ids de `Project.labels` (padrão []; no máximo `PROJECT_LIMITS.labelsPerTask`). */
  labels?: string[];
  /** Sprint de onde a tarefa veio ("veio da sprint anterior"). */
  carriedFrom?: string;
  /** Quantas sprints a tarefa atravessou (padrão 0). */
  carryCount?: number;
  /** Só nas folhas do projeto "Avulsas": o que era do pedido simples (projeto `kind: "tarefa"`). */
  meta?: ProjectTaskMeta;
  /** Arquivada pelo dono (só concluída ou cancelada): some da árvore, do quadro e das contas de progresso. */
  archived?: true;
  /** "Isso primeiro" numa tarefa avulsa (folha do Avulsas, que não tem projeto próprio para fixar). */
  pinnedAt?: string;
  /**
   * LIBERAÇÃO ("criar não executa"): true = liberada (entra na fila), false = Planejada (existe, mas o agendador não a despacha).
   * AUSENTE = liberada (o que já está gravado continua rodando como sempre). Em módulo e tarefa-mãe o campo só serve para a herança:
   * o item novo dentro de um contêiner com `released === true` nasce liberado. Veja release.ts.
   */
  released?: boolean;
};

/**
 * Liberação diária do projeto: o código (sem acordar o Maestro) libera `perDay` tarefas ou módulos por dia, na ordem de prioridade e depois
 * na da árvore, com os pré-requisitos junto. `startsOn` = dia local (AAAA-MM-DD) em que começa; `given` = o que já saiu hoje (zera na virada do dia).
 */
export type ReleasePace = { perDay: number; unit: "tarefas" | "modulos"; startsOn?: string; given?: { day: string; count: number } };
export const RELEASE_PACE_UNITS = ["tarefas", "modulos"] as const;
export const RELEASE_PACE_LIMITS = { perDay: { min: 1, max: 500 } } as const;

/** Origem de uma folha do "Avulsas": o pedido (Task do Maestro) que a gerou e o que o projeto antigo guardava. */
export type ProjectTaskMeta = {
  /** Id do pedido (== id do projeto `kind: "tarefa"` antigo). `ProjectService.forRequest` acha a folha por aqui. */
  requestId: string;
  origin: ProjectOrigin;
  routineRef?: ProjectRoutineRef;
  /** Briefing completo vindo do Cyno. */
  brief?: string;
  joint?: ProjectJointRef;
  /** Quando o pedido nasceu (o `createdAt` do projeto antigo): ordena e arquiva. */
  createdAt?: string;
};

/** Qual rotina, horário (schedule) e chave do horário local ("2026-11-11T08:00") dispararam e o período (ex.: "2026-W46"). */
export type ProjectRoutineRef = { routineId: string; scheduleId?: string; slot?: string; period?: string };

/** Etiqueta do projeto (front, backend, bug…); `color` é um id da paleta. */
export type Label = { id: string; name: string; color: string };

export type Project = {
  /** Id do projeto: no primeiro projeto de um pedido é o mesmo id do pedido; nos extras (`new_project: true`) e nos criados à mão é um UUID próprio. */
  id: string;
  /** Id do pedido do Maestro de origem, quando diferente de `id` (2º+ projeto no mesmo pedido). Ausente = `id` (veja `requestIdOf`). */
  requestId?: string;
  kind: ProjectKind;
  title: string;
  /** Resumo do Maestro para o usuário (topo do plano). */
  summary?: string;
  origin: ProjectOrigin;
  /** Preenchido quando `origin` é "rotina": qual rotina, horário (schedule) e chave do horário local ("2026-11-11T08:00") dispararam e o período (ex.: "2026-W46"). */
  routineRef?: ProjectRoutineRef;
  status: ProjectStatus;
  /** Sobe a cada ajuste (create_plan de novo antes da aprovação). */
  version: number;
  /** Último ajuste pedido pelo usuário. */
  feedback?: string;
  /** Item do "Para você" que pede a aprovação do plano (só kind "projeto"). */
  forYouId?: string;
  priority: ProjectPriority;
  startAt?: string;
  dueAt?: string;
  pace?: Pace;
  /** Padrão { kind: "pede-ok" }. */
  mode: ProjectMode;
  /** Sugestão de Automático: só vale depois do OK do usuário. */
  modeProposal?: ModeProposal;
  /** Quantas ações o Automático fez sozinho no dia local de São Paulo (teto `grant.dailyCap`). */
  autoUsage?: { day: string; count: number };
  doneWhen?: DoneItem[];
  /** Milissegundos trabalhados por dia local (AAAA-MM-DD); poda em 90 dias. */
  worked: Record<string, number>;
  tasks: ProjectTask[];
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  /** Quem aprovou ou dispensou a aprovação do plano (ausente em projetos antigos). */
  approval?: ProjectApproval;
  finishedAt?: string;
  /** O Maestro já recebeu o resumo do fim (uma vez). */
  doneNotified?: boolean;
  /** Briefing completo vindo do Cyno (até PROJECT_BRIEF_MAX caracteres); o Maestro não refaz as perguntas que já estão aqui. */
  brief?: string;
  /** Parte de um projeto conjunto da plataforma (`data/platform/joint/J-0001.json`): qual e de quais partes espera. */
  joint?: ProjectJointRef;
  // ---------- Sprints, etiquetas e o projeto fixo "Avulsas" (opcionais) ----------
  /** Projeto fixo do sistema: "avulsas" não se apaga nem conclui, fica sempre `ativo` e guarda as tarefas simples como folhas. */
  system?: "avulsas";
  /** Etiquetas do projeto (padrão []; no máximo `PROJECT_LIMITS.labels`). */
  labels?: Label[];
  /** Sprints do projeto (padrão []; no máximo `PROJECT_LIMITS.sprints`). Sem sprints = todas as tarefas elegíveis. */
  sprints?: Sprint[];
  /** Quando foi pausado (para empurrar as datas das sprints ao retomar). */
  pausedAt?: string;
  /** "Isso primeiro": quando o dono fixou o projeto no topo da fila (ausente = não fixado). */
  pinnedAt?: string;
  /** Só no Avulsas: o próximo número do `ref` das folhas (`A<n>`). */
  nextRef?: number;
  /** Liberação diária (ausente = nada é liberado sozinho: só à mão ou pelo Maestro). */
  releasePace?: ReleasePace;
};

/** Teto do briefing que o Cyno entrega com o pedido. */
export const PROJECT_BRIEF_MAX = 12_000;

/** Liga o projeto a um projeto conjunto (Cyno). */
export type ProjectJointRef = { id: string; part: string; dependsOn: string[] };

/** Padrões dos campos obrigatórios (usados ao criar e ao ler arquivos antigos). */
export const PROJECT_DEFAULT_MODE: ProjectMode = { kind: "pede-ok" };
export const WORKED_RETENTION_DAYS = 90;

/** Campos do projeto que têm padrão. */
export function projectDefaults(): Pick<Project, "priority" | "mode" | "worked" | "origin" | "kind"> {
  return { kind: "projeto", origin: "maestro", priority: "normal", mode: { kind: "pede-ok" }, worked: {} };
}

/** Quantas vezes uma recusa com motivo volta sozinha ao mesmo agente antes de o Maestro ser chamado. */
export const MAX_REWORK = 2;

/** Campos da tarefa que têm padrão. */
export function projectTaskDefaults(): Pick<ProjectTask, "doneWhen" | "rework"> {
  return { doneWhen: [], rework: { count: 0 } };
}

/** O ciclo de vida do plano (aprovação, distribuição, avisos ao Maestro) cuida deste projeto? Projeto de tarefa avulsa só espelha a Task. */
export function isPlanned(project: Pick<Project, "kind" | "approvedAt">): boolean {
  return project.kind === "projeto" && project.approvedAt !== undefined;
}

/** Id do pedido do Maestro a que o projeto pertence (`requestId` nos projetos extras do mesmo pedido, ou `id` no primeiro). */
export function requestIdOf(project: Pick<Project, "id" | "requestId">): string {
  return project.requestId ?? project.id;
}

/** Limites de paralelismo da distribuição (por workspace). */
export type DispatchSettings = { maxRunning: number; perAgent: number };

export const DEFAULT_DISPATCH: DispatchSettings = { maxRunning: 3, perAgent: 1 };
/**
 * Projetos do histórico fabricado do app de teste (`dev/history-seed.ts`) têm o id com este prefixo. Eles existem para as telas e as contas
 * da Gestão terem o que mostrar; o agendador nunca os executa nem avisa o Maestro deles (senão o app de teste gastaria cota de verdade
 * rodando tarefas inventadas, visto em 13/11). No app real não existe projeto com este prefixo: a semente se recusa a rodar fora do laboratório.
 */
export const SEED_PROJECT_PREFIX = "seed-";
/** Qualquer registro fabricado pela semente (projeto, pedido, tarefa de agente): o id começa com o prefixo. */
export const isSeedId = (id: string): boolean => id.startsWith(SEED_PROJECT_PREFIX);
export const isSeedProject = (project: { id: string }): boolean => project.id.startsWith(SEED_PROJECT_PREFIX);
/** Folha fabricada pela semente dentro do "Avulsas" (um pedido simples inventado): o pedido dela tem o mesmo prefixo. */
export const isSeedTask = (task: { meta?: { requestId?: string } }): boolean => Boolean(task.meta?.requestId?.startsWith(SEED_PROJECT_PREFIX));

export const DISPATCH_LIMITS = { maxRunning: { min: 1, max: 10 }, perAgent: { min: 1, max: 3 } } as const;

/** Configuração efetiva (o que faltar = o padrão). */
export function dispatchSettings(partial: Partial<DispatchSettings> | undefined): DispatchSettings {
  return { ...DEFAULT_DISPATCH, ...Object.fromEntries(Object.entries(partial ?? {}).filter(([, value]) => value !== undefined)) };
}

/** Tetos do plano (o que o Maestro manda). Não há teto de tarefas, módulos, níveis nem subtarefas: o dono decide o tamanho do projeto. */
export const PROJECT_LIMITS = {
  steps: 6,
  title: 120,
  briefing: 3000,
  stepWhat: 1000,
  ref: 12,
  /** Etiquetas por tarefa, etiquetas e sprints por projeto. */
  labelsPerTask: 5,
  labels: 12,
  sprints: 20,
} as const;

/**
 * Rede de segurança (NÃO é um limite de produto): só barra erro grosseiro, como um laço que cria itens sem parar ou uma árvore
 * ridiculamente funda. `nodes` = itens por projeto, `depth` = níveis abaixo do projeto, `perCall` = itens (ou responsáveis) por chamada de
 * ferramenta. Um lote de 100 capítulos cabe com folga.
 */
export const PROJECT_SAFETY = { nodes: 5000, depth: 50, perCall: 500 } as const;

// ---------- Urgência (agendador e tela Trabalho) ----------

export const PRIORITY_RANK: Record<ProjectPriority, number> = { alta: 0, normal: 1, baixa: 2 };

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** O que a ordem de urgência olha em um item (projeto, tarefa ou etapa na fila). */
export type RankInput = {
  priority: ProjectPriority;
  dueAt?: string;
  /** Só para a tela (desempate: o mais recente primeiro). */
  createdAt?: string;
  /** Quando o projeto foi aprovado (desempate do agendador: o aprovado há mais tempo primeiro). */
  approvedAt?: string;
  /** Veio da sprint anterior: passa na frente do que é novo (depois da prioridade, antes do prazo). */
  carried?: boolean;
  /** Posição na fila/no plano (último desempate). */
  position?: number;
  /** "Isso primeiro": fixado pelo dono. Passa na frente de tudo; entre fixados, o fixado há mais tempo primeiro. */
  pinnedAt?: string;
};

export type RankOptions = {
  /** `recent` (tela): mais recente primeiro. `approved` (agendador): aprovado há mais tempo, depois a posição. */
  tieBreak?: "recent" | "approved";
  /** Tempo médio das tarefas já feitas: prazo mais curto que isto sobe a prioridade uma classe (regra de urgência extra). */
  avgTaskMs?: number;
};

/** Faixa de urgência: 0 atrasado, 1 prazo em menos de 24 h, 2 o resto. */
export function urgencyTier(item: Pick<RankInput, "dueAt">, now: number): 0 | 1 | 2 {
  const due = item.dueAt ? Date.parse(item.dueAt) : NaN;
  if (Number.isNaN(due)) return 2;
  if (due < now) return 0;
  return due - now < DAY_MS ? 1 : 2;
}

/**
 * Prioridade que vale na ordem: a do item, subindo uma classe (baixa -> normal -> alta) quando o
 * prazo ainda não passou mas falta menos que o tempo médio de uma tarefa (`avgTaskMs`).
 */
export function effectiveRank(item: Pick<RankInput, "priority" | "dueAt">, now: number, avgTaskMs?: number): number {
  const base = PRIORITY_RANK[item.priority];
  const due = item.dueAt ? Date.parse(item.dueAt) : NaN;
  if (avgTaskMs && !Number.isNaN(due) && due >= now && due - now < avgTaskMs) return Math.max(0, base - 1);
  return base;
}

/**
 * Ordem de urgência: fixado ("Isso primeiro"), atrasado, prazo em menos de 24 h, prioridade (com a urgência extra), prazo mais
 * próximo (sem prazo por último) e o desempate de `tieBreak`. Negativo = `a` vem antes.
 */
export function compareWork(a: RankInput, b: RankInput, now: number, options: RankOptions = {}): number {
  // "Isso primeiro": os fixados vêm antes de tudo (até do atrasado), entre si pelo `pinnedAt`.
  if (a.pinnedAt || b.pinnedAt) {
    if (!a.pinnedAt) return 1;
    if (!b.pinnedAt) return -1;
    if (a.pinnedAt !== b.pinnedAt) return a.pinnedAt < b.pinnedAt ? -1 : 1;
  }
  const tier = urgencyTier(a, now) - urgencyTier(b, now);
  if (tier !== 0) return tier;
  const priority = effectiveRank(a, now, options.avgTaskMs) - effectiveRank(b, now, options.avgTaskMs);
  if (priority !== 0) return priority;
  const carried = Number(Boolean(b.carried)) - Number(Boolean(a.carried));
  if (carried !== 0) return carried;
  const dueA = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
  const dueB = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
  if (dueA !== dueB) return dueA < dueB ? -1 : 1;
  if (options.tieBreak === "approved") {
    const approved = (a.approvedAt ?? "").localeCompare(b.approvedAt ?? "");
    if (approved !== 0) return approved;
    return (a.position ?? 0) - (b.position ?? 0);
  }
  return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
}

/** Copia a lista na ordem de urgência (estável: empate total mantém a ordem recebida). */
export function workRank<T extends RankInput>(items: readonly T[], now: number, options: RankOptions = {}): T[] {
  return [...items].sort((a, b) => compareWork(a, b, now, options));
}

/** Prioridade que vale para uma tarefa: a dela, ou a do projeto quando a dela é a padrão. */
export function effectivePriority(project: Pick<Project, "priority">, task: Pick<ProjectTask, "priority">): ProjectPriority {
  return task.priority !== "normal" ? task.priority : project.priority;
}

/** Entrada da ordem de urgência de uma tarefa de projeto (prazo e começo herdam do projeto). */
export function taskRankInput(project: Pick<Project, "priority" | "dueAt" | "approvedAt" | "createdAt" | "pinnedAt">, task: Pick<ProjectTask, "priority" | "dueAt" | "carriedFrom" | "pinnedAt">, position: number): RankInput {
  const dueAt = task.dueAt ?? project.dueAt;
  const pinnedAt = task.pinnedAt ?? project.pinnedAt;
  return { priority: effectivePriority(project, task), ...(task.carriedFrom ? { carried: true } : {}), ...(dueAt ? { dueAt } : {}), ...(pinnedAt ? { pinnedAt } : {}), approvedAt: project.approvedAt ?? project.createdAt, position };
}

/** Projeto aberto com prazo atrasado ou em menos de 24 h (o "prazo em risco" da Gestão e da tela Trabalho). */
export function isDeadlineAtRisk(project: Pick<Project, "dueAt" | "status">, now: number): boolean {
  return project.dueAt !== undefined && isProjectOpen(project) && urgencyTier(project, now) < 2;
}

// ---------- Horário de trabalho (America/Sao_Paulo) ----------

/** Fuso em que "hoje", a janela de horário e a virada do dia valem (o do dono; o servidor pode estar em UTC). */
export const WORK_TIME_ZONE = "America/Sao_Paulo";

const clockFormat = new Intl.DateTimeFormat("en-CA", { timeZone: WORK_TIME_ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Dia local ("AAAA-MM-DD", a chave de `worked`), minutos desde a meia-noite e segundos do minuto, no fuso do trabalho. */
export function workClock(ms: number): { day: string; minutes: number; seconds: number } {
  const parts: Record<string, string> = {};
  for (const part of clockFormat.formatToParts(new Date(ms))) parts[part.type] = part.value;
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute), seconds: Number(parts.second) };
}

/** Instante (ms) da próxima meia-noite local (a virada do dia que zera o limite de horas). */
export function nextWorkDayStart(ms: number): number {
  const { minutes, seconds } = workClock(ms);
  return ms + (24 * 60 - minutes) * 60_000 - seconds * 1000 - (ms % 1000);
}

/** Início (ms) do dia local de `ms`. */
export function workDayStart(ms: number): number {
  const { minutes, seconds } = workClock(ms);
  return ms - minutes * 60_000 - seconds * 1000 - (((ms % 1000) + 1000) % 1000);
}

/** "HH:MM" -> minutos desde a meia-noite (undefined se inválido). */
export function parseClock(text: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

/** "9h" / "9h30" (como a tela e as notas falam o horário). */
export function clockLabel(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hour}h` : `${hour}h${String(rest).padStart(2, "0")}`;
}

/**
 * Estado da janela de horário no instante `ms`: aberta (`open`) ou fechada, com o instante da
 * próxima abertura. `from` > `to` é uma janela que atravessa a meia-noite (ex.: 22:00-06:00).
 * Janela inválida ou sem duração = sempre aberta.
 */
export function windowState(window: { from: string; to: string } | undefined, ms: number): { open: true } | { open: false; opensAt: number; opensAtMinutes: number } {
  const from = window ? parseClock(window.from) : undefined;
  const to = window ? parseClock(window.to) : undefined;
  if (from === undefined || to === undefined || from === to) return { open: true };
  const { minutes, seconds } = workClock(ms);
  const open = from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
  if (open) return { open: true };
  const wait = (from - minutes + 24 * 60) % (24 * 60);
  return { open: false, opensAt: ms - seconds * 1000 - (((ms % 1000) + 1000) % 1000) + wait * 60_000, opensAtMinutes: from };
}

/** Horas por dia de `pace` em milissegundos (undefined = sem limite). */
export function dailyLimitMs(pace: Pace | undefined): number | undefined {
  const hours = pace?.hoursPerDay;
  return hours !== undefined && hours > 0 ? hours * HOUR_MS : undefined;
}

/** Poda `worked` mantendo só os últimos `WORKED_RETENTION_DAYS` dias (devolve true se removeu algo). */
export function pruneWorked(worked: Record<string, number>, ms: number): boolean {
  const cutoff = workClock(ms - WORKED_RETENTION_DAYS * DAY_MS).day;
  let removed = false;
  for (const day of Object.keys(worked)) {
    if (day < cutoff) {
      delete worked[day];
      removed = true;
    }
  }
  return removed;
}

// ---------- Kanban ----------

export const KANBAN_COLUMNS = [
  { id: "backlog", label: "Backlog" },
  { id: "a_fazer", label: "A fazer" },
  { id: "em_andamento", label: "Em andamento" },
  { id: "esperando_voce", label: "Esperando você" },
  { id: "concluido", label: "Concluído" },
] as const;
export type KanbanColumnId = (typeof KANBAN_COLUMNS)[number]["id"];

/** Coluna do quadro de uma tarefa (falhou fica em andamento, marcada: o Maestro decide). */
export function kanbanColumn(task: Pick<ProjectTask, "status">): KanbanColumnId {
  switch (task.status) {
    case "backlog":
      return "backlog";
    case "a_fazer":
      return "a_fazer";
    case "em_andamento":
    case "falhou":
      return "em_andamento";
    case "esperando_voce":
      return "esperando_voce";
    case "concluida":
    case "cancelada":
      return "concluido";
  }
}

/**
 * Tarefas concluídas de verdade e o total (sem as canceladas nem as puladas: `skipped` conta à
 * parte, para o resumo não dizer "3 de 3 concluídas" quando uma foi pulada).
 */
export function projectProgress(plan: Pick<Project, "tasks">): { done: number; total: number; skipped: number } {
  // Só as folhas contam (pai e módulo têm estado calculado); sem árvore, são todas as tarefas.
  const leaves = leafTasks(plan.tasks).filter((task) => !task.archived);
  const skipped = leaves.filter((task) => task.status === "concluida" && task.skipped).length;
  const counted = leaves.filter((task) => task.status !== "cancelada" && !(task.status === "concluida" && task.skipped));
  return { done: counted.filter((task) => task.status === "concluida").length, total: counted.length, skipped };
}

/**
 * "2 de 3 concluídas" (+ ", 1 pulada"): o texto do progresso, sem contar as puladas como feitas. Com `unit` (veja `projectUnitProgress`) diz a
 * unidade do projeto: "3 de 8 módulos concluídos" / "12 de 40 tarefas concluídas".
 */
export function progressLabel(progress: { done: number; total: number; skipped?: number; unit?: "modulos" | "tarefas" }): string {
  const skipped = progress.skipped ?? 0;
  const tail = skipped > 0 ? `, ${skipped} ${skipped === 1 ? "pulada" : "puladas"}` : "";
  if (progress.unit === "modulos") return `${progress.done} de ${progress.total} ${progress.total === 1 ? "módulo concluído" : "módulos concluídos"}${tail}`;
  if (progress.unit === "tarefas") return `${progress.done} de ${progress.total} ${progress.total === 1 ? "tarefa concluída" : "tarefas concluídas"}${tail}`;
  return `${progress.done} de ${progress.total} concluídas${tail}`;
}

/** O plano ainda pode ter trabalho (não terminou nem foi cancelado)? */
export function isProjectOpen(plan: Pick<Project, "status">): boolean {
  return plan.status !== "concluido" && plan.status !== "cancelado";
}

export function isProjectTaskFinished(task: Pick<ProjectTask, "status">): boolean {
  return task.status === "concluida" || task.status === "cancelada";
}

/** A subtarefa executa uma etapa de plano? */
export function isProjectStepTask(task: Pick<Task, "work">): boolean {
  return task.work !== undefined;
}

/** Quem é o próximo da tarefa (a etapa atual ainda não feita), se houver. */
export function nextStep(task: Pick<ProjectTask, "steps" | "current" | "status">): ProjectStep | undefined {
  if (isProjectTaskFinished(task)) return undefined;
  return task.steps[task.current];
}

// ---------- Validação (create_plan / add_plan_tasks) ----------

/** Tarefa como o Maestro manda (os campos da ferramenta MCP, em inglês). */
export type ProjectTaskInput = {
  ref?: string;
  title: string;
  briefing: string;
  /** Id ou nome do agente. Obrigatório nas folhas; entregável e tarefa-mãe não têm. */
  owner?: string;
  /** Sem etapas: uma etapa só, do dono, fazendo o briefing. */
  steps?: { agent: string; does: string }[];
  depends_on?: string[];
  priority?: ProjectInputPriority;
  approval_type?: string;
  /** "Pronto quando…": critérios que o agente confere antes de entregar. */
  done_when?: string[];
  /** ISO 8601 (a tarefa só começa depois disto / deve terminar até isto). */
  start_at?: string;
  due_at?: string;
  /** `ref` do pai (outro item da mesma chamada ou uma tarefa que já existe); ausente = direto no projeto. */
  parent?: string;
  /** "module" (ou o apelido antigo "group") = módulo (em qualquer profundidade, sem dono nem etapas, nunca executa; pode conter outros módulos); padrão "task". */
  kind?: "task" | "module" | "group";
  /** Liberação do item (opcional): "now" = entra na fila, "later" = Planejada. Num módulo, vale para os filhos que não definirem o próprio. */
  release?: ProjectInputRelease;
  /** Sprint da folha: o `ref`, o id ("S1") ou o nome de uma sprint (da mesma chamada ou já existente). */
  sprint?: string;
  /** Nomes de etiquetas (criadas no projeto se faltarem). */
  labels?: string[];
};

/** Ritmo como o Maestro manda (contrato em inglês). */
export type ProjectPaceInput = { hours_per_day?: number; window?: { from: string; to: string }; max_parallel?: number };

/** Ritmo do contrato MCP -> o gravado no projeto. */
export function paceFromInput(input: ProjectPaceInput | undefined): Pace | undefined {
  if (!input) return undefined;
  const pace: Pace = {
    ...(input.hours_per_day !== undefined ? { hoursPerDay: input.hours_per_day } : {}),
    ...(input.window ? { window: { from: input.window.from, to: input.window.to } } : {}),
    ...(input.max_parallel !== undefined ? { maxParallel: input.max_parallel } : {}),
  };
  return Object.keys(pace).length > 0 ? pace : undefined;
}

/** Data/hora do contrato MCP -> ISO (ou undefined se não for uma data válida). */
export function isoFromInput(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const at = Date.parse(value.trim());
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

const plain = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/** Acha o agente pelo id ou pelo nome (sem acento/caixa). */
export function findAgentByRef<A extends Pick<Agent, "id" | "name">>(agents: readonly A[], ref: string): A | undefined {
  const wanted = plain(ref);
  return agents.find((agent) => agent.id === ref) ?? agents.find((agent) => plain(agent.id) === wanted || plain(agent.name) === wanted);
}

const REF_PATTERN = /^[A-Za-z0-9_-]{1,12}$/;

/**
 * Primeiro ciclo achado nas dependências (lista de refs, fechando no primeiro) ou null. `deps`: ref
 * -> refs de que depende (refs desconhecidos são ignorados aqui).
 */
export function findDependencyCycle(deps: ReadonlyMap<string, readonly string[]>): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (ref: string): string[] | null => {
    const mark = state.get(ref);
    if (mark === "done") return null;
    if (mark === "visiting") return [...stack.slice(stack.indexOf(ref)), ref];
    state.set(ref, "visiting");
    stack.push(ref);
    for (const dep of deps.get(ref) ?? []) {
      if (!deps.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(ref, "done");
    return null;
  };
  for (const ref of deps.keys()) {
    const cycle = visit(ref);
    if (cycle) return cycle;
  }
  return null;
}

export type ProjectAgentPool = {
  /** Agentes que podem receber etapas (sem o Maestro). */
  agents: readonly Pick<Agent, "id" | "name">[];
  /** Ids que nunca podem (o Maestro). */
  forbidden?: ReadonlySet<string>;
};

/**
 * Valida as tarefas e devolve as ProjectTask prontas (status backlog/a_fazer conforme as dependências
 * já resolvidas), ou a lista de erros (em inglês, para o modelo corrigir). `existing`: tarefas que já
 * estão no plano (add_plan_tasks): os refs novos não podem repetir os delas e `depends_on` pode
 * citá-las. Rejeita: agente desconhecido (ou o Maestro), ref repetido/inválido, dependência
 * desconhecida e ciclos.
 */
export function buildProjectTasks(
  input: readonly ProjectTaskInput[],
  pool: ProjectAgentPool,
  at: string,
  existing: readonly ProjectTask[] = [],
): { ok: true; tasks: ProjectTask[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (input.length === 0) errors.push("The plan needs at least one task");
  if (input.length > PROJECT_SAFETY.perCall) errors.push(`At most ${PROJECT_SAFETY.perCall} items per call (safety net): send the rest in another call`);
  if (input.length + existing.length > PROJECT_SAFETY.nodes) errors.push(`The project would have ${input.length + existing.length} items (safety net: at most ${PROJECT_SAFETY.nodes} items per project)`);
  const taken = new Set(existing.map((task) => task.ref));
  let auto = existing.length;
  const nextAuto = () => {
    let ref: string;
    do ref = `T${++auto}`;
    while (taken.has(ref) || input.some((item) => item.ref?.trim() === ref));
    return ref;
  };
  const resolve = (ref: string, where: string): string | undefined => {
    // "workspace/agente": hoje só vale o agente (agentes de outros workspaces vêm na fatia 6).
    const address = parseAddress(ref);
    const agent = findAgentByRef(pool.agents, ref) ?? (address ? findAgentByRef(pool.agents, address.agentId) : undefined);
    if (!agent || pool.forbidden?.has(agent.id)) {
      errors.push(`${where}: agent "${ref}" does not exist (or cannot receive tasks). Agents: ${pool.agents.map((candidate) => `${candidate.name} (${candidate.id})`).join(", ") || "none"}`);
      return undefined;
    }
    return agent.id;
  };
  const parentRefs = new Set([...input.map((item) => item.parent?.trim()), ...existing.map((task) => task.parent)].filter((ref): ref is string => !!ref));
  const tasks: ProjectTask[] = [];
  for (const [index, item] of input.entries()) {
    const label = `Task ${item.ref?.trim() || index + 1}${item.title ? ` (“${item.title}”)` : ""}`;
    let ref = item.ref?.trim();
    if (ref && !REF_PATTERN.test(ref)) {
      errors.push(`${label}: invalid ref "${ref}" (use letters, digits, - or _, up to 12)`);
      ref = undefined;
    }
    if (ref && taken.has(ref)) errors.push(`${label}: ref "${ref}" already exists in the plan`);
    ref ??= nextAuto();
    taken.add(ref);
    const title = item.title.trim().replace(/\s+/g, " ");
    const briefing = item.briefing.trim();
    if (!title) errors.push(`${label}: missing title`);
    if (!briefing) errors.push(`${label}: missing briefing`);
    const group = item.kind === "module" || item.kind === "group";
    const mother = !group && parentRefs.has(ref);
    let ownerId: string | undefined;
    const steps: ProjectStep[] = [];
    if (group) {
      if (item.owner || item.steps?.length) errors.push(`${label}: a module (kind "module") has no owner or steps; it never runs. Put the owners on the tasks inside it`);
    } else if (mother) {
      // Tarefa-mãe (tem filhas na mesma chamada): quem executa são as filhas; o dono e as etapas dela não valem.
    } else if (!item.owner?.trim()) {
      errors.push(`${label}: a leaf task needs an owner (the agent responsible; see get_team). Parent tasks and modules have none, the tasks inside them do`);
    } else {
      ownerId = resolve(item.owner, `${label}, owner`);
      const rawSteps = item.steps && item.steps.length > 0 ? item.steps : [{ agent: item.owner, does: briefing }];
      if (rawSteps.length > PROJECT_LIMITS.steps) errors.push(`${label}: at most ${PROJECT_LIMITS.steps} steps`);
      for (const [stepIndex, step] of rawSteps.entries()) {
        const agentId = resolve(step.agent, `${label}, step ${stepIndex + 1}`);
        const what = step.does.trim();
        if (!what) errors.push(`${label}, step ${stepIndex + 1}: say what the agent does`);
        if (agentId) steps.push({ agentId, what, status: "pendente" });
      }
    }
    const startAt = isoFromInput(item.start_at);
    const dueAt = isoFromInput(item.due_at);
    if (item.start_at && !startAt) errors.push(`${label}: start_at "${item.start_at}" is not a valid date (use ISO 8601)`);
    if (item.due_at && !dueAt) errors.push(`${label}: due_at "${item.due_at}" is not a valid date (use ISO 8601)`);
    if (startAt && dueAt && startAt > dueAt) errors.push(`${label}: start_at is after due_at`);
    const doneWhen = (item.done_when ?? []).map((text) => text.trim()).filter(Boolean);
    tasks.push({
      ref,
      title,
      briefing,
      ownerId: ownerId ?? "",
      steps,
      current: 0,
      dependsOn: [...new Set((item.depends_on ?? []).map((dep) => dep.trim()).filter(Boolean))],
      priority: PRIORITY_FROM_INPUT[item.priority ?? "normal"],
      ...projectTaskDefaults(),
      doneWhen: doneWhen.map((text, index) => ({ id: `d${index + 1}`, text })),
      ...(startAt ? { startAt } : {}),
      ...(dueAt ? { dueAt } : {}),
      status: "backlog",
      ...(item.approval_type ? { approvalType: item.approval_type } : {}),
      ...(item.parent?.trim() ? { parent: item.parent.trim() } : {}),
      ...(group ? { group: true as const } : {}),
      ...(item.sprint?.trim() && !group ? { sprintId: item.sprint.trim() } : {}),
      updatedAt: at,
    });
  }
  const known = new Map<string, ProjectTask>([...existing, ...tasks].map((task) => [task.ref, task]));
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!known.has(dep)) errors.push(`Task ${task.ref}: depends on "${dep}", which is not in the plan (refs: ${[...known.keys()].join(", ")})`);
      if (dep === task.ref) errors.push(`Task ${task.ref}: cannot depend on itself`);
    }
  }
  const cycle = findDependencyCycle(new Map([...known.values()].map((task) => [task.ref, task.dependsOn])));
  if (cycle) errors.push(`The dependencies form a cycle: ${cycle.join(" → ")}. Remove one of them.`);
  else {
    // Ciclo pelo grafo efetivo: a dependência de um módulo ou de uma mãe vale para as folhas de entrada dela.
    const effective = dependencyCycle({ tasks: [...known.values()] });
    if (effective) errors.push(`The dependencies form a cycle: ${effective.join(" → ")}. Remove one of them.`);
  }
  if (errors.length > 0) return { ok: false, errors };
  const parentsNow = new Set([...parentRefs]);
  const all = { tasks: [...known.values()] };
  const done = completedRefs(all);
  for (const task of tasks) {
    if (task.group || parentsNow.has(task.ref)) continue;
    // Dependência da mãe ou do módulo vale para as folhas de entrada dela; módulo/mãe conta como pronto quando todas as folhas terminaram.
    const ready = effectiveDeps(all, task).every((dep) => done.has(dep));
    task.status = ready ? "a_fazer" : "backlog";
  }
  return { ok: true, tasks };
}

/** Plano em markdown (o texto do item do "Para você" e o `get_plan` do Maestro). */
export function projectMarkdown(plan: Pick<Project, "title" | "summary" | "tasks">, agentName: (id: string) => string): string {
  const lines = [`**${plan.title}**`, ...(plan.summary ? ["", plan.summary] : []), ""];
  for (const task of plan.tasks) {
    const chain = task.steps.map((step) => agentName(step.agentId)).join(" → ");
    const deps = task.dependsOn.length > 0 ? ` (depois de ${task.dependsOn.join(", ")})` : "";
    const priority = task.priority !== "normal" ? ` · prioridade ${PROJECT_PRIORITY_LABELS[task.priority].toLowerCase()}` : "";
    lines.push(`- **${task.ref} · ${task.title}** — dono: ${agentName(task.ownerId)}; etapas: ${chain}${deps}${priority}`);
  }
  return lines.join("\n");
}

/** O projeto veio de um plano (esteve em aprovação ou foi aprovado), e não de uma tarefa avulsa? */
export function isPlanProject(project: Pick<Project, "approvedAt" | "forYouId" | "status">): boolean {
  return project.approvedAt !== undefined || project.forYouId !== undefined || project.status === "proposto" || project.status === "ajustando";
}

// ---------- Modo Automático (fatia 7) ----------

/** "Teto de 8 por dia atingido", "3 de 8 hoje": o uso do dia (sem teto = só a contagem). */
export function autoUsageLabel(used: number, cap: number | undefined): string {
  return cap === undefined ? `${used} hoje` : `${used} de ${cap} hoje`;
}

/** Quanto o Automático já usou hoje (zera na virada do dia de São Paulo). */
export function autoUsedToday(project: Pick<Project, "autoUsage">, now: number): number {
  return project.autoUsage && project.autoUsage.day === workClock(now).day ? project.autoUsage.count : 0;
}

/**
 * A conta do Automático, sem estado: o tipo da ação está no `grant`, o site (clique) está liberado e o
 * uso do dia (`used`) ainda cabe no teto. Liberando, `label` já conta esta ação ("3 de 8 hoje").
 * Quem guarda o contador (o projeto, ou a rotina) chama isto e depois grava `used + 1`.
 */
export function autoVerdict(grant: AutoGrant, used: number, input: { type?: string; host?: string }): { ok: true; label: string } | { ok: false; note?: string } {
  if (input.type !== undefined && !grant.actions.includes(input.type)) return { ok: false, note: `O tipo “${input.type}” não está liberado no Automático` };
  if (input.host !== undefined && !autoSiteAllowed(grant, input.host)) return { ok: false, note: `O site ${input.host} não está liberado no Automático` };
  if (grant.dailyCap !== undefined && used >= grant.dailyCap) return { ok: false, note: `Teto de ${grant.dailyCap} por dia atingido` };
  return { ok: true, label: autoUsageLabel(used + 1, grant.dailyCap) };
}

/** O host do clique cabe nos sites liberados (sem lista = qualquer site)? */
export function autoSiteAllowed(grant: Pick<AutoGrant, "sites">, host: string): boolean {
  if (!grant.sites || grant.sites.length === 0) return true;
  const clean = host.trim().toLowerCase().replace(/^www\./, "");
  return grant.sites.some((site) => {
    const wanted = site.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    return wanted !== "" && (clean === wanted || clean.endsWith(`.${wanted}`));
  });
}
