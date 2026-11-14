import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Task } from "@cyno/shared";
import { writeFileAtomic } from "../../store/atomic-write";
import { shorten } from "../../util/text";
import { DIARY_LIMITS } from "./limits";

/** Arquivo do diário dentro da pasta do agente (`agents/<id>/diario.md`). */
export const DIARY_FILE = "diario.md";

const HEADER = "# Diário\n\nO que este agente fez nas últimas tarefas (o server escreve uma entrada por tarefa; as mais recentes no fim).\n";
const ENTRY = /^- \d{4}-\d{2}-\d{2} /;

const pad = (value: number) => String(value).padStart(2, "0");
const stamp = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** Primeiras linhas de texto do resultado (sem títulos e marcação), numa linha só. */
function gist(result: string, max: number): string {
  const lines = result
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "").replace(/[*_`]/g, "").trim())
    .filter(Boolean);
  return shorten(lines.slice(0, 3).join(" / "), max);
}

/**
 * Uma entrada (1–3 linhas, sem chamar modelo nenhum): data, o pedido e o começo da entrega (ou o
 * motivo da falha), com teto.
 */
export function diaryEntry(task: Pick<Task, "id" | "prompt">, outcome: { status: "done" | "failed"; result: string }, date: Date): string {
  const request = shorten(task.prompt.replace(/\s+/g, " ").trim(), 90);
  const what = outcome.status === "done" ? `entregue: ${gist(outcome.result, 160)}` : `falhou: ${gist(outcome.result, 120)}`;
  return shorten(`- ${stamp(date)} · “${request}” → ${what} (tarefa ${task.id.slice(0, 8)})`, DIARY_LIMITS.entryChars);
}

async function readEntries(file: string): Promise<string[]> {
  try {
    return (await readFile(file, "utf8")).split(/\r?\n/).filter((line) => ENTRY.test(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Diário de cada agente de CLI (`agents/<id>/diario.md`): curto e só do agente. Não é nota do
 * Cérebro (nunca entra como nota); as últimas entradas vão no topo de cada tarefa nova, porque
 * cada tarefa começa numa sessão nova da CLI.
 */
export class AgentDiary {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly agentDir: (agentId: string) => string) {}

  /** Acrescenta uma entrada (guarda só as DIARY_LIMITS.keep mais recentes). */
  append(agentId: string, entry: string): Promise<void> {
    const file = path.join(this.agentDir(agentId), DIARY_FILE);
    const previous = this.chains.get(agentId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const entries = [...(await readEntries(file)), entry].slice(-DIARY_LIMITS.keep);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFileAtomic(file, `${HEADER}\n${entries.join("\n")}\n`);
      });
    this.chains.set(agentId, next);
    return next;
  }

  /** As últimas entradas (mais antigas primeiro), com teto de caracteres; "" se não houver. */
  async recent(agentId: string): Promise<string> {
    await this.chains.get(agentId)?.catch(() => undefined);
    const entries = (await readEntries(path.join(this.agentDir(agentId), DIARY_FILE))).slice(-DIARY_LIMITS.recent);
    const kept: string[] = [];
    let size = 0;
    for (const entry of [...entries].reverse()) {
      if (size + entry.length + 1 > DIARY_LIMITS.recentChars) break;
      kept.unshift(entry);
      size += entry.length + 1;
    }
    return kept.join("\n");
  }
}
