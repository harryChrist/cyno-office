import { AgentService } from "./agent-service";
import type { ForYouService } from "../for-you/service";
import type { ServiceDeps } from "./deps";
import { TaskService } from "./task-service";
import { TeamService } from "./team-service";
import { RoomService } from "./room-service";

export type { ServiceDeps } from "./deps";

export type Services = {
  rooms: RoomService;
  teams: TeamService;
  agents: AgentService;
  tasks: TaskService;
  forYou: ForYouService;
};

export function createServices(deps: ServiceDeps): Services {
  return {
    rooms: new RoomService(deps),
    teams: new TeamService(deps),
    agents: new AgentService(deps),
    tasks: new TaskService(deps),
    forYou: deps.forYou,
  };
}
