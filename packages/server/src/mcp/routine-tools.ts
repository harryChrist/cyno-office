import {
  agentAddress,
  describeDays,
  describeTimes,
  goalOf,
  PACE_LABELS,
  parseAddress,
  ROUTINE_KINDS,
  ROUTINE_LIMITS,
  ROUTINE_LIMITS_TABLE,
  routineSiteSchema,
  type ForYouItem,
  type OfficeState,
  type Routine,
  type RoutineOverviewItem,
  type RoutineSchedule,
  type ScheduleDays,
  type ScheduleInput,
  type TrackingSpec,
  type UpdateRoutineBody,
  type Weekday,
} from "@cyno/shared";
import { z } from "zod";
import { overviewItem } from "../workspace/routines/overview";
import { RoutineToolError, type RoutineService } from "../workspace/routines/routine-service";
import type { CliAgentRunner } from "../engines/terminals/cli-runner";
import { errorMessage } from "../util/text";
import { defineTool, type McpTool, type McpToolResult } from "./protocol";
import { routineItemsTools, type RoutineItemsToolsDeps } from "./routine-items-tools";
import { findByRef } from "./structure-tools";

/*
 * Rotinas (metas com prazo e acompanhamentos). O contrato MCP é em inglês. O Maestro só PROPÕE (o
 * usuário aprova no "Para você") e aplica direto só o que é reversível (pausar, retomar, parar um item).
 * Ninguém aqui apaga rotina, liga o Automático ou muda a permissão: isso é só do usuário. O agente só
 * registra os itens que fez.
 */

export type RoutineToolsDeps = {
  state: { read(): OfficeState };
  routines: Pick<RoutineService, "propose" | "proposeChange" | "list" | "find" | "pauseByMaestro" | "resumeByMaestro" | "record" | "entries" | "todayCount" | "history" | "ownerOf" | "decisionsOf" | "statsFor" | "nextOf">;
  /** Itens do "Para você" (as opções de uma Meta com preparo); sem isto o status não mostra o que está em preparo. */
  forYou?: () => ForYouItem[];
  runner: Pick<CliAgentRunner, "currentTaskId" | "hasActive">;
  /** Itens acompanhados (R2): sem ele as ferramentas de itens não existem. */
  tracking?: RoutineItemsToolsDeps["tracking"] & { summary?: (routine: Routine) => { active: number; ended: number; stopped: number; changedToday: number; due: number } | undefined };
  /** Id do workspace (os horários apontam o agente por "workspace/agente"). */
  workspaceId?: string;
  now: () => Date;
};

const ok = (text: string): McpToolResult => ({ text });
const fail = (text: string): McpToolResult => ({ text, isError: true });

// ---------- Entrada v2 (inglês) -> modelo do servidor ----------

const WEEKDAY_NAMES = "1=Monday … 7=Sunday";

/** Um horário como o Maestro o escreve. */
const scheduleField = z.object({
  id: z.string().trim().max(8).optional().describe('Only in routine_update_propose: the id of an existing schedule (e.g. "S1") to change; omit to add a new one'),
  label: z.string().trim().min(1).max(80).optional().describe('Short name in Brazilian Portuguese (e.g. "Olhar posts novos"). Required for a new schedule'),
  days: z.enum(["every_day", "business_days", "selected_weekdays", "day_of_month"]).optional().describe("Which days: every_day, business_days (Mon-Fri), selected_weekdays (needs weekdays) or day_of_month (needs month_day). Required for a new schedule"),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional().describe(`With days "selected_weekdays": ${WEEKDAY_NAMES}`),
  month_day: z.number().int().min(1).max(31).optional().describe('With days "day_of_month" (1-31; short months run on the last day)'),
  times: z.array(z.string().trim().min(1).max(8)).min(1).max(24).optional().describe('Times of day, Brazil time, "HH:MM" 24h (e.g. ["09:00","13:00","18:00"]); "9h" and "18h30" are also understood. Required for a new schedule'),
  action: z.string().trim().min(1).max(4000).optional().describe("What the agent must do at EACH of these times, complete (the agent does not see the conversation). In Brazilian Portuguese. Required for a new schedule"),
  agent: z.string().trim().max(100).optional().describe('Who does THIS schedule, as "workspace/agent" (e.g. "lab/eco"; the agent name or id also works). Omit = the routine owner'),
  scope: z.enum(["general", "due_items_only"]).optional().describe('Tracking only: "due_items_only" = runs only if there are items due for a check (costs nothing otherwise); "general" (default) always runs'),
  enabled: z.boolean().optional().describe("false = switch this schedule off without removing it (routine_update_propose)"),
});
type ScheduleArg = z.infer<typeof scheduleField>;

const fieldTypeMap = { text: "texto", link: "link", date: "data", number: "numero", option: "opcao" } as const;
const trackingFieldsArg = z
  .array(
    z.object({
      key: z.string().trim().min(1).max(40).describe('Column key, letters/digits/underscore, starting with a letter (e.g. "company")'),
      label: z.string().trim().min(1).max(80).describe('Column title in Brazilian Portuguese (e.g. "Empresa")'),
      type: z.enum(["text", "link", "date", "number", "option"]),
      options: z.array(z.string().trim().min(1).max(80)).max(30).optional().describe('Only for type "option"'),
      required: z.boolean().optional(),
    }),
  )
  .max(30);
const trackingStatusesArg = z
  .array(z.object({ name: z.string().trim().min(1).max(60), terminal: z.boolean().optional().describe("Final status: the item ends when it gets here (e.g. Contratado, Recusado)"), alert: z.boolean().optional().describe("Worth an alert for the user (e.g. Entrevista)") }))
  .min(1)
  .max(20);

