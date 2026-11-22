import { agentAddress, ASK_LIMITS, effectiveAccess, isMaestroAgent, isoFromInput, PROJECT_INPUT_PRIORITIES, type DayStats, type OfficeState, type PlanApprovalRule, type PlanApprovalSettings, type TodayView } from "@cyno/shared";
import { z } from "zod";
import type { ForYouService } from "../workspace/for-you/service";
import type { CardSummaryStore } from "../workspace/card/summary-store";
import type { CliMaestro } from "../workspace/maestro/cli-maestro";
import type { ProjectService } from "../workspace/projects/project-service";
import type { CliAgentRunner } from "../engines/terminals/cli-runner";
import { agentTools, type AgentToolsDeps } from "./agent-tools";
import { brainTools, type BrainToolsDeps } from "./brain-tools";
import { browserTools, type BrowserToolsDeps } from "./browser-tools";
import type { ScriptToolsDeps } from "./script-tools";
import { agendaTools, type AgendaToolsDeps } from "./agenda-tools";
import { approvalTypeTool, delegationTypeNote, mentionedForYouType, type ApprovalTypeDeps } from "./approval-type-tool";
import { boardTools, type BoardToolsDeps } from "./board-tools";
import { mediaTools, type MediaToolsDeps } from "./media-tools";
import { muralTools, type MuralToolsDeps } from "./mural-tools";
import { asSources, attachmentError } from "./sources-field";
import { planTools } from "./plan-tools";
import { workerTools } from "./worker-tools";
import { approvalFields, questionsField, requestApprovalDescription, requestId, text, withinLimit } from "./tool-fields";
import { calendarTools, type CalendarToolsDeps } from "./calendar-tools";
import { forYouTools } from "./for-you-tools";
import { manageTools, type ManageToolsDeps } from "./manage-tools";
import { defineTool, type McpTool } from "./protocol";
import { maestroRoutineTools, type RoutineToolsDeps } from "./routine-tools";
import { maestroDayStatsTool } from "./day-stats-tools";
import { maestroMetricsTool } from "./metrics-tools";
import { maestroReportTool } from "./report-tools";
import { maestroBrainOrganizeTools, type BrainOrganizeToolsDeps } from "./brain-organize-tools";
import { maestroRetroTools, type RetroToolsDeps } from "./retro-tools";
import { maestroTodayTool } from "./today-tools";
import { structureTools, type StructureToolsDeps } from "./structure-tools";

/*
 * O contrato MCP (nomes, parâmetros, valores e descrições das ferramentas) é todo em inglês; o que
 * o usuário vê continua em pt-BR (e as instruções mandam os agentes responderem a ele em pt-BR).
 */

