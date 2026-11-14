import { workDayStart, type PlatformToday } from "@cyno/shared";
import { buildPlatformToday, todayAgenda } from "../../workspace/today/today";
import type { AgendaService } from "../agenda/agenda-service";
import type { WorkspaceManager } from "../workspaces/manager";

/**
 * O painel "Hoje" da plataforma inteira: um bloco por workspace (cada um com os compromissos que o
 * agente marcou nele), mais os compromissos do dono (todos, uma vez só) e a soma do "Esperando você".
 * Só código, sem IA: ler isto não acorda ninguém.
 */
export function platformTodayOf(manager: Pick<WorkspaceManager, "list" | "find">, agenda: Pick<AgendaService, "list">, now: Date): PlatformToday {
  const names = new Map(manager.list().map((workspace) => [workspace.id, workspace.name]));
  const views = manager.list().flatMap((workspace) => {
    const runtime = manager.find(workspace.id);
    return runtime ? [runtime.today({ ownerAgenda: false })] : [];
  });
  const start = workDayStart(now.getTime());
  return buildPlatformToday(views, todayAgenda(agenda.list({ from: start, to: start + 24 * 3_600_000 }), (id) => names.get(id)), now);
}
