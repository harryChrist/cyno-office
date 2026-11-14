import { maskSecrets } from "@cyno/shared";
import type { RunHooks, SubagentHooks, ThreadHooks } from "../runner/types";
import type { TerminalEvent } from "./types";

/** Ganchos de log que a ponte usa (os de RunHooks, sem progresso/aprovação). */
export type BridgeHooks = Pick<RunHooks, "log" | "toolResult" | "subagent">;

/**
 * Ponte terminal -> log de trabalho: cada TerminalEvent vira a entrada certa pelos ganchos
 * (que já põem `provider`, tarefa e agente). Texto -> `text`; ferramenta -> `tool` "running" e
 * depois atualizada no lugar; subagente (Task/Agent do Claude Code) -> `subagent` started/finished
 * com a thread = id da chamada, e tudo que vier com `thread` = esse id entra na thread dele;
 * linhas soltas -> `raw`. Eventos de controle (status, turnos, sessão) não viram log aqui.
 * Devolve a função que recebe os eventos e `close` (fecha subagentes ainda abertos).
 */
export function terminalLogBridge(hooks: BridgeHooks): { handle: (event: TerminalEvent) => void; close: (reason: string) => void } {
  const subagents = new Map<string, SubagentHooks>();
  const target = (thread: string | undefined): ThreadHooks => (thread ? (subagents.get(thread) ?? hooks) : hooks);

  const handle = (event: TerminalEvent): void => {
    switch (event.type) {
      case "text":
        target(event.thread).log({ kind: "text", text: event.text });
        return;
      case "tool_use":
        target(event.thread).log({ kind: "tool", toolUseId: event.id, name: event.name, ...(event.input ? { input: event.input } : {}) });
        return;
      case "tool_result":
        target(event.thread).toolResult(event.id, { status: event.ok ? "ok" : "error", ...(event.output ? { output: event.output } : {}) });
        return;
      case "subagent_start":
        if (!subagents.has(event.id)) subagents.set(event.id, hooks.subagent({ id: event.id, label: event.label, goal: event.goal, ...(event.model ? { model: event.model } : {}) }));
        return;
      case "subagent_end": {
        const sub = subagents.get(event.id);
        if (!sub) return;
        subagents.delete(event.id);
        sub.finish({ status: event.ok ? "ok" : "error", ...(event.result ? { result: event.result } : {}) });
        return;
      }
      case "raw":
        // A saída crua do programa pode trazer um segredo (o stderr de um erro): mascarada antes de ir à tela, ao registro e ao disco.
        hooks.log({ kind: "raw", stream: event.stream, text: maskSecrets(event.text) });
        return;
      default:
        return;
    }
  };

  const close = (reason: string): void => {
    for (const sub of subagents.values()) sub.finish({ status: "error", result: reason });
    subagents.clear();
  };

  return { handle, close };
}
