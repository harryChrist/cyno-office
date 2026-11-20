import { effectiveAccess, SCRIPT_LIMITS, scriptDurationLabel, type ScriptRun, type WorkspaceAccess } from "@cyno/shared";
import { z } from "zod";
import type { ScriptsService } from "../workspace/scripts/service";
import { defineTool, type McpTool, type McpToolResult } from "./protocol";
import { text } from "./tool-fields";

export type ScriptToolsDeps = {
  scripts: Pick<ScriptsService, "start" | "wait" | "stop" | "list" | "find" | "plainTail">;
  /** Política de acesso do workspace (lida a cada tools/list: mudanças valem na hora). */
  access: () => WorkspaceAccess | undefined;
  /** Tarefa em curso do agente (o script fica ligado a ela e para quando ela termina). */
  currentTaskId: (agentId: string) => string | undefined;
};

/** Teto do `wait_seconds` do check_script (segundos): abaixo do que as CLIs aguentam numa chamada de ferramenta. */
export const MAX_CHECK_WAIT_SECONDS = SCRIPT_LIMITS.maxWaitSeconds;

/** A primeira linha de `start_script`, `check_script` e `stop_script`: a interface lê o id e o estado dela. */
export const scriptHeadline = (run: Pick<ScriptRun, "id" | "status">): string => `Script ${run.id} · ${run.status}`;

const ABOUT_LONG =
  "Runs a long command ON THE SERVER, in the background, and returns right away. The server records the whole output and the user watches it live (and can stop it). Use it for anything expected to take more than about a minute: loops over many items, waits between steps, downloads, crawlers, full builds or test suites, data migrations. Keep quick commands in your own terminal. It has the same power as your terminal and no more: runs with bash in your folder (or a work folder of yours), with a clean environment. It is NOT interactive: no input can be typed, so use flags like -y. ";

const ids = z.string().trim().regex(/^s\d{1,7}$/, 'A script id like "s12"').describe('The script id returned by start_script (e.g. "s12")');

function describeEnd(run: ScriptRun): string[] {
  switch (run.status) {
    case "running":
      return [];
    case "done":
      return ["It finished successfully (exit code 0)."];
    case "failed":
      return [`It failed (exit code ${run.exitCode ?? "unknown"}). Read the output end below, fix the cause and start it again if needed.`];
    case "timeout":
      return ["It was stopped because it passed its time limit."];
    case "stopped":
      return [run.stoppedBy === "user" ? "The user stopped it." : run.stoppedBy === "agent" ? "You stopped it." : run.stoppedBy === "task" ? "It was stopped because your task ended." : "The server stopped it."];
    case "lost":
      return ["It was interrupted by a server restart; the output up to that point was kept."];
  }
}

/**
 * Ferramentas de script (`start_script`, `check_script`, `stop_script`, `list_scripts`): só para agentes de time com o terminal
 * ligado. Cada agente só enxerga e mexe nos scripts que ele mesmo lançou.
 */
