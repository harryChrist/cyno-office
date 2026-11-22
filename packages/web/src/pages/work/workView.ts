import {
  leafTasks,
  AVULSAS_ID,
  compareWork,
  handoffLabel,
  hasSprints,
  isProjectOpen,
  parseAddress,
  PRIORITY_RANK,
  projectUnitProgress,
  type UnitProgress,
  type BlockedType,
  type ForYouItem,
  type Project,
  type ProjectPriority,
  type ProjectTask,
  type ProjectTaskStatus,
  type RankInput,
  type Task,
  urgencyTier,
  workRank,
} from "@cyno/shared";
import { brasiliaDay, brasiliaShortDate } from "./workTime";

/**
 * Lógica pura da tela Trabalho: urgência (`workRank`), "Esperando você" (um só cálculo), bloqueio, prazo,
 * ritmo do dia, filtros, quadro e linha do tempo. Nada daqui toca em React nem no relógio (o `now` vem de fora).
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---------- Tarefas avulsas sem projeto ----------

const LOOSE_STATUS: Record<string, ProjectTaskStatus> = {
  queued: "a_fazer",
  in_progress: "em_andamento",
  waiting_approval: "esperando_voce",
  done: "concluida",
  failed: "falhou",
};

/** Falha de verdade, ou cancelada por alguém (usuário, Maestro)? Cancelar não é falhar. */
const looseStatus = (task: Pick<Task, "status" | "outcome">): ProjectTaskStatus => (task.status === "failed" && task.outcome === "cancelled" ? "cancelada" : (LOOSE_STATUS[task.status] ?? "em_andamento"));

/**
 * Pedidos do Maestro abertos e trabalhando (não esperando resposta na conversa) que ainda não viraram
 * Projeto: o Maestro está montando. A tela mostra "Maestro montando o projeto…" em vez de "Nenhum projeto".
 */
export function assemblingRequests(tasks: readonly Task[], projects: readonly Pick<Project, "id">[]): Task[] {
  const known = new Set(projects.map((project) => project.id));
  return tasks.filter((task) => task.role === "request" && (task.status === "queued" || task.status === "in_progress") && !known.has(task.id));
}

const firstLine = (text: string, max = 120): string => {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "")?.replace(/\s+/g, " ").trim() ?? "Tarefa";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/**
 * Tarefas que o servidor ainda não espelhou num Projeto (ex.: as criadas pela caixa do Office) viram
 * "tarefa avulsa" só na tela: um Projeto de mentira com 1 tarefa e 1 etapa, para a lista e o quadro
 * mostrarem tudo do mesmo jeito. Ficam de fora o registro do pedido do Maestro, as etapas de projeto
 * (têm `work`) e as tarefas cujo pedido já tem Projeto.
 */
export function looseTaskProjects(tasks: readonly Task[], projects: readonly Project[]): Project[] {
  const known = new Set(projects.map((project) => project.id));
  const linked = new Set(projects.flatMap((project) => project.tasks.flatMap((task) => task.steps.map((step) => step.taskId).filter((id): id is string => id !== undefined))));
  const out: Project[] = [];
  for (const task of tasks) {
    if (task.role === "request" || task.work !== undefined || known.has(task.id) || linked.has(task.id)) continue;
    if (task.projectId !== undefined && known.has(task.projectId)) continue;
    const status = looseStatus(task);
    const agentId = task.agentId ?? "";
    const title = firstLine(task.prompt);
    out.push({
      id: task.id,
      kind: "tarefa",
      title,
      origin: "usuario",
      status: status === "concluida" ? "concluido" : status === "cancelada" ? "cancelado" : "ativo",
      version: 1,
      priority: "normal",
      mode: { kind: "pede-ok" },
      worked: {},
      tasks: [
        {
          ref: "T1",
          title,
          briefing: task.prompt,
          ownerId: agentId,
          steps: [{ agentId, what: title, status: status === "concluida" ? "feita" : status === "em_andamento" || status === "esperando_voce" ? "em_andamento" : status === "falhou" || status === "cancelada" ? "falhou" : "pendente", taskId: task.id }],
          current: 0,
          dependsOn: [],
          priority: "normal",
          doneWhen: [],
          rework: { count: 0 },
          status,
          ...(task.status === "done" && task.result ? { result: task.result } : {}),
          ...(status === "falhou" ? { failure: task.result ?? "sem motivo informado" } : {}),
          updatedAt: task.updatedAt,
        },
      ],
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      ...(status === "concluida" ? { finishedAt: task.updatedAt } : {}),
    });
  }
  return out;
}

