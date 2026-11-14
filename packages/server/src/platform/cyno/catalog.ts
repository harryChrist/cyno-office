import { ENGINE_FALLBACK_MODELS, ENGINE_LABELS, isCliEngine, type EngineInfo } from "@cyno/shared";
import { ROOM_PURPOSE_INPUTS, ROOM_SIZE_INPUTS } from "../../mcp/structure-tools";
import type { WorkspaceManager } from "../workspaces/manager";

/**
 * O catálogo do que existe para montar um workspace (`get_catalog`): motores instalados com os modelos, os
 * padrões do dono, os conectores cadastrados (e a quem estão liberados) e os tipos/tamanhos de sala.
 * Montado por código, em inglês (é o Cyno quem lê); sem segredos.
 */
export function catalogText(input: { engines: readonly EngineInfo[]; simulated: boolean; workspaces: Pick<WorkspaceManager, "list" | "find"> }): string {
  const engines = input.engines.filter((info) => isCliEngine(info.engine) || (input.simulated && info.engine === "mock"));
  const lines: string[] = ["## Engines installed on this machine"];
  for (const info of engines) {
    const fallback = isCliEngine(info.engine) ? ENGINE_FALLBACK_MODELS[info.engine as "claude" | "gemini"] : undefined;
    const models = info.models.map((model) => model.id).slice(0, 14).join(", ");
    lines.push(
      `- ${info.engine} (${ENGINE_LABELS[info.engine] ?? info.label}): ${info.available ? "installed" : `NOT available${info.reason ? ` (${info.reason})` : ""}`}${info.version ? `, ${info.version}` : ""}. ${fallback ? `Default: model ${fallback.model}${fallback.effort ? `, effort ${fallback.effort}` : ""}. ` : ""}Models: ${models || "any name"}${info.freeModel ? " (free text also accepted)" : ""}.`,
    );
  }
  lines.push("", "Owner's defaults: Claude = sonnet (effort medium); Antigravity (engine gemini) = gemini-3.8-flash-medium. Use opus or other models only when the owner asks. Efforts: low, medium, high, xhigh, max (Claude only; the Gemini level is part of the model name).");

  lines.push("", "## Connectors (external MCP servers) already registered, per workspace");
  let any = false;
  for (const workspace of input.workspaces.list()) {
    const runtime = input.workspaces.find(workspace.id);
    if (!runtime) continue;
    const agents = runtime.store.snapshot().agents;
    for (const connector of runtime.connectors.list()) {
      any = true;
      const users = connector.agentIds.map((id) => agents.find((agent) => agent.id === id)?.name ?? id);
      lines.push(`- "${connector.name}" (${connector.kind}, ${connector.status.state}) in workspace "${workspace.name}"; used by: ${users.join(", ") || "nobody"}. In a proposal, use id "${connector.id}": it is copied into the new workspace.`);
    }
  }
  if (!any) lines.push("- none registered yet. A connector that does not exist is registered with add_connector (the owner approves).");

  lines.push("", "## Room purposes (`purpose`) and sizes (`size`)");
  lines.push(...Object.entries(ROOM_PURPOSE_INPUTS).map(([key, spec]) => `- ${key}: ${spec.description}`));
  lines.push(`Sizes: ${Object.keys(ROOM_SIZE_INPUTS).join(", ")} (initial floor only; "auto" grows by itself and is the default).`);
  lines.push("", "Skills and installable apps do not exist yet: leave `skills` out.");
  return lines.join("\n");
}
