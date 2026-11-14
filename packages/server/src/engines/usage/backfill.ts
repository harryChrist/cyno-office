import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Agent, Task, UsageRecord, UsageRecordTokens } from "@cyno/shared";
import { claudeTranscriptDir } from "../terminals/claude-transcript";
import { readOfficeFile, readTasksAnyLayout } from "../../store/files";
import { dataPaths } from "../../store/paths";
import { claudeUsageDetail } from "./claude-turn-detail";
import { computeCost, PRICE_TABLE } from "./pricing";
import { parseUsageLine, rootTaskOf, taskTitleOf, usageDir, usageFile } from "./usage-history";
import { monthKeyOf } from "./usage-time";

/**
 * Importação (uma vez, idempotente) dos gastos antigos dos agentes de Claude Code a partir das
 * conversas que a própria CLI gravou: `<projetos do Claude>/<cwd do agente codificado>/<sessão>.jsonl`
 * (o cwd de cada agente é workspaces/<ws>/agents/<id>, então a pasta é só dele; os subagentes ficam
 * em `<sessão>/subagents/*.jsonl`). Cada mensagem do assistente com `usage` vira uma linha em
 * `usage/backfill-YYYY-MM.jsonl` com o modelo real e a hora dela. A tarefa vem dos logs de trabalho
 * (`logs/<taskId>.jsonl`: o id de cada ferramenta e o `[init] sessão <id>` de cada subida).
 *
 * - Nada é importado duas vezes: o id da linha é o id da mensagem (`claude-msg:<id>`).
 * - Nada que o server já gravou ao vivo é importado: só mensagens ANTES do primeiro turno ao vivo
 *   daquele agente.
 * - Antigravity: não há o que importar (só daqui para frente).
 * - Só lê as conversas e os arquivos do workspace; escreve só em usage/backfill-*.jsonl (nunca no
 *   arquivo que o server está escrevendo).
 */

export type BackfillOptions = {
  /** Pasta do workspace (DATA_DIR/workspaces/<ws>), com o caminho com que os agentes rodaram. */
  workspaceDir: string;
  /** Pasta de projetos do Claude Code (`$CLAUDE_CONFIG_DIR/projects`, padrão ~/.claude/projects). */
  projectsDir: string;
  /** Só conta, não grava. */
  dryRun?: boolean;
};

export type BackfillReport = {
  agents: number;
  files: number;
  /** Mensagens com tokens achadas nas conversas. */
  messages: number;
  imported: number;
  /** Já estavam no histórico (rodada anterior). */
  duplicates: number;
  /** Depois do começo do registro ao vivo do agente (já contadas pelo server). */
  afterLive: number;
  /** Das importadas, quantas ficaram ligadas a uma tarefa. */
  withTask: number;
  /** Das importadas, quantas com modelo fora da tabela de preços. */
  unpriced: number;
  /** Linhas importadas por mês (YYYY-MM). */
  months: Record<string, number>;
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

/** Uma mensagem do assistente (o mesmo id aparece em várias linhas, uma por bloco: fica o maior de cada número). */
type Message = {
  id: string;
  at: string;
  model?: string;
  sessionId?: string;
  sidechain: boolean;
  usage: Json;
  toolIds: string[];
  /** Índice do turno dentro do arquivo (muda a cada pedido de verdade do usuário). */
  turn: number;
  /** Primeira mensagem do turno (conta como turno). */
  first: boolean;
};

/** Mapas tirados dos logs de trabalho: ferramenta -> tarefa, sessão -> tarefa e a linha do tempo de cada agente. */
type TaskHints = {
  byToolId: Map<string, string>;
  bySession: Map<string, string>;
  timeline: Map<string, { at: number; taskId: string }[]>;
};

const INIT_SESSION = /^\[init\] sessão ([0-9a-f-]{36})/i;
/** Até quanto tempo depois da última linha de log de uma tarefa a mensagem ainda é dela. */
const TIMELINE_WINDOW_MS = 30 * 60_000;

async function readLines(file: string): Promise<string[]> {
  try {
    return (await readFile(file, "utf8")).split("\n");
  } catch {
    return [];
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function taskHints(logsDir: string): Promise<TaskHints> {
  const hints: TaskHints = { byToolId: new Map(), bySession: new Map(), timeline: new Map() };
  for (const name of (await listDir(logsDir)).filter((file) => file.endsWith(".jsonl"))) {
    for (const line of await readLines(path.join(logsDir, name))) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObject(entry)) continue;
      const taskId = str(entry.taskId);
      const agentId = str(entry.agentId);
      if (!taskId || !agentId) continue;
      const toolId = str(entry.toolUseId);
      if (toolId) hints.byToolId.set(toolId, taskId);
      const session = entry.kind === "raw" ? INIT_SESSION.exec(str(entry.text) ?? "")?.[1] : undefined;
      if (session) hints.bySession.set(session, taskId);
      const at = Date.parse(str(entry.at) ?? "");
      if (!Number.isNaN(at)) {
        const list = hints.timeline.get(agentId) ?? [];
        list.push({ at, taskId });
        hints.timeline.set(agentId, list);
      }
    }
  }
  for (const list of hints.timeline.values()) list.sort((a, b) => a.at - b.at);
  return hints;
}

/** Tarefa da última linha de log do agente até `at` (dentro da janela). */
function taskAt(hints: TaskHints, agentId: string, at: number): string | undefined {
  const list = hints.timeline.get(agentId);
  if (!list) return undefined;
  let found: { at: number; taskId: string } | undefined;
  for (const item of list) {
    if (item.at > at) break;
    found = item;
  }
  return found && at - found.at <= TIMELINE_WINDOW_MS ? found.taskId : undefined;
}

/** Texto de um pedido de verdade (não tool_result, não lembrete/comando da CLI). */
function isRealPrompt(data: Json): boolean {
  if (data.isMeta === true || data.isCompactSummary === true) return false;
  const content = isObject(data.message) ? data.message.content : undefined;
  if (typeof content === "string") return !/^\s*</.test(content);
  if (!Array.isArray(content)) return false;
  if (content.some((block) => isObject(block) && block.type === "tool_result")) return false;
  return content.some((block) => isObject(block) && block.type === "text" && !/^\s*</.test(str(block.text) ?? ""));
}

const maxUsage = (a: Json, b: Json): Json => {
  const out: Json = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (typeof value === "number" && typeof out[key] === "number") out[key] = Math.max(out[key], value);
    else if (out[key] === undefined) out[key] = value;
    else if (isObject(value) && isObject(out[key])) out[key] = maxUsage(out[key], value);
  }
  return out;
};

