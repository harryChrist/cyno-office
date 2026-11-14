import {
  agentEngine,
  isCliEngine,
  isConversationLogId,
  isMaestroAgent,
  isMaestroTask,
  isPlanProject,
  isPlanTaskFinished,
  subtasksOf,
  type AgentEngine,
  type AgentLogEntry,
  type AgentLogSummary,
  type AgentUsageResponse,
  type EngineBlock,
  type EngineInfo,
  type OfficeState,
  type Plan,
  type PlanStatus,
  type SubscriptionUsage,
  type Task,
} from "@cyno/shared";
import { z } from "zod";
import { HttpError } from "../platform/http/errors";
import type { AgentChat } from "../engines/terminals/agent-chat";
import type { TerminalManager } from "../engines/terminals/manager";
import { defineTool, type McpTool, type McpToolResult } from "./protocol";
import { findByRef } from "./structure-tools";
import { usageReport } from "./usage-report";

/**
 * Ferramentas do Maestro para os agentes e para acompanhar o workspace: ligar/desligar o terminal
 * de um agente, mandar uma mensagem a ele (a mesma via do POST /agents/:id/chat), ver o que ele
 * fez, listar pedidos e planos e ver o uso da assinatura. Tudo pelos serviços das rotas.
 */

export type AgentToolsDeps = {
  state: { read(): OfficeState };
  terminals: Pick<TerminalManager, "start" | "stop">;
  chat: Pick<AgentChat, "send">;
  agentLog: { recentForAgent(agentId: string, limit: number): Promise<AgentLogEntry[]>; summary(agentId: string): AgentLogSummary };
  plans?: { list(): Plan[] };
  /** Uso da assinatura (da conta) por provedor. */
  usage?: () => SubscriptionUsage[];
  /** Por que um motor está indisponível agora (undefined = disponível). */
  availability?: (engine: AgentEngine) => EngineBlock | undefined;
  /** Motores detectados no server. */
  engines?: () => Promise<EngineInfo[]>;
  /** Uso relatado por agente (turnos e tokens) nas últimas horas. */
  agentUsage?: () => AgentUsageResponse;
  now: () => Date;
};

const error = (text: string): McpToolResult => ({ text, isError: true });
const ok = (text: string): McpToolResult => ({ text });
const ref = (what: string) => z.string().trim().min(1).max(64).describe(`${what} id (or name)`);

/** Status do plano no MCP (inglês). */
const PLAN_STATUS_INPUTS = {
  awaiting_approval: "proposto",
  adjusting: "ajustando",
  running: "ativo",
  done: "concluido",
  cancelled: "cancelado",
} as const satisfies Record<string, PlanStatus>;
type PlanStatusInput = keyof typeof PLAN_STATUS_INPUTS;
const PLAN_STATUS_IDS = Object.keys(PLAN_STATUS_INPUTS) as [PlanStatusInput, ...PlanStatusInput[]];
const planStatusInput = (status: PlanStatus) => PLAN_STATUS_IDS.find((input) => PLAN_STATUS_INPUTS[input] === status) ?? status;

/** Primeira linha do pedido, curta (é o título do pedido do Maestro). */
const titleOf = (task: Pick<Task, "prompt">) => oneLine(task.prompt.split("\n")[0] ?? "", 100);
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const REQUEST_FILTERS = ["open", "done", "failed", "all"] as const;

