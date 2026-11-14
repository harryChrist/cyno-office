import type { AppConfig } from "../../config";
import { MockRunner } from "../../sim/mock-runner";
import type { AgentRunner } from "./types";

export type { AgentRunner, RunHooks, RunInput, RunOutcome } from "./types";
export { MockRunner, type MockRunnerOptions } from "../../sim/mock-runner";
export { NO_ENGINE_RESULT, NoEngineRunner } from "./no-engine-runner";

/**
 * Runner simulado só quando ligado explicitamente (AGENT_RUNNER=mock, para testes e e2e).
 * Sem isso: undefined, e o servidor só oferece agentes e Maestro reais.
 */
export function createRunner(config: Pick<AppConfig, "agentRunner" | "mock">): AgentRunner | undefined {
  return config.agentRunner === "mock" ? new MockRunner(config.mock) : undefined;
}
