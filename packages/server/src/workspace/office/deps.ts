import type { ModelChoice } from "@cyno/shared";
import type { Brain } from "../brain/brain";
import type { CalendarService } from "../calendar/calendar-service";
import type { ForYouService } from "../for-you/service";
import type { MaestroCoordinator } from "../../sim/coordinator";
import type { Orchestrator } from "./orchestrator";
import type { StateManager } from "../../store/state-manager";
import type { DataCleanup } from "../../store/cleanup";

export type ServiceDeps = {
  state: StateManager;
  brain: Brain;
  orchestrator: Orchestrator;
  maestro: MaestroCoordinator;
  forYou: ForYouService;
  /** Eventos do calendário ligados a quartos (saem junto com o quarto). */
  calendar: Pick<CalendarService, "countByRoom" | "removeByRoom">;
  /** Apaga do disco o que era de quartos/agentes/tarefas removidos (logs, pastas, Cérebro). */
  cleanup: DataCleanup;
  now: () => Date;
  /** Modo simulado ligado (só testes): só então o motor "mock" é aceito na API. */
  simulated?: boolean;
  /** Padrão `agentes` do workspace: o agente criado sem `engine` nasce com ele. */
  agentDefaults?: () => ModelChoice | undefined;
};
