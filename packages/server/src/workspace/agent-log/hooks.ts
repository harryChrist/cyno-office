import { describeWork, maskSecrets, summarizeToolInput, type AgentLogBody } from "@cyno/shared";
import type { RunHooks, RunnerLogInput, SubagentHooks, ThreadHooks } from "../../engines/runner/types";
import type { AgentLogService, LogRef } from "./service";

/** Converte o que o runner escreveu num corpo de entrada (ferramenta nasce "running"). */
function toBody(input: RunnerLogInput): AgentLogBody {
  if (input.kind !== "tool") return input;
  const { toolUseId, name, input: toolInput, summary } = input;
  // A frase de atividade ("📖 Lendo App.tsx") nasce aqui, para todo motor. O resumo é texto montado
  // pelo servidor: sai mascarado (o input e a saída crus ficam no log; a tela mascara ao mostrar).
  const { icon, text } = describeWork(name, toolInput);
  return {
    kind: "tool",
    toolUseId,
    name,
    summary: maskSecrets(summary ?? summarizeToolInput(toolInput)),
    phrase: { icon, text },
    status: "running",
    ...(toolInput === undefined ? {} : { input: toolInput }),
  };
}

/** Id de thread seguro (letras, números, "_" e "-", até 64), ou undefined se não sobrar nada. */
function threadId(raw: string | undefined): string | undefined {
  const clean = raw?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return clean ? clean : undefined;
}

function threadHooks(service: AgentLogService, ref: LogRef, active: () => boolean): ThreadHooks {
  return {
    log: (input) => {
      if (active()) service.append(ref, toBody(input));
    },
    toolResult: (toolUseId, result) => {
      if (active()) service.toolResult(ref.taskId, toolUseId, result);
    },
  };
}

/**
 * Ganchos de log de uma execução (`log`, `toolResult`, `subagent`), para o orquestrador montar
 * os RunHooks. `active()` falso (tarefa cancelada, server desligando) = tudo vira no-op.
 */
export function runnerLogHooks(
  service: AgentLogService,
  ref: LogRef,
  active: () => boolean,
): Pick<RunHooks, "log" | "toolResult" | "subagent"> {
  return {
    ...threadHooks(service, ref, active),
    subagent: (spec): SubagentHooks => {
      const id = threadId(spec.id) ?? `sa-${service.nextId()}`;
      const thread: LogRef = { ...ref, thread: id };
      let finished = false;
      const open = () => active() && !finished;
      if (active()) service.append(ref, { kind: "subagent", phase: "started", subagentId: id, label: spec.label, goal: spec.goal, ...(spec.model ? { model: spec.model } : {}) });
      return {
        id,
        ...threadHooks(service, thread, open),
        progress: (progress, message) => {
          if (open()) service.progress(thread, progress, message);
        },
        finish: ({ status, result }) => {
          if (!open()) return;
          finished = true;
          if (result) service.append(thread, { kind: "result", text: result });
          service.append(ref, {
            kind: "subagent",
            phase: "finished",
            subagentId: id,
            label: spec.label,
            status,
            ...(result === undefined ? {} : { result }),
          });
        },
      };
    },
  };
}
