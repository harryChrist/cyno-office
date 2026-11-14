import { ACTIVITY_USER, skillBudgetWarnings, type ServerEvent, type TerminalStatus } from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import type { LibraryService } from "../library-service";
import { materializeAgentSkills, skillIndexTokens, type AgentSkill } from "./agent-skills";
import type { StoredSkill } from "./store";

/** O terminal de um agente, do jeito que a sincronização precisa (parar quando estiver ocioso). */
type TerminalLike = { status(): TerminalStatus; stop(reason?: string): Promise<void> };

export type SkillsServiceDeps = {
  workspaceId: string;
  agents: () => { id: string; name: string }[];
  /** Terminal vivo do agente, se houver. */
  terminal: (agentId: string) => TerminalLike | undefined;
  /** Pasta do agente (a cópia das skills vai em `<pasta>/skills/`). */
  agentDir: (agentId: string) => string;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
};

/** Skill liberada a este workspace, com os agentes DELE que a recebem. */
export type WorkspaceSkill = { id: string; name: string; description: string; indexTokens: number; weightTokens: number; agentIds: string[] };

/**
 * Visão de UM workspace sobre as skills da Biblioteca: só enxerga o que foi liberado a ele; entrega a
 * agentes (`setAgentSkills`); e mantém a pasta de cada agente em dia. Mudou o que um agente recebe
 * (liberação, retirada ou nova versão da skill): copia/apaga em `<pasta do agente>/skills/` e, quando
 * o terminal dele fica ocioso, reinicia (a sessão continua) para o índice novo entrar no prompt. Quem
 * está no meio de um turno termina antes. Parado ou sem terminal: a próxima subida já pega tudo
 * (`TerminalManager.prepare` copia e monta o índice de novo).
 */
export class SkillsService {
  private readonly signatures = new Map<string, string>();
  private readonly pendingRestart = new Set<string>();

  constructor(
    private readonly library: LibraryService,
    private readonly deps: SkillsServiceDeps,
  ) {
    for (const agent of deps.agents()) this.signatures.set(agent.id, this.signature(agent.id));
  }

  /** As skills liberadas a este workspace. */
  list(): WorkspaceSkill[] {
    return this.library.skills.grantedTo(this.deps.workspaceId).map((record) => ({
      id: record.id,
      name: record.name,
      description: record.description,
      indexTokens: skillIndexTokens(record),
      weightTokens: record.weightTokens,
      agentIds: record.grants[this.deps.workspaceId]?.agentIds ?? [],
    }));
  }

  /** O que o terminal do agente entrega (cópia + índice no prompt). */
  forAgent(agentId: string): AgentSkill[] {
    return this.library.skills.agentSkills(this.deps.workspaceId, agentId);
  }

  /** Avisos de limite do agente (só avisam). */
  warnings(agentId: string): string[] {
    return skillBudgetWarnings(this.forAgent(agentId).map((skill) => ({ indexTokens: skillIndexTokens(skill) })));
  }

  /** Lista inteira de skills de um agente (as liberadas a este workspace; [] = nenhuma). Devolve as que ele tem agora. */
  setAgentSkills(agentId: string, skillIds: readonly string[], actor: string = ACTIVITY_USER): Promise<StoredSkill[]> {
    return this.library.skills.setAgentSkills(this.deps.workspaceId, agentId, skillIds, actor);
  }

  /** Texto extra do `get_team` do Maestro: as skills liberadas a este workspace e quem usa. */
  teamNote(): string {
    const agents = this.deps.agents();
    const nameOf = (agentId: string) => agents.find((agent) => agent.id === agentId)?.name;
    const lines = this.list().map((skill) => {
      const users = skill.agentIds.map(nameOf).filter((name): name is string => Boolean(name));
      const when = skill.description.replace(/\s+/g, " ").trim();
      return `- ${skill.name} (id: ${skill.id}) — ${when.length > 160 ? `${when.slice(0, 159)}…` : when} — used by: ${users.length > 0 ? users.join(", ") : "nobody"}`;
    });
    return lines.length > 0 ? `## Skills (ready-made instructions from the Library; set_agent_skills hands them to an agent)\n${lines.join("\n")}` : "";
  }

  /** As liberações mudaram (a Biblioteca avisa): pastas em dia e reinício dos ociosos. */
  changed(): void {
    for (const agent of this.deps.agents()) {
      const next = this.signature(agent.id);
      if (this.signatures.get(agent.id) === next) continue;
      const known = this.signatures.has(agent.id);
      this.signatures.set(agent.id, next);
      if (!known) continue;
      this.pendingRestart.add(agent.id);
      this.flushRestart(agent.id);
    }
  }

  /** Eventos do workspace: agente removido sai das liberações; terminal ocioso com reinício pendente reinicia. */
  handleEvent(event: ServerEvent): void {
    if (event.type === "agent:deleted") {
      this.signatures.delete(event.id);
      this.pendingRestart.delete(event.id);
      return;
    }
    if (event.type === "agent:terminal" && this.pendingRestart.has(event.terminal.agentId)) this.flushRestart(event.terminal.agentId);
    if (event.type === "agent:upserted" && !this.signatures.has(event.agent.id)) this.signatures.set(event.agent.id, this.signature(event.agent.id));
  }

  private signature(agentId: string): string {
    return this.forAgent(agentId)
      .map((skill) => `${skill.revision}:${skill.name}:${skill.description}`)
      .join("|");
  }

  /** Ocioso, parado ou sem terminal: pasta em dia e, se havia processo ocioso, reinicia. Trabalhando ou subindo: espera. */
  private flushRestart(agentId: string): void {
    const terminal = this.deps.terminal(agentId);
    const status = terminal?.status();
    if (status === "busy" || status === "starting") return;
    this.pendingRestart.delete(agentId);
    const restart = terminal !== undefined && status === "idle";
    void (async () => {
      try {
        await materializeAgentSkills(this.deps.agentDir(agentId), this.forAgent(agentId));
      } catch (error) {
        this.deps.log.warn({ err: error, agentId }, "não foi possível sincronizar as skills do agente");
      }
      if (!restart) return;
      this.deps.log.info({ agentId }, "skills do agente mudaram: reiniciando o terminal (a sessão continua)");
      try {
        await terminal.stop("As skills do agente mudaram");
      } catch (error) {
        this.deps.log.warn({ err: error, agentId }, "não foi possível reiniciar o terminal");
      }
    })();
  }
}
