import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { UsageRecord } from "@cyno/shared";
import { priceRecord } from "../../engines/usage/usage-aggregate";
import { parseUsageLine } from "../../engines/usage/usage-history";

export type TaskCost = { costUsd: number; tokens: number };

/** Custo equivalente (em dólar, pela tabela de preços atual) e tokens por tarefa, somando os turnos dela. */
export function taskCostsOf(records: readonly UsageRecord[]): Map<string, TaskCost> {
  const out = new Map<string, TaskCost>();
  for (const record of records) {
    if (!record.taskId || !record.measured || !record.tokens) continue;
    const priced = priceRecord(record);
    if (priced.suspect) continue;
    const entry = out.get(record.taskId) ?? { costUsd: 0, tokens: 0 };
    entry.tokens += priced.totalTokens;
    if (priced.cost.usd !== null) entry.costUsd += priced.cost.usd;
    out.set(record.taskId, entry);
  }
  return out;
}

/** Lê o histórico de gastos de um workspace (usage/*.jsonl) direto do disco (a migração roda antes dos workspaces abrirem). */
export async function readUsageDir(dir: string): Promise<UsageRecord[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: UsageRecord[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      for (const line of (await readFile(path.join(dir, name), "utf8")).split("\n")) {
        const record = parseUsageLine(line);
        if (record) out.push(record);
      }
    } catch {
      // arquivo ilegível: segue
    }
  }
  return out;
}