// ---------- Urgência ----------

// A regra mora no `shared` (o agendador do servidor usa a mesma); aqui só reexporta.
export { compareWork, PRIORITY_RANK, urgencyTier, workRank, type RankInput };

// ---------- Esperando você (um só cálculo) ----------

/** O item de aprovação pede um OK de texto? (os outros tipos são plano, pergunta e rotina). */
export const isApproval = (item: Pick<ForYouItem, "kind">): boolean => (item.kind ?? "aprovacao") === "aprovacao";

/** Projeto a que o item pertence: pelo `projectId` ou, nos antigos, pela tarefa que o pediu. */
export function projectOfItem(item: Pick<ForYouItem, "projectId" | "taskId" | "taskRef">, projects: readonly Project[]): Project | undefined {
  if (item.projectId) {
    const byId = projects.find((project) => project.id === item.projectId);
    if (byId) return byId;
    // Pedido simples: o item aponta para a folha do projeto fixo "Avulsas" (projeto + ref); na tela o pedido é um projeto de uma tarefa.
    if (item.projectId === AVULSAS_ID && item.taskRef) {
      const byRef = projects.find((project) => project.kind === "tarefa" && project.tasks.some((task) => task.ref === item.taskRef));
      if (byRef) return byRef;
    }
  }
  if (item.taskId) return projects.find((project) => project.tasks.some((task) => task.steps.some((step) => step.taskId === item.taskId)));
  return undefined;
}

export type Awaiting = {
  /** Quantas coisas esperam você agora (itens pendentes do Para você, planos sem item e tarefas paradas em você sem item). */
  count: number;
  /** Quanto disso é de cada projeto (id do projeto). */
  byProject: ReadonlyMap<string, number>;
  /** Itens pendentes por projeto. */
  items: ReadonlyMap<string, ForYouItem[]>;
};

/**
 * "Esperando você": a única conta usada pelo menu, pela página e pelo painel. Cada coisa conta uma vez:
 * os itens pendentes do Para você (os de projeto e os soltos), o plano esperando OK que ainda não tem
 * item e a tarefa parada em você que não tem item (o item é que a segura, e ele já foi contado).
 */
export function awaitingUser(projects: readonly Project[], forYou: readonly ForYouItem[] | null | undefined): Awaiting {
  const items = new Map<string, ForYouItem[]>();
  let loose = 0;
  for (const item of forYou ?? []) {
    if (item.status !== "pendente") continue;
    const project = projectOfItem(item, projects);
    if (!project) {
      loose += 1;
      continue;
    }
    items.set(project.id, [...(items.get(project.id) ?? []), item]);
  }
  const byProject = new Map<string, number>();
  let count = loose;
  for (const project of projects) {
    const mine = items.get(project.id) ?? [];
    let n = mine.length;
    // Projeto fechado: um item que ficou pendente ainda espera você (só ele conta).
    if (!isProjectOpen(project)) {
      if (n > 0) byProject.set(project.id, n);
      count += n;
      continue;
    }
    if (project.status === "proposto" && !mine.some((item) => item.kind === "plano")) n += 1;
    if (project.status === "ativo" || project.status === "pausado") {
      for (const task of project.tasks) {
        if (task.status !== "esperando_voce") continue;
        const held = mine.some((item) => item.taskRef === task.ref || (item.taskId !== undefined && task.steps.some((step) => step.taskId === item.taskId)));
        if (!held) n += 1;
      }
    }
    if (n > 0) byProject.set(project.id, n);
    count += n;
  }
  return { count, byProject, items };
}

// ---------- Bloqueio, estado, prazo, ritmo ----------

export const BLOCK_LABELS: Record<BlockedType, string> = {
  voce: "Esperando você",
  agente: "Esperando outro agente",
  cota: "Sem cota",
  acesso: "Sem acesso",
};

