import type { Agent } from "@cyno/shared";
import { AvatarSprite } from "../../ui/AvatarSprite";

/** Lado (px) da bolinha de avatar das listas. */
export const AVATAR_PEQUENO = 24;

/** Avatar pequeno do agente (uma interrogação se ele não existe mais). */
export function AgentAvatar({ agent, size = AVATAR_PEQUENO }: { agent: Agent | undefined; size?: number }) {
  return (
    <span className="w-avatar" style={{ width: size, height: size }}>
      {agent ? <AvatarSprite avatar={agent.avatar} seedId={agent.id} size={size} framing="head" /> : <span aria-hidden="true">?</span>}
    </span>
  );
}

/** Avatar e nome do agente, lado a lado. */
export function AgentTag({ agent, fallback }: { agent: Agent | undefined; fallback?: string }) {
  return (
    <span className="w-agent">
      <AgentAvatar agent={agent} />
      <span className="w-agent__name">{agent?.name ?? fallback ?? "Sem agente"}</span>
    </span>
  );
}
