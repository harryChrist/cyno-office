import { DEFAULT_PLAN_APPROVAL, PROJECT_INPUT_APPROVALS, PROJECT_INPUT_PRIORITIES, PROJECT_INPUT_RELEASES, PROJECT_LIMITS, PROJECT_SAFETY, RELEASE_PACE_LIMITS, isoFromInput, leavesOf, paceFromInput, sprintDay, type PlanApprovalRule, type TaskPatchBody } from "@cyno/shared";
import { z } from "zod";
import type { ProjectUpdate } from "../workspace/projects/project-service";
import { defineTool, type McpTool } from "./protocol";
import { requestId, text } from "./tool-fields";
import type { OfficeToolsDeps } from "./office-tools";

/** Ferramentas de projeto do Maestro (create_project & cia; os nomes antigos `*_plan*` seguem como apelidos por uma versão). */

const isoString = z.string().trim().max(40);
const isoField = (what: string) => isoString.optional().describe(`${what} (ISO 8601, e.g. "2026-11-20T18:00:00-03:00" or "2026-11-20")`);
const clearableIso = (what: string) => z.union([isoString, z.null()]).optional().describe(`${what} (ISO 8601), or null to clear`);

const PRIORITY_MAP = { high: "alta", normal: "normal", low: "baixa" } as const;
const STATUS_MAP = { active: "ativo", paused: "pausado", completed: "concluido", canceled: "cancelado" } as const;
const APPROVAL_RULE_MAP: Record<"always_ask" | "never_ask" | "maestro_decides", PlanApprovalRule> = {
  always_ask: "always",
  never_ask: "never",
  maestro_decides: "maestro",
};

const RELEASE_CALL_HELP =
  'REQUIRED: "now" = enters the queue right away and runs when slots, agents and dependencies allow; "later" = stays Planned until someone releases it. YOU decide from what the owner said: structuring, discussing or planning = "later"; "já pode fazer" / "pode começar" = "now". Items may override this individually.';

const APPROVAL_CALL_HELP =
  'REQUIRED: "ask" = send the project to the owner for approval before anything starts, use it when the structure is a proposal worth confirming; "skip" = start without asking, use it when the owner already said how it should be or told you not to ask. The workspace rule overrides this when set to "always" or "never".';

const targetProjectId = z.string().trim().min(1).max(64).optional().describe("Project id (from create_project or list_projects; works on manual projects too). Pass either project_id or request_id, not both");
const targetRequestId = z.string().trim().min(1).max(64).optional().describe('Request id (from open_request or a "Pedido <id>" message). Pass either project_id or request_id, not both');
const targetRule = (value: { project_id?: string | undefined; request_id?: string | undefined }) => Boolean(value.project_id) !== Boolean(value.request_id);
const targetMessage = { message: "Pass either project_id or request_id (exactly one)" };