export type BlockInfo = { type: BlockedType; label: string; since?: string; note?: string };

/** Bloqueio de uma tarefa: o gravado pelo servidor, ou "Esperando você" quando ela pede um OK. */
export function taskBlock(task: ProjectTask): BlockInfo | undefined {
  if (task.blocked) return { type: task.blocked.type, label: BLOCK_LABELS[task.blocked.type], since: task.blocked.since, note: task.blocked.note };
  if (task.status === "esperando_voce") return { type: "voce", label: BLOCK_LABELS.voce, ...(task.waitingSince ? { since: task.waitingSince } : {}) };
  return undefined;
}

/**
 * O bloqueio que a linha mostra: primeiro o das tarefas (cota, acesso, outro agente: o mais antigo),
 * depois "Esperando você" (desde o item pendente mais antigo, se houver).
 */
export function projectBlock(project: Project, awaiting: number, items: readonly ForYouItem[]): BlockInfo | undefined {
  if (!isProjectOpen(project) || project.status === "proposto") return undefined;
  const blocked = project.tasks
    .filter((task) => task.blocked && task.blocked.type !== "voce" && task.status !== "concluida" && task.status !== "cancelada")
    .map((task) => taskBlock(task)!)
    .sort((a, b) => (a.since ?? "").localeCompare(b.since ?? ""));
  if (blocked[0]) return blocked[0];
  if (awaiting <= 0) return undefined;
  const since = [...items.map((item) => item.createdAt), ...project.tasks.filter((task) => task.status === "esperando_voce" && task.waitingSince).map((task) => task.waitingSince!)].sort()[0];
  return { type: "voce", label: BLOCK_LABELS.voce, ...(since ? { since } : {}) };
}

export type Tone = "busy" | "attention" | "success" | "neutral" | "danger";
export type StateInfo = { label: string; tone: Tone };

const TASK_STATE: Record<ProjectTaskStatus, StateInfo> = {
  backlog: { label: "A fazer", tone: "neutral" },
  a_fazer: { label: "A fazer", tone: "neutral" },
  em_andamento: { label: "Fazendo", tone: "busy" },
  esperando_voce: { label: "Esperando você", tone: "attention" },
  concluida: { label: "Feita", tone: "success" },
  falhou: { label: "Falhou", tone: "danger" },
  cancelada: { label: "Cancelada", tone: "neutral" },
};

/** Estado de uma tarefa pelo glossário (A fazer, Fazendo, Esperando você, Feita). */
export const taskState = (task: Pick<ProjectTask, "status"> & { skipped?: boolean }): StateInfo => (task.status === "concluida" && task.skipped ? { label: "Pulada", tone: "neutral" } : TASK_STATE[task.status]);

/** Estado da linha: do Projeto (Em andamento, Concluído…) ou, na tarefa avulsa, o da própria tarefa. */
export function projectState(project: Project): StateInfo {
  if (project.kind === "tarefa" && project.tasks[0] && (project.status === "ativo" || project.status === "concluido")) return taskState(project.tasks[0]);
  switch (project.status) {
    case "proposto":
      return { label: "Plano esperando OK", tone: "attention" };
    case "ajustando":
      return { label: "Maestro ajustando", tone: "busy" };
    case "ativo":
      return { label: "Em andamento", tone: "busy" };
    case "pausado":
      return { label: "Pausado", tone: "attention" };
    case "concluido":
      return { label: "Concluído", tone: "success" };
    case "cancelado":
      return { label: "Cancelado", tone: "neutral" };
  }
}

