import { PROJECT_INPUT_PRIORITIES, PROJECT_LIMITS, isoFromInput, leavesOf, paceFromInput, sprintDay } from "@cyno/shared";
import { z } from "zod";
import type { ProjectUpdate } from "../workspace/projects/project-service";
import { defineTool, type McpTool } from "./protocol";
import { requestId, text } from "./tool-fields";
import type { OfficeToolsDeps } from "./office-tools";

/** Ferramentas de projeto do Maestro (create_project & cia; os nomes antigos `*_plan*` seguem como apelidos por uma versão). */

const isoString = z.string().trim().max(40);
const isoField = (what: string) => isoString.optional().describe(`${what} (ISO 8601, e.g. "2026-11-20T18:00:00-03:00" or "2026-11-20")`);
const clearableIso = (what: string) => z.union([isoString, z.null()]).optional().describe(`${what} (ISO 8601), or null to clear`);

/** Uma tarefa do projeto (create_project / add_project_tasks). */
export const projectTaskField = z.object({
  ref: z.string().trim().max(PROJECT_LIMITS.ref).optional().describe('Short unique alias (e.g. "T1"), used in depends_on. Without it: T1, T2…'),
  title: z.string().trim().min(1).max(PROJECT_LIMITS.title).describe("Short task title"),
  briefing: z.string().trim().min(1).max(PROJECT_LIMITS.briefing).describe("What to do, with the context the agents need (they did not see the conversation)"),
  owner: z.string().trim().min(1).max(64).optional().describe('Who is responsible (agentId, name or "workspace/agent"; see get_team). REQUIRED on every task that does the work (a leaf); omit it on deliverables (kind "group") and on parent tasks, whose subtasks have the owners'),
  parent: z.string().trim().min(1).max(PROJECT_LIMITS.ref).optional().describe("Ref of the parent: a deliverable (kind group) or a task, in this call or already in the project. Depth: deliverable > task > subtask (at most 3 levels). Omit for a top-level item"),
  kind: z.enum(["task", "group"]).optional().describe('"group" = a DELIVERABLE (e.g. "Front-End"): a heading with tasks inside, no owner, no steps, never runs, only at the top level. Default "task"'),
  sprint: z.string().trim().min(1).max(64).optional().describe("Sprint of this task: the ref given in sprints[] (or its id like S1, or its name). Only on tasks that do the work, not on deliverables or parents. Without it: the first sprint (in create_project) or the active one (in add_project_tasks)"),
  labels: z.array(z.string().trim().min(1).max(24)).max(PROJECT_LIMITS.labelsPerTask).optional().describe('Label names (e.g. ["front"]); created in the project when missing'),
  steps: z
    .array(z.object({ agent: z.string().trim().min(1).max(64).describe('agentId, name or "workspace/agent"'), does: z.string().trim().min(1).max(PROJECT_LIMITS.stepWhat).describe("What this agent does in this step") }))
    .max(PROJECT_LIMITS.steps)
    .optional()
    .describe("LEGACY, avoid: participants in order inside ONE task. Prefer one subtask per agent with depends_on (each one has its own briefing, status and delivery). Without steps: only the owner, doing the briefing."),
  depends_on: z.array(z.string().trim().min(1).max(PROJECT_LIMITS.ref)).max(PROJECT_LIMITS.tasks).optional().describe("Refs of the tasks that must finish first; their full delivery is handed to this task when it starts (siblings of the same parent form a chain this way)"),
  priority: z.enum(PROJECT_INPUT_PRIORITIES).optional().describe("high, normal (default) or low: who starts first when there is a queue"),
  approval_type: z.string().trim().min(1).max(40).optional().describe("Approval type id of the deliverable, if it goes to approval (the last agent receives the character limit)"),
  done_when: z
    .array(z.string().trim().min(1).max(300))
    .max(10)
    .optional()
    .describe('"Done when…" criteria, short and checkable (e.g. "5 posts under 1200 characters", "each post has a hook in the first line"). The agent receives them, checks each one and reports before delivering.'),
  start_at: isoField("The task only starts after this moment"),
  due_at: isoField("The task should finish by this moment"),
});

