import type { AgentRunner, RunHooks, RunInput, RunOutcome } from "./types";

/** Mensagem da tarefa de um agente sem motor (gravado com `engine: "mock"` ou sem `engine`, dados antigos). */
export const NO_ENGINE_RESULT = "Este agente está sem motor; escolha um (Claude Code ou Antigravity) em Editar agente e tente de novo.";

/**
 * Runner dos agentes "sem motor" quando o modo simulado está desligado (o padrão de produção):
 * nada roda; a tarefa falha na hora com uma mensagem clara. O agente não é alterado no disco.
 */
export class NoEngineRunner implements AgentRunner {
  async run(_input: RunInput, hooks: RunHooks): Promise<RunOutcome> {
    hooks.onProgress(0, NO_ENGINE_RESULT);
    return { status: "failed", result: NO_ENGINE_RESULT, kind: "motor" };
  }
}
