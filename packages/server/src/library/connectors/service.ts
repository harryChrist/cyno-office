import { ACTIVITY_USER, type Connector, type ConnectorImportResponse, type ConnectorIconMime, type CreateConnectorBody, type ServerEvent, type TerminalStatus, type UpdateConnectorBody } from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import type { McpTool } from "../../mcp/protocol";
import type { LibraryService } from "../library-service";
import { claudeImportCandidates, type ClaudeMcpListOptions } from "./import-claude";

/** O terminal de um agente, do jeito que a sincronização precisa (parar quando estiver ocioso). */
type TerminalLike = { status(): TerminalStatus; stop(reason?: string): Promise<void> };

export type ConnectorsServiceDeps = {
  workspaceId: string;
  agents: () => { id: string; name: string }[];
  /** Terminal vivo do agente, se houver (os conectores mudaram = ele reinicia quando ficar ocioso). */
  terminal: (agentId: string) => TerminalLike | undefined;
  /** `claude mcp list` para importar (comando do Claude Code configurado no server). */
  claudeList: ClaudeMcpListOptions;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
};

/**
 * Visão de UM workspace sobre a Biblioteca da plataforma, com a assinatura de sempre (`list`,
 * `toolsFor`, `teamNote`, `create`, `update`, `remove`, `test`, `setAgentConnectors`…): o resto do
 * código (ferramentas dos agentes, `set_agent_connectors` do Maestro, o cartão do workspace) não
 * muda. Só enxerga o que a Biblioteca liberou a este workspace:
 * - `list` = os conectores liberados aqui, com `agentIds` = os agentes DESTE workspace que os recebem;
 * - `create` cria na Biblioteca e já libera a este workspace (compatível com a rota antiga);
 * - `remove` retira do workspace (o conector continua na Biblioteca, nos outros workspaces);
 * - `setAgentConnectors` só entrega o que foi liberado ao workspace (404 para o resto).
 *
 * As ferramentas que a CLI conhece são lidas quando a sessão sobe (o nosso servidor MCP não avisa
 * mudanças), então um agente cujas ferramentas de conector mudaram tem o processo parado assim que
 * fica ocioso: a próxima ordem retoma a mesma sessão já com as ferramentas novas (nada se perde;
 * quem está no meio de um turno termina antes).
 */
export class ConnectorsService {
  /** Assinatura (nomes das ferramentas) de cada agente e quem precisa reiniciar. */
  private readonly signatures = new Map<string, string>();
  private readonly pendingRestart = new Set<string>();

  constructor(
    private readonly library: LibraryService,
    private readonly deps: ConnectorsServiceDeps,
  ) {
    for (const agent of deps.agents()) this.signatures.set(agent.id, this.signature(agent.id));
  }

  list(): Connector[] {
    return this.library.workspaceList(this.deps.workspaceId);
  }

  toolsFor(agentId: string): McpTool[] {
    return this.library.toolsFor(this.deps.workspaceId, agentId);
  }

  /** Texto extra do `get_team` do Maestro: o que a Biblioteca liberou a este workspace e quem usa. */
  teamNote(): string {
    const agents = this.deps.agents();
    const nameOf = (agentId: string) => agents.find((agent) => agent.id === agentId)?.name;
    const lines = this.list()
      .filter((connector) => connector.enabled)
      .map((connector) => {
        const users = connector.agentIds.map(nameOf).filter((name): name is string => Boolean(name));
        const tools = connector.status.tools.length;
        return `- ${connector.name} (ferramentas ${connector.toolPrefix}__*; ${tools} ferramenta${tools === 1 ? "" : "s"}; estado: ${connector.status.state}) — usado por: ${users.length > 0 ? users.join(", ") : "ninguém"}`;
      });
    return lines.length > 0 ? `## Conectores (servidores MCP externos)\n${lines.join("\n")}` : "";
  }

  /** Cria na Biblioteca e libera a este workspace (e a estes agentes). */
  async create(body: CreateConnectorBody): Promise<Connector> {
    const { agentIds, origin, ...rest } = body;
    const created = await this.library.create({ ...rest, ...(origin ? { origin } : {}), grants: { [this.deps.workspaceId]: { agentIds: agentIds ?? [] } } });
    return this.library.workspaceGet(this.deps.workspaceId, created.id);
  }