/** Uma tarefa ou módulo de projeto novo (create_project: sem sprints). */
const createProjectTaskField = z.object({
  ref: z.string().trim().max(PROJECT_LIMITS.ref).optional().describe('Short unique alias (e.g. "T1", "M1"), used in depends_on and parent. Without it: T1, T2…'),
  title: z.string().trim().min(1).max(PROJECT_LIMITS.title).describe("Short task or module title"),
  briefing: z.string().trim().min(1).max(PROJECT_LIMITS.briefing).describe("What to do, with the context the agents need (they did not see the conversation)"),
  owner: z.string().trim().min(1).max(64).optional().describe('Who is responsible (agentId, name or "workspace/agent"; see get_team). REQUIRED on every leaf task that does the work; omit it on modules (kind "module") and on parent tasks, whose subtasks have the owners'),
  parent: z.string().trim().min(1).max(PROJECT_LIMITS.ref).optional().describe("Ref of the parent: a module (kind module) or a task, in this call or already in the project. A module can sit inside another module and a subtask inside a subtask: no fixed depth. Omit for a top-level item"),
  kind: z.enum(["task", "module", "group"]).optional().describe('"module" (or legacy alias "group") = a MODULE (e.g. "Front-End"): a container with tasks or submodules inside, no owner, no steps, never runs, at any depth. May have depends_on (it then starts only after those items finish). Default "task"'),
  release: z
    .enum(PROJECT_INPUT_RELEASES)
    .optional()
    .describe('Optional per-item override: "now" (enters the queue) or "later" (stays Planned). On a module, it also applies to children that do not set their own release. Omit to inherit from the parent or from the call-level release'),
  labels: z.array(z.string().trim().min(1).max(24)).max(PROJECT_LIMITS.labelsPerTask).optional().describe('Label names (e.g. ["front"]); created in the project when missing'),
  steps: z
    .array(z.object({ agent: z.string().trim().min(1).max(64).describe('agentId, name or "workspace/agent"'), does: z.string().trim().min(1).max(PROJECT_LIMITS.stepWhat).describe("What this agent does in this step") }))
    .max(PROJECT_LIMITS.steps)
    .optional()
    .describe("LEGACY, avoid: participants in order inside ONE task. Prefer one subtask per agent with depends_on (each one has its own briefing, status and delivery). Without steps: only the owner, doing the briefing."),
  depends_on: z
    .array(z.string().trim().min(1).max(PROJECT_LIMITS.ref))
    .max(PROJECT_SAFETY.perCall)
    .optional()
    .describe("Refs of the tasks or modules that must finish first (works between modules, from a module to a task, and from a task to a module; a module counts as finished when all work inside it finished). Their full delivery is handed to this task when it starts"),
  priority: z.enum(PROJECT_INPUT_PRIORITIES).optional().describe("high, normal (default) or low: who starts first when there is a queue"),
  approval_type: z.string().trim().min(1).max(40).optional().describe("Approval type id of the output, if it goes to approval (the last agent receives the character limit)"),
  done_when: z
    .array(z.string().trim().min(1).max(300))
    .max(10)
    .optional()
    .describe('"Done when…" criteria, short and checkable (e.g. "5 posts under 1200 characters", "each post has a hook in the first line"). The agent receives them, checks each one and reports before delivering.'),
  start_at: isoField("The task only starts after this moment"),
  due_at: isoField("The task should finish by this moment"),
});