export function agentTools(deps: AgentToolsDeps): McpTool[] {
  const findAgent = (agentRef: string) => {
    const state = deps.state.read();
    const agent = findByRef(state.agents, agentRef);
    if (!agent) throw new Error(`Agent "${agentRef}" not found. See the ids with get_team.`);
    return { state, agent };
  };
  const tools: McpTool[] = [
    defineTool({
      name: "start_agent",
      description: "Starts a real agent's terminal (Claude Code/Antigravity), resuming its saved session. Agents start by themselves when they get a task: use it only when the user asks.",
      input: z.object({ agent: ref("Agent") }),
      call: async ({ agent: agentRef }) => {
        const { state, agent } = findAgent(agentRef);
        if (isMaestroAgent(state, agent)) return error("Your own terminal is not started or stopped here.");
        if (!isCliEngine(agentEngine(agent))) return error(`${agent.name} is simulated (engine mock): there is no terminal to start.`);
        const info = await deps.terminals.start(agent.id);
        return ok(`${agent.name}'s terminal: ${info.status}${info.error ? ` (${info.error})` : ""}.`);
      },
    }),
    defineTool({
      name: "stop_agent",
      description:
        "Stops a real agent's terminal (the session stays saved; the next task starts it again). If the agent is in the middle of a turn it refuses, unless force: true — that cuts the turn and FAILS the task in progress, so only with user_confirmed: true when the user asked for it.",
      input: z.object({
        agent: ref("Agent"),
        force: z.boolean().optional().describe("true = stop even in the middle of a turn (the task in progress fails)"),
        user_confirmed: z.boolean().optional().describe("Required with force: true — the user explicitly asked to stop the agent now"),
      }),
      call: async ({ agent: agentRef, force, user_confirmed }) => {
        const { state, agent } = findAgent(agentRef);
        if (isMaestroAgent(state, agent)) return error("Your own terminal is not started or stopped here.");
        if (!isCliEngine(agentEngine(agent))) return error(`${agent.name} is simulated (engine mock): there is no terminal to stop.`);
        if (force && user_confirmed !== true) return error("force: true cuts the turn and fails the task in progress: only with user_confirmed: true, when the user asked for it.");
        try {
          const info = await deps.terminals.stop(agent.id, { force: force === true });
          return ok(`${agent.name}'s terminal: ${info.status}. The session is saved.`);
        } catch (cause) {
          if (cause instanceof HttpError && cause.statusCode === 409) {
            return error(`${agent.name} is in the middle of a turn: stopping now cuts the work in progress. Tell the user; if they still want it, call again with force: true and user_confirmed: true.`);
          }
          throw cause;
        }
      },
    }),
    defineTool({
      name: "message_agent",
      description: [
        "Sends a message to a team agent, like the chat box in their panel: if they are working on a task it becomes a live NOTE on that task (e.g. a course correction); if they are free it is a CONVERSATION (not a task: for new work, use open_request/delegate_task).",
        "The agent's reply does NOT come back to you as a message: read it later with get_agent_activity (or the task's result with get_task).",
      ].join(" "),
      input: z.object({ agent: ref("Agent"), text: z.string().trim().min(1).max(4000).describe("The message, in Brazilian Portuguese") }),
      call: async ({ agent: agentRef, text }) => {
        const { state, agent } = findAgent(agentRef);
        if (isMaestroAgent(state, agent)) return error("That is you.");
        const sent = await deps.chat.send(agent.id, `(Mensagem do Maestro, não do usuário) ${text}`);
        if (sent.mode === "nota") {
          return ok(`Sent to ${agent.name} as a note on task ${sent.taskId}${sent.live ? " (delivered live)" : " (queued: it arrives at the end of the current turn)"}. Check later with get_agent_activity.`);
        }
        return ok(`Sent to ${agent.name} as a conversation (they had no task in progress). Their reply shows up in get_agent_activity.`);
      },
    }),
    defineTool({
      name: "get_agent_activity",
      description: "Shows an agent's latest log entries (all tasks and conversations, newest last): what they said, tools used, progress, results and replies to message_agent.",
      input: z.object({ agent: ref("Agent"), limit: z.number().int().min(1).max(60).optional().describe("How many entries (default 20)") }),
      call: async ({ agent: agentRef, limit }) => {
        const { state, agent } = findAgent(agentRef);
        const entries = await deps.agentLog.recentForAgent(agent.id, limit ?? 20);
        const summary = deps.agentLog.summary(agent.id);
        const head = `${agent.name} (${agent.id}) — status: ${agent.status}${summary.activeTaskId ? `; working on task ${summary.activeTaskId}` : ""}${summary.activeSubagents > 0 ? `; ${summary.activeSubagents} subagent(s) running` : ""}`;
        if (entries.length === 0) return ok(`${head}\n(no activity logged yet)`);
        const titles = new Map(state.tasks.map((task) => [task.id, titleOf(task)]));
        let lastTask = "";
        const lines: string[] = [head];
        for (const entry of entries) {
          if (entry.taskId !== lastTask) {
            lastTask = entry.taskId;
            lines.push(`## ${titles.has(entry.taskId) ? `Task ${entry.taskId}: ${titles.get(entry.taskId)}` : isConversationLogId(entry.taskId) ? "Conversation" : `Log ${entry.taskId}`}`);
          }
          const line = describeEntry(entry);
          if (line) lines.push(`- ${entry.at.slice(11, 16)} ${entry.thread ? `[${entry.thread}] ` : ""}${line}`);
        }
        return ok(lines.join("\n"));
      },
    }),
    defineTool({
      name: "list_requests",
      description: "Lists the workspace's requests (the ones you opened or the user created): id, status, title, plan and subtasks. Default: the open ones.",
      input: z.object({
        status: z.enum(REQUEST_FILTERS).optional().describe("open (default: queued, in progress or waiting), done, failed or all"),
        limit: z.number().int().min(1).max(50).optional().describe("Most recent first (default 20)"),
      }),
      call: ({ status = "open", limit }) => {
        const state = deps.state.read();
        const plans = (deps.plans?.list() ?? []).filter(isPlanProject);
        const requests = state.tasks
          .filter((task) => isMaestroTask(state, task))
          .filter((task) => status === "all" || (status === "open" ? !["done", "failed"].includes(task.status) : task.status === status))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, limit ?? 20);
        if (requests.length === 0) return ok(`No ${status === "all" ? "" : `${status} `}requests.`);
        const names = new Map(state.agents.map((agent) => [agent.id, agent.name]));
        return ok(
          requests
            .map((request) => {
              const subtasks = subtasksOf(state.tasks, request.id);
              const plan = plans.find((candidate) => candidate.id === request.id);
              const planText = plan ? `; plan: ${planStatusInput(plan.status)} (${plan.tasks.filter(isPlanTaskFinished).length}/${plan.tasks.length} tasks)` : "";
              const subs = subtasks.length > 0 ? `; subtasks: ${subtasks.map((sub) => `${names.get(sub.agentId ?? "") ?? "?"} ${sub.status}`).join(", ")}` : "";
              const waiting = request.waiting ? `; waiting: ${oneLine(request.waiting, 80)}` : "";
              return `- ${request.id} — ${request.status} — “${titleOf(request)}” (opened ${request.createdAt.slice(0, 16).replace("T", " ")})${planText}${subs}${waiting}`;
            })
            .join("\n"),
        );
      },
    }),
    defineTool({
      name: "list_projects",
      description: "Lists the requests' projects: project id, request id, status and progress (use get_project(request_id) for the detail).",
      input: z.object({ status: z.enum(PLAN_STATUS_IDS).optional().describe(`${PLAN_STATUS_IDS.join(", ")} (default: all)`) }),
      call: ({ status }) => {
        const plans = (deps.plans?.list() ?? []).filter(isPlanProject).filter((plan) => !status || plan.status === PLAN_STATUS_INPUTS[status]);
        if (plans.length === 0) return ok(status ? `No ${status} plans.` : "No plans yet.");
        return ok(
          plans
            .slice(-30)
            .reverse()
            .map((plan) => {
              const failed = plan.tasks.filter((task) => task.status === "falhou").map((task) => task.ref);
              return `- ${plan.id} — request ${plan.id} — ${planStatusInput(plan.status)} — “${oneLine(plan.title, 80)}”: ${plan.tasks.filter(isPlanTaskFinished).length}/${plan.tasks.length} tasks finished${failed.length > 0 ? `; FAILED: ${failed.join(", ")}` : ""}`;
            })
            .join("\n"),
        );
      },
    }),
    defineTool({
      name: "get_usage",
      description: "Shows the user's subscription usage per engine (5-hour and weekly windows, when they reset), which engines are available, and which agents used the most in the last 5 hours.",
      input: z.object({}),
      call: async () => ok(await usageReport({ usages: deps.usage?.() ?? [], engines: (await deps.engines?.()) ?? [], availability: deps.availability, agentUsage: deps.agentUsage?.(), names: new Map(deps.state.read().agents.map((agent) => [agent.id, agent.name])), now: deps.now().getTime() })),
    }),
  ];
  // `list_plans` é o nome antigo (apelido por uma versão; não aparece no tools/list).
  return [...tools, ...tools.filter((tool) => tool.name === "list_projects").map((tool) => ({ ...tool, name: "list_plans", listed: false }))];
}