export function scriptTools(agentId: string, deps: ScriptToolsDeps): McpTool[] {
  const { scripts } = deps;
  const own = (id: string): ScriptRun => {
    const run = scripts.find(id);
    if (!run || run.agentId !== agentId) throw new Error(`Script ${id} was not found among your scripts (list_scripts shows them; a finished script is removed about ${SCRIPT_LIMITS.finishedTtlMinutes} minutes after it ends)`);
    return run;
  };
  const report = async (run: ScriptRun, extra: string[] = [], tail = true): Promise<McpToolResult> => {
    const now = Date.now();
    const lines = [
      scriptHeadline(run),
      `Title: ${run.title}`,
      `Folder: ${run.cwd}`,
      `Time limit: ${Math.round((Date.parse(run.deadlineAt) - Date.parse(run.startedAt)) / 60_000)} min`,
      `Elapsed: ${scriptDurationLabel(run.startedAt, run.endedAt, now)}`,
      ...(run.exitCode !== undefined ? [`Exit code: ${run.exitCode === null ? "none (killed)" : run.exitCode}`] : []),
      `Output so far: ${Math.round(run.bytes / 1024)} KB${run.truncated ? " (over the limit: the rest is not kept)" : ""}`,
      ...describeEnd(run),
      ...extra,
    ];
    if (tail) {
      const end = await scripts.plainTail(run.id, SCRIPT_LIMITS.agentTail);
      lines.push("", end ? `Output (end, colors removed, up to ${SCRIPT_LIMITS.agentTail} characters):` : "Output: nothing yet.", ...(end ? [end] : []));
    }
    return text(lines.join("\n"));
  };
  return [
    defineTool({
      name: "start_script",
      description: [
        ABOUT_LONG,
        "The script is stopped when your task ends, so after starting it keep following it with check_script until it finishes, and only then call submit_result. Do not poll with ps, cat or tail yourself.",
      ].join(""),
      input: z.object({
        command: z.string().trim().min(1).max(SCRIPT_LIMITS.command).describe("The shell command (bash -c). For anything long or multi-line, write a script file in your folder and run it here"),
        title: z.string().trim().min(1).max(SCRIPT_LIMITS.title).describe('Short name the user will see, in Brazilian Portuguese (e.g. "Baixar os capítulos da série 294")'),
        cwd: z.string().trim().max(500).optional().describe("Folder to run in: your own folder (default) or a folder inside it or inside one of your work folders"),
        timeout_minutes: z.number().int().min(1).max(SCRIPT_LIMITS.maxTimeoutMinutes).optional().describe(`Time limit in minutes (default ${SCRIPT_LIMITS.defaultTimeoutMinutes}, max ${SCRIPT_LIMITS.maxTimeoutMinutes}); the script is stopped when it passes`),
      }),
      call: async ({ command, title, cwd, timeout_minutes }) => {
        const taskId = deps.currentTaskId(agentId);
        const run = await scripts.start({ agentId, ...(taskId ? { taskId } : {}), title, command, ...(cwd ? { cwd } : {}), ...(timeout_minutes ? { timeoutMinutes: timeout_minutes } : {}) });
        return report(
          run,
          [
            "",
            `Started in the background. Follow it with check_script({ id: "${run.id}" }) (it waits for the script to finish, up to ${SCRIPT_LIMITS.defaultWaitSeconds} s per call by default) until the status is no longer running, then report the result. It stops by itself when your task ends.`,
          ],
          false,
        );
      },
    }),
    defineTool({
      name: "check_script",
      description:
        `Follows a script you started with start_script: waits up to wait_seconds (default ${SCRIPT_LIMITS.defaultWaitSeconds}, max ${MAX_CHECK_WAIT_SECONDS}) for it to finish, then returns its status and the end of its output (plain text). Call it again until the status is not "running"; do not poll with ps/cat/tail. Do not call submit_result while a script you need is still running: it would be stopped.`,
      input: z.object({
        id: ids,
        wait_seconds: z.number().int().min(0).max(MAX_CHECK_WAIT_SECONDS).optional().describe(`How long to wait for it to finish (default ${SCRIPT_LIMITS.defaultWaitSeconds}, max ${MAX_CHECK_WAIT_SECONDS}); 0 = answer right now`),
      }),
      call: async ({ id, wait_seconds }) => {
        own(id);
        const run = await scripts.wait(id, wait_seconds ?? SCRIPT_LIMITS.defaultWaitSeconds);
        return report(run, run.status === "running" ? ["", `Still running. Call check_script({ id: "${id}" }) again; do not end your task while you need its result.`] : []);
      },
    }),
    defineTool({
      name: "stop_script",
      description: "Stops a script you started (terminates its whole process tree) and returns its final status and the end of its output. You can only stop your own scripts.",
      input: z.object({ id: ids }),
      call: async ({ id }) => {
        own(id);
        return report(await scripts.stop(id, "agent"));
      },
    }),
    defineTool({
      name: "list_scripts",
      description: `Lists your scripts (running first, then the ones that finished in about the last ${SCRIPT_LIMITS.finishedTtlMinutes} minutes) with id, status, title and elapsed time.`,
      input: z.object({}),
      call: () => {
        const mine = scripts.list().filter((run) => run.agentId === agentId);
        if (mine.length === 0) return text("You have no scripts.");
        const now = Date.now();
        return text(mine.map((run) => `${scriptHeadline(run)} · ${run.title} · ${scriptDurationLabel(run.startedAt, run.endedAt, now)}${run.exitCode !== undefined && run.exitCode !== null ? ` · exit ${run.exitCode}` : ""}`).join("\n"));
      },
    }),
  ];
}

/** Os agentes com o terminal ligado (workspace E agente) recebem as ferramentas; os outros não as veem. */
export function scriptToolsFor(agentId: string, agent: Parameters<typeof effectiveAccess>[1], deps: ScriptToolsDeps | undefined): McpTool[] {
  if (!deps) return [];
  return effectiveAccess(deps.access(), agent).terminal ? scriptTools(agentId, deps) : [];
}