/** Ritmo do projeto: horas por dia e janela de horário. */
const paceObject = z.object({
    hours_per_day: z.number().positive().max(24).optional().describe("How many hours per day the project may work (e.g. 1.5)"),
    window: z
      .object({ from: z.string().regex(/^\d{2}:\d{2}$/, 'Use "HH:MM"'), to: z.string().regex(/^\d{2}:\d{2}$/, 'Use "HH:MM"') })
      .optional()
      .describe('Time-of-day window (server local time) in which the project may work, e.g. {"from":"09:00","to":"12:00"}'),
    max_parallel: z.number().int().min(1).max(10).optional().describe("How many steps of this project may run at the same time"),
});
/** Sprint da proposta (create_project). */
const sprintField = z.object({
  ref: z.string().trim().min(1).max(PROJECT_LIMITS.ref).optional().describe('Alias that tasks cite in "sprint" (e.g. "S1"). Without it the sprints are S1, S2… in order'),
  name: z.string().trim().min(1).max(60).describe('Sprint name in Brazilian Portuguese (e.g. "Sprint 1 · Base")'),
  goal: z.string().trim().max(400).optional().describe("The sprint's goal, one sentence"),
  start_at: isoField("When the sprint starts (default: when the previous one ends; the first one, at the project start_at or now)"),
  end_at: isoField("When the sprint ends"),
  duration_days: z.number().int().min(1).max(60).optional().describe("Length in days when end_at is omitted (default 7)"),
});
const labelField = z.object({ name: z.string().trim().min(1).max(24), color: z.enum(["blue", "green", "amber", "rose", "violet", "teal"]).optional() });
const PACE_HELP = "How fast the project should go. Leave it out unless the user said something about pace or hours.";

/** Registra uma ferramenta sob o nome novo e um apelido antigo (que continua chamável, mas não aparece no tools/list). */
function withAlias(tool: McpTool, oldName: string): McpTool[] {
  return [tool, { ...tool, name: oldName, description: `Deprecated alias of ${tool.name}. ${tool.description}`, listed: false }];
}

