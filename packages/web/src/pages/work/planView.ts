import { isPlanOpen, type ForYouItem, type Plan, type Task } from "@cyno/shared";

/** Lógica pura que sobrou dos planos: agrupamento do "Para você" por pedido e passagens de etapa do escritório. */

/** O que do pedido espera o usuário: tarefas do plano "esperando você" e itens pendentes que não seguram uma tarefa do plano (o plano para aprovar, o questionário do Maestro). */
export type Waiting = { tasks: number; items: number };

export function waitingOnUser(requestId: string, plans: readonly Plan[], items: readonly ForYouItem[]): Waiting {
  const plan = plans.filter((candidate) => candidate.id === requestId && isPlanOpen(candidate)).at(-1);
  const blocked = new Set(plan?.tasks.filter((task) => task.status === "esperando_voce").map((task) => task.ref) ?? []);
  const loose = items.filter((item) => item.status === "pendente" && item.projectId === requestId && !(item.taskRef && blocked.has(item.taskRef))).length;
  return { tasks: blocked.size, items: loose };
}

/** "3 tarefas esperando você · 1 pendência do pedido" (vazio quando nada espera). */
export function waitingLabel(waiting: Waiting): string {
  const parts: string[] = [];
  if (waiting.tasks > 0) parts.push(`${waiting.tasks} ${waiting.tasks === 1 ? "tarefa esperando" : "tarefas esperando"} você`);
  if (waiting.items > 0) parts.push(`${waiting.items} ${waiting.items === 1 ? "pendência do pedido" : "pendências do pedido"}`);
  return parts.join(" · ");
}

export type ForYouGroup = { key: string; requestId?: string; title: string; waiting: Waiting; items: ForYouItem[] };

/**
 * Itens do "Para você" agrupados por pedido, na ordem em que o primeiro item de cada pedido aparece;
 * os sem pedido ficam juntos ("Outros"). A lista achatada dos grupos é a ordem da tela.
 */
export function groupByRequest(items: readonly ForYouItem[], tasks: readonly Pick<Task, "id" | "prompt">[], plans: readonly Plan[], allItems: readonly ForYouItem[] = items): ForYouGroup[] {
  const groups = new Map<string, ForYouGroup>();
  for (const item of items) {
    const requestId = item.projectId;
    const key = requestId ?? "";
    let group = groups.get(key);
    if (!group) {
      const prompt = requestId ? tasks.find((task) => task.id === requestId)?.prompt : undefined;
      group = {
        key,
        ...(requestId ? { requestId } : {}),
        title: requestId ? (prompt?.split("\n")[0]?.trim() || plans.find((plan) => plan.id === requestId)?.title || "Pedido") : "Outros",
        waiting: requestId ? waitingOnUser(requestId, plans, allItems) : { tasks: 0, items: 0 },
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  // "Outros" (sem pedido) vai para o fim.
  return [...groups.values()].sort((a, b) => Number(a.key === "") - Number(b.key === ""));
}

/** Passagem de etapa: o agente da etapa que terminou leva o resultado ao da seguinte (só visual). */
export type Handoff = { planId: string; ref: string; title: string; fromAgentId: string; toAgentId: string };

/** As passagens entre a versão anterior e a nova de um plano (etapa k feita e a etapa atual com outro agente). */
export function detectHandoffs(previous: Plan | undefined, next: Plan): Handoff[] {
  if (!previous) return [];
  const out: Handoff[] = [];
  for (const task of next.tasks) {
    const before = previous.tasks.find((candidate) => candidate.ref === task.ref);
    if (!before || task.current <= before.current) continue;
    const done = task.steps[before.current];
    const now = task.steps[task.current];
    if (!done || !now || done.status !== "feita" || done.agentId === now.agentId) continue;
    out.push({ planId: next.id, ref: task.ref, title: task.title, fromAgentId: done.agentId, toAgentId: now.agentId });
  }
  return out;
}
