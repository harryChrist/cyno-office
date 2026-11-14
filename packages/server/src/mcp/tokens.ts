import { randomBytes } from "node:crypto";

/**
 * Quem é o dono do token. `scope: "platform"` = o Cyno (sem workspace): o token dele só enxerga as
 * ferramentas da plataforma, e o de um agente de workspace nunca enxerga as do Cyno.
 */
export type McpIdentity = { workspaceId: string; agentId: string; scope?: "platform" };

/** Como acabou a espera pelas ferramentas: a CLI conectou, o tempo acabou ou alguém desistiu (processo saiu, token revogado). */
export type ToolsWaitOutcome = "ready" | "timeout" | "cancelled";

/** Espera pelas ferramentas de uma CLI que está subindo (veja `McpTokens.waitForTools`). */
export type ToolsWait = { done: Promise<ToolsWaitOutcome>; cancel(): void };

/** Conexão MCP do token: `initialize` visto desde a última subida e quem espera o `tools/list`. */
type Link = { initialized: boolean; waiters: Set<(outcome: ToolsWaitOutcome) => void> };

/**
 * Tokens do servidor MCP: um por terminal de agente (vai no cabeçalho Authorization da
 * configuração MCP da CLI). Identifica workspace e agente; vale até o terminal ser descartado
 * (agente removido, motor trocado, server desligando). Só em memória.
 *
 * Também acompanha a conexão de cada token (a rota avisa cada método recebido): a CLI que acabou de
 * subir só tem as ferramentas do escritório depois do `initialize` e do primeiro `tools/list`. O
 * terminal espera isso antes da primeira mensagem (`waitForTools`).
 */
export class McpTokens {
  private readonly byToken = new Map<string, McpIdentity>();
  private readonly links = new Map<string, Link>();

  issue(identity: McpIdentity): string {
    const token = randomBytes(32).toString("hex");
    this.byToken.set(token, { ...identity });
    return token;
  }

  revoke(token: string): void {
    this.byToken.delete(token);
    const link = this.links.get(token);
    this.links.delete(token);
    for (const settle of [...(link?.waiters ?? [])]) settle("cancelled");
  }

  /** Identidade do token, ou undefined (tokens de 256 bits aleatórios, só em memória). */
  resolve(token: string | undefined): McpIdentity | undefined {
    const identity = token ? this.byToken.get(token) : undefined;
    return identity ? { ...identity } : undefined;
  }

  /**
   * O cliente MCP do token mandou `method` (a rota chama a cada mensagem, depois de responder):
   * `initialize` abre a conexão; o `tools/list` seguinte é quando a CLI passa a ter as ferramentas.
   */
  observe(token: string, method: string): void {
    if (!this.byToken.has(token)) return;
    const link = this.link(token);
    if (method === "initialize") link.initialized = true;
    else if (method === "tools/list" && link.initialized) for (const settle of [...link.waiters]) settle("ready");
  }

  /**
   * Uma CLI vai subir agora com este token (chamar ANTES de subir o processo): a promessa resolve
   * "ready" quando ela fizer `initialize` e depois `tools/list`, "timeout" depois de `timeoutMs` sem
   * isso e "cancelled" com `cancel()` ou o token revogado. Um `initialize` de antes não conta (a
   * subida anterior do mesmo token já tinha conectado).
   */
  waitForTools(token: string, timeoutMs: number): ToolsWait {
    if (!this.byToken.has(token)) return { done: Promise.resolve("cancelled"), cancel: () => undefined };
    const link = this.link(token);
    link.initialized = false;
    let settle!: (outcome: ToolsWaitOutcome) => void;
    const done = new Promise<ToolsWaitOutcome>((resolve) => {
      const timer = setTimeout(() => settle("timeout"), Math.max(0, timeoutMs));
      timer.unref?.();
      settle = (outcome) => {
        clearTimeout(timer);
        link.waiters.delete(settle);
        resolve(outcome);
      };
    });
    link.waiters.add(settle);
    return { done, cancel: () => settle("cancelled") };
  }

  private link(token: string): Link {
    let link = this.links.get(token);
    if (!link) {
      link = { initialized: false, waiters: new Set() };
      this.links.set(token, link);
    }
    return link;
  }
}