/** "15 min", "2 h", "3 d": quanto tempo é `ms` (arredondado para baixo, no mínimo 1 min). */
export function spanLabel(ms: number): string {
  const minutes = Math.max(1, Math.floor(Math.max(0, ms) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

export type Deadline = { label: string; state: "late" | "soon" | "ok"; risk: boolean; at: string };

const pad = (n: number) => String(n).padStart(2, "0");
/** "13/11" e, se o prazo tem hora marcada, " 18:00" (horário de Brasília, seja qual for o fuso do navegador). */
export function shortDate(iso: string): string {
  return brasiliaShortDate(iso);
}

/** Prazo de um projeto aberto: atrasado e em menos de 24 h estão em risco (vermelho). Fechado = sem prazo na tela. */
export function deadlineOf(project: Pick<Project, "dueAt" | "status">, now: number): Deadline | null {
  if (!project.dueAt || !isProjectOpen(project)) return null;
  const due = Date.parse(project.dueAt);
  if (Number.isNaN(due)) return null;
  if (due < now) return { label: `atrasado ${spanLabel(now - due)}`, state: "late", risk: true, at: project.dueAt };
  if (due - now < DAY) return { label: `em ${spanLabel(due - now)}`, state: "soon", risk: true, at: project.dueAt };
  return { label: shortDate(project.dueAt), state: "ok", risk: false, at: project.dueAt };
}

/** Dia "AAAA-MM-DD" em São Paulo (a chave de `worked`, a mesma do servidor). */
export function dayKey(date: Date): string {
  return brasiliaDay(date);
}

/** "0,5", "1", "2,3": horas com no máximo uma casa, em pt-BR. */
export function hoursLabel(hours: number): string {
  return (Math.round(hours * 10) / 10).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
}

export type PaceToday = { workedHours: number; targetHours: number; label: string };

/** Ritmo de hoje ("0,5/1 h hoje"): só quando o projeto tem horas por dia. */
export function paceToday(project: Pick<Project, "pace" | "worked">, now: Date): PaceToday | null {
  const target = project.pace?.hoursPerDay;
  if (target === undefined || target <= 0) return null;
  const workedHours = (project.worked[dayKey(now)] ?? 0) / HOUR;
  return { workedHours, targetHours: target, label: `${hoursLabel(workedHours)}/${hoursLabel(target)} h hoje` };
}

/** Todos os agentes que têm etapa no projeto (sem repetir, na ordem em que aparecem). */
export function projectAgents(project: Pick<Project, "tasks">): string[] {
  const seen = new Set<string>();
  for (const task of project.tasks) for (const step of task.steps) if (step.agentId) seen.add(step.agentId);
  for (const task of project.tasks) if (task.ownerId) seen.add(task.ownerId);
  return [...seen];
}

/** Dono atual: o agente da etapa que roda (ou espera) agora; sem nenhuma, o da próxima tarefa a fazer; por fim, o da última. */
export function currentOwner(project: Pick<Project, "tasks">): string | undefined {
  // Só as folhas executam: uma tarefa-mãe ou um módulo (sem passos) nunca é "quem está com a vez".
  const tasks = leafTasks(project.tasks);
  const live = tasks.find((task) => task.status === "em_andamento") ?? tasks.find((task) => task.status === "esperando_voce");
  const pick = live ?? tasks.find((task) => task.status === "a_fazer") ?? tasks.find((task) => task.status === "backlog") ?? tasks.at(-1);
  if (!pick) return undefined;
  return pick.steps[pick.current]?.agentId ?? pick.steps.at(-1)?.agentId ?? (pick.ownerId || undefined);
}

// ---------- Linhas da lista ----------

export type WorkRow = {
  project: Project;
  /** Progresso por unidade: módulos de primeiro nível ("3 de 8 módulos") ou, sem módulo, tarefas. */
  progress: UnitProgress;
  owner?: string;
  state: StateInfo;
  /** Quanto espera você neste projeto (item pendente, plano, tarefa). */
  awaiting: number;
  /** Itens pendentes do Para você deste projeto. */
  items: ForYouItem[];
  /** Quantos itens são aprovações (o botão "Aprovar (N)"). */
  approvals: number;
  block?: BlockInfo;
  deadline: Deadline | null;
  pace: PaceToday | null;
  /** Alguma tarefa falhou (o Maestro decide): conta como parado. */
  failed: boolean;
};

/** "3 de 8 módulos" / "1 de 1 módulo" / "12 de 40 tarefas": o progresso do projeto na unidade que ele usa (singular só com total 1). */
export function unitProgressText(progress: Pick<UnitProgress, "done" | "total" | "unit">): string {
  if (progress.total <= 0) return progress.unit === "modulos" ? "Sem módulos" : "Sem tarefas";
  const noun = progress.unit === "modulos" ? (progress.total === 1 ? "módulo" : "módulos") : progress.total === 1 ? "tarefa" : "tarefas";
  return `${progress.done} de ${progress.total} ${noun}`;
}

/** Monta as linhas (uma por Projeto ou tarefa avulsa) já na ordem de urgência: abertos primeiro, fechados do mais novo ao mais velho. */
export function buildRows(projects: readonly Project[], forYou: readonly ForYouItem[] | null | undefined, now: Date): WorkRow[] {
  const awaiting = awaitingUser(projects, forYou);
  const at = now.getTime();
  const rows = projects.map((project): WorkRow => {
    const items = awaiting.items.get(project.id) ?? [];
    const n = awaiting.byProject.get(project.id) ?? 0;
    const block = projectBlock(project, n, items);
    return {
      project,
      progress: projectUnitProgress({ tasks: project.tasks.filter((task) => !task.archived) }),
      owner: currentOwner(project),
      state: projectState(project),
      awaiting: n,
      items,
      approvals: items.filter(isApproval).length,
      ...(block ? { block } : {}),
      deadline: deadlineOf(project, at),
      pace: isProjectOpen(project) ? paceToday(project, now) : null,
      failed: isProjectOpen(project) && project.tasks.some((task) => task.status === "falhou"),
    };
  });
  const open = rows.filter((row) => isProjectOpen(row.project)).sort((a, b) => compareWork(a.project, b.project, at));
  const closed = rows.filter((row) => !isProjectOpen(row.project)).sort((a, b) => (b.project.finishedAt ?? b.project.updatedAt).localeCompare(a.project.finishedAt ?? a.project.updatedAt));
  return [...open, ...closed];
}

// ---------- Quadro ----------

export const WORK_COLUMNS = [
  { id: "todo", title: "A fazer" },
  { id: "doing", title: "Fazendo" },
  { id: "waiting", title: "Esperando você" },
  { id: "blocked", title: "Parada" },
  { id: "done", title: "Feita" },
] as const;
export type WorkColumnId = (typeof WORK_COLUMNS)[number]["id"];

/** Quantas tarefas feitas o quadro mostra (as mais recentes; a contagem do cabeçalho é a total). */
export const DONE_CARD_LIMIT = 30;

/** Coluna de uma tarefa: Parada junta pausa, bloqueio (cota, acesso, outro agente) e falha; o resto segue o estado. Null = fora do quadro. */
export function workColumn(task: ProjectTask, project: Pick<Project, "status">): WorkColumnId | null {
  if (task.status === "cancelada" || project.status === "cancelado" || project.status === "proposto" || project.status === "ajustando") return null;
  if (task.status === "concluida") return "done";
  if (task.status === "falhou") return "blocked";
  if (task.status === "esperando_voce") return "waiting";
  if (project.status === "pausado") return "blocked";
  if (task.blocked && task.blocked.type !== "voce") return "blocked";
  if (task.blocked?.type === "voce") return "waiting";
  return task.status === "em_andamento" ? "doing" : "todo";
}

export type WorkCard = { key: string; project: Project; task: ProjectTask; column: WorkColumnId; block?: BlockInfo; paused: boolean };
export type WorkBoardColumn = { id: WorkColumnId; title: string; cards: WorkCard[]; count: number };

/** Monta o quadro com as tarefas das linhas recebidas (já filtradas): cada tarefa na sua coluna, as mais urgentes primeiro; Feita: as mais recentes. */
export function buildWorkBoard(rows: readonly WorkRow[]): WorkBoardColumn[] {
  const buckets = new Map<WorkColumnId, WorkCard[]>(WORK_COLUMNS.map((column) => [column.id, []]));
  const order = new Map(rows.map((row, index) => [row.project.id, index]));
  for (const row of rows) {
    // Só as folhas viram cartão: a tarefa-mãe e o módulo são o resumo delas (contá-los seria contar em dobro).
    for (const task of leafTasks(row.project.tasks.filter((candidate) => !candidate.archived))) {
      const column = workColumn(task, row.project);
      if (!column) continue;
      const block = taskBlock(task);
      buckets.get(column)!.push({ key: `${row.project.id}:${task.ref}`, project: row.project, task, column, ...(block ? { block } : {}), paused: row.project.status === "pausado" });
    }
  }
  return WORK_COLUMNS.map((column) => {
    const list = buckets.get(column.id)!;
    const sorted =
      column.id === "done"
        ? list.sort((a, b) => (b.task.finishedAt ?? b.task.updatedAt).localeCompare(a.task.finishedAt ?? a.task.updatedAt))
        : list.sort((a, b) => (order.get(a.project.id) ?? 0) - (order.get(b.project.id) ?? 0) || a.task.ref.localeCompare(b.task.ref, "pt-BR", { numeric: true }));
    return { ...column, cards: column.id === "done" ? sorted.slice(0, DONE_CARD_LIMIT) : sorted, count: list.length };
  });
}

// ---------- Trilha ----------

export type StepMark = "feita" | "fazendo" | "proxima" | "esperando" | "falhou" | "cancelada" | "pulada";

export const STEP_MARK_GLYPH: Record<StepMark, string> = { feita: "✓", fazendo: "●", proxima: "○", esperando: "⏸", falhou: "✕", cancelada: "⊘", pulada: "↷" };
export const STEP_MARK_LABEL: Record<StepMark, string> = { feita: "feita", fazendo: "fazendo", proxima: "próxima", esperando: "esperando", falhou: "falhou", cancelada: "cancelada", pulada: "pulada" };

/** Marca da etapa na trilha: feita ✓, fazendo ●, próxima ○, esperando ⏸ (a etapa atual de uma tarefa que espera você ou está bloqueada). */
export function stepMark(task: Pick<ProjectTask, "steps" | "current" | "status" | "blocked"> & { skipped?: boolean }, index: number): StepMark {
  const step = task.steps[index];
  if (!step) return "proxima";
  if (step.status === "feita") return "feita";
  // A etapa de uma tarefa cancelada ou pulada pelo Maestro não "falhou": foi parada de propósito (neutra, nunca vermelha).
  if (step.status === "falhou") return task.status === "cancelada" ? "cancelada" : task.status === "concluida" && task.skipped ? "pulada" : "falhou";
  const active = task.status !== "concluida" && task.status !== "cancelada" && task.status !== "backlog" && task.status !== "falhou";
  if (index === task.current && active) {
    if (task.status === "esperando_voce" || task.blocked) return "esperando";
    if (step.status === "em_andamento" || task.status === "em_andamento") return "fazendo";
  }
  return "proxima";
}

// ---------- Aprovação do plano (selo e cartão) ----------

export type ApprovalBadge = { label: string; title?: string };

/**
 * Selo discreto quando o projeto começou sem pedir aprovação do dono (regra do workspace ou escolha do Maestro).
 * Quando foi aprovado pelo dono (`by === "dono"`) ou não há registro, devolve null (nenhum selo).
 */
export function projectApprovalBadge(approval: Project["approval"]): ApprovalBadge | null {
  if (!approval || approval.by === "dono") return null;
  const label = approval.by === "regra" ? "Começou sem aprovação (regra do workspace)" : "Começou sem aprovação (escolha do Maestro)";
  const quote = approval.quote?.trim();
  return quote ? { label, title: quote } : { label };
}

/** Título e texto do cartão de aprovação pedida pelo Maestro (aprovação é opcional conforme a regra do workspace). */
export function planCardCopy(project: Pick<Project, "version" | "sprints">): { title: string; text: string } {
  const title = `Aprovação pedida pelo Maestro${project.version > 1 ? ` · versão ${project.version}` : ""}`;
  const text = hasSprints(project)
    ? "O Maestro pediu a sua confirmação antes de começar. Você pode ajustar as tarefas, os responsáveis e as sprints antes de aprovar; a primeira sprint começa na data dela (ou agora, se a data já passou)."
    : "O Maestro pediu a sua confirmação antes de começar. Você pode ajustar as tarefas e os responsáveis antes de aprovar.";
  return { title, text };
}

// ---------- Linha do tempo ----------

export type TimelineEntry = { kind: "criado" | "aprovado" | "comeca" | "entrega" | "repasse" | "prazo" | "fim"; text: string; at: string; title?: string };

/** "Crivo passou para Eco" (de quem para quem) de uma tarefa criada por repasse; undefined se não nasceu de um. */
export function handoffText(task: Pick<ProjectTask, "origin" | "ownerId">, agentName: (id: string) => string): string | undefined {
  if (!task.origin) return undefined;
  const from = parseAddress(task.origin.fromAddress)?.agentId ?? task.origin.fromAddress;
  return handoffLabel(task.origin, agentName(from), agentName(task.ownerId));
}
export type TimelineDay = { day: string; entries: TimelineEntry[]; workedMs: number };

/** Dia local de um instante ISO ("" se inválido). */
export function localDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : dayKey(date);
}

/** Linha do tempo por dia: pedido, aprovação, começo, entregas (tarefas feitas), prazo, fim e as horas trabalhadas (`worked`). Do dia mais antigo ao mais novo. */
export function projectTimeline(project: Project, agentName: (id: string) => string = (id) => id): TimelineDay[] {
  const events: TimelineEntry[] = [{ kind: "criado", text: project.kind === "tarefa" ? "Tarefa criada" : "Projeto criado", at: project.createdAt }];
  if (project.kind === "projeto") {
    const badge = projectApprovalBadge(project.approval);
    if (badge) {
      const at = project.approval?.at || project.approvedAt;
      if (at) events.push({ kind: "aprovado", text: badge.label, at, ...(badge.title ? { title: badge.title } : {}) });
    } else if (project.approvedAt) {
      events.push({ kind: "aprovado", text: "Plano aprovado", at: project.approvedAt });
    }
  }
  if (project.startAt) events.push({ kind: "comeca", text: "Começa", at: project.startAt });
  for (const task of project.tasks) {
    const handoff = handoffText(task, agentName);
    if (handoff && task.origin?.at) events.push({ kind: "repasse", text: `${handoff} · ${task.ref}`, at: task.origin.at });
    if (task.status === "concluida" && task.finishedAt) events.push({ kind: "entrega", text: `${task.ref} · ${task.title}`, at: task.finishedAt });
  }
  if (project.dueAt) events.push({ kind: "prazo", text: "Prazo", at: project.dueAt });
  if (project.finishedAt) events.push({ kind: "fim", text: project.status === "cancelado" ? "Cancelado" : "Concluído", at: project.finishedAt });
  const days = new Map<string, TimelineDay>();
  const dayOf = (day: string): TimelineDay => {
    let entry = days.get(day);
    if (!entry) {
      entry = { day, entries: [], workedMs: 0 };
      days.set(day, entry);
    }
    return entry;
  };
  for (const event of events) {
    const day = localDay(event.at);
    if (day) dayOf(day).entries.push(event);
  }
  for (const [day, ms] of Object.entries(project.worked)) if (ms > 0) dayOf(day).workedMs += ms;
  for (const day of days.values()) day.entries.sort((a, b) => a.at.localeCompare(b.at));
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** "2 h 05" / "35 min": horas trabalhadas de um dia. */
export function workedLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${pad(rest)}` : ""}`;
}

// ---------- Pedido ao Maestro ----------

export type NewWorkInput = { text: string; kind: "projeto" | "tarefa" | "auto"; dueAt?: string; priority: ProjectPriority };

/** Texto do pedido que o botão Novo manda ao Maestro (o mesmo caminho da conversa): estruturado, em pt-BR. */
export function newWorkMessage(input: NewWorkInput): string {
  const kind = input.kind === "projeto" ? "Projeto" : input.kind === "tarefa" ? "Tarefa avulsa" : "Você decide (Projeto ou Tarefa avulsa)";
  const lines = [
    "Novo pedido pela tela Trabalho.",
    `Tipo: ${kind}`,
    `Prioridade: ${input.priority}`,
    ...(input.dueAt ? [`Prazo: ${input.dueAt}`] : []),
    "",
    "O que fazer:",
    input.text.trim(),
  ];
  return lines.join("\n");
}
