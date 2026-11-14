/**
 * Endereço de um agente: "workspace/agente" (ex.: "linkedin/eco"). É derivado (o `agent.id` não
 * muda ao renomear), nunca a fonte da verdade. O Maestro é "workspace/maestro".
 */

export type ParsedAddress = { workspace: string; agentId: string };

export function agentAddress(workspaceId: string, agentId: string): string {
  return `${workspaceId}/${agentId}`;
}

/** "linkedin/eco" -> { workspace, agentId }; qualquer outra forma -> undefined. */
export function parseAddress(address: string): ParsedAddress | undefined {
  const match = /^([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/.exec(address.trim());
  return match ? { workspace: match[1]!, agentId: match[2]! } : undefined;
}