  /** Edita um conector liberado aqui; `agentIds` troca os agentes deste workspace. */
  /** Libera a este workspace um conector que já existe na Biblioteca (mesmas credenciais), sem entregar a nenhum agente. */
  async adopt(id: string, actor: string = ACTIVITY_USER): Promise<Connector> {
    await this.library.grantWorkspace(id, this.deps.workspaceId, [], actor);
    const adopted = this.list().find((connector) => connector.id === id);
    if (!adopted) throw new Error(`Conector ${id} não ficou disponível para o workspace`);
    return adopted;
  }

  async update(id: string, body: UpdateConnectorBody): Promise<Connector> {
    this.library.workspaceGet(this.deps.workspaceId, id); // 404 se não é daqui
    const { agentIds, ...rest } = body;
    if (Object.keys(rest).length > 0) await this.library.update(id, rest);
    if (agentIds !== undefined) await this.library.grantWorkspace(id, this.deps.workspaceId, agentIds);
    return this.library.workspaceGet(this.deps.workspaceId, id);
  }

  /** Retira do workspace (o conector continua na Biblioteca). */
  async remove(id: string): Promise<void> {
    this.library.workspaceGet(this.deps.workspaceId, id);
    await this.library.revokeWorkspace(id, this.deps.workspaceId);
  }

  async test(id: string): Promise<Connector> {
    this.library.workspaceGet(this.deps.workspaceId, id);
    await this.library.test(id);
    return this.library.workspaceGet(this.deps.workspaceId, id);
  }

  setAgentConnectors(agentId: string, connectorIds: readonly string[], actor: string = ACTIVITY_USER): Promise<Connector[]> {
    return this.library.setAgentConnectors(this.deps.workspaceId, agentId, connectorIds, actor);
  }

  async setIcon(id: string, mime: ConnectorIconMime, bytes: Buffer): Promise<Connector> {
    this.library.workspaceGet(this.deps.workspaceId, id);
    await this.library.setIcon(id, mime, bytes);
    return this.library.workspaceGet(this.deps.workspaceId, id);
  }

  readIcon(id: string) {
    this.library.workspaceGet(this.deps.workspaceId, id);
    return this.library.readIcon(id);
  }

  importFromClaude(): Promise<ConnectorImportResponse> {
    return claudeImportCandidates(this.deps.claudeList, this.library.registry.all());
  }

  /** Eventos do workspace: agente removido sai das liberações; ferramentas mudaram = reinício quando ocioso. */
  handleEvent(event: ServerEvent): void {
    if (event.type === "agent:deleted") {
      this.signatures.delete(event.id);
      this.pendingRestart.delete(event.id);
      void this.library.forgetAgent(this.deps.workspaceId, event.id).catch((error: unknown) => this.deps.log.error({ err: error }, "não foi possível tirar o agente dos conectores"));
      return;
    }
    if (event.type === "connector:upserted" || event.type === "connector:deleted") {
      for (const agent of this.deps.agents()) {
        const next = this.signature(agent.id);
        if (this.signatures.get(agent.id) === next) continue;
        // Agente novo (sem assinatura ainda) não tem sessão com ferramentas velhas.
        const known = this.signatures.has(agent.id);
        this.signatures.set(agent.id, next);
        if (known) {
          this.pendingRestart.add(agent.id);
          this.flushRestart(agent.id);
        }
      }
      return;
    }
    if (event.type === "agent:terminal" && this.pendingRestart.has(event.terminal.agentId)) this.flushRestart(event.terminal.agentId);
    if (event.type === "agent:upserted" && !this.signatures.has(event.agent.id)) this.signatures.set(event.agent.id, this.signature(event.agent.id));
  }

  /** A Biblioteca é da plataforma e fecha com ela: nada a fechar por workspace. */
  async close(): Promise<void> {}

  private signature(agentId: string): string {
    return this.toolsFor(agentId)
      .map((tool) => tool.name)
      .sort()
      .join(",");
  }

  /** Para o processo do agente se ele estiver ocioso; parado ou sem terminal = a próxima subida já pega as ferramentas novas. */
  private flushRestart(agentId: string): void {
    const terminal = this.deps.terminal(agentId);
    const status = terminal?.status();
    if (!terminal || status === "stopped") {
      this.pendingRestart.delete(agentId);
      return;
    }
    if (status !== "idle") return;
    this.pendingRestart.delete(agentId);
    this.deps.log.info({ agentId }, "conectores do agente mudaram: reiniciando o terminal (a sessão continua)");
    void terminal.stop("Os conectores do agente mudaram").catch((error: unknown) => this.deps.log.warn({ err: error, agentId }, "não foi possível reiniciar o terminal"));
  }
}
