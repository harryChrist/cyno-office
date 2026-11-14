import { isActiveTaskStatus } from "@cyno/shared";
import type { ProjectHost, ProjectWakeKind } from "../projects/project-service";
import type { MaestroCore } from "./maestro-core";

/** O papel de `ProjectHost`: o ProjectService avisa; o pedido é do Maestro (daqui sai o status, o log e a mensagem que o acorda). */
export class MaestroPlanHost implements ProjectHost {
  constructor(private readonly core: MaestroCore) {}

  awaitUser(requestId: string, why: string): void {
    const state = this.core.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === requestId);
    if (!task || !isActiveTaskStatus(task.status)) return;
    delete task.waiting;
    this.core.setTask(state, task, { status: "waiting_approval" });
    this.core.logEntry(task, { kind: "status", status: "waiting", message: why });
    this.core.setProgress(task, 0.2, why);
    this.core.deps.refreshStatus();
  }

  working(requestId: string, message: string, progress: number): void {
    const state = this.core.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === requestId);
    if (!task || !isActiveTaskStatus(task.status)) return;
    if (task.status !== "in_progress" || task.waiting) this.core.setTask(state, task, { status: "in_progress" });
    this.core.setProgress(task, progress, message);
    this.core.deps.refreshStatus();
  }

  wake(requestId: string, kind: ProjectWakeKind, build: () => string): void {
    if (!this.core.isOpen(requestId)) return;
    const labels: Record<ProjectWakeKind, string> = {
      done: "O Maestro está juntando os resultados do plano",
      failed: "Uma tarefa falhou: o Maestro decide",
      help: "Um agente pediu ajuda: o Maestro decide",
      stalled: "Tarefas paradas: o Maestro foi avisado",
      adjust: "O Maestro está ajustando o plano",
      handoff: "Repasse entre agentes barrado: o Maestro foi avisado",
    };
    const state = this.core.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === requestId)!;
    if (task.status !== "in_progress") this.core.setTask(state, task, { status: "in_progress" });
    this.core.setProgress(task, kind === "done" ? 0.9 : 0.5, labels[kind]);
    // O texto é montado quando a sessão consome a mensagem (não agora).
    this.core.push(requestId, build);
    this.core.deps.refreshStatus();
  }

  close(requestId: string, reason: string): void {
    const state = this.core.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === requestId);
    // O usuário cancelou o projeto: o pedido fecha como cancelado (não como falha).
    if (task && isActiveTaskStatus(task.status)) this.core.finish(state, task, "failed", reason, "cancelled");
  }
}