const autoScopeArg = z
  .object({
    actions: z.array(z.string().trim().min(1).max(40)).min(1).max(10).describe('Approval type ids the user would let run without asking (e.g. ["comentario"]); see request_approval for the ids. Reading never needs approval, so do not list it'),
    sites: z.array(z.string().trim().min(1).max(100)).max(10).optional().describe("Sites where it applies"),
    connectors: z.array(z.string().trim().min(1).max(100)).max(10).optional().describe("Connectors where it applies"),
    daily_cap: z.number().int().min(0).max(1000).optional().describe("Maximum automatic decisions PER DAY for the whole routine (all its executions together)"),
  })
  .describe('Required with suggested_mode "auto": the narrowest scope that makes sense');

const TIME_PATTERN = /^(\d{1,2})(?::(\d{2})|h(\d{2})?)$/i;
/** "9h", "18h30", "9:00" -> "09:00"; undefined se não for uma hora. */
export function normalizeTime(raw: string): string | undefined {
  const match = TIME_PATTERN.exec(raw.trim());
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? match[3] ?? "0");
  if (hour > 23 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function daysOf(arg: ScheduleArg, where: string): ScheduleDays {
  switch (arg.days) {
    case "every_day":
      return { kind: "todo_dia" };
    case "business_days":
      return { kind: "uteis" };
    case "selected_weekdays":
      if (!arg.weekdays?.length) throw new RoutineToolError(`${where}: days "selected_weekdays" needs weekdays (${WEEKDAY_NAMES}).`);
      return { kind: "semana", weekdays: [...new Set(arg.weekdays)].sort() as Weekday[] };
    case "day_of_month":
      if (arg.month_day === undefined) throw new RoutineToolError(`${where}: days "day_of_month" needs month_day (1-31).`);
      return { kind: "mes", monthDay: arg.month_day };
    default:
      throw new RoutineToolError(`${where}: missing days (every_day, business_days, selected_weekdays or day_of_month).`);
  }
}

function timesOf(arg: ScheduleArg, where: string): string[] {
  if (!arg.times?.length) throw new RoutineToolError(`${where}: missing times (e.g. ["09:00","18:00"]).`);
  return arg.times.map((time) => {
    const normalized = normalizeTime(time);
    if (!normalized) throw new RoutineToolError(`${where}: "${time}" is not a time. Use "HH:MM" 24h (e.g. "09:00", "18:30").`);
    return normalized;
  });
}

const scopeOf = (arg: ScheduleArg): "geral" | "itens_vencidos" | undefined => (arg.scope === undefined ? undefined : arg.scope === "due_items_only" ? "itens_vencidos" : "geral");

/** Ferramentas de rotinas do Maestro: propor (nova e mudança), listar, ver, pausar, retomar e parar um item. */
export function maestroRoutineTools(deps: Omit<RoutineToolsDeps, "runner">): McpTool[] {
  const workspaceId = deps.workspaceId ?? "workspace";
  const items = () => {
    const now = deps.now();
    return deps.routines
      .list()
      .filter((routine) => routine.status !== "encerrada" && routine.status !== "proposta")
      .map((routine) => overviewItem({ routines: deps.routines, state: deps.state, now, ...(deps.forYou ? { forYou: deps.forYou() } : {}) }, routine));
  };
  const find = (id: string) => {
    const routine = deps.routines.find(id);
    if (!routine) throw new RoutineToolError(`Routine ${id} does not exist (see routine_list).`);
    return overviewItem({ routines: deps.routines, state: deps.state, now: deps.now(), ...(deps.forYou ? { forYou: deps.forYou() } : {}) }, routine);
  };
  const guard = (run: () => McpToolResult): McpToolResult => {
    try {
      return run();
    } catch (error) {
      if (error instanceof RoutineToolError) return fail(error.message);
      throw error instanceof Error ? error : new Error(errorMessage(error));
    }
  };

  /** Agente por endereço "workspace/agente", id ou nome; devolve o endereço. */
  const addressOf = (ref: string, where: string): string => {
    const state = deps.state.read();
    const parsed = parseAddress(ref);
    const agent = findByRef(state.agents, ref) ?? (parsed ? (findByRef(state.agents, parsed.agentId) ?? findByRef(state.agents, parsed.agentId.replace(/-/g, " "))) : undefined);
    if (!agent) throw new RoutineToolError(`${where}: agent "${ref}" not found. Use "workspace/agent" from get_team (agents: ${state.agents.map((candidate) => `${workspaceId}/${candidate.id} (${candidate.name})`).join(", ") || "none"}).`);
    return agentAddress(workspaceId, agent.id);
  };

  /** Horário novo completo (todos os campos obrigatórios). */
  const newSchedule = (arg: ScheduleArg, index: number): ScheduleInput => {
    const where = `schedules[${index}]`;
    if (!arg.label) throw new RoutineToolError(`${where}: missing label.`);
    if (!arg.action) throw new RoutineToolError(`${where}: missing action (what the agent does at each of these times).`);
    return {
      label: arg.label,
      days: daysOf(arg, where),
      times: timesOf(arg, where),
      action: arg.action,
      ...(arg.agent ? { agent: addressOf(arg.agent, `${where}.agent`) } : {}),
      ...(scopeOf(arg) ? { scope: scopeOf(arg)! } : {}),
      enabled: arg.enabled ?? true,
    };
  };

  /** Horário existente com os campos que o Maestro mandou trocados. */
  const mergedSchedule = (before: RoutineSchedule, arg: ScheduleArg, index: number): ScheduleInput => {
    const where = `schedule_changes[${index}] (${before.id})`;
    const changesDays = arg.days !== undefined;
    return {
      id: before.id,
      label: arg.label ?? before.label,
      days: changesDays ? daysOf(arg, where) : before.days,
      times: arg.times ? timesOf(arg, where) : before.times,
      action: arg.action ?? before.action,
      ...(arg.agent ? { agent: addressOf(arg.agent, `${where}.agent`) } : before.agent ? { agent: before.agent } : {}),
      ...(scopeOf(arg) ? { scope: scopeOf(arg)! } : before.scope ? { scope: before.scope } : {}),
      enabled: arg.enabled ?? before.enabled,
    };
  };

  const trackingOf = (arg: { fields?: z.infer<typeof trackingFieldsArg> | undefined; statuses?: z.infer<typeof trackingStatusesArg> | undefined; lifespan_days?: number | undefined; until_terminal?: boolean | undefined; expire_status?: string | undefined; check_every_hours?: number | undefined }) => ({
    ...(arg.fields ? { fields: arg.fields.map((field) => ({ key: field.key, label: field.label, type: fieldTypeMap[field.type], ...(field.options?.length ? { options: field.options } : {}), ...(field.required !== undefined ? { required: field.required } : {}) })) } : {}),
    ...(arg.statuses ? { statuses: arg.statuses.map((status) => ({ name: status.name, ...(status.terminal ? { terminal: true } : {}), ...(status.alert ? { alert: true } : {}) })) } : {}),
    ...(arg.lifespan_days !== undefined || arg.until_terminal !== undefined ? { lifespan: { ...(arg.lifespan_days !== undefined ? { days: arg.lifespan_days } : {}), untilTerminal: arg.until_terminal ?? false } } : {}),
    ...(arg.expire_status ? { expireStatus: arg.expire_status } : {}),
    ...(arg.check_every_hours !== undefined ? { checkEveryHours: arg.check_every_hours } : {}),
  });

  const modeScope = (suggested: "auto" | undefined, scope: z.infer<typeof autoScopeArg> | undefined) => {
    if (suggested !== "auto") return undefined;
    if (!scope) throw new RoutineToolError('suggested_mode "auto" needs auto_scope (actions = approval type ids the user would let run without asking).');
    return { actions: scope.actions, ...(scope.sites?.length ? { sites: scope.sites } : {}), ...(scope.connectors?.length ? { connectors: scope.connectors } : {}), ...(scope.daily_cap !== undefined ? { dailyCap: scope.daily_cap } : {}) };
  };

  const resolveOwner = (ref: string): { agentId?: string; teamId?: string } => {
    const state = deps.state.read();
    const parsed = parseAddress(ref);
    const agent = findByRef(state.agents, ref) ?? (parsed ? findByRef(state.agents, parsed.agentId) : undefined);
    if (agent) return { agentId: agent.id };
    const team = findByRef(state.teams, ref);
    if (team) return { teamId: team.id };
    throw new RoutineToolError(`Owner "${ref}" not found. Use an agent ("workspace/agent") or a team id/name from get_team.`);
  };

  return [
    defineTool({
      name: "routine_propose",
      description: [
        "Proposes a NEW routine (something recurring the server runs by itself). It goes to the user as a card in \"Para você\" showing the type, each schedule, the goal or the item table and the suggested mode; NOTHING runs until they press \"Criar rotina\".",
        "TYPES. type \"goal\": a target per period the server watches (\"2 posts per week\", \"10 invites per week\"; needs kind, site, goal). type \"tracking\": a table of items the agent reads and updates at fixed times (job applications, orders, deadlines; needs schedules and tracking). A goal MAY also have schedules (reminders that force a check at those times).",
        "SCHEDULES (schedules[]): each has its own days, times, action and optionally another agent. E.g. \"every business day at 9h, 13h and 18h look at new posts and prepare comments\" = {label, days:\"business_days\", times:[\"09:00\",\"13:00\",\"18:00\"], action:\"…\"}; \"Tue, Thu, Fri at 10h find people to connect\" = a second schedule {days:\"selected_weekdays\", weekdays:[2,4,5], times:[\"10:00\"], action:\"…\", agent:\"workspace/other-agent\"}. Times are Brazil time.",
        "GOAL example: \"I want 2 posts per week, preferably Tue and Thu\" = {type:\"goal\", kind:\"post\", site:\"linkedin.com\", unit:\"post\", goal:{target:2, period:\"week\", preferred_days:[2,4]}}. Targets are clamped to the site's limits (LinkedIn: invites 15/day and 60/week, comments 8/day, posts 1/day, likes 30/day and 100/week).",
        "TRACKING example: \"follow my applications: check e-mail at 8h and 18h, each company's site once a day, 15 days each\" = {type:\"tracking\", schedules:[{label:\"E-mail\", days:\"every_day\", times:[\"08:00\",\"18:00\"], action:\"read new e-mails and create/update items\"}, {label:\"Site de cada vaga\", days:\"every_day\", times:[\"10:00\"], scope:\"due_items_only\", action:\"…\"}], tracking:{fields:[{key:\"company\",label:\"Empresa\",type:\"text\",required:true},{key:\"link\",label:\"Link\",type:\"link\"}], statuses:[{name:\"Inscrito\"},{name:\"Em análise\"},{name:\"Entrevista\",alert:true},{name:\"Oferta\",terminal:true,alert:true},{name:\"Recusado\",terminal:true},{name:\"Sem resposta\"}], lifespan_days:15, until_terminal:true, expire_status:\"Sem resposta\", check_every_hours:24}}.",
        "MODE: every routine starts in \"Pede OK\" (sensitive actions ask the user; reading never asks). Only the USER turns Automatic on. You may SUGGEST it with suggested_mode \"auto\" + auto_scope (approval type ids, sites, daily_cap for the whole routine); the card then offers \"Criar já no Automático\" and the default stays \"Pede OK\".",
        "Ask the user only what is missing (which agent, the times, the target — never pick a number for the target yourself, what a tracked item is and how long it lives). When you have enough, call this ONCE and end the turn. Never create a routine any other way. To change a routine that already exists use routine_update_propose; errors come back as text: fix and call again.",
      ].join(" "),
      input: z.object({
        type: z.enum(["goal", "tracking"]).describe('"goal" = target per period; "tracking" = table of items followed at set times'),
        title: z.string().trim().min(1).max(ROUTINE_LIMITS.title).describe('Short title in Brazilian Portuguese (e.g. "Posts da semana", "Minhas inscrições")'),
        owner: z.string().trim().min(1).max(64).describe('The agent that does it by default: "workspace/agent" (or agent name/id), or a team (id/name; the server picks its agent). See get_team. A schedule may name another agent.'),
        instruction: z.string().trim().min(1).max(ROUTINE_LIMITS.instruction).describe("General rules of the routine, complete (the agents did not see the conversation): who to target, tone, what to avoid, what a tracked item is. In Brazilian Portuguese."),
        unit: z.string().trim().min(1).max(ROUTINE_LIMITS.unit).optional().describe('Goal: what is counted, singular, in Brazilian Portuguese (e.g. "convite", "post", "comentário"). Tracking: the item name (default "item")'),
        kind: z.enum(ROUTINE_KINDS).optional().describe("Goal only: post, comment, invite, like or other (other never gets approval-free actions)"),
        site: routineSiteSchema.optional().describe('Goal only: site host, e.g. "linkedin.com"'),
        goal: z
          .object({
            target: z.number().int().min(1).max(ROUTINE_LIMITS.target).describe("Items per period, EXACTLY as the user said. If the user did not say how many, do NOT call this tool: ask the user for the target first (and the period)"),
            period: z.enum(["week", "month"]).optional().describe("Default week"),
            preferred_days: z.array(z.number().int().min(1).max(7)).max(7).optional().describe(`Preferred days (a suggestion, never a block): ${WEEKDAY_NAMES}`),
            stop_on_hit: z.boolean().optional().describe("Default true: stop asking once the target is hit, until the next period"),
            prepare_factor: z.number().int().min(1).max(3).optional().describe("Default 1; 2 = prepare twice as many candidates so the user picks the best"),
          })
          .optional()
          .describe('Required for type "goal"'),
        schedules: z.array(scheduleField).max(12).optional().describe('Required for type "tracking" (at least one); optional reminders for a goal'),
        tracking: z
          .object({
            fields: trackingFieldsArg.optional().describe("The columns of each item"),
            statuses: trackingStatusesArg.optional().describe("The status list; the FIRST is the initial one"),
            lifespan_days: z.number().int().min(1).max(3650).optional().describe("Each item stops being followed this many days after it appears"),
            until_terminal: z.boolean().optional().describe("Also stop when the item reaches a status marked terminal (needs one)"),
            expire_status: z.string().trim().max(60).optional().describe('Status written when the lifespan ends (e.g. "Sem resposta"); must be one of the statuses'),
            check_every_hours: z.number().int().min(1).max(2160).optional().describe("How often each item must be checked (e.g. 24)"),
          })
          .optional()
          .describe('Required for type "tracking"'),
        suggested_mode: z.enum(["auto"]).optional().describe('"auto": suggest Automatic mode (see auto_scope). Only a suggestion.'),
        auto_scope: autoScopeArg.optional(),
      }),
      call: (input) =>
        guard(() => {
          const owner = resolveOwner(input.owner);
          if (input.type === "goal") {
            if (!input.goal) throw new RoutineToolError('type "goal" needs goal: {target, period?, preferred_days?, …}.');
            if (!input.kind || !input.site) throw new RoutineToolError('type "goal" needs kind (post, comment, invite, like, other) and site (e.g. "linkedin.com").');
          } else {
            if (!input.schedules?.length) throw new RoutineToolError('type "tracking" needs at least one schedule (days, times, action).');
            if (!input.tracking?.statuses?.length) throw new RoutineToolError('type "tracking" needs tracking.statuses (the first is the initial one) and usually tracking.fields.');
          }
          const schedules = (input.schedules ?? []).map((schedule, index) => newSchedule(schedule, index));
          const suggestedMode = modeScope(input.suggested_mode, input.auto_scope);
          const isGoal = input.type === "goal";
          const { routine, item, targetClamped } = deps.routines.propose({
            type: isGoal ? "meta" : "acompanhamento",
            title: input.title,
            unit: input.unit ?? (isGoal ? "item" : "item"),
            kind: isGoal ? input.kind! : "other",
            site: isGoal ? input.site! : "",
            target: isGoal ? input.goal!.target : 1,
            instruction: input.instruction,
            ...(isGoal ? { period: input.goal!.period ?? "week", goal: { ...(input.goal!.preferred_days?.length ? { preferredDays: input.goal!.preferred_days as Weekday[] } : {}), ...(input.goal!.stop_on_hit !== undefined ? { stopOnHit: input.goal!.stop_on_hit } : {}), ...(input.goal!.prepare_factor !== undefined ? { prepareFactor: input.goal!.prepare_factor } : {}) } } : {}),
            ...(!isGoal ? { tracking: trackingOf(input.tracking ?? {}) as Partial<TrackingSpec> } : {}),
            schedules,
            ...(suggestedMode ? { suggestedMode } : {}),
            ...owner,
          });
          const clamp = targetClamped ? ` The target was lowered to ${routine.target}/${routine.period} (site limit).` : "";
          return ok(
            `Routine ${routine.id} proposed${item ? ` (card ${item.id} in Para você)` : ""}.${clamp} It does NOT run until the user approves it (they may also adjust it or turn it down). Tell the user in one sentence what you proposed and end the turn.`,
          );
        }),
    }),
    defineTool({
      name: "routine_update_propose",
      description: [
        "Proposes a CHANGE to a routine that already exists (e.g. \"change the 9h run to 8h\", \"add a Friday schedule\", \"stop checking the e-mail\"). The user sees a card with the BEFORE and the AFTER and nothing changes until they approve.",
        "Call routine_status(routine_id) FIRST to see the schedule ids (S1, S2…) and current values. Pass only what changes: schedule_changes (each with the id of the schedule to change and only the fields that change; WITHOUT id = a new schedule), remove_schedule_ids, title, instruction, owner, goal (target, period, preferred_days (empty list clears), stop_on_hit, prepare_factor) or tracking (fields and statuses can only be ADDED, never removed; lifespan_days, until_terminal, expire_status, check_every_hours).",
        "Pausing, resuming and stopping one tracked item are NOT changes: use routine_pause, routine_resume and routine_item_stop (they apply right away). Mode: only the user turns Automatic on; you may suggest it with suggested_mode \"auto\" + auto_scope. End the turn after calling.",
      ].join(" "),
      input: z.object({
        routine_id: z.string().trim().min(1).max(16).describe('Routine id, e.g. "R-0001"'),
        reason: z.string().trim().max(300).optional().describe("One short sentence in Brazilian Portuguese about why (shown on the card)"),
        title: z.string().trim().min(1).max(ROUTINE_LIMITS.title).optional(),
        instruction: z.string().trim().min(1).max(ROUTINE_LIMITS.instruction).optional().describe("The NEW full general instruction (replaces the old one)"),
        owner: z.string().trim().min(1).max(64).optional().describe('New default owner: "workspace/agent" or a team'),
        schedule_changes: z.array(scheduleField).max(12).optional().describe("Schedules to change (with id) or add (without id)"),
        remove_schedule_ids: z.array(z.string().trim().max(8)).max(12).optional(),
        goal: z
          .object({
            target: z.number().int().min(1).max(ROUTINE_LIMITS.target).optional(),
            period: z.enum(["week", "month"]).optional(),
            preferred_days: z.array(z.number().int().min(1).max(7)).max(7).optional().describe("Empty list clears them"),
            stop_on_hit: z.boolean().optional(),
            prepare_factor: z.number().int().min(1).max(3).optional(),
          })
          .optional()
          .describe("Goal routines only"),
        tracking: z
          .object({
            add_fields: trackingFieldsArg.optional().describe("New columns (existing ones stay)"),
            add_statuses: trackingStatusesArg.optional().describe("New statuses, added after the existing ones"),
            lifespan_days: z.number().int().min(1).max(3650).optional(),
            until_terminal: z.boolean().optional(),
            expire_status: z.string().trim().max(60).optional(),
            check_every_hours: z.number().int().min(1).max(2160).optional(),
          })
          .optional()
          .describe("Tracking routines only"),
        suggested_mode: z.enum(["auto"]).optional(),
        auto_scope: autoScopeArg.optional(),
      }),
      call: (input) =>
        guard(() => {
          const routine = deps.routines.find(input.routine_id);
          if (!routine) throw new RoutineToolError(`Routine ${input.routine_id} does not exist (see routine_list).`);
          const patch: UpdateRoutineBody = {};
          if (input.title) patch.title = input.title;
          if (input.instruction) patch.instruction = input.instruction;
          if (input.owner) {
            const owner = resolveOwner(input.owner);
            if (owner.agentId) patch.agentId = owner.agentId;
            else patch.teamId = owner.teamId!;
          }
          if (input.schedule_changes?.length || input.remove_schedule_ids?.length) {
            const removed = new Set(input.remove_schedule_ids ?? []);
            for (const id of removed) if (!routine.schedules.some((schedule) => schedule.id === id)) throw new RoutineToolError(`remove_schedule_ids: ${id} is not a schedule of ${routine.id} (it has ${routine.schedules.map((schedule) => schedule.id).join(", ") || "none"}).`);
            const changes = new Map<string, ScheduleArg>();
            const added: ScheduleInput[] = [];
            for (const [index, change] of (input.schedule_changes ?? []).entries()) {
              if (change.id) {
                if (!routine.schedules.some((schedule) => schedule.id === change.id)) throw new RoutineToolError(`schedule_changes[${index}]: ${change.id} is not a schedule of ${routine.id} (it has ${routine.schedules.map((schedule) => schedule.id).join(", ") || "none"}).`);
                changes.set(change.id, change);
              } else added.push(newSchedule(change, index));
            }
            patch.schedules = [
              ...routine.schedules.filter((schedule) => !removed.has(schedule.id)).map((schedule, index) => (changes.has(schedule.id) ? mergedSchedule(schedule, changes.get(schedule.id)!, index) : scheduleInputOf(schedule))),
              ...added,
            ];
          }
          if (input.goal) {
            if (routine.type !== "meta") throw new RoutineToolError(`${routine.id} is a tracking routine: it has no goal.`);
            if (input.goal.target !== undefined) patch.target = input.goal.target;
            patch.goal = {
              ...(input.goal.period ? { period: input.goal.period } : {}),
              ...(input.goal.preferred_days ? { preferredDays: input.goal.preferred_days.length ? (input.goal.preferred_days as Weekday[]) : null } : {}),
              ...(input.goal.stop_on_hit !== undefined ? { stopOnHit: input.goal.stop_on_hit } : {}),
              ...(input.goal.prepare_factor !== undefined ? { prepareFactor: input.goal.prepare_factor } : {}),
            };
          }
          if (input.tracking) {
            if (routine.type !== "acompanhamento" || !routine.tracking) throw new RoutineToolError(`${routine.id} is a goal routine: it has no item table.`);
            const spec = routine.tracking;
            const added = trackingOf({ fields: input.tracking.add_fields, statuses: input.tracking.add_statuses });
            patch.tracking = {
              ...(added.fields ? { fields: [...spec.fields, ...added.fields] } : {}),
              ...(added.statuses ? { statuses: [...spec.statuses, ...added.statuses] } : {}),
              ...(input.tracking.lifespan_days !== undefined || input.tracking.until_terminal !== undefined ? { lifespan: { days: input.tracking.lifespan_days ?? spec.lifespan.days, untilTerminal: input.tracking.until_terminal ?? spec.lifespan.untilTerminal } } : {}),
              ...(input.tracking.expire_status ? { expireStatus: input.tracking.expire_status } : {}),
              ...(input.tracking.check_every_hours !== undefined ? { checkEveryHours: input.tracking.check_every_hours } : {}),
            };
            if (patch.tracking.lifespan && patch.tracking.lifespan.days === undefined) delete patch.tracking.lifespan.days;
          }
          const suggestedMode = modeScope(input.suggested_mode, input.auto_scope);
          const { item } = deps.routines.proposeChange({ routineId: routine.id, patch, ...(suggestedMode ? { suggestedMode } : {}), ...(input.reason ? { reason: input.reason } : {}) });
          return ok(`Change to ${routine.id} proposed${item ? ` (card ${item.id} in Para você, with before and after)` : ""}. NOTHING changed yet: it applies only if the user approves. Tell the user in one sentence and end the turn.`);
        }),
    }),
    defineTool({
      name: "routine_list",
      description: "Lists the workspace's routines (active and paused) with type, mode, each schedule (days, times, agent, next runs), the goal and this period's progress, or the tracked items' summary. Read-only.",
      input: z.object({}),
      call: () => {
        const list = items();
        return ok(list.length === 0 ? "No routines yet." : list.map((item) => describe(item, deps)).join("\n\n"));
      },
    }),
    defineTool({
      name: "routine_status",
      description: "Detailed status of one routine: type, mode (and today's automatic usage), schedules with their ids (S1, S2…), next runs, the goal period or the item table (fields, statuses, lifespan, counts), history, limits, open task, cost and the server's last decisions. Read-only. Use it before routine_update_propose.",
      input: z.object({ routine_id: z.string().trim().min(1).max(16).describe('Routine id, e.g. "R-0001"') }),
      call: ({ routine_id }) =>
        guard(() => {
          const item = find(routine_id);
          const decisions = deps.routines
            .decisionsOf(routine_id, 8)
            .map((decision) => `  - ${decision.at} ${decision.kind}: ${decision.reason}`)
            .join("\n");
          const lines = [describe(item, deps)];
          if (item.routine.type === "acompanhamento" && item.routine.tracking) lines.push(describeTracking(item.routine.tracking));
          const runs = item.routine.lastRuns.slice(-5).reverse().map((run) => `  - ${run.startedAt.slice(0, 16)} ${run.scheduleId ?? ""} ${run.outcome}${run.skipReason ? ` (${run.skipReason})` : ""}${run.summary ? `: ${run.summary.slice(0, 100)}` : ""}`);
          if (runs.length > 0) lines.push(`  last runs:\n${runs.join("\n")}`);
          lines.push(`  recent server decisions:\n${decisions || "  (none)"}`);
          return ok(lines.join("\n"));
        }),
    }),
    defineTool({
      name: "routine_pause",
      description: "Pauses an active routine (the server stops creating work for it) when the user asks or something is wrong (e.g. the site is asking for verification). Applies right away (reversible). Tell the user why. Resume with routine_resume.",
      input: z.object({ routine_id: z.string().trim().min(1).max(16), reason: z.string().trim().max(300).optional().describe("Why, for your message to the user") }),
      call: ({ routine_id }) =>
        guard(() => {
          const routine = deps.routines.pauseByMaestro(routine_id);
          return ok(`Routine ${routine.id} paused. Resume with routine_resume when the user asks. Tell them it is paused.`);
        }),
    }),
    defineTool({
      name: "routine_resume",
      description: "Resumes a PAUSED routine, only when the user asks. Applies right away. Schedules that passed while it was paused do not run late.",
      input: z.object({ routine_id: z.string().trim().min(1).max(16) }),
      call: ({ routine_id }) =>
        guard(() => {
          const routine = deps.routines.resumeByMaestro(routine_id);
          return ok(`Routine ${routine.id} resumed. Tell the user.`);
        }),
    }),
    ...(deps.tracking
      ? [
          defineTool({
            name: "routine_item_stop",
            description: 'Stops following ONE item of a tracking routine when the user asks (e.g. "stop following company Y"). Look up the item id with routine_status/routine_list first; the item id is not in this list, so ask the user or search with the company name only if you know the id. Applies right away; the user can resume the item on the routine screen.',
            input: z.object({ routine_id: z.string().trim().min(1).max(16), item_id: z.string().trim().min(1).max(16).describe('Item id, e.g. "I-0003"'), reason: z.string().trim().min(1).max(300).describe("Why (shown in the item history)") }),
            call: ({ routine_id, item_id, reason }) =>
              guard(() => {
                const item = deps.tracking!.stop(routine_id, item_id, { by: "agente", reason: `Maestro, a pedido do usuário: ${reason}` });
                return ok(`Item ${item.id} stopped. The user can resume it on the routine screen. Tell them.`);
              }),
          }),
          ...[
                defineTool({
                  name: "routine_items",
                  description: "Lists the items of a tracking routine (id, values, status, state) so you can find the one the user means (e.g. by company name) before routine_item_stop. Read-only.",
                  input: z.object({ routine_id: z.string().trim().min(1).max(16), state: z.enum(["active", "ended", "stopped", "all"]).optional().describe("Default active"), limit: z.number().int().min(1).max(100).optional() }),
                  call: ({ routine_id, state, limit }) =>
                    guard(() => {
                      const { spec } = deps.tracking!.specOf(routine_id);
                      const wanted = state ?? "active";
                      const { items: list, total } = deps.tracking!.list(routine_id, { ...(wanted !== "all" ? { state: wanted === "active" ? "ativo" : wanted === "ended" ? "encerrado" : "parado" } : {}), limit: limit ?? 30, offset: 0 });
                      const rows = list.map((item) => `${item.id} status: ${item.status}; state: ${item.state}; ${spec.fields.map((field) => `${field.key}=${String(item.values[field.key] ?? "").slice(0, 60)}`).join(" | ")}`);
                      return ok(rows.length === 0 ? "No items." : `${total} item(s) (showing ${rows.length}):\n${rows.join("\n")}`);
                    }),
                }),
              ],
        ]
      : []),
  ];
}

/** Horário gravado -> a forma de entrada (para devolver ao PATCH sem mudar). */
function scheduleInputOf(schedule: RoutineSchedule): ScheduleInput {
  return { id: schedule.id, label: schedule.label, days: schedule.days, times: schedule.times, action: schedule.action, ...(schedule.agent ? { agent: schedule.agent } : {}), ...(schedule.scope ? { scope: schedule.scope } : {}), enabled: schedule.enabled };
}

/** O esquema dos itens em texto para o modelo. */
function describeTracking(spec: TrackingSpec): string {
  const fields = spec.fields.map((field) => `${field.key} (${field.type}${field.required ? ", required" : ""})`).join(", ") || "none";
  const statuses = spec.statuses.map((status, index) => `${status.name}${index === 0 ? " [initial]" : ""}${status.terminal ? " [terminal]" : ""}${status.alert ? " [alert]" : ""}`).join(" > ");
  return `  item table: fields ${fields}; statuses ${statuses}; lifespan ${spec.lifespan.days ?? "no limit"} day(s)${spec.lifespan.untilTerminal ? " or until a terminal status" : ""}; expire status ${spec.expireStatus ?? "-"}; check every ${spec.checkEveryHours ?? "-"} h.`;
}

/** Uma rotina em texto para o modelo (tipo, modo, horários, ritmo, histórico, limites e tarefa aberta). */
function describe(item: RoutineOverviewItem, deps: Pick<RoutineToolsDeps, "routines" | "tracking" | "now">): string {
  const { routine } = item;
  const owner = item.owner ? `${item.owner.kind} ${item.owner.name} (${item.owner.id})` : "none";
  const mode =
    routine.mode.kind === "automatico"
      ? `AUTOMATIC (types: ${routine.mode.grant.actions.join(", ")}${routine.mode.grant.dailyCap !== undefined ? `; cap ${routine.mode.grant.dailyCap}/day, used today ${routine.autoUsage ? routine.autoUsage.count : 0}` : ""}${routine.mode.grant.sites?.length ? `; sites ${routine.mode.grant.sites.join(", ")}` : ""})`
      : `asks the user's OK for sensitive actions (reading never asks)${routine.modeProposal ? `; Automatic suggested, waiting for the user (${routine.modeProposal.grant.actions.join(", ")})` : ""}`;
  const schedules = routine.schedules.map((schedule) => {
    const agent = schedule.agent ? ` -> ${schedule.agent}` : "";
    return `    ${schedule.id} “${schedule.label}” ${describeDays(schedule.days)} · ${describeTimes(schedule.times)}${agent}${schedule.scope === "itens_vencidos" ? " [only if items are due]" : ""}${schedule.enabled ? "" : " [OFF]"}: ${schedule.action.replace(/\s+/g, " ").slice(0, 110)}`;
  });
  const next = deps.routines.nextOf(routine.id, 3, deps.now()).map((slot) => slot.slotKey.replace("T", " "));
  const header = `${routine.id} “${routine.title}” [${routine.status}] ${routine.type === "meta" ? "goal" : "tracking"}; owner: ${owner}; mode: ${mode}.`;
  const lines = [header];
  lines.push(schedules.length > 0 ? `  schedules:\n${schedules.join("\n")}\n  next runs: ${next.length > 0 ? next.join(", ") : routine.status === "ativa" ? "none" : "(not running)"}` : "  schedules: none (the server watches the goal by itself)");
  if (routine.type === "acompanhamento") {
    const summary = deps.tracking?.summary?.(routine);
    lines.push(`  items: ${summary ? `${summary.active} active, ${summary.ended} ended, ${summary.stopped} stopped, ${summary.due} due for a check, ${summary.changedToday} changed today` : "n/a"}; open task: ${item.openTask ? `${item.openTask.id} (${item.openTask.status})` : "none"}; cost: US$ ${item.cost.totalUsd.toFixed(2)} total.`);
    return lines.join("\n");
  }
  const limit = ROUTINE_LIMITS_TABLE[routine.kind];
  const limits = [limit.daily ? `${limit.daily}/day` : "", limit.weekly ? `${limit.weekly}/week` : ""].filter(Boolean).join(", ") || "none";
  const history = item.history.length > 0 ? item.history.map((point) => `${point.periodKey} ${point.outcome} (${point.delivered}/${point.target})`).join("; ") : "none yet";
  const goal = goalOf(routine);
  const periodName = item.period === "month" ? "month" : "week";
  lines.push(
    `  goal: ${item.delivered}/${routine.target} ${routine.unit} delivered this ${periodName} (${item.periodKey}), ${item.registered} recorded but not yet delivered, expected by now ${item.expected}, pace: ${PACE_LABELS[item.pace]}, ${item.daysLeft} day(s) left; on ${routine.site} (${routine.kind}); ${item.inFlight} approved and waiting to be done, ${item.pending} option(s) waiting for the user's OK, ${item.missing} still missing; prepare factor ${goal.prepareFactor}x; preferred days (a suggestion only): ${item.preferredDays.length > 0 ? item.preferredDays.join(",") : "any"}; stops when the goal is hit: ${goal.stopOnHit ? "yes" : "no"}; options prepared/approved/dismissed this ${periodName}: ${item.stats.prepared}/${item.stats.approved}/${item.stats.dismissed}.`,
    `  site limits: ${limits}; today ${item.todayCount}${item.dailyCap !== null ? `/${item.dailyCap}` : ""}; open task: ${item.openTask ? `${item.openTask.id} (${item.openTask.status})` : "none"}; next: ${item.nextDispatch.reason}; cost this period: US$ ${item.cost.periodUsd.toFixed(2)}${item.cost.perUnitUsd !== null ? ` (US$ ${item.cost.perUnitUsd.toFixed(2)} per ${routine.unit})` : ""}.`,
    `  last periods: ${history}.`,
  );
  return lines.join("\n");
}

/** Ferramentas de rotinas dos agentes de time: ver as suas e registrar o que fizeram. */
export function workerRoutineTools(agentId: string, deps: RoutineToolsDeps): McpTool[] {
  const currentTask = () => {
    if (!deps.runner.hasActive(agentId)) return undefined;
    const taskId = deps.runner.currentTaskId(agentId);
    return deps.state.read().tasks.find((task) => task.id === taskId);
  };
  const mine = () => {
    const state = deps.state.read();
    const teamId = state.agents.find((agent) => agent.id === agentId)?.teamId;
    return deps.routines.list().filter((routine) => routine.status !== "proposta" && routine.status !== "encerrada" && (routine.agentId === agentId || (routine.teamId !== undefined && routine.teamId === teamId)));
  };
  return [
    ...(deps.tracking ? routineItemsTools(agentId, { state: deps.state, runner: deps.runner, tracking: deps.tracking, now: deps.now }) : []),
    defineTool({
      name: "routine_status",
      description: "Shows the routines you work on: this week's progress, pace, daily cap left and the one your current task belongs to. Read-only.",
      input: z.object({}),
      call: () => {
        const now = deps.now();
        const task = currentTask();
        const list = mine().map((routine) => {
          const item = overviewItem({ routines: deps.routines, state: deps.state, now, ...(deps.forYou ? { forYou: deps.forYou() } : {}) }, routine);
          return `${describe(item, deps)}${task?.routineId === routine.id ? "\n  <- the routine of your current task" : ""}`;
        });
        return ok(list.length === 0 ? "You have no routines." : list.join("\n\n"));
      },
    }),
    defineTool({
      name: "routine_record",
      description:
        "Records ONE item you actually did for the routine of your current task (e.g. the invite you sent, the comment you posted), with its link (a link on the routine's site is required when the routine publishes there). When nothing is published because the item was delivered to the owner (they approve and use it themselves), or the routine has no site, record it WITHOUT url: pass delivered_to \"owner\" and a note saying what was delivered. Call it right after each item. It only counts when your task ends with submit_result (items of a failed or unfinished task do not count). Duplicated links and items over the site's daily cap are refused. Never record what you only prepared or what is waiting for the user's approval.",
      input: z.object({
        routine_id: z.string().trim().min(1).max(16).describe('The routine of your task, e.g. "R-0001" (it is in the task briefing)'),
        url: z.string().trim().max(ROUTINE_LIMITS.url).optional().describe("Full https link to the item (the post, the comment permalink, the profile invited). Required when the routine publishes on its site; omit only with delivered_to"),
        delivered_to: z.literal("owner").optional().describe('"owner" = the item was delivered to the owner (nothing published, no link): requires note'),
        note: z.string().trim().max(ROUTINE_LIMITS.note).optional().describe("One short line about the item (e.g. the person's name); required with delivered_to"),
      }),
      call: ({ routine_id, url, delivered_to, note }) => {
        try {
          const { entry, todayCount, cap } = deps.routines.record({ task: currentTask(), agentId, routineId: routine_id, ...(url ? { url } : {}), ...(delivered_to ? { deliveredTo: delivered_to } : {}), ...(note ? { note } : {}) });
          return ok(`Recorded (${entry.id.slice(0, 8)}): ${todayCount}${cap !== undefined ? `/${cap}` : ""} today. It counts when you finish with submit_result.`);
        } catch (error) {
          if (error instanceof RoutineToolError) return fail(error.message);
          throw error;
        }
      },
    }),
  ];
}
