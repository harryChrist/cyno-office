import { findOfficeRuleViolations, type ForYouItem, type OfficeState, type Project, type ServerEvent, type Task } from "@cyno/shared";
import type { EventHub } from "../platform/events/hub";
import type { OfficeStructure } from "./files";
import type { OfficeStore } from "./office-store";

export type StateChange = {
  /** Novos quartos/times/agentes (grava office.json). */
  office?: OfficeStructure;
  /** Nova lista de tarefas (regrava só os meses de tasks/ que mudaram). */
  tasks?: Task[];
  /** Nova lista de itens do "Para você" (regrava só os meses de for-you/ que mudaram). */
  forYou?: ForYouItem[];
  /** Projetos criados ou alterados (um arquivo projects/<id>.json por projeto; só os que mudaram de fato são regravados). */
  projects?: Project[];
  /** Projetos apagados. */
  deletedProjects?: string[];
  events: ServerEvent[];
};

/**
 * Único caminho de escrita do estado: troca o estado em memória na hora (de forma
 * síncrona, então ler-alterar-gravar sem `await` no meio nunca perde atualização),
 * persiste em disco e publica os eventos para o WebSocket.
 */
export class StateManager {
  constructor(
    private readonly store: OfficeStore,
    private readonly hub: EventHub,
  ) {}

  /** Cópia do estado atual: pode ser alterada livremente e depois passada para commit. */
  read(): OfficeState {
    return this.store.snapshot();
  }

  /** Cópia dos itens do "Para você" (mesma regra de `read`). */
  readForYou(): ForYouItem[] {
    return this.store.forYouSnapshot();
  }

  /** Cópia dos projetos (mesma regra de `read`). */
  readProjects(): Project[] {
    return this.store.projectsSnapshot();
  }

  /** Resolve quando os arquivos foram gravados. Um estado que quebra as regras não muda nada. */
  commit(change: StateChange): Promise<void> {
    if (change.office) {
      const violations = findOfficeRuleViolations(change.office);
      if (violations.length > 0) throw new Error(`Estado inválido: ${violations.join("; ")}`);
    }
    const writes: Promise<void>[] = [];
    if (change.office) writes.push(this.store.commitOffice(change.office));
    if (change.tasks) writes.push(this.store.commitTasks(change.tasks));
    if (change.forYou) writes.push(this.store.commitForYou(change.forYou));
    if (change.projects || change.deletedProjects) writes.push(this.store.commitProjects(change.projects ?? [], change.deletedProjects));
    for (const event of change.events) this.hub.publish(event);
    return Promise.all(writes).then(() => undefined);
  }

  /** Evento sem mudança de estado persistido (ex.: task:progress). */
  publish(event: ServerEvent): void {
    this.hub.publish(event);
  }
}

export function officeStructure(state: OfficeState): OfficeStructure {
  return { rooms: state.rooms, teams: state.teams, agents: state.agents };
}
