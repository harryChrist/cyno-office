import { HANDOFF_LIMITS, isProjectTaskFinished, parseAddress, type HandoffIntent, type Project, type ProjectTask } from "@cyno/shared";
import { shorten } from "../../util/text";
import { shorten2 } from "./project-types";

/**
 * Passagem de bastão entre agentes (fatia 6): regras puras do `ProjectService.handoff`. Os limites
 * vivem todos aqui, no servidor, para que um laço entre dois agentes nunca dependa do bom senso do
 * modelo: ao estourar, o agente recebe o motivo e o Maestro é acordado uma vez.
 */

/** Quem mandou a tarefa de repasse (o agente que escreveu em `origin.fromAddress`). */
export function originAgent(task: Pick<ProjectTask, "origin">): string | undefined {
  return task.origin ? parseAddress(task.origin.fromAddress)?.agentId : undefined;
}

/** Cadeia de agentes até o remetente (do mais antigo ao remetente), seguindo `origin.fromRef` para trás. */
export function handoffChain(plan: Pick<Project, "tasks">, sender: ProjectTask, senderAgentId: string): string[] {
  const agents = [senderAgentId];
  let current: ProjectTask | undefined = sender;
  for (let guard = 0; current?.origin && guard < 50; guard += 1) {
    const from = originAgent(current);
    if (from) agents.unshift(from);
    const ref: string = current.origin.fromRef;
    current = plan.tasks.find((candidate) => candidate.ref === ref);
  }
  return agents;
}

/** Os últimos 4 repasses (5 agentes) alternam só entre os mesmos 2 agentes: A, B, A, B, A. */
export function isPingPong(chain: string[]): boolean {
  const last = chain.slice(-(HANDOFF_LIMITS.pingPong + 1));
  if (last.length < HANDOFF_LIMITS.pingPong + 1) return false;
  return last[0] !== last[1] && last.every((agent, index) => index < 2 || agent === last[index - 2]);
}

/** Dito ao agente em todo erro do repasse: ele costuma escrever "passei o trabalho" mesmo com a ferramenta recusando. */
export const NOTHING_HANDED_OFF = "Nothing was handed off. Do the work yourself or call request_help. Do not report a handoff.";

/** Raiz da cadeia de repasses de uma tarefa (segue `origin.fromRef` para trás; a própria tarefa se não veio de repasse). */
export function handoffRoot(plan: Pick<Project, "tasks">, task: ProjectTask): ProjectTask {
  let current = task;
  for (let guard = 0; current.origin && guard < 50; guard += 1) {
    const ref: string = current.origin.fromRef;
    const from = plan.tasks.find((candidate) => candidate.ref === ref);
    if (!from) break;
    current = from;
  }
  return current;
}

/**
 * As tarefas da mesma cadeia de repasses do remetente (a raiz e tudo que desce dela). O Avulsas junta todas as
 * tarefas simples do workspace; os limites contra laço têm de olhar só esta cadeia, não a lista inteira.
 */
export function handoffFamily(plan: Pick<Project, "tasks">, sender: ProjectTask): ProjectTask[] {
  const root = handoffRoot(plan, sender).ref;
  return plan.tasks.filter((task) => handoffRoot(plan, task).ref === root);
}

export type HandoffContext = {
  plan: Project;
  /** Todos os projetos do workspace (o limite por hora é do workspace). */
  plans: readonly Project[];
  sender: ProjectTask;
  senderAgentId: string;
  targetAgentId: string;
  now: number;
};

/** O que barra este repasse (texto para o agente, em inglês), ou undefined se pode. */
export function handoffRefusal(context: HandoffContext): string | undefined {
  const { plan, plans, sender, senderAgentId, targetAgentId, now } = context;
  if (targetAgentId === senderAgentId) return "You cannot hand off to yourself: this work is yours. Do it and finish with submit_result.";
  const hops = (sender.origin?.hops ?? 0) + 1;
  if (hops > HANDOFF_LIMITS.hops) return `Handoff chain limit reached (${HANDOFF_LIMITS.hops} hops): the work has already passed through too many agents. Finish your part with submit_result; the Maestro was warned and will decide.`;
  const open = plan.tasks.filter((task) => task.origin?.fromRef === sender.ref && !isProjectTaskFinished(task)).length;
  if (open >= HANDOFF_LIMITS.openPerTask) return `You already have ${open} open handoffs from this task (limit ${HANDOFF_LIMITS.openPerTask}). Wait for them to finish; finish your part with submit_result.`;
  if (isPingPong(handoffChain(plan, sender, senderAgentId).concat(targetAgentId))) {
    return `Back-and-forth refused: the last ${HANDOFF_LIMITS.pingPong} handoffs only alternated between these two agents. Settle it yourself, or finish with submit_result saying what is still open; the Maestro was warned.`;
  }
  const inProject = plan.tasks.filter((task) => task.origin).length;
  if (inProject >= HANDOFF_LIMITS.perProject) return `This project already has ${inProject} handoff tasks (limit ${HANDOFF_LIMITS.perProject}). Finish with submit_result; the Maestro was warned.`;
  const hourAgo = now - 3_600_000;
  const lastHour = plans.reduce((total, other) => total + other.tasks.filter((task) => task.origin?.at && Date.parse(task.origin.at) > hourAgo).length, 0);
  if (lastHour >= HANDOFF_LIMITS.perHour) return `This workspace already created ${lastHour} handoff tasks in the last hour (limit ${HANDOFF_LIMITS.perHour}). Try again later or finish with submit_result; the Maestro was warned.`;
  return undefined;
}

/** Próximo apelido "H<n>" livre no projeto. */
export function nextHandoffRef(plan: Pick<Project, "tasks">): string {
  const used = new Set(plan.tasks.map((task) => task.ref));
  let n = plan.tasks.filter((task) => /^H\d+$/.test(task.ref)).length + 1;
  while (used.has(`H${n}`)) n += 1;
  return `H${n}`;
}

/** Rótulo curto da intenção (título da tarefa). */
export const HANDOFF_TITLES: Record<HandoffIntent, string> = { pass_on: "Vez passada", ask: "Pergunta", fyi: "Aviso" };

/** Briefing da tarefa de repasse: a mensagem completa e o contexto (parcial, limitado) do remetente. */
export function handoffBriefing(input: { fromName: string; message: string; intent: HandoffIntent; sender: ProjectTask; reply?: boolean; question?: string }): string {
  const { fromName, message, intent, sender, reply, question } = input;
  const partial = [...sender.steps].reverse().find((step) => step.result)?.result;
  const head = reply
    ? `Resposta de ${fromName} à sua pergunta:\n${shorten2(message, 2500)}${question ? `\n\nA sua pergunta era:\n${shorten2(question, 600)}` : ""}`
    : `${intent === "pass_on" ? `${fromName} terminou a parte e passou a vez para você.` : intent === "ask" ? `${fromName} precisa de uma informação sua. Responda com \`submit_result\`: a resposta volta para ele como tarefa.` : `${fromName} avisa (não precisa responder).`}\n\nMensagem:\n${shorten2(message, 2500)}`;
  const context = [`Contexto (tarefa ${sender.ref} «${shorten(sender.title, 100)}»):`, shorten2(sender.briefing, 600), partial ? `Resultado parcial de ${sender.ref}:\n${shorten2(partial, 1200)}` : ""].filter(Boolean).join("\n");
  return [head, context].join("\n\n");
}
