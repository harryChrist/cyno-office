import type { OfficeState, ServerEvent } from "@cyno/shared";

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((current) => current.id === item.id);
  if (index === -1) return [...items, item];
  return items.map((current, i) => (i === index ? item : current));
}

/** Remove os itens que casam; devolve o MESMO array se nada saiu (evita re-render). */
function removeWhere<T>(items: T[], shouldRemove: (item: T) => boolean): T[] {
  const kept = items.filter((item) => !shouldRemove(item));
  return kept.length === items.length ? items : kept;
}

function withChanges(office: OfficeState, changes: Partial<OfficeState>): OfficeState {
  const changed = (Object.keys(changes) as (keyof OfficeState)[]).some((key) => changes[key] !== office[key]);
  return changed ? { ...office, ...changes } : office;
}

/**
 * Remove o quarto e, localmente, tudo que dependia dele (times, agentes, tarefas e
 * Cérebros lidos pelos outros quartos). O server também emite eventos da cascata; repetir a remoção é inofensivo,
 * e tarefas não têm evento de remoção, então a cascata aqui é a única forma de limpá-las.
 */
function deleteRoom(office: OfficeState, id: string): OfficeState {
  const teamIds = new Set(office.teams.filter((team) => team.roomId === id).map((team) => team.id));
  const rooms = removeWhere(office.rooms, (room) => room.id === id);
  return withChanges(office, {
    rooms: rooms.map((room) =>
      room.readsBrainsOf.includes(id)
        ? { ...room, readsBrainsOf: room.readsBrainsOf.filter((other) => other !== id) }
        : room,
    ),
    teams: removeWhere(office.teams, (team) => teamIds.has(team.id)),
    agents: removeWhere(office.agents, (agent) => teamIds.has(agent.teamId)),
    tasks: removeWhere(office.tasks, (task) => task.roomId === id),
  });
}

/** Aplica um evento do server ao estado do escritório (função pura). */
export function applyServerEvent(office: OfficeState, event: ServerEvent): OfficeState {
  switch (event.type) {
    case "office:snapshot":
      return event.office;
    case "room:upserted":
      return { ...office, rooms: upsert(office.rooms, event.room) };
    case "room:deleted":
      return office.rooms.some((room) => room.id === event.id)
        ? deleteRoom(office, event.id)
        : office;
    case "team:upserted":
      return { ...office, teams: upsert(office.teams, event.team) };
    case "team:deleted":
      // As tarefas do time ficam como histórico (o server manda task:upserted se mudarem).
      return withChanges(office, {
        teams: removeWhere(office.teams, (team) => team.id === event.id),
        agents: removeWhere(office.agents, (agent) => agent.teamId === event.id),
      });
    case "agent:upserted":
      return { ...office, agents: upsert(office.agents, event.agent) };
    case "agent:deleted":
      return withChanges(office, { agents: removeWhere(office.agents, (agent) => agent.id === event.id) });
    case "task:upserted":
      return { ...office, tasks: upsert(office.tasks, event.task) };
    case "task:progress":
      // Progresso é transitório e fica fora do OfficeState (ver taskProgress.ts).
      return office;
    case "workspaces:list":
      // A lista de workspaces fica fora do escritório (ver workspaceStore.ts).
      return office;
    case "calendar:upserted":
    case "calendar:deleted":
    case "foryou:upserted":
    case "foryou:deleted":
    case "foryou:archived":
    case "foryou-types:upserted":
    case "foryou-types:deleted":
      // Calendário e "Para você" ficam fora do escritório (ver calendarStore.ts, forYouItems.ts e forYouTypes.ts).
      return office;
    case "sync:resumed":
      // Reconexão sem perda: os eventos que faltaram vêm logo em seguida, cada um pelo seu caminho.
      return office;
    case "agent:log":
    case "agent:chat-status":
    case "agent:terminal":
    case "usage:updated":
    case "usage:agents":
      // O log de trabalho, o estado dos terminais de CLI e o uso da assinatura ficam fora do escritório.
      return office;
    case "connector:upserted":
    case "connector:deleted":
    case "connector:activity":
    case "library:upserted":
    case "library:deleted":
    case "library:skill-upserted":
    case "library:skill-deleted":
    case "library:app":
    case "library:app-removed":
    case "library:app-run":
    case "library:job":
    case "library:job-log":
      // Conectores têm store próprio (ver connectorsStore.ts).
      return office;
    case "browser:tabs":
    case "browser:activity":
      // Navegador compartilhado: store próprio (ver browserStore.ts).
      return office;
    case "project:upserted":
    case "project:deleted":
      // Planos dos pedidos têm store próprio (ver workStore.ts).
      return office;
    case "routine:upserted":
    case "routine:removed":
    case "routine:entry":
    case "routine:execution":
    case "routine:items":
    case "routine:closed":
    case "routine:goal-hit":
      // Rotinas e metas ficam fora do escritório (ver routinesStore.ts e a página Gestão).
      return office;
    case "media:upserted":
    case "media:deleted":
      // Biblioteca de mídia: fica fora do escritório (ver mediaStore.ts).
      return office;
    case "board:upserted":
    case "board:deleted":
      // Quadros do workspace: ficam fora do escritório (a tela dos Quadros cuida deles).
      return office;
    case "activity:appended":
      // Atividade: store próprio (ver activityLogStore.ts).
      return office;
    case "system:warning":
      // Avisos do servidor: store próprio (ver systemWarningStore.ts).
      return office;
    default: {
      const unknownEvent: never = event;
      return unknownEvent;
    }
  }
}