/** As mensagens com tokens de um arquivo de conversa, na ordem. `sidechain`: o arquivo é de um subagente. */
async function transcriptMessages(file: string, sidechainFile: boolean): Promise<Message[]> {
  const byId = new Map<string, Message>();
  const order: Message[] = [];
  let turn = 0;
  let newTurn = !sidechainFile;
  for (const line of await readLines(file)) {
    if (!line.trim()) continue;
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(data)) continue;
    const sidechain = sidechainFile || data.isSidechain === true;
    if (data.type === "user" && !sidechain && isRealPrompt(data)) {
      turn += 1;
      newTurn = true;
      continue;
    }
    if (data.type !== "assistant" || !isObject(data.message)) continue;
    const message = data.message;
    const id = str(message.id);
    const usage = isObject(message.usage) ? message.usage : undefined;
    const at = str(data.timestamp);
    if (!id || !usage || !at || Number.isNaN(Date.parse(at))) continue;
    const toolIds = Array.isArray(message.content)
      ? message.content.filter((block): block is Json => isObject(block) && block.type === "tool_use").map((block) => str(block.id)).filter((x): x is string => !!x)
      : [];
    const known = byId.get(id);
    if (known) {
      known.usage = maxUsage(known.usage, usage);
      known.toolIds.push(...toolIds);
      continue;
    }
    const model = str(message.model);
    const entry: Message = {
      id,
      at,
      ...(model && model !== "<synthetic>" ? { model } : {}),
      ...(str(data.sessionId) ? { sessionId: str(data.sessionId) } : {}),
      sidechain,
      usage,
      toolIds,
      turn,
      first: newTurn && !sidechain,
    };
    if (!sidechain) newTurn = false;
    byId.set(id, entry);
    order.push(entry);
  }
  return order;
}

async function transcriptFiles(dir: string): Promise<{ file: string; sidechain: boolean }[]> {
  const out: { file: string; sidechain: boolean }[] = [];
  for (const name of (await listDir(dir)).sort()) {
    if (name.endsWith(".jsonl")) out.push({ file: path.join(dir, name), sidechain: false });
    else {
      const subagents = path.join(dir, name, "subagents");
      for (const sub of (await listDir(subagents)).sort()) if (sub.endsWith(".jsonl")) out.push({ file: path.join(subagents, sub), sidechain: true });
    }
  }
  return out;
}

const tokensOf = (usage: Json): UsageRecordTokens => {
  const detail = claudeUsageDetail(usage);
  return {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheCreation: count(usage.cache_creation_input_tokens),
    ...(detail.cacheCreation5mTokens !== undefined ? { cacheCreation5m: detail.cacheCreation5mTokens } : {}),
    ...(detail.cacheCreation1hTokens !== undefined ? { cacheCreation1h: detail.cacheCreation1hTokens } : {}),
  };
};

