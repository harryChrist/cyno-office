import { z } from "zod";

/**
 * Scripts dos agentes: comandos demorados (download, crawler, build, migração) que o SERVIDOR roda a pedido de um
 * agente (ferramentas MCP `start_script` / `check_script` / `stop_script`), em vez de o agente rodar no terminal
 * da própria CLI. Assim a saída aparece ao vivo (página "Scripts" e painel do agente), fica guardada inteira e o
 * usuário pode parar. O script roda com o mesmo poder do terminal do agente, nunca mais: só para quem tem o acesso
 * "terminal" ligado, na pasta do agente ou numa pasta de trabalho dele, com o ambiente sem segredos e, nos motores
 * que rodam cercados (OpenClaw, Hermes), dentro da mesma cerca de arquivos.
 *
 * Um script vive no máximo até a tarefa que o lançou terminar: o agente espera com `check_script` antes de entregar.
 */

export const SCRIPT_STATUSES = ["running", "done", "failed", "stopped", "timeout", "lost"] as const;
export type ScriptStatus = (typeof SCRIPT_STATUSES)[number];

/** Rótulos em pt-BR (página Scripts e painel do agente). */
export const SCRIPT_STATUS_LABELS: Record<ScriptStatus, string> = {
  running: "Rodando",
  done: "Terminou",
  failed: "Terminou com erro",
  stopped: "Parado",
  timeout: "Passou do tempo",
  lost: "Interrompido",
};

/** Quem parou um script (`status: "stopped"`). `task`: a tarefa que o lançou terminou ou foi cancelada. */
export const SCRIPT_STOPPERS = ["user", "agent", "task", "server"] as const;
export type ScriptStopper = (typeof SCRIPT_STOPPERS)[number];

export const SCRIPT_STOPPER_LABELS: Record<ScriptStopper, string> = {
  user: "Parado por você",
  agent: "Parado pelo agente",
  task: "Parado porque a tarefa terminou",
  server: "Parado pelo Cyno",
};

export const SCRIPT_LIMITS = {
  /** Tamanho máximo do comando. */
  command: 4000,
  /** Nome curto que o agente dá ao script ("Download dos capítulos da série 294"). */
  title: 80,
  /** Scripts rodando ao mesmo tempo por agente (não há teto por workspace: o número de agentes rodando já é limitado). */
  runningPerAgent: 2,
  /** Tempo máximo de um script, em minutos: o padrão e o teto que o agente pode pedir. */
  defaultTimeoutMinutes: 60,
  maxTimeoutMinutes: 12 * 60,
  /** Saída guardada por script (bytes). Passou disso, o script segue rodando mas o resto não é gravado. */
  outputBytes: 20 * 1024 * 1024,
  /** Última linha da saída mostrada na lista. */
  lastLine: 300,
  /** Fim da saída que as ferramentas devolvem ao agente (caracteres, sem cores). */
  agentTail: 4000,
  /** Quanto o `check_script` pode esperar por novidade, em segundos: o padrão e o teto. */
  defaultWaitSeconds: 60,
  maxWaitSeconds: 240,
  /** Scripts terminados guardados por workspace (os mais velhos saem, com a saída). */
  keepFinished: 40,
  /** Quanto um script terminado fica na lista, em minutos: serve de registro do que rodou e depois some, com a saída. */
  finishedTtlMinutes: 30,
  /** De quanto em quanto tempo a faxina dos terminados vencidos passa, em minutos (um terminado some entre 30 e 40 minutos depois do fim). */
  sweepMinutes: 10,
  /** Pedaço máximo de saída por leitura (GET .../output). */
  readBytes: 256 * 1024,
} as const;

/** Um script lançado por um agente. Tudo que é texto do comando ou da saída já vem com segredos mascarados. */
export type ScriptRun = {
  /** "s1", "s2"… (único no workspace, não se repete depois de reiniciar). */
  id: string;
  agentId: string;
  /** Nome do agente na hora do lançamento. */
  agentName: string;
  /** A tarefa em curso quando o agente lançou (ausente: lançado numa conversa). */
  taskId?: string;
  title: string;
  command: string;
  /** Pasta em que roda. */
  cwd: string;
  status: ScriptStatus;
  /** Código de saída (só depois de terminar; null = morto por sinal). */
  exitCode?: number | null;
  stoppedBy?: ScriptStopper;
  startedAt: string;
  endedAt?: string;
  /** Prazo: depois disto o script é parado (`timeout`). */
  deadlineAt: string;
  /** Bytes de saída gravados até agora. */
  bytes: number;
  /** A saída passou do limite e o resto não foi gravado. */
  truncated: boolean;
  /** Última linha não vazia da saída (sem cores, até SCRIPT_LIMITS.lastLine). */
  lastLine?: string;
  /** Rodou dentro da cerca de arquivos (só nos motores cercados). */
  fenced: boolean;
};

/** GET /scripts e o campo `scripts` do estado inicial: os que estão rodando e os terminados recentes (mais novos primeiro). */
export type ScriptsState = { runs: ScriptRun[] };

/**
 * GET /scripts/:id/output?from=<byte>: um pedaço da saída a partir de `from` (bytes). `next` é o `from` da próxima
 * leitura; `done` = o script terminou E não há mais nada depois de `next`. O texto é o bruto do programa (com as
 * sequências de cor e `\r` das barras de progresso), para um terminal de leitura (xterm) desenhar igual.
 */
export type ScriptOutputResponse = { id: string; from: number; next: number; size: number; data: string; done: boolean };

export const scriptIdSchema = z.string().regex(/^s\d{1,7}$/);
export const scriptParamsSchema = z.object({ id: scriptIdSchema });
export const scriptOutputQuerySchema = z.object({ from: z.coerce.number().int().min(0).default(0) });

export const isScriptRunning = (run: Pick<ScriptRun, "status">): boolean => run.status === "running";

export function scriptsPath(workspaceId: string): string {
  return `/api/w/${encodeURIComponent(workspaceId)}/scripts`;
}
export function scriptPath(workspaceId: string, id: string): string {
  return `${scriptsPath(workspaceId)}/${encodeURIComponent(id)}`;
}
/** Saída em pedaços (JSON). */
export function scriptOutputPath(workspaceId: string, id: string, from = 0): string {
  return `${scriptPath(workspaceId, id)}/output?from=${from}`;
}
/** A saída inteira como arquivo de texto (sem cores), para baixar. */
export function scriptDownloadPath(workspaceId: string, id: string): string {
  return `${scriptPath(workspaceId, id)}/download`;
}
/** POST: para o script. */
export function scriptStopPath(workspaceId: string, id: string): string {
  return `${scriptPath(workspaceId, id)}/stop`;
}

// eslint-disable-next-line no-control-regex -- as sequências de terminal começam com ESC e podem terminar com BEL
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/** Tira as sequências de cor/controle do terminal. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * Texto simples de uma saída de terminal: sem cores, e em cada linha só o que ficou depois do último `\r`
 * (uma barra de progresso que se reescreve vira a última versão dela).
 */
export function plainScriptOutput(text: string): string {
  return stripAnsi(text)
    .split("\n")
    .map((line) => {
      const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
      const at = clean.lastIndexOf("\r");
      return at >= 0 ? clean.slice(at + 1) : clean;
    })
    .join("\n");
}

/** Duração legível ("42 s", "3 min", "1 h 05 min"). */
export function scriptDurationLabel(startedAt: string, endedAt: string | undefined, now: number): string {
  const end = endedAt ? Date.parse(endedAt) : now;
  const seconds = Math.max(0, Math.round((end - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}
