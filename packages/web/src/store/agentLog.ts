import { describeWork, maskDeep, maskSecrets, tasksOf, type AgentLogEntry, type LogPhrase } from "@cyno/shared";

// `threadsOf` e `tasksOf` moraram aqui; foram para o shared (o servidor monta a cena ao vivo com o mesmo adaptador).
export { tasksOf, threadsOf, type LogTask } from "@cyno/shared";

/**
 * Regras puras do log de trabalho dos agentes no cliente: juntar entradas (histórico do GET +
 * eventos `agent:log` ao vivo), limitar a memória, separar threads (subagentes) e tarefas.
 * A ordem é sempre a dos ids (ordem lexicográfica = ordem em que as entradas nasceram).
 */

/** Entradas guardadas por agente (as mais novas ficam). */
export const AGENT_LOG_CAP = 500;
/** Entradas guardadas por tarefa aberta na tela (inclui as dos subagentes). */
export const TASK_LOG_CAP = 1000;
/** Quantos logs de tarefa ficam em memória (os mais antigos saem). */
export const TASK_LOG_CACHE = 20;

/** Valor de thread do próprio agente (sem subagente) na UI. */
export const MAIN_THREAD = "main";

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Corta para as `cap` mais novas (devolve o mesmo array se já cabe). */
function capped(list: AgentLogEntry[], cap: number): AgentLogEntry[] {
  return list.length > cap ? list.slice(list.length - cap) : list;
}

/**
 * Junta uma entrada ao vivo: mesmo id substitui (ferramenta atualizada no lugar); id novo entra
 * na posição do id (quase sempre no fim). Devolve um array novo, ordenado e limitado a `cap`.
 */
export function mergeEntry(list: readonly AgentLogEntry[], rawEntry: AgentLogEntry, cap = AGENT_LOG_CAP): AgentLogEntry[] {
  const entry = maskToolEntry(rawEntry);
  const last = list.at(-1);
  if (!last || compareIds(last.id, entry.id) < 0) return capped([...list, entry], cap);
  const index = list.findIndex((current) => current.id === entry.id);
  if (index !== -1) return list.map((current, i) => (i === index ? entry : current));
  // Chegou fora de ordem: entra no lugar certo.
  const at = list.findIndex((current) => compareIds(current.id, entry.id) > 0);
  return capped([...list.slice(0, at), entry, ...list.slice(at)], cap);
}

/**
 * Máscara de segredos no que a tela mostra de uma ferramenta (resumo, entrada e saída): chaves,
 * tokens e senhas viram `***`. O log em disco guarda o original (projeto pessoal); a tela mascara
 * ao receber, então nada de ferramenta chega mascarado ou não ao Timeline, ao terminal e ao Maestro.
 */
export function maskToolEntry(entry: AgentLogEntry): AgentLogEntry {
  if (entry.kind !== "tool") return entry;
  const masked = {
    ...entry,
    summary: maskSecrets(entry.summary),
    ...(entry.input ? { input: maskDeep(entry.input) } : {}),
    ...(entry.output === undefined ? {} : { output: maskSecrets(entry.output) }),
  };
  return masked;
}

/** A frase de atividade de uma entrada de ferramenta (a gravada pelo servidor; log antigo: calculada na hora). */
export function phraseOfTool(entry: Extract<AgentLogEntry, { kind: "tool" }>): LogPhrase {
  if (entry.phrase) return entry.phrase;
  const { icon, text } = describeWork(entry.name, entry.input);
  return { icon, text };
}

/** Quanto tempo uma ferramenta já terminada ainda dá a frase do agente (depois o cartão volta ao normal). */
export const PHRASE_LINGER_MS = 6_000;

/**
 * O que o agente está fazendo agora, em frase: a ferramenta mais recente da conversa principal, se
 * ainda está rodando (ou terminou há pouco). Sem ferramenta recente, undefined.
 */
export function livePhrase(entries: readonly AgentLogEntry[], now: number): LogPhrase | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.kind !== "tool" || entry.thread !== undefined) {
      if (entry.kind === "result" || entry.kind === "status") return undefined;
      continue;
    }
    const at = Date.parse(entry.at);
    if (entry.status === "running" || (Number.isFinite(at) && now - at < PHRASE_LINGER_MS)) return phraseOfTool(entry);
    return undefined;
  }
  return undefined;
}

/**
 * A versão que fica quando o histórico (GET) traz um id que já chegou ao vivo. O GET pode ter saído
 * antes do evento: uma ferramenta já terminada ao vivo não volta para "running".
 */
function keepOnHistory(existing: AgentLogEntry, incoming: AgentLogEntry): AgentLogEntry {
  if (existing.kind === "tool" && incoming.kind === "tool" && existing.status !== "running" && incoming.status === "running") return existing;
  return incoming;
}

/** Junta um lote do histórico (GET) ao que já está em memória (por id; ordenado; limitado). */
export function mergeHistory(list: readonly AgentLogEntry[], incoming: readonly AgentLogEntry[], cap = AGENT_LOG_CAP): AgentLogEntry[] {
  const byId = new Map<string, AgentLogEntry>();
  for (const entry of list) byId.set(entry.id, entry);
  for (const raw of incoming) {
    const entry = maskToolEntry(raw);
    const existing = byId.get(entry.id);
    byId.set(entry.id, existing ? keepOnHistory(existing, entry) : entry);
  }
  const merged = [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
  return capped(merged, cap);
}

/** As entradas de uma thread: "main" = do próprio agente; senão as do subagente com esse id. */
export function entriesOfThread(entries: readonly AgentLogEntry[], thread: string): AgentLogEntry[] {
  return entries.filter((entry) => (thread === MAIN_THREAD ? entry.thread === undefined : entry.thread === thread));
}

/** O que o log diz do agente agora: a tarefa aberta mais recente e os subagentes dela. */
export function liveSummary(entries: readonly AgentLogEntry[]): { activeTaskId?: string; activeSubagents: number } {
  const open = tasksOf(entries).filter((task) => task.open);
  const current = open.at(-1);
  if (!current) return { activeSubagents: 0 };
  return { activeTaskId: current.taskId, activeSubagents: open.reduce((sum, task) => sum + task.activeSubagents, 0) };
}
