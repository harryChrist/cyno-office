/**
 * Compatibilidade: o "Plano" virou "Projeto" (veja projects.ts). Os nomes antigos continuam
 * exportados como apelidos por uma versão; código novo importa de projects.ts.
 */
export {
  buildProjectTasks as buildPlanTasks,
  DEFAULT_DISPATCH,
  DISPATCH_LIMITS,
  dispatchSettings,
  findAgentByRef,
  findDependencyCycle,
  isProjectOpen as isPlanOpen,
  isProjectStepTask as isPlanStepTask,
  isProjectTaskFinished as isPlanTaskFinished,
  KANBAN_COLUMNS,
  kanbanColumn,
  nextStep,
  PROJECT_INPUT_PRIORITIES as PLAN_INPUT_PRIORITIES,
  PROJECT_LIMITS as PLAN_LIMITS,
  PROJECT_PRIORITIES as PLAN_PRIORITIES,
  PROJECT_PRIORITY_LABELS as PLAN_PRIORITY_LABELS,
  PROJECT_STATUS_LABELS as PLAN_STATUS_LABELS,
  PROJECT_STATUSES as PLAN_STATUSES,
  PROJECT_STEP_STATUSES as PLAN_STEP_STATUSES,
  PROJECT_TASK_STATUSES as PLAN_TASK_STATUSES,
  projectMarkdown as planMarkdown,
  projectProgress as planProgress,
} from "./projects";
export type {
  DispatchSettings,
  KanbanColumnId,
  Project as Plan,
  ProjectAgentPool as PlanAgentPool,
  ProjectHelp as PlanHelp,
  ProjectInputPriority as PlanInputPriority,
  ProjectPriority as PlanPriority,
  ProjectStatus as PlanStatus,
  ProjectStep as PlanStep,
  ProjectStepStatus as PlanStepStatus,
  ProjectTask as PlanTask,
  ProjectTaskInput as PlanTaskInput,
  ProjectTaskStatus as PlanTaskStatus,
} from "./projects";