export type OfficeToolsDeps = {
  state: { read(): OfficeState };
  maestro: Pick<CliMaestro, "team" | "openRequest" | "delegate" | "viewTask" | "conclude" | "requestApproval" | "askQuestions" | "requestFor"> & Partial<Pick<CliMaestro, "cancelRequest">>;
  runner: Pick<CliAgentRunner, "deliver" | "progress" | "requestApproval" | "requestInformation" | "currentTaskId" | "hasActive" | "holdForHelp">;
  /** Planos e projetos (create_project & cia do Maestro; get_task e request_help dos agentes). */
  plans?: Pick<ProjectService, "propose" | "addTasks" | "createSprint" | "updateSprint" | "moveTask" | "updateTask" | "deleteTask" | "releaseWork" | "holdWork" | "setReleasePace" | "setProjectStatus" | "assignTask" | "reassignTask" | "closeSprint" | "sprintIdOf" | "decideTask" | "describe" | "workerView" | "help" | "helpReleased" | "handoff" | "updateProject" | "recordChecklist">;
  /** Regra de aprovação de projetos do workspace (`set_plan_approval_rule` e contexto do retorno de `create_project`). */
  planApproval?: {
    get: () => PlanApprovalSettings;
    set: (rule: PlanApprovalRule, ownerQuote: string) => Promise<PlanApprovalSettings>;
  };
  /** Tipos do "Para você" (o `approval_type` do request_approval e o set_approval_type do Maestro). */
  forYouTypes: ApprovalTypeDeps;
  /** Itens do "Para você" (list/update/cancel_pending_item): o Maestro em todos, o agente só nos dele. */
  forYou?: Pick<ForYouService, "list" | "update" | "cancel">;
  /** Serviços e motores das ferramentas de estrutura do Maestro (criar sala, time, agente, líder). */
  structure: Omit<StructureToolsDeps, "state">;
  /** Cérebro (search_notes, read_note, save_note), com as regras de visibilidade do quarto do agente. */
  brain?: BrainToolsDeps["access"];
  /** A frase "o que este workspace faz" da ficha (o Maestro escreve com `set_workspace_summary`). */
  cardSummary?: Pick<CardSummaryStore, "get" | "write">;
  /** Texto a mais no `get_team` (os conectores do workspace e quem usa cada um). */
  teamNote?: () => string;
  /** Navegador compartilhado (ferramentas `browser_*`, só para quem tem o navegador liberado). */
  browser?: BrowserToolsDeps;
  /** Scripts demorados que o servidor roda (`start_script` & cia), só para agentes de time com o terminal ligado. */
  scripts?: ScriptToolsDeps;
  /** Biblioteca de mídia (`media_*`, e o `mediaIds`/`sources` do request_approval). */
  media?: MediaToolsDeps;
  /** Quadros (`board_*`): páginas e dados para o dono olhar, para o Maestro e os agentes de time. */
  board?: BoardToolsDeps;
  /** Rotinas: o Maestro propõe/lista/pausa; os agentes veem as suas e registram o que fizeram (routine_record). */
  /** O painel "Hoje" do workspace (`get_today` do Maestro). */
  today?: () => TodayView;
  /** A diária do workspace (`get_day_stats` do Maestro). */
  dayStats?: { dayStats: (day: string) => Promise<DayStats>; now: () => Date };
  /** As métricas da Gestão do workspace (`get_metrics` do Maestro). */
  metrics?: Parameters<typeof maestroMetricsTool>[0];
  /** Os relatórios congelados da Gestão (`get_report` do Maestro). */
  reports?: Parameters<typeof maestroReportTool>[0];
  /** `propose_rule` do Maestro (a retrospectiva da Gestão: o dono pede as regras com o botão; cada regra vira um cartão para ele aprovar). */
  retro?: RetroToolsDeps;
  /** `propose_brain_cleanup` do Maestro (o dono clica em "Organizar" num Cérebro; a proposta vira um cartão para ele aprovar). */
  brainOrganize?: BrainOrganizeToolsDeps;
  routines?: Pick<RoutineToolsDeps, "routines" | "tracking" | "now" | "forYou" | "workspaceId">;
  /** Pedir ajuda ao Cyno, o agente da plataforma (`ask_cyno`); ausente = a ferramenta não existe. Joga erro com o motivo se um limite barrar. */
  cyno?: { ask: (input: { question: string; context?: string; requestId?: string }) => string };
  /** "Sua agenda" (a do dono, única para a plataforma): `agenda_book` & cia, para o Maestro e para os agentes de time. */
  agenda?: { service: AgendaToolsDeps["agenda"]; workspaceId: string; now: () => Date; workspaceName?: (id: string) => string | undefined };
  /** O mural da plataforma (`mural_share`, `mural_list`, `mural_use`): para o Maestro e para os agentes de time. */
  mural?: { service: MuralToolsDeps["mural"]; workspaceId: string; workspaceName: (id: string) => string | undefined };
  /** Gestão do Maestro além de criar: editar/remover, acesso, conectores, terminais, mensagens, acompanhamento e calendário. */
  manage?: MaestroManageDeps;
};

/** Dependências das ferramentas de gestão do Maestro (manage-tools, agent-tools e calendar-tools). */
export type MaestroManageDeps = Omit<ManageToolsDeps, "state"> & Omit<AgentToolsDeps, "state"> & Omit<CalendarToolsDeps, "state">;

/**
 * Ferramentas MCP do escritório para o agente dono do token: o Maestro recebe as de gerente,
 * os agentes de time recebem as de trabalho. Erros viram resultado com isError (o modelo vê).
 */