/** Uma linha por entrada do log (compacta, para o modelo). */
function describeEntry(entry: AgentLogEntry): string | undefined {
  switch (entry.kind) {
    case "text":
      return `said: ${oneLine(entry.text, 240)}`;
    case "tool":
      return `tool ${entry.name}${entry.summary ? ` (${oneLine(entry.summary, 100)})` : ""}: ${entry.status}`;
    case "progress":
      return `progress ${Math.round(entry.progress * 100)}%: ${entry.message}`;
    case "approval":
      return entry.phase === "asked" ? `asked the user: ${entry.question}` : `user ${entry.approved ? "approved" : "rejected"}${entry.note ? `: ${entry.note}` : ""}`;
    case "delegation":
      return `delegated to ${entry.toAgentName ?? entry.teamName} (subtask ${entry.subtaskId})`;
    case "subagent":
      return entry.phase === "started" ? `subagent ${entry.label} started` : `subagent ${entry.label} ${entry.status}`;
    case "status":
      return `${entry.status}: ${entry.message}`;
    case "result":
      return `RESULT: ${oneLine(entry.text, 600)}`;
    case "chat":
      return `${entry.from === "user" ? "message to agent" : "agent replied"}: ${oneLine(entry.text, 400)}`;
    case "raw":
      return undefined;
  }
}