/** Importa os gastos antigos dos agentes de Claude Code de um workspace (veja o comentário do módulo). */
export async function backfillClaudeTranscripts(options: BackfillOptions): Promise<BackfillReport> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const paths = dataPaths(workspaceDir);
  const dir = usageDir(workspaceDir);
  const report: BackfillReport = { agents: 0, files: 0, messages: 0, imported: 0, duplicates: 0, afterLive: 0, withTask: 0, unpriced: 0, months: {} };

  let agents: readonly Agent[] = [];
  let tasks: readonly Task[] = [];
  try {
    agents = (await readOfficeFile(paths.officeFile)).office.agents;
  } catch {
    // Sem office.json: os nomes ficam de fora (o id da pasta continua valendo).
  }
  try {
    tasks = await readTasksAnyLayout(paths);
  } catch {
    // Sem tarefas legíveis: as tarefas ficam só com o id que veio dos logs.
  }
  const hints = await taskHints(paths.logsDir);

  // O que já está no histórico: os ids (para não repetir) e o começo do registro ao vivo de cada agente.
  const seen = new Set<string>();
  const liveSince = new Map<string, number>();
  for (const name of await listDir(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    for (const line of await readLines(path.join(dir, name))) {
      const record = parseUsageLine(line);
      if (!record) continue;
      seen.add(record.id);
      if (record.source === "live") {
        const at = Date.parse(record.at);
        liveSince.set(record.agentId, Math.min(liveSince.get(record.agentId) ?? Infinity, at));
      }
    }
  }

  const out = new Map<string, UsageRecord[]>();
  for (const agentId of (await listDir(paths.agentsDir)).sort()) {
    const transcripts = claudeTranscriptDir(options.projectsDir, paths.agentDir(agentId));
    if (!transcripts) continue;
    const files = await transcriptFiles(transcripts);
    if (files.length === 0) continue;
    report.agents += 1;
    const agent = agents.find((item) => item.id === agentId);
    const cutoff = liveSince.get(agentId) ?? Infinity;
    for (const { file, sidechain } of files) {
      report.files += 1;
      const messages = await transcriptMessages(file, sidechain);
      // A tarefa de cada turno: a primeira ferramenta dele que aparece num log; senão a sessão; senão a linha do tempo.
      const turnTask = new Map<number, string>();
      for (const message of messages) {
        if (turnTask.has(message.turn)) continue;
        const direct = message.toolIds.map((id) => hints.byToolId.get(id)).find((id) => id !== undefined);
        if (direct) turnTask.set(message.turn, direct);
      }
      for (const message of messages) {
        const tokens = tokensOf(message.usage);
        // Mensagem sem nenhum token (ex.: as "<synthetic>" da própria CLI): nada a importar.
        if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation === 0) continue;
        report.messages += 1;
        const recordId = `claude-msg:${message.id}`;
        const at = Date.parse(message.at);
        if (seen.has(recordId)) {
          report.duplicates += 1;
          continue;
        }
        if (at >= cutoff) {
          report.afterLive += 1;
          continue;
        }
        seen.add(recordId);
        const taskId =
          turnTask.get(message.turn) ?? (message.sessionId ? hints.bySession.get(message.sessionId) : undefined) ?? taskAt(hints, agentId, at);
        const task = taskId ? tasks.find((item) => item.id === taskId) : undefined;
        const root = task ? rootTaskOf(task, tasks) : undefined;
        const detail = claudeUsageDetail(message.usage);
        const promptTokens = tokens.input + tokens.cacheRead + tokens.cacheCreation;
        const cost = computeCost({ model: message.model ?? agent?.model, at: message.at, tokens, promptTokens, speed: detail.speed, webSearches: detail.webSearches });
        if (cost.usd === null) report.unpriced += 1;
        if (taskId) report.withTask += 1;
        const model = message.model ?? agent?.model;
        const record: UsageRecord = {
          v: 1,
          id: recordId,
          at: new Date(at).toISOString(),
          agentId,
          ...(agent ? { agentName: agent.name } : {}),
          provider: "claude",
          ...(model ? { model, modelSource: message.model ? ("cli" as const) : ("config" as const) } : {}),
          ...(taskId ? { taskId, channel: "task" as const } : { channel: "other" as const }),
          ...(task ? { taskTitle: taskTitleOf(task) } : {}),
          ...(task?.projectId ? { parentTaskId: task.projectId } : {}),
          ...(root ? { rootTaskId: root.id } : taskId ? { rootTaskId: taskId } : {}),
          ...(message.sessionId ? { sessionId: message.sessionId } : {}),
          source: "backfill",
          ...(message.first ? {} : { turns: 0 as const }),
          measured: true,
          tokens,
          promptTokens,
          ...(detail.speed ? { speed: detail.speed } : {}),
          ...(detail.webSearches ? { webSearches: detail.webSearches } : {}),
          costUsd: cost.usd,
          priceVersion: PRICE_TABLE.version,
        };
        const month = monthKeyOf(at);
        const list = out.get(month) ?? [];
        list.push(record);
        out.set(month, list);
        report.imported += 1;
        report.months[month] = (report.months[month] ?? 0) + 1;
      }
    }
  }

  if (!options.dryRun && out.size > 0) {
    await mkdir(dir, { recursive: true });
    for (const [month, records] of [...out.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      records.sort((a, b) => a.at.localeCompare(b.at));
      await appendFile(usageFile(dir, month, "backfill"), records.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
    }
  }
  return report;
}