export function officeToolsFor(agentId: string, deps: OfficeToolsDeps): McpTool[] {
  const state = deps.state.read();
  const agent = state.agents.find((candidate) => candidate.id === agentId);
  if (!agent) return [];
  const brain = deps.brain ? brainTools(agentId, { state: deps.state, access: deps.brain }) : [];
  const browser = deps.browser && effectiveAccess(deps.browser.access(), agent).browser ? browserTools(agentId, deps.browser) : [];
  const media = deps.media ? mediaTools(agentId, deps.media) : [];
  const board = deps.board ? boardTools(agentId, deps.board) : [];
  const agenda = deps.agenda
    ? agendaTools({
        agenda: deps.agenda.service,
        actor: { kind: "agente", workspace: deps.agenda.workspaceId, name: agent.name, address: agentAddress(deps.agenda.workspaceId, agent.id) },
        now: deps.agenda.now,
        ...(deps.agenda.workspaceName ? { workspaceName: deps.agenda.workspaceName } : {}),
        // O agente de time liga o compromisso à tarefa (e ao projeto) que está executando.
        currentTask: () => {
          if (!deps.runner.hasActive(agentId)) return undefined;
          const taskId = deps.runner.currentTaskId(agentId);
          return deps.state.read().tasks.find((task) => task.id === taskId);
        },
      })
    : [];
  const mural = deps.mural ? muralTools({ mural: deps.mural.service, workspace: deps.mural.workspaceId, address: agentAddress(deps.mural.workspaceId, agent.id), agentId: agent.id, workspaceName: deps.mural.workspaceName }) : [];
  return [...(isMaestroAgent(state, agent) ? maestroTools(deps) : workerTools(agentId, deps)), ...agenda, ...brain, ...browser, ...media, ...board, ...mural];
}

