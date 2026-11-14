import { activity } from "../../workspace/activity/log";
import { cleanString } from "../../workspace/activity/sanitize";

/**
 * Ganchos dos terminais das CLIs: acompanham quais processos estão vivos (a amostra de memória
 * soma a árvore de cada um) e só viram Atividade as FALHAS (CLI que caiu, que desistiu de subir ou
 * que não conectou no MCP). Subir e sair normalmente não é atividade. Nunca lançam.
 */

export type TerminalBinding = { workspaceId: string; agentId: string; engine: string; agentName?: () => string | undefined };
type TerminalState = TerminalBinding & { pid?: number };

const terminals = new WeakMap<object, TerminalState>();

/** Processos das CLIs vivos (para a amostra de memória): pid -> de quem é. */
export type TrackedProcess = { pid: number; workspaceId?: string; agentId?: string; engine?: string };
const processes = new Map<number, TrackedProcess>();

/** Diz de quem é um terminal (o TerminalManager chama ao criar). */
export function bindTerminal(terminal: object, binding: TerminalBinding): void {
  terminals.set(terminal, { ...binding });
}

function stateOf(terminal: object, agentId?: string): TerminalState {
  let state = terminals.get(terminal);
  if (!state) {
    state = { workspaceId: "", agentId: agentId ?? "", engine: "" };
    terminals.set(terminal, state);
  }
  return state;
}

function who(state: TerminalState): string {
  return state.agentName?.() ?? state.agentId ?? "agente";
}

/** O processo da CLI subiu (só acompanha o pid). */
export function trackTerminalSpawn(terminal: object, info: { agentId?: string; pid?: number }): void {
  try {
    const state = stateOf(terminal, info.agentId);
    state.pid = info.pid;
    if (info.pid) processes.set(info.pid, { pid: info.pid, ...(state.workspaceId ? { workspaceId: state.workspaceId } : {}), ...(state.agentId ? { agentId: state.agentId } : {}), ...(state.engine ? { engine: state.engine } : {}) });
  } catch {
    // nunca lança
  }
}

/** O processo da CLI saiu. `expected`: paramos nós (ociosidade, usuário, troca de config, desligamento). Queda inesperada vira Atividade. */
export function trackTerminalExit(terminal: object, info: { agentId?: string; code: number | null; signal?: string | number | null; expected: boolean; reason?: string; error?: string }): void {
  try {
    const state = stateOf(terminal, info.agentId);
    if (state.pid) processes.delete(state.pid);
    state.pid = undefined;
    if (info.expected) return;
    activity({
      category: "agente",
      action: "terminal_caiu",
      actor: state.agentId || "sistema",
      workspaceId: state.workspaceId || undefined,
      summary: `O terminal de ${who(state)} caiu${info.error ? `: ${cleanString(info.error, 160)}` : ` (código ${info.code ?? "?"}${info.signal ? `, sinal ${info.signal}` : ""})`}`,
      data: { code: info.code, ...(info.signal ? { signal: info.signal } : {}), engine: state.engine || undefined, ...(info.error ? { error: info.error } : {}) },
    });
  } catch {
    // nunca lança
  }
}

/** Falhas do terminal: desistiu de religar ou não conseguiu subir. */
export function trackTerminalFailure(terminal: object, type: "gave_up" | "start_failed", data: Record<string, unknown> = {}, agentId?: string): void {
  try {
    const state = stateOf(terminal, agentId);
    const error = typeof data.error === "string" ? cleanString(data.error, 200) : undefined;
    activity({
      category: "agente",
      action: type === "gave_up" ? "terminal_desistiu" : "terminal_nao_subiu",
      actor: state.agentId || "sistema",
      workspaceId: state.workspaceId || undefined,
      summary: type === "gave_up" ? `${who(state)} ficou sem terminal: o servidor desistiu de religar${error ? ` (${error})` : ""}` : `Não foi possível ligar o terminal de ${who(state)}${error ? `: ${error}` : ""}`,
      data: { ...data, engine: state.engine || undefined },
    });
  } catch {
    // nunca lança
  }
}

/** A CLI não conectou no MCP do escritório a tempo (a primeira mensagem vai assim mesmo). */
export function noteMcpHandshakeTimeout(workspaceId: string, agentId: string, agentName: string | undefined, timeoutMs: number): void {
  activity(
    {
      category: "agente",
      action: "mcp_sem_conexao",
      actor: agentId,
      workspaceId,
      summary: `${agentName ?? agentId} demorou a conectar nas ferramentas do escritório (mais de ${Math.round(timeoutMs / 1000)} s)`,
      data: { timeoutMs },
    },
    { throttle: { key: `mcp-timeout:${workspaceId}:${agentId}`, ms: 10 * 60_000 } },
  );
}

/** Pedido recusado no /mcp vindo de fora do loopback: no máximo um aviso a cada 10 minutos. */
export function noteMcpForbidden(): void {
  activity({ category: "sistema", action: "mcp_recusado", actor: "sistema", summary: "Um pedido ao MCP foi recusado por vir de fora da máquina" }, { throttle: { key: "mcp-forbidden", ms: 10 * 60_000 } });
}

/** Processos das CLIs vivos agora. */
export function trackedProcesses(): TrackedProcess[] {
  return [...processes.values()];
}
