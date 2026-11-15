import { execFile } from "node:child_process";

export type GitResult = { ok: true; stdout: string } | { ok: false; code: number | string | null; stderr: string; timedOut: boolean };

/** Ambiente do git sem interação: nunca pergunta senha, nem no ssh (BatchMode) e com tempo de conexão curto. */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const ssh = `${base.GIT_SSH_COMMAND?.trim() || "ssh"} -o BatchMode=yes -o ConnectTimeout=10`;
  return { ...base, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: ssh, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", GCM_INTERACTIVE: "never" };
}

/** Roda `git <args>` sem shell, com tempo limite. `cwd` pode faltar (comandos como `ls-remote <url>` não precisam de repositório). */
export function runGit(args: string[], options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { ...(options.cwd ? { cwd: options.cwd } : {}), timeout: options.timeoutMs ?? 5000, killSignal: "SIGKILL", env: gitEnv(options.env), maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, stdout });
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        resolve({ ok: false, code: failure.code ?? null, stderr: String(stderr ?? ""), timedOut: failure.killed === true || failure.signal === "SIGKILL" });
      },
    );
  });
}