function maestroTools({ state, maestro, forYouTypes, forYou, structure, teamNote, plans, planApproval, manage, routines, media, cardSummary, cyno, today, dayStats, metrics, reports, retro, brainOrganize }: OfficeToolsDeps): McpTool[] {
  return [
    defineTool({
      name: "get_team",
      description: "Lists the workspace's rooms, teams and agents (ids, focus, engine, status and pending tasks).",
      input: z.object({}),
      call: () => text([maestro.team(), teamNote?.() ?? ""].filter(Boolean).join("\n\n")),
    }),
    defineTool({
      name: "open_request",
      description:
        "Opens a request (the user sees it in Pedidos e Tarefas) when the conversation turned into something to DO: the user asked clearly, or confirmed. Do not open one for chat, questions, ideas or planning. Returns the request id, used in delegate_task, request_approval and complete_request.",
      input: z.object({
        title: z.string().trim().min(1).max(120).describe('Short title of the deliverable, in Brazilian Portuguese (e.g. "Post sobre IA para o LinkedIn")'),
        description: z
          .string()
          .trim()
          .min(1)
          .max(3800)
          .describe("The full briefing agreed in the conversation: goal, audience, format, tone, deadline, constraints, where it will be published and what the user already decided"),
        user_quote: z.string().trim().max(600).optional().describe("The user's sentence that asked for (or confirmed) the work"),
      }),
      call: ({ title, description, user_quote }) => {
        const task = maestro.openRequest({ title, description, ...(user_quote ? { origin: user_quote } : {}) });
        return text(
          `Request ${task.id} opened: “${title}”. Now delegate with delegate_task(request_id: "${task.id}", …) (or, if it is simple and you solve it yourself, close it with complete_request(request_id: "${task.id}", text)). Tell the user you opened the request.`,
        );
      },
    }),
    defineTool({
      name: "delegate_task",
      description:
        "Delegates work from an open request (request_id: the id open_request returned; never make one up) to an agent (agent_id) or to the best free agent of a team (team_id). Without an open request, open one first with open_request and wait for the id. Always give the `reason` for the choice (the user sees it). Returns right away with the subtask id; the result arrives later in a message.",
      input: z.object({
        request_id: requestId,
        agent_id: z.string().max(64).optional().describe("Agent id (see get_team)"),
        team_id: z.string().max(64).optional().describe("Team id (the server picks the agent)"),
        task: z.string().trim().min(1).max(4000).describe("What the agent must do: a complete briefing, with the context it needs (it did not see the conversation)"),
        reason: z.string().trim().max(300).optional().describe('Why this agent/team (one short sentence in Brazilian Portuguese, e.g. "Clara é a redatora do time de Conteúdo"). Always fill it in.'),
        approval_type: z
          .string()
          .trim()
          .min(1)
          .max(40)
          .optional()
          .describe("Approval type id the result is for (when the text will need approval): the agent receives the type's name, description and character limit"),
        due_at: z.string().trim().max(40).optional().describe('Deadline of this task (ISO 8601, e.g. "2026-11-20T18:00:00-03:00" or "2026-11-20")'),
        priority: z.enum(PROJECT_INPUT_PRIORITIES).optional().describe("high, normal (default) or low: who starts first when there is a queue"),
        done_when: z.array(z.string().trim().min(1).max(300)).max(10).optional().describe('"Done when…" criteria, short and checkable; the agent checks each one and reports before delivering'),
      }),
      call: ({ agent_id, team_id, task, reason, approval_type, request_id, due_at, priority, done_when }) => {
        const dueAt = due_at ? isoFromInput(due_at) : undefined;
        if (due_at && !dueAt) throw new Error(`due_at "${due_at}" is not a valid date (use ISO 8601)`);
        const types = forYouTypes.list();
        const typeId = approval_type ?? mentionedForYouType(types, task);
        const full = typeId ? `${task}\n\n${delegationTypeNote(types, typeId)}` : task;
        return text(maestro.delegate({ agentId: agent_id, teamId: team_id, task: full, reason, requestId: request_id, ...(dueAt ? { dueAt } : {}), ...(priority ? { priority } : {}), ...(done_when?.length ? { doneWhen: done_when } : {}), ...(typeId ? { approvalType: types.find((type) => type.id === typeId)?.id ?? typeId } : {}) }));
      },
    }),
    defineTool({
      name: "get_task",
      description: "Shows the status and result of a task (e.g. a delegated subtask).",
      input: z.object({ id: z.string().min(1).max(64).describe("Task id") }),
      call: ({ id }) => text(maestro.viewTask(id)),
    }),
    defineTool({
      name: "complete_request",
      description: "Closes an open request with the final answer (it is what the user sees as the result). Every open request ends with this. Do not use it for chat (just reply).",
      input: z.object({ text: z.string().trim().min(1).max(20000).describe("The final answer, in markdown (in Brazilian Portuguese)"), request_id: requestId }),
      call: ({ text: answer, request_id }) => text(maestro.conclude({ text: answer, requestId: request_id })),
    }),
    defineTool({
      name: "request_approval",
      description: requestApprovalDescription(`Asks the user for a decision (becomes an item in "Para você").`),
      input: z.object({ ...approvalFields(forYouTypes), request_id: requestId }),
      call: ({ question, approval_type, text: draft, where, to, mediaIds, sources, request_id }) =>
        withinLimit(
          forYouTypes,
          { type: approval_type, text: draft, where },
          () => maestro.requestApproval({ question, type: approval_type, text: draft, where, to, ...(mediaIds?.length ? { mediaIds } : {}), ...(sources?.length ? { sources: asSources(sources)! } : {}), requestId: request_id }),
          () => attachmentError(media?.media, mediaIds, sources),
        ),
    }),
    defineTool({
      name: "ask_user",
      description:
        'Sends SEVERAL questions to the user at once, as a questionnaire in "Para você" (with options and a default, if you want). The user answers in their own time and the answers arrive TOGETHER in one message. Use it instead of interrogating in the chat when several pieces of information are missing. To change a questionnaire you already sent (still pending), use update_pending_item instead of sending another one. End the turn afterwards.',
      input: z.object({
        questions: questionsField,
        title: z.string().trim().max(120).optional().describe("Short questionnaire title"),
        request_id: requestId,
      }),
      call: ({ questions, title, request_id }) => text(maestro.askQuestions({ questions, title, requestId: request_id })),
    }),
    ...(forYou ? forYouTools({ actor: "maestro" }, { state, forYou, types: forYouTypes, ...(media ? { media: media.media } : {}) }) : []),
    ...(maestro.cancelRequest ? [cancelRequestTool(maestro.cancelRequest.bind(maestro))] : []),
    ...(plans ? planTools(maestro, plans, planApproval) : []),
    ...(routines ? maestroRoutineTools({ state, ...routines }) : []),
    ...(today ? [maestroTodayTool(today)] : []),
    ...(dayStats ? [maestroDayStatsTool(dayStats)] : []),
    ...(metrics ? [maestroMetricsTool(metrics)] : []),
    ...(reports ? [maestroReportTool(reports)] : []),
    ...(retro ? maestroRetroTools(retro) : []),
    ...(brainOrganize ? maestroBrainOrganizeTools(brainOrganize) : []),
    approvalTypeTool(forYouTypes),
    ...structureTools({ ...structure, state }),
    ...(manage ? [...manageTools({ ...manage, state }), ...agentTools({ ...manage, state }), ...calendarTools({ ...manage, state })] : []),
    ...(cardSummary ? [workspaceSummaryTool(cardSummary)] : []),
    ...(cyno ? [askCynoTool(cyno)] : []),
  ];
}