/** Uma tarefa ou módulo adicionado em projeto existente (`add_project_tasks`: aceita `sprint` só em projetos legados que já têm sprints). */
export const projectTaskField = createProjectTaskField.extend({
  sprint: z.string().trim().min(1).max(64).optional().describe("Only for projects that already use sprints: sprint ref, id (S1) or name. Only on leaf tasks, not on modules or parents"),
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
const labelField = z.object({ name: z.string().trim().min(1).max(24), color: z.enum(["blue", "green", "amber", "rose", "violet", "teal"]).optional() });
const PACE_HELP = "How fast the project should go. Leave it out unless the user said something about pace or hours.";

/** Registra uma ferramenta sob o nome novo e um apelido antigo (que continua chamável, mas não aparece no tools/list). */
function withAlias(tool: McpTool, oldName: string): McpTool[] {
  return [tool, { ...tool, name: oldName, description: `Deprecated alias of ${tool.name}. ${tool.description}`, listed: false }];
}

/** Ferramentas de projeto do Maestro (criar, editar, liberar, gerenciar e apagar projetos a pedido do dono). */
export function planTools(maestro: OfficeToolsDeps["maestro"], plans: NonNullable<OfficeToolsDeps["plans"]>, planApproval?: OfficeToolsDeps["planApproval"]): McpTool[] {
  const projectId = z.string().trim().min(1).max(64).describe("Project id (from create_project or list_projects; works on manual projects too)");
  const sprintId = z.string().trim().min(1).max(60).describe('Sprint id (e.g. "S2") or its name; see get_project');
  const toIso = (value: string | undefined, key: string): string | undefined => {
    if (value === undefined) return undefined;
    const iso = isoFromInput(value);
    if (!iso) throw new Error(`${key} "${value}" is not a valid date (use ISO 8601)`);
    return iso;
  };
  const toClearableIso = (value: string | null | undefined, key: string): string | null | undefined => {
    if (value === undefined || value === null) return value;
    return toIso(value, key);
  };

  const createProject = defineTool({
    name: "create_project",
    description: [
      'Splits a BIG request (several parts, more than one agent, work in sequence, or the user said "project") into a project of modules and tasks. Each leaf task that does the work has ONE owner, its own briefing, depends_on, priority, optional done_when / start_at / due_at. When a task needs more than one agent, make it a parent with ONE SUBTASK PER AGENT (parent = the task ref), each with its own briefing, done_when and depends_on. Modules (kind "module", nestable at any depth) group tasks or other modules and support depends_on (module->module, module->task, task->module).',
      'REQUIRED `release` ("now" | "later"): YOU decide from what the owner said (structuring/planning/discussing = "later"; "já pode fazer" / "pode começar" = "now"). Any item or module can set its own `release`, and a module passes it to children that omit it.',
      'REQUIRED `approval` ("ask" | "skip"): approval is optional. Use "ask" when the structure is a proposal worth confirming before anything starts; use "skip" when the owner already said how it should be or told you not to ask. The workspace rule overrides this when set to "always" or "never".',
      "Calling it again before approval sends a new version. To create ANOTHER separate project under the same request, pass `new_project: true`. To add work to an existing or completed project, use add_project_tasks.",
      'suggested_mode "auto" (with auto_scope) only SUGGESTS that the user lets approvals of those types run without asking; it does nothing until the user accepts on the project card.',
    ].join(" "),
    input: z.object({
      request_id: requestId,
      release: z.enum(PROJECT_INPUT_RELEASES).describe(RELEASE_CALL_HELP),
      approval: z.enum(PROJECT_INPUT_APPROVALS).describe(APPROVAL_CALL_HELP),
      new_project: z.boolean().optional().describe("Set to true to create ANOTHER separate project in the same request (gets its own project_id). Omit or false for the request's main project (or a new version before approval)"),
      title: z.string().trim().min(1).max(PROJECT_LIMITS.title).optional().describe("Project title, in Brazilian Portuguese (defaults to the request title)"),
      summary: z.string().trim().max(1000).optional().describe("One or two sentences for the user about the project (shown at the top)"),
      priority: z.enum(PROJECT_INPUT_PRIORITIES).optional().describe("Project priority: high, normal (default) or low"),
      start_at: isoField("The project starts at this moment (omit to start right after approval)"),
      due_at: isoField("The project's deadline"),
      pace: paceObject.optional().describe(PACE_HELP),
      suggested_mode: z.enum(["auto"]).optional().describe('"auto": suggest Automatic mode (see auto_scope). Only a suggestion.'),
      auto_scope: z
        .object({
          actions: z.array(z.string().trim().min(1).max(40)).min(1).max(10).describe('Approval type ids the user would let run without asking (e.g. ["comentario"])'),
          sites: z.array(z.string().trim().min(1).max(100)).max(10).optional().describe("Sites where it applies"),
          connectors: z.array(z.string().trim().min(1).max(100)).max(10).optional().describe("Connectors where it applies"),
          daily_cap: z.number().int().min(0).max(1000).optional().describe("Maximum automatic decisions per day"),
        })
        .optional()
        .describe('Required with suggested_mode "auto": the narrowest scope that makes sense'),
      labels: z.array(labelField).max(PROJECT_LIMITS.labels).optional().describe("Labels of the project (e.g. front, backend); tasks cite them by name in labels"),
      tasks: z.array(createProjectTaskField).min(1).max(PROJECT_SAFETY.perCall),
    }),
    call: async ({ request_id, release, approval, new_project, tasks, labels, summary, title, priority, start_at, due_at, pace, suggested_mode, auto_scope }) => {
      const request = maestro.requestFor(request_id);
      const workspaceRule = planApproval?.get().rule ?? DEFAULT_PLAN_APPROVAL;
      const project = await plans.propose(request.id, {
        tasks,
        release,
        approval,
        ...(new_project ? { new_project } : {}),
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
      const leaves = leavesOf(project);
      if (project.status === "ativo") {
        const why =
          project.approval?.by === "regra"
            ? approval === "ask"
              ? 'workspace rule "never" overrode your "ask"'
              : 'workspace rule is "never"'
            : 'your choice "skip" (workspace rule is "maestro")';
        const planned = leaves.filter((leaf) => leaf.released === false).length;
        const released = leaves.length - planned;
        return text(
          `Project with ${leaves.length} task(s) (project_id: "${project.id}") started without asking for approval (${why}). ${released} released, ${planned} planned. The server distributes released tasks by itself and wakes you at the end (or if something fails or stalls).`,
        );
      }
      const why =
        workspaceRule === "always" || approval === "skip"
          ? approval === "skip"
            ? 'workspace rule "always" overrode your "skip"'
            : 'workspace rule is "always"'
          : 'your choice "ask" (workspace rule is "maestro")';
      return text(
        `Project with ${leaves.length} task(s) (project_id: "${project.id}") sent to the user for approval (Para você) (${why}). Say so in one sentence and end the turn: nothing starts before approval; the user can edit the tree before approving; then the server distributes released tasks and you get a message at the end (or if something goes wrong).`,
      );
    },
  });

  const addTasks = defineTool({
    name: "add_project_tasks",
    description:
      'Adds modules or tasks to an existing project (including completed projects, which reopen automatically, and manual owner projects via project_id). Pass either project_id or request_id (not both). REQUIRED `release` ("now" | "later") sets whether the new items enter the queue or stay Planned (items may override individually; an explicit "now" on a child inside a Planned parent runs as "now"). Supports nested modules (kind "module"), parent, and depends_on between modules and tasks. No new approval needed.',
    input: z
      .object({
        project_id: targetProjectId,
        request_id: targetRequestId,
        release: z.enum(PROJECT_INPUT_RELEASES).describe(RELEASE_CALL_HELP),
        tasks: z.array(projectTaskField).min(1).max(PROJECT_SAFETY.perCall),
      })
      .refine(targetRule, targetMessage),
    call: ({ project_id, request_id, release, tasks }) => {
      const target = project_id ? { projectId: project_id } : { requestId: maestro.requestFor(request_id).id };
      const project = plans.addTasks(target, tasks, { release });
      return text(`Added to project ${project.id}. It now has ${leavesOf(project).length} task(s).`);
    },
  });

  const resolveTask = defineTool({
    name: "resolve_task",
    description:
      'Resolves a project task that failed: "retry" (back to the queue at the same step; pass an instruction with what to change), "skip" (marked as skipped: dependents proceed, but it does not count as done) or "cancel_project" (stops the project). Pass either project_id or request_id (not both).',
    input: z
      .object({
        project_id: targetProjectId,
        request_id: targetRequestId,
        ref: z.string().trim().min(1).max(PROJECT_LIMITS.ref).describe('Task ref (e.g. "T3"); for cancel_project, any of them'),
        action: z.enum(["retry", "skip", "cancel_project", "cancel_plan"]).describe('"cancel_plan" is the old name of "cancel_project"'),
        instruction: z.string().trim().max(1000).optional().describe("What to change in the new attempt (retry) or why"),
      })
      .refine(targetRule, targetMessage),
    call: ({ project_id, request_id, ref, action, instruction }) => {
      const target = project_id ? { projectId: project_id } : { requestId: maestro.requestFor(request_id).id };
      return text(plans.decideTask(target, ref, action, instruction));
    },
  });

  const getProject = defineTool({
    name: "get_project",
    description:
      "Shows a project: status, progress by unit (modules or tasks), release state and daily release pace, dates, what waits for the owner, and the tree (module > task > subtask) with status, owners, dependencies and failures. Pass either project_id or request_id (not both). Large trees are summarized per top-level module (open tasks only, capped); pass `ref` to expand a specific module or task subtree.",
    input: z
      .object({
        project_id: targetProjectId,
        request_id: targetRequestId,
        ref: z.string().trim().min(1).max(PROJECT_LIMITS.ref).optional().describe("Optional module or task ref to expand its entire subtree"),
      })
      .refine(targetRule, targetMessage),
    call: ({ project_id, request_id, ref }) => {
      const target = project_id ? { projectId: project_id } : { requestId: maestro.requestFor(request_id).id };
      return text(plans.describe(target, ref ? { ref } : {}));
    },
  });

  const updateProject = defineTool({
    name: "update_project",
    description:
      "Changes an existing project (also after approval): title, priority, start_at, due_at and pace. Send only what changes; null clears a date or the pace. It does not change the tasks or the mode.",
    input: z.object({
      project_id: projectId,
      title: z.string().trim().min(1).max(PROJECT_LIMITS.title).optional(),
      priority: z.enum(PROJECT_INPUT_PRIORITIES).optional(),
      start_at: clearableIso("The project starts at this moment"),
      due_at: clearableIso("The project's deadline"),
      pace: z.union([paceObject, z.null()]).optional().describe("New pace (hours per day, window, max parallel), or null to clear"),
    }),
    call: async ({ project_id, title, priority, start_at, due_at, pace }) => {
      const patch: ProjectUpdate = {};
      if (title) patch.title = title;
      if (priority) patch.priority = PRIORITY_MAP[priority];
      const startAt = toClearableIso(start_at, "start_at");
      const dueAt = toClearableIso(due_at, "due_at");
      if (startAt !== undefined) patch.startAt = startAt;
      if (dueAt !== undefined) patch.dueAt = dueAt;
      if (pace !== undefined) patch.pace = pace === null ? null : (paceFromInput(pace) ?? null);
      if (Object.keys(patch).length === 0) throw new Error("Nothing to change: send title, priority, start_at, due_at or pace");
      const project = await plans.updateProject(project_id, patch, "maestro");
      return text(`Project ${project.id} updated (${Object.keys(patch).join(", ")}). Tell the user in one sentence.`);
    },
  });

  const updateTaskTool = defineTool({
    name: "update_task",
    description:
      "Updates an existing task or module in a project: title, briefing, priority, owner (leaf tasks only; null clears), depends_on (replaces the full list; works between modules and tasks), start_at/due_at (null clears), done_when (leaf tasks only). Send only what changes.",
    input: z.object({
      project_id: projectId,
      ref: z.string().trim().min(1).max(PROJECT_LIMITS.ref).describe('Task or module ref (e.g. "T3", "M1")'),
      title: z.string().trim().min(1).max(PROJECT_LIMITS.title).optional(),
      briefing: z.string().trim().max(PROJECT_LIMITS.briefing).optional(),
      priority: z.enum(PROJECT_INPUT_PRIORITIES).optional().describe("high, normal or low"),
      owner: z.union([z.string().trim().min(1).max(64), z.null()]).optional().describe("New owner (agentId or name; null clears). Only for leaf tasks, not modules"),
      depends_on: z.array(z.string().trim().min(1).max(PROJECT_LIMITS.ref)).max(PROJECT_SAFETY.perCall).optional().describe("Replaces the full list of dependencies (tasks or modules)"),
      start_at: clearableIso("The item only starts after this moment"),
      due_at: clearableIso("The item should finish by this moment"),
      done_when: z.array(z.string().trim().min(1).max(500)).max(20).optional().describe('Replaces the "Done when…" criteria (leaf tasks only)'),
    }),
    call: async ({ project_id, ref, title, briefing, priority, owner, depends_on, start_at, due_at, done_when }) => {
      const patch: TaskPatchBody = {};
      if (title !== undefined) patch.title = title;
      if (briefing !== undefined) patch.briefing = briefing;
      if (priority !== undefined) patch.priority = PRIORITY_MAP[priority];
      if (owner !== undefined) patch.assignee = owner;
      if (depends_on !== undefined) patch.dependsOn = depends_on;
      const startAt = toClearableIso(start_at, "start_at");
      const dueAt = toClearableIso(due_at, "due_at");
      if (startAt !== undefined) patch.startAt = startAt;
      if (dueAt !== undefined) patch.dueAt = dueAt;
      if (done_when !== undefined) patch.doneWhen = done_when;
      if (Object.keys(patch).length === 0) throw new Error("Nothing to change: send title, briefing, priority, owner, depends_on, start_at, due_at or done_when");
      await plans.updateTask(project_id, ref, patch, "maestro");
      return text(`Item ${ref} updated (${Object.keys(patch).join(", ")}).`);
    },
  });

  const deleteTaskTool = defineTool({
    name: "delete_task",
    description:
      "Deletes a task, subtask or module (and its entire subtree) from a project. Refuses if any leaf in the subtree is running or waiting for the owner (cancel or wait first). Cleans up runner tasks, logs, pending items and removes references to the deleted items from other items' depends_on. Never deletes a whole project (use delete_project for that).",
    input: z.object({
      project_id: projectId,
      ref: z.string().trim().min(1).max(PROJECT_LIMITS.ref).describe('Task or module ref to delete (e.g. "T3", "M1")'),
      reason: z.string().trim().max(500).optional().describe("Why this item is being deleted (optional)"),
    }),
    call: async ({ project_id, ref, reason }) => {
      const result = await plans.deleteTask(project_id, ref, { by: "maestro", ...(reason ? { reason } : {}) });
      const cleaned = result.cleanedDependsOn.length > 0 ? ` Removed dependencies from: ${result.cleanedDependsOn.map((entry) => `${entry.ref} (${entry.removed.join(", ")})`).join("; ")}.` : "";
      return text(`Deleted ${result.deleted.length} item(s) (${result.deleted.join(", ")}) from project ${project_id}.${cleaned}`);
    },
  });

  const deleteProjectTool = defineTool({
    name: "delete_project",
    description:
      'Deletes a whole project with everything in it (tasks, modules, logs, pending items); cannot be undone. Call it ONLY when the owner asked in this conversation to delete it, quoting their words in owner_quote. Refuses if a task is running or waiting for the owner, and never deletes the Avulsas project. Deletes one project per call.',
    input: z.object({
      project_id: projectId,
      owner_quote: z.string().trim().min(3).max(300).describe("The owner's own words from this conversation asking to delete the project (3 to 300 characters)"),
    }),
    call: async ({ project_id, owner_quote }) => {
      const title = plans.list().find((candidate) => candidate.id === project_id)?.title;
      const result = await plans.deleteProject(project_id, { by: "maestro", reason: owner_quote });
      return text(`Deleted project ${title ? `"${title}" (${project_id})` : project_id}: removed ${result.deleted.tasks} item(s) and ${result.deleted.logs} log(s).`);
    },
  });

  const releaseWorkTool = defineTool({
    name: "release_work",
    description:
      "Releases Planned tasks or modules into the execution queue (a module releases all tasks inside it). Pass either `refs` or `all: true` (not both). `with_prerequisites: true` also releases Planned dependencies they wait on.",
    input: z
      .object({
        project_id: projectId,
        refs: z.array(z.string().trim().min(1).max(PROJECT_LIMITS.ref)).min(1).max(PROJECT_SAFETY.perCall).optional().describe("Task or module refs to release"),
        all: z.boolean().optional().describe("Set to true to release the entire project"),
        with_prerequisites: z.boolean().optional().describe("Set to true to also release Planned prerequisites that these items depend on"),
      })
      .refine((v) => Boolean(v.refs?.length) !== (v.all === true), { message: "Pass either refs or all: true (not both)" }),
    call: async ({ project_id, refs, all, with_prerequisites }) => {
      await plans.releaseWork(project_id, { ...(refs ? { refs } : {}), ...(all ? { all: true } : {}), ...(with_prerequisites ? { withPrerequisites: true } : {}) }, "maestro");
      return text(all ? `Released all planned work in project ${project_id}.` : `Released ${refs!.join(", ")} in project ${project_id}.`);
    },
  });

  const holdWorkTool = defineTool({
    name: "hold_work",
    description:
      "Moves released tasks or modules back to Planned so they do not enter the queue. Items that already started or finished stay as they are (returns an error if none could be held).",
    input: z.object({
      project_id: projectId,
      refs: z.array(z.string().trim().min(1).max(PROJECT_LIMITS.ref)).min(1).max(PROJECT_SAFETY.perCall).describe("Task or module refs to move back to Planned"),
    }),
    call: async ({ project_id, refs }) => {
      await plans.holdWork(project_id, { refs }, "maestro");
      return text(`Held ${refs.join(", ")} (back to Planned) in project ${project_id}.`);
    },
  });

  const setReleasePaceTool = defineTool({
    name: "set_release_pace",
    description:
      'Configures automatic daily release for a project: the server releases `per_day` tasks or modules per day (by priority, then tree order, with prerequisites included). Pass `per_day: null` to turn daily release off.',
    input: z.object({
      project_id: projectId,
      per_day: z.union([z.number().int().min(RELEASE_PACE_LIMITS.perDay.min).max(RELEASE_PACE_LIMITS.perDay.max), z.null()]).describe("Number of tasks or modules to release per day (1-500), or null to turn off"),
      unit: z.enum(["tasks", "modules"]).optional().describe('Unit for per_day: "tasks" (default) or "modules"'),
      starts_on: z.union([z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use "YYYY-MM-DD"'), z.null()]).optional().describe('Local start date ("YYYY-MM-DD"), or null to start today'),
    }),
    call: async ({ project_id, per_day, unit, starts_on }) => {
      const pace = per_day === null ? null : { perDay: per_day, unit: unit === "modules" ? ("modulos" as const) : ("tarefas" as const), ...(starts_on ? { startsOn: starts_on } : {}) };
      await plans.setReleasePace(project_id, pace, "maestro");
      return text(per_day === null ? `Daily release turned off for project ${project_id}.` : `Daily release set to ${per_day} ${unit ?? "tasks"}/day${starts_on ? ` starting ${starts_on}` : ""} for project ${project_id}.`);
    },
  });

  const setProjectStatusTool = defineTool({
    name: "set_project_status",
    description:
      'Changes a project\'s status: "active" reopens a completed or canceled project (canceled tasks stay canceled) or resumes a paused one; "paused" pauses an active project; "completed" marks it completed (refuses if any leaf is running or waiting for the owner); "canceled" cancels the project and its open tasks. Never works on the system "avulsas" project.',
    input: z.object({
      project_id: projectId,
      status: z.enum(["active", "paused", "completed", "canceled"]).describe("Target project status"),
    }),
    call: async ({ project_id, status }) => {
      const project = await plans.setProjectStatus(project_id, STATUS_MAP[status], "maestro");
      return text(`Project ${project.id} status is now ${status}.`);
    },
  });

  const addSprintTool = defineTool({
    name: "add_sprint",
    description: "Legacy tool for projects that already use sprints: adds a sprint at the end of an existing project that already has sprints. Refuses projects without sprints.",
    listed: false,
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
    description: "For projects that already use sprints: changes a sprint that has not closed yet (name, goal, start_at, end_at). Send only what changes; goal null clears it.",
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
    description: "Moves a task or module: under another parent (parent: a module or task ref; null = top level), optionally before a sibling, and/or to another sprint (sprint; null = no sprint, on projects with sprints). A closed sprint does not receive tasks.",
    input: z.object({
      project_id: projectId,
      ref: z.string().trim().min(1).max(PROJECT_LIMITS.ref).describe('Task or module ref (e.g. "T3", "M1")'),
      sprint: z.union([sprintId, z.null()]).optional().describe("Target sprint id or name; null = no sprint (backlog)"),
      parent: z.union([z.string().trim().min(1).max(PROJECT_LIMITS.ref), z.null()]).optional().describe("New parent ref (module or task); null = top level"),
      before: z.string().trim().min(1).max(PROJECT_LIMITS.ref).optional().describe("Sibling ref the item goes before (default: the end)"),
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
      'Sets who does a leaf task that has not started: one agent replaces the owner; several agents turn the task into a parent with ONE SUBTASK PER AGENT. Mode "chain" (default): each subtask waits for the previous one and receives its full delivery; mode "parallel": all run together; mode "sequence" is the legacy format (steps inside one task), avoid it. For a task with subtasks or a module, assign the leaf tasks inside it.',
    input: z.object({
      project_id: projectId,
      ref: z.string().trim().min(1).max(PROJECT_LIMITS.ref).describe('Task ref (e.g. "T3")'),
      assignees: z.array(z.string().trim().min(1).max(64)).min(1).max(PROJECT_SAFETY.perCall).describe("agentIds or names (see get_team), in the order of the work"),
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
      "For projects that already use sprints: starts closing the ACTIVE sprint before its end date (what was left goes to the next sprint, and the delivery summary waits for the owner's OK in Aprovações).",
    input: z.object({ project_id: projectId, sprint: sprintId }),
    call: async ({ project_id, sprint }) => {
      const project = await plans.closeSprint(project_id, plans.sprintIdOf(project_id, sprint), "maestro");
      const closed = project.sprints!.find((candidate) => candidate.id === plans.sprintIdOf(project_id, sprint))!;
      return text(`Sprint ${closed.id} is closing: ${closed.summary ? `${closed.summary.done.length} done, ${closed.summary.carried.length} carried over; ` : ""}the delivery summary waits for the user's OK in Aprovações. Tell the user in one sentence.`);
    },
  });

  const setPlanApprovalRuleTool = defineTool({
    name: "set_plan_approval_rule",
    description:
      'Sets the workspace approval rule for new projects: "always_ask" (every new project asks the owner for approval), "never_ask" (no project asks), or "maestro_decides" (you choose per project). ONLY call this when the owner explicitly said so in this conversation, quoting their words in owner_quote. Never change it on your own. The owner can undo or change it anytime in Configurações. Projects already waiting for approval are not changed.',
    input: z.object({
      rule: z.enum(["always_ask", "never_ask", "maestro_decides"]).describe('Target rule: "always_ask", "never_ask" or "maestro_decides"'),
      owner_quote: z.string().trim().min(3).max(300).describe("The owner's own words from this conversation asking for this rule (3 to 300 characters)"),
    }),
    call: async ({ rule, owner_quote }) => {
      if (!planApproval) throw new Error("Plan approval settings are not available in this workspace");
      const mapped = APPROVAL_RULE_MAP[rule];
      await planApproval.set(mapped, owner_quote);
      return text(
        `Workspace plan approval rule set to "${mapped}" (from "${rule}"), recording the owner's words: "${owner_quote}". Existing projects waiting for approval stay unchanged. The owner can change or undo this anytime in Configurações.`,
      );
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
    updateTaskTool,
    deleteTaskTool,
    deleteProjectTool,
    releaseWorkTool,
    holdWorkTool,
    setReleasePaceTool,
    setProjectStatusTool,
    setPlanApprovalRuleTool,
  ];
}
