import { approvalRefusedResult } from "@cyno/shared";
import {
  approvalQuestion,
  failureResult,
  mockDraft,
  mockResult,
  mockToolCall,
  planMockRun,
  subagentGoal,
  subagentLabel,
  type MockStep,
  type MockSubagentPlan,
  type MockToolName,
} from "./mock-script";
import { realSleep, type Sleep } from "../engines/runner/sleep";
import type { AgentRunner, ApprovalDecision, RunHooks, RunInput, RunOutcome, ThreadHooks } from "../engines/runner/types";

export type MockRunnerOptions = {
  /** Duração total de cada tarefa: sorteada entre minMs e maxMs. */
  minMs: number;
  maxMs: number;
  /** Chance (0..1) de pedir aprovação mesmo sem "[aprovar]" no pedido. */
  approvalRate: number;
  /** Chance (0..1) de dividir um passo entre 2–3 subagentes em paralelo (padrão 0). */
  subagentRate?: number;
  /** Aleatoriedade injetável (testes determinísticos). Número em [0, 1). */
  random?: () => number;
  /** Relógio injetável: espera entre os passos, respeitando o AbortSignal. */
  sleep?: Sleep;
};

/** Contexto de uma execução: a entrada, o sinal e o gerador de ids de ferramenta. */
type RunContext = { input: RunInput; signal: AbortSignal; nextToolId: (prefix: string) => string };

/**
 * Agente simulado: narra cada passo no log, usa ferramentas simuladas (brain.search, web_search,
 * read_file, write_draft, run_checks; às vezes uma falha e é repetida), às vezes divide um passo
 * entre subagentes em paralelo, emite progresso, pede aprovação opcional (com um rascunho
 * simulado para o "Para você") e devolve um resultado em markdown que usa o texto final aprovado.
 * O tempo de cada passo é o mesmo de antes (as esperas de um passo somam `waitMs`).
 */
export class MockRunner implements AgentRunner {
  readonly provider = "mock" as const;
  private readonly random: () => number;
  private readonly sleep: Sleep;

  constructor(private readonly options: MockRunnerOptions) {
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? realSleep;
  }

  async run(input: RunInput, hooks: RunHooks): Promise<RunOutcome> {
    const { signal } = input;
    signal.throwIfAborted();
    const plan = planMockRun(input.task.prompt, { ...this.options, random: this.random });
    let toolCount = 0;
    const run: RunContext = { input, signal, nextToolId: (prefix) => `${prefix}-${++toolCount}` };
    let approval: ApprovalDecision | undefined;

    for (const [index, step] of plan.steps.entries()) {
      hooks.log({ kind: "text", text: step.narration });
      if (index === plan.subagentsAt) await this.delegate(run, hooks, plan.subagents, step.waitMs);
      else await this.work(run, hooks, step);
      if (index === plan.approvalAt) {
        const draft = mockDraft(input);
        approval = await hooks.requestApproval({ question: approvalQuestion(input), draft });
        signal.throwIfAborted();
        // Recusa com motivo que volta para refazer: o agente simulado revisa o texto e pede de novo.
        while (approval.retry) {
          hooks.log({ kind: "text", text: `O usuário recusou (${approval.reason ?? "sem motivo"}). Refazendo com o motivo.` });
          approval = await hooks.requestApproval({ question: approvalQuestion(input), draft: { ...draft, text: `${draft.text} (revisado: ${approval.reason ?? "ajustado"})` } });
          signal.throwIfAborted();
        }
        if (!approval.approved) return { status: "failed", result: approvalRefusedResult(approval.response) };
        hooks.log({ kind: "text", text: approval.cancelled ? "O pedido foi retirado do Para você. Seguindo sem ele." : "Aprovado. Seguindo com o texto final." });
      }
      if (index === plan.failAt) {
        hooks.log({ kind: "text", text: "Não consegui seguir: o pedido mandou falhar." });
        return { status: "failed", result: failureResult(input) };
      }
      hooks.onProgress(step.progress, step.message);
    }
    hooks.log({ kind: "text", text: "Pronto: entregando o resultado." });
    return { status: "done", result: mockResult(input, approval) };
  }

  /** Espera e confere o cancelamento (nenhum gancho é chamado depois de um abort). */
  private async wait(ms: number, signal: AbortSignal): Promise<void> {
    await this.sleep(ms, signal);
    signal.throwIfAborted();
  }

  /** Um passo comum: com ferramenta, pensa um pouco e chama; sem, só espera. */
  private async work(run: RunContext, hooks: ThreadHooks, step: MockStep): Promise<void> {
    if (!step.tool) return this.wait(step.waitMs, run.signal);
    await this.useTool(run, hooks, step.tool, step.waitMs, step.toolFails, "t");
  }

  /**
   * Chamada de ferramenta simulada dentro de `totalMs`: pensa (40%), chama e espera o resultado.
   * Com `fails`, a primeira tentativa dá erro e o agente tenta de novo.
   */
  private async useTool(run: RunContext, hooks: ThreadHooks, name: MockToolName, totalMs: number, fails: boolean, prefix: string): Promise<void> {
    const call = mockToolCall(name, run.input);
    const think = Math.round(totalMs * 0.4);
    await this.wait(think, run.signal);
    let toolUseId = run.nextToolId(prefix);
    hooks.log({ kind: "tool", toolUseId, name, input: call.input });
    let rest = totalMs - think;
    if (fails) {
      const first = Math.round(totalMs * 0.3);
      await this.wait(first, run.signal);
      hooks.toolResult(toolUseId, { status: "error", output: call.error });
      hooks.log({ kind: "text", text: `A ferramenta ${name} falhou; tentando de novo.` });
      toolUseId = run.nextToolId(prefix);
      hooks.log({ kind: "tool", toolUseId, name, input: call.input });
      rest -= first;
    }
    await this.wait(rest, run.signal);
    hooks.toolResult(toolUseId, { status: "ok", output: call.output });
  }

  /**
   * Divide o passo entre subagentes que rodam ao mesmo tempo (cada um com a própria thread no
   * log) e junta os resultados. Espera todos terminarem (ou falharem) antes de seguir: assim
   * nenhum subagente chama ganchos depois que a execução resolveu.
   */
  private async delegate(run: RunContext, hooks: RunHooks, plans: MockSubagentPlan[], waitMs: number): Promise<void> {
    hooks.log({ kind: "text", text: `Vou dividir este passo em ${plans.length} frentes, cada uma com um subagente.` });
    const settled = await Promise.allSettled(
      plans.map((plan, index) => {
        const sub = hooks.subagent({ label: subagentLabel(run.input, plan), goal: subagentGoal(run.input, plan) });
        return this.subagentWork(run, sub, plan, waitMs, index);
      }),
    );
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    run.signal.throwIfAborted();
    hooks.log({ kind: "text", text: `Juntei o que os ${plans.length} subagentes trouxeram.` });
  }

  private async subagentWork(
    run: RunContext,
    sub: ReturnType<RunHooks["subagent"]>,
    plan: MockSubagentPlan,
    waitMs: number,
    index: number,
  ): Promise<void> {
    sub.log({ kind: "text", text: `Foco: ${plan.focus}.` });
    // Começos escalonados: as threads se intercalam no log.
    const start = Math.round(waitMs * 0.1 * index);
    await this.wait(start, run.signal);
    sub.progress(0.3, "Começando");
    await this.useTool(run, sub, plan.tool, waitMs - start, false, sub.id);
    sub.progress(1, "Pronto");
    sub.finish({ status: "ok", result: `Resumo da ${plan.focus} (simulado): 3 pontos úteis para a entrega.` });
  }
}