/** `cancel_request`: o Maestro desfaz um pedido aberto por engano (ou que o usuário desistiu). */
function cancelRequestTool(cancel: NonNullable<OfficeToolsDeps["maestro"]["cancelRequest"]>): McpTool {
  return defineTool({
    name: "cancel_request",
    description:
      "Cancels an open request that was opened by mistake or that the user gave up on: active subtasks stop, an open plan is cancelled and the request's pending items in \"Para você\" are cancelled. It closes as cancelled with your reason. To deliver a result, use complete_request instead.",
    input: z.object({ request_id: requestId, reason: z.string().trim().min(1).max(500).describe("Why, in Brazilian Portuguese (the user sees it)") }),
    call: async ({ request_id, reason }) => text(await cancel(request_id, reason)),
  });
}


/** `set_workspace_summary` do Maestro: a frase "o que este workspace faz" da ficha (o que o Cyno lê sem acordar ninguém). */
function workspaceSummaryTool(store: Pick<CardSummaryStore, "get" | "write">): McpTool {
  return defineTool({
    name: "set_workspace_summary",
    description:
      "Writes the one-sentence description of what THIS workspace does (max 280 characters, in Brazilian Portuguese, plain and concrete: what it produces and for whom). It is shown on the workspace card and read by the platform agent (Cyno) so it can route requests without waking you. Reversible; no approval needed. If the owner already wrote the sentence, yours is saved as a suggestion for them to accept.",
    input: z.object({ text: z.string().trim().min(1).max(280).describe("The sentence, e.g. 'Posts, comentários e convites do perfil da empresa no LinkedIn.'") }),
    call: async ({ text: sentence }) => {
      const result = await store.write(sentence, "maestro");
      if (result.stored === "sugestao") return text("The owner wrote the current sentence, so yours was saved as a suggestion on the card (they can accept it). Do not insist.");
      if (result.stored === "igual") return text("The card already says exactly that.");
      return text("Saved. The workspace card now shows this sentence.");
    },
  });
}

/** `ask_cyno`: o Maestro pede ajuda ao Cyno para algo entre workspaces ou da plataforma (o servidor limita e a resposta volta como mensagem). */
function askCynoTool(cyno: NonNullable<OfficeToolsDeps["cyno"]>): McpTool {
  return defineTool({
    name: "ask_cyno",
    description:
      "Asks the Cyno (the platform agent, above all workspaces) for help with something that involves ANOTHER workspace or the platform and that you cannot solve alone: e.g. use an image the design workspace made, find out which workspace handles a subject, get a piece of work done elsewhere. The Cyno answers ONCE per question, and the answer arrives later as a message in this conversation: keep doing whatever does not depend on it and end your turn. Limited per workspace and per hour; to continue a conversation you must open a new question (it counts in the limit). Do NOT use it for what you can solve yourself, nor to ask the owner (that is ask_user). Write the question in Brazilian Portuguese.",
    input: z.object({
      question: z.string().trim().min(1).max(ASK_LIMITS.question).describe("The question or what you need, specific and self-contained (the Cyno does not see your conversation)"),
      context: z.string().trim().max(ASK_LIMITS.context).optional().describe("Background the Cyno needs: what the request is, what you already tried, what you will do with the answer"),
      request_id: requestId,
    }),
    call: ({ question, context, request_id }) => text(cyno.ask({ question, ...(context ? { context } : {}), ...(request_id ? { requestId: request_id } : {}) })),
  });
}