/** Ferramentas de projeto do Maestro. */
export function planTools(maestro: OfficeToolsDeps["maestro"], plans: NonNullable<OfficeToolsDeps["plans"]>): McpTool[] {
  const createProject = defineTool({
    name: "create_project",
    description: [
      "Splits a BIG request (several parts, more than one agent, work in sequence, or the user said \"project\") into a project of tasks. Each task that does the work has ONE owner, its own briefing, depends_on, priority, optional done_when / start_at / due_at. When a task needs more than one agent, make it a parent with ONE SUBTASK PER AGENT (parent = the task ref), each with its own briefing, done_when and depends_on (a chain when one needs the previous result, parallel when independent, ending in a review/check subtask when it makes sense). When a subtask starts, its agent receives the full delivery of the subtasks it depends on; the parent finishes when all subtasks finish. There is no fixed limit of agents per task: use only who the task really needs (a simple task keeps a single agent; at most 12 subtasks per task). You decide the flow.",
      "Fill in what the request implies: due_at/start_at when the user mentioned dates (\"one per day this week\" = one task per day with its own start_at/due_at), priority when it is urgent or secondary, done_when with the checkable criteria of each deliverable, pace only if the user said something about hours.",
      "The project goes to the user to APPROVE before anything starts. Once approved, the server distributes the tasks by itself (dependencies, parallel limits, each agent's queue) and hands each delivery to the next subtask; you are only called when EVERYTHING finishes (a message with the summary) or if something needs you (failure, help request, stall).",
      "Calling it again before approval sends a new version. Simple request (one agent, one deliverable): use delegate_task.",
      "ONE call builds the whole proposal: deliverables (kind \"group\") with tasks inside (parent), subtasks (one per agent, chained with depends_on or parallel), sprints[] with dates (and sprint on each task), labels. A flat list of tasks (the old format) still works. The server validates the tree and answers with the exact problems (which task, which rule): fix them and call again.",
      'suggested_mode "auto" (with auto_scope) only SUGGESTS that the user lets approvals of those types run without asking; it does nothing until the user accepts on the project card.',
    ].join(" "),
    input: z.object({
      request_id: requestId,
      title: z.string().trim().min(1).max(PROJECT_LIMITS.title).optional().describe("Project title, in Brazilian Portuguese (defaults to the request title)"),
      summary: z.string().trim().max(1000).optional().describe("One or two sentences for the user about the project (shown at the top)"),
      priority: z.enum(PROJECT_INPUT_PRIORITIES).optional().describe("Project priority: high, normal (default) or low"),
      start_at: isoField("The project starts at this moment (omit to start right after approval)"),
      due_at: isoField("The project's deadline"),
      pace: paceObject.optional().describe(PACE_HELP),
      suggested_mode: z.enum(["auto"]).optional().describe('"auto": suggest Automatic mode (see auto_scope). Only a suggestion.'),
      auto_scope: z
        .object({
          actions: z.array(z.string().trim().min(1).max(40)).min(1).max(10).describe("Approval type ids the user would let run without asking (e.g. [\"comentario\"])"),
          sites: z.array(z.string().trim().min(1).max(100)).max(10).optional().describe("Sites where it applies"),
          connectors: z.array(z.string().trim().min(1).max(100)).max(10).optional().describe("Connectors where it applies"),
          daily_cap: z.number().int().min(0).max(1000).optional().describe("Maximum automatic decisions per day"),
        })
        .optional()
        .describe('Required with suggested_mode "auto": the narrowest scope that makes sense'),
      sprints: z.array(sprintField).max(PROJECT_LIMITS.sprints).optional().describe("Time boxes (about a week each) with a one-sentence goal and dates. Only for big or long projects; tasks go into them with their sprint field. Leave out for short projects"),
      labels: z.array(labelField).max(PROJECT_LIMITS.labels).optional().describe("Labels of the project (e.g. front, backend); tasks cite them by name in labels"),
      tasks: z.array(projectTaskField).min(1).max(PROJECT_LIMITS.tasks),
    }),
    call: async ({ request_id, tasks, sprints, labels, summary, title, priority, start_at, due_at, pace, suggested_mode, auto_scope }) => {
      const request = maestro.requestFor(request_id);
      const project = await plans.propose(request.id, {
        tasks,
        ...(sprints ? { sprints } : {}),
        ...(labels ? { labels } : {}),
        ...(title ? { title } : {}),
        ...(summary ? { summary } : {}),
        ...(priority ? { priority } : {}),
        ...(start_at ? { start_at } : {}),
        ...(due_at ? { due_at } : {}),
        ...(pace ? { pace } : {}),
        ...(suggested_mode ? { suggested_mode } : {}),
        ...(auto_scope ? { auto_scope } : {}),
      });
      const sprintText = project.sprints?.length ? ` in ${project.sprints.length} sprint(s) (${project.sprints.map((sprint) => `${sprint.name} ${sprintDay(sprint.startAt)}-${sprintDay(sprint.endAt)}`).join("; ")})` : "";
      return text(
        `Project with ${leavesOf(project).length} task(s)${sprintText} sent to the user for approval (Para você). Say so in one sentence and end the turn: nothing starts before approval; the user can edit the tree before approving; then the server distributes everything (the first sprint opens on its date) and you get a message only at the end (or if something goes wrong).`,
      );
    },
  });
  const addTasks = defineTool({
    name: "add_project_tasks",
    description:
      "Adds tasks to an already approved project (e.g. after a help request or a failure). Same task format as create_project, including parent (an existing deliverable or task), kind \"group\" and sprint (an existing sprint); depends_on may reference existing tasks. Without sprint, the task goes into the active sprint. No new approval needed.",
    input: z.object({ request_id: requestId, tasks: z.array(projectTaskField).min(1).max(PROJECT_LIMITS.tasks) }),
    call: ({ request_id, tasks }) => {
      const request = maestro.requestFor(request_id);
      const project = plans.addTasks(request.id, tasks);
      return text(`Added. The project now has ${leavesOf(project).length} task(s). End the turn.`);
    },
  });
  const resolveTask = defineTool({
    name: "resolve_task",
    description:
      'Resolves a project task that failed: "retry" (back to the queue at the same step; pass an instruction with what to change), "skip" (marked as skipped: dependents proceed, but it does not count as done) or "cancel_project" (stops everything; then close the request with complete_request).',
    input: z.object({
      request_id: requestId,
      ref: z.string().trim().min(1).max(PROJECT_LIMITS.ref).describe('Task ref (e.g. "T3"); for cancel_project, any of them'),
      action: z.enum(["retry", "skip", "cancel_project", "cancel_plan"]).describe('"cancel_plan" is the old name of "cancel_project"'),
      instruction: z.string().trim().max(1000).optional().describe("What to change in the new attempt (retry) or why"),
    }),
    call: ({ request_id, ref, action, instruction }) => {
      const request = maestro.requestFor(request_id);
      return text(plans.decideTask(request.id, ref, action, instruction));
    },
  });
  const getProject = defineTool({
    name: "get_project",
    description: "Shows a request's project: priority, dates, the sprints with their state (and a warning when none is active), what waits for the user (plan approval, a sprint delivery, an approval), and the tree (deliverable > task > subtask) with status, owners, sprint, steps (who already did it, who is doing it), dependencies and failures.",
    input: z.object({ request_id: requestId }),
    call: ({ request_id }) => text(plans.describe(maestro.requestFor(request_id).id)),
  });
  const updateProject = defineTool({
    name: "update_project",
    description:
      "Changes an existing project (also after approval): title, priority, start_at, due_at and pace. Send only what changes; null clears a date or the pace. It does not change the tasks or the mode.",
    input: z.object({
      project_id: z.string().trim().min(1).max(64).describe("Project id (the same as its request id)"),
      title: z.string().trim().min(1).max(PROJECT_LIMITS.title).optional(),
      priority: z.enum(PROJECT_INPUT_PRIORITIES).optional(),
      start_at: clearableIso("The project starts at this moment"),
      due_at: clearableIso("The project's deadline"),
      pace: z.union([paceObject, z.null()]).optional().describe("New pace (hours per day, window, max parallel), or null to clear"),
    }),
    call: async ({ project_id, title, priority, start_at, due_at, pace }) => {
      const patch: ProjectUpdate = {};
      if (title) patch.title = title;
      if (priority) patch.priority = ({ high: "alta", normal: "normal", low: "baixa" } as const)[priority];
      for (const [key, value] of [["startAt", start_at], ["dueAt", due_at]] as const) {
        if (value === undefined) continue;
        if (value === null) patch[key] = null;
        else {
          const iso = isoFromInput(value);
          if (!iso) throw new Error(`${key === "startAt" ? "start_at" : "due_at"} "${value}" is not a valid date (use ISO 8601)`);
          patch[key] = iso;
        }
      }
      if (pace !== undefined) patch.pace = pace === null ? null : (paceFromInput(pace) ?? null);
      if (Object.keys(patch).length === 0) throw new Error("Nothing to change: send title, priority, start_at, due_at or pace");
      const project = await plans.updateProject(project_id, patch);
      return text(`Project ${project.id} updated (${Object.keys(patch).join(", ")}). Tell the user in one sentence.`);
    },
  });
  const sprintId = z.string().trim().min(1).max(60).describe('Sprint id (e.g. "S2") or its name; see get_project');
  const projectId = z.string().trim().min(1).max(64).describe("Project id (the same as its request id)");
  const toIso = (value: string | undefined, key: string): string | undefined => {
    if (value === undefined) return undefined;
    const iso = isoFromInput(value);
    if (!iso) throw new Error(`${key} "${value}" is not a valid date (use ISO 8601)`);
    return iso;
  };
  const addSprintTool = defineTool({
    name: "add_sprint",
    description: "Adds a sprint (a time box, about a week) at the end of an existing project. Without start_at it starts when the previous one ends. Then put tasks in it with move_task (or add_project_tasks with sprint). It opens by itself on its start date.",
    input: z.object({
      project_id: projectId,
      name: z.string().trim().min(1).max(60).optional().describe('Sprint name in Brazilian Portuguese (default "Sprint N")'),
      goal: z.string().trim().max(400).optional().describe("The goal, one sentence"),
      start_at: isoField("When it starts"),
      end_at: isoField("When it ends"),
      duration_days: z.number().int().min(1).max(60).optional().describe("Length in days when end_at is omitted (default 7)"),
    }),
    call: async ({ project_id, name, goal, start_at, end_at, duration_days }) => {
      const startAt = toIso(start_at, "start_at");
      let endAt = toIso(end_at, "end_at");
      if (!endAt && duration_days && startAt) endAt = new Date(Date.parse(startAt) + duration_days * 86_400_000).toISOString();
      const { project, sprintId: id } = await plans.createSprint(project_id, { ...(name ? { name } : {}), ...(goal ? { goal } : {}), ...(startAt ? { startAt } : {}), ...(endAt ? { endAt } : {}) }, "maestro");
      const sprint = project.sprints!.find((candidate) => candidate.id === id)!;
      return text(`Sprint ${sprint.id} «${sprint.name}» added (${sprintDay(sprint.startAt)} to ${sprintDay(sprint.endAt)}). Move tasks into it with move_task. End the turn or continue.`);
    },
  });
  const updateSprintTool = defineTool({
    name: "update_sprint",
    description: "Changes a sprint that has not closed yet: name, goal, start_at, end_at (e.g. extend the end of the active one). Send only what changes; goal null clears it.",
    input: z.object({
      project_id: projectId,
      sprint: sprintId,
      name: z.string().trim().min(1).max(60).optional(),
      goal: z.union([z.string().trim().max(400), z.null()]).optional(),
      start_at: isoField("New start"),
      end_at: isoField("New end"),
    }),
    call: async ({ project_id, sprint, name, goal, start_at, end_at }) => {
      const patch = { ...(name ? { name } : {}), ...(goal !== undefined ? { goal } : {}), ...(toIso(start_at, "start_at") ? { startAt: toIso(start_at, "start_at")! } : {}), ...(toIso(end_at, "end_at") ? { endAt: toIso(end_at, "end_at")! } : {}) };
      if (Object.keys(patch).length === 0) throw new Error("Nothing to change: send name, goal, start_at or end_at");
      await plans.updateSprint(project_id, plans.sprintIdOf(project_id, sprint), patch, "maestro");
      return text(`Sprint updated (${Object.keys(patch).join(", ")}).`);
    },
  });
  const moveTaskTool = defineTool({
    name: "move_task",
    description: 'Moves a task: to another sprint (sprint; null = no sprint) and/or under another parent (parent: a deliverable or task ref; null = top level), optionally before a sibling. Only tasks that did not finish; a closed sprint does not receive tasks.',
    input: z.object({
      project_id: projectId,
      ref: z.string().trim().min(1).max(PROJECT_LIMITS.ref).describe('Task ref (e.g. "T3")'),
      sprint: z.union([sprintId, z.null()]).optional().describe("Target sprint id or name; null = no sprint (backlog)"),
      parent: z.union([z.string().trim().min(1).max(PROJECT_LIMITS.ref), z.null()]).optional().describe("New parent ref; null = top level"),
      before: z.string().trim().min(1).max(PROJECT_LIMITS.ref).optional().describe("Sibling ref the task goes before (default: the end)"),
    }),
    call: async ({ project_id, ref, sprint, parent, before }) => {
      if (sprint === undefined && parent === undefined && before === undefined) throw new Error("Nothing to move: send sprint, parent or before");
      await plans.moveTask(project_id, ref, { ...(parent !== undefined ? { parent } : {}), ...(before ? { before } : {}), ...(sprint !== undefined ? { sprintId: sprint === null ? null : plans.sprintIdOf(project_id, sprint) } : {}) }, "maestro");
      return text(`Task ${ref} moved.`);
    },
  });
  const assignTaskTool = defineTool({
    name: "assign_task",
    description:
      'Sets who does a task that has not started: one agent replaces the owner; several agents turn the task into a parent with ONE SUBTASK PER AGENT. Mode "chain" (default): each subtask waits for the previous one and receives its full delivery; mode "parallel": all run together; mode "sequence" is the legacy format (steps inside one task), avoid it. There is no fixed limit of agents: use only who the task really needs (at most 12 subtasks per task). For a task with subtasks, assign the subtasks.',
    input: z.object({
      project_id: projectId,
      ref: z.string().trim().min(1).max(PROJECT_LIMITS.ref).describe('Task ref (e.g. "T3")'),
      assignees: z.array(z.string().trim().min(1).max(64)).min(1).max(PROJECT_LIMITS.subtasksPerTask).describe('agentIds or names (see get_team), in the order of the work'),
      mode: z.enum(["chain", "parallel", "sequence"]).optional().describe('How several agents share the task: "chain" (default, one subtask per agent, each after the previous), "parallel" or "sequence" (legacy steps)'),
    }),
    call: async ({ project_id, ref, assignees, mode }) => {
      await plans.assignTask(project_id, ref, assignees, mode ?? "chain", "maestro");
      return text(`Task ${ref} assigned to ${assignees.join(", ")}${assignees.length > 1 ? ` (${mode ?? "chain"})` : ""}.`);
    },
  });
  const reassignTaskTool = defineTool({
    name: "reassign_task",
    description:
      "Moves a STUCK task to another agent and puts it back in the queue: use it when the task failed, is blocked (no quota, no access) or sits in the queue behind a busy agent. It changes the agent of the current step (or of `step`, 0-based) and clears the block or the failure. It refuses (and says why) when a step of the task is running or waits for the owner: cancel that step first. Unlike assign_task it works after the task started; the work done by earlier steps stays.",
    input: z.object({
      project_id: projectId,
      ref: z.string().trim().min(1).max(PROJECT_LIMITS.ref).describe('Task ref (e.g. "T3")'),
      agent: z.string().trim().min(1).max(64).describe("agentId or name of the agent who takes it (see get_team)"),
      step: z.number().int().min(0).max(PROJECT_LIMITS.steps - 1).optional().describe("Index (0-based) of the step to hand over; default: the current step"),
    }),
    call: async ({ project_id, ref, agent, step }) => {
      await plans.reassignTask(project_id, ref, { agentId: agent, ...(step !== undefined ? { step } : {}) }, "maestro");
      return text(`Task ${ref} reassigned to ${agent} and back in the queue. Tell the user in one sentence.`);
    },
  });
  const closeSprintTool = defineTool({
    name: "close_sprint",
    description:
      "Starts closing the ACTIVE sprint before its end date (e.g. everything in it is done): what was left goes to the next sprint by code, the delivery summary is built and sent to the user as a card in Aprovações. The sprint only becomes closed when the user approves the summary (or the Automatic mode does): you do not decide that.",
    input: z.object({ project_id: projectId, sprint: sprintId }),
    call: async ({ project_id, sprint }) => {
      const project = await plans.closeSprint(project_id, plans.sprintIdOf(project_id, sprint), "maestro");
      const closed = project.sprints!.find((candidate) => candidate.id === plans.sprintIdOf(project_id, sprint))!;
      return text(`Sprint ${closed.id} is closing: ${closed.summary ? `${closed.summary.done.length} done, ${closed.summary.carried.length} carried over; ` : ""}the delivery summary waits for the user's OK in Aprovações. Tell the user in one sentence.`);
    },
  });
  return [
    addSprintTool,
    updateSprintTool,
    moveTaskTool,
    assignTaskTool,
    reassignTaskTool,
    closeSprintTool,
    ...withAlias(createProject, "create_plan"),
    ...withAlias(addTasks, "add_plan_tasks"),
    ...withAlias(resolveTask, "resolve_plan_task"),
    ...withAlias(getProject, "get_plan"),
    updateProject,
  ];
}
