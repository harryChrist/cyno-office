import { leavesOf, sprintsInOrder, type MediaItem, type Project, type ProjectTask, type Sprint, type SprintSummary } from "@cyno/shared";
import { formatDateTime } from "../../ui/format";
import { shortSprintName, sprintPlanned } from "./sprintsView";
import { workedLabel } from "./workView";

/**
 * O resumo de entrega de uma sprint para a tela (cartão em Aprovações, aba Sprints e aba Entregas). Funções puras:
 * o React só desenha o que sai daqui. O resumo em si é montado no servidor (`buildSprintSummary`, ao fechar).
 */

export type DeliveryEntry = SprintSummary["done"][number];
export type CarriedEntry = { ref: string; title: string; where: string };

export type DeliveryView = {
  sprint: Sprint;
  summary: SprintSummary;
  /** "Sprint 2 fechou: 8 entregues, 2 sobraram". */
  headline: string;
  /** "08/11–14/11" (as datas previstas) e "fechou em 11/11 15:00" (a real). */
  range: string;
  closedLabel: string | null;
  done: DeliveryEntry[];
  carried: CarriedEntry[];
  failed: SprintSummary["failed"];
  cancelled: NonNullable<SprintSummary["cancelled"]>;
  reworked: NonNullable<SprintSummary["reworked"]>;
  skipped: number;
  /** Tarefas da sprint que ainda estão terminando (o ritmo mole não interrompe). */
  finishing: { ref: string; title: string }[];
  /** "5 h 30 trabalhadas" (vazio se não houve horas registradas). */
  worked: string | null;
  /** Como foi decidida: null = ainda espera o OK. */
  decision: { tone: "ok" | "auto" | "returned"; text: string } | null;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Sprint 2 fechou: 8 entregues, 2 sobraram" (o mesmo texto que o servidor dá ao cartão). */
export function deliveryHeadline(sprint: Pick<Sprint, "name">, summary: Pick<SprintSummary, "done" | "carried" | "failed">): string {
  const failed = summary.failed.length;
  const left = `${plural(summary.carried.length, "sobrou", "sobraram")}${failed > 0 ? ` (${plural(failed, "falhou", "falharam")})` : ""}`;
  return `${sprint.name} fechou: ${plural(summary.done.length, "entregue", "entregues")}, ${left}`;
}

/** Onde a sobra foi parar: "foi para Sprint 2" ou "ficou sem sprint". */
export function carriedWhere(project: Pick<Project, "sprints">, to: string | null): string {
  if (to === null) return "ficou sem sprint";
  const target = project.sprints?.find((sprint) => sprint.id === to);
  return `foi para ${target ? shortSprintName(target.name) : "outra sprint"}`;
}

/** Como a entrega foi decidida, em uma frase ("aprovada por você em 11/11 15:00", "aprovada sozinha em …"). */
export function decisionText(summary: SprintSummary): DeliveryView["decision"] {
  if (!summary.decidedAt && !summary.decidedBy) return null;
  const when = summary.decidedAt ? ` em ${formatDateTime(summary.decidedAt)}` : "";
  if (summary.returned) return { tone: "returned", text: `devolvida por você${when}: ${summary.returned.reason}` };
  if (summary.decidedBy === "automatico") return { tone: "auto", text: `aprovada sozinha${when}` };
  return { tone: "ok", text: `aprovada por você${when}` };
}

/** O resumo de uma sprint pronto para desenhar; null enquanto ela não fechou (sem resumo). */
export function deliveryView(project: Project, sprint: Sprint): DeliveryView | null {
  const summary = sprint.summary;
  if (!summary) return null;
  const live = leavesOf({ tasks: project.tasks.filter((task) => !task.archived) });
  const finishing = live.filter((task) => task.sprintId === sprint.id && (task.status === "em_andamento" || task.status === "esperando_voce")).map((task) => ({ ref: task.ref, title: task.title }));
  return {
    sprint,
    summary,
    headline: deliveryHeadline(sprint, summary),
    range: sprintPlanned(sprint),
    closedLabel: sprint.closedAt ? `fechou em ${formatDateTime(sprint.closedAt)}` : null,
    done: summary.done,
    carried: summary.carried.map((entry) => ({ ref: entry.ref, title: entry.title, where: carriedWhere(project, entry.to) })),
    failed: summary.failed,
    cancelled: summary.cancelled ?? [],
    reworked: summary.reworked ?? [],
    skipped: summary.skipped.length,
    finishing,
    worked: summary.workedMs > 0 ? `${workedLabel(summary.workedMs)} trabalhadas` : null,
    decision: decisionText(summary),
  };
}

/** A mídia e os arquivos de uma entrega: os itens da Mídia ligados às tarefas do runner das etapas dela. */
export function mediaOfEntry(media: readonly MediaItem[] | null | undefined, entry: Pick<DeliveryEntry, "taskIds">): MediaItem[] {
  const ids = new Set(entry.taskIds ?? []);
  if (ids.size === 0) return [];
  return (media ?? []).filter((item) => (item.taskId !== undefined && ids.has(item.taskId)) || (item.rootTaskId !== undefined && ids.has(item.rootTaskId)));
}

/** Endereço curto de um link para mostrar ("exemplo.com/arte.png"). */
export function shortLink(link: string): string {
  try {
    const url = new URL(link);
    const path = url.pathname === "/" ? "" : url.pathname;
    const text = `${url.hostname.replace(/^www\./, "")}${path}`;
    return text.length > 42 ? `${text.slice(0, 41)}…` : text;
  } catch {
    return link;
  }
}

/** Uma "entrega" da aba Entregas: a sprint com o resumo (se houver) e as tarefas entregues nela, a mais nova primeiro. */
export type DeliveryGroup = { key: string; sprint: Sprint | null; tasks: ProjectTask[]; view: DeliveryView | null };

/**
 * A aba Entregas agrupada por sprint (a mais recente primeiro): cada grupo traz as tarefas entregues nela e o
 * resumo. Projeto sem sprints devolve um grupo só, sem sprint (a lista de sempre). Entrega sem sprint (ou de
 * sprint que não existe mais) vai num grupo "Sem sprint" no fim.
 */
export function deliveryGroups(project: Project): DeliveryGroup[] {
  const leaves = leavesOf({ tasks: project.tasks.filter((task) => !task.archived) });
  const delivered = leaves.filter((task) => task.status === "concluida" && !task.skipped && task.result).sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
  const sprints = sprintsInOrder(project);
  if (sprints.length === 0) return delivered.length > 0 ? [{ key: "all", sprint: null, tasks: delivered, view: null }] : [];
  const groups: DeliveryGroup[] = [];
  for (const sprint of [...sprints].reverse()) {
    const view = deliveryView(project, sprint);
    const tasks = delivered.filter((task) => task.sprintId === sprint.id);
    // Sprint planejada ou ativa sem entrega ainda não aparece; a que fechou aparece mesmo vazia (o resumo é a entrega).
    if (tasks.length === 0 && !view) continue;
    groups.push({ key: sprint.id, sprint, tasks, view });
  }
  const ids = new Set(sprints.map((sprint) => sprint.id));
  const loose = delivered.filter((task) => !task.sprintId || !ids.has(task.sprintId));
  if (loose.length > 0) groups.push({ key: "none", sprint: null, tasks: loose, view: null });
  return groups;
}
