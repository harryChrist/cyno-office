import { useEffect } from "react";
import { useConnectorsStore } from "../../store/connectorsStore";
import { useNavStore } from "../../store/navStore";
import { openLibrary } from "../library/libraryView";

/**
 * Conectores no workspace: um resumo. Os conectores (servidores MCP) moram na Biblioteca da
 * plataforma, que mostra todos, libera cada um a workspaces e agentes e diz quem usa o quê; aqui só
 * se vê quantos este workspace recebeu e se abre a Biblioteca já filtrada nele.
 */
export function ConnectorsSettings() {
  const list = useConnectorsStore((state) => state.list);
  const workspaceId = useNavStore((state) => state.workspaceId);

  useEffect(() => {
    if (useConnectorsStore.getState().list === null) void useConnectorsStore.getState().load();
  }, []);

  const count = list?.length ?? null;
  const agents = new Set((list ?? []).flatMap((connector) => connector.agentIds)).size;
  return (
    <div className="settings__groups" data-testid="settings-connectors">
      <section className="settings__card">
        <h4 className="settings__card-title" data-testid="settings-connectors-summary">
          {count === null ? "Carregando…" : count === 0 ? "Nenhum conector liberado para este workspace" : `${count} ${count === 1 ? "conector liberado" : "conectores liberados"} para este workspace`}
        </h4>
        <p className="settings__card-hint">
          {count ? `${agents === 0 ? "Nenhum agente usa" : agents === 1 ? "1 agente usa" : `${agents} agentes usam`} o que foi liberado. ` : ""}
          Os conectores (servidores MCP) ficam na Biblioteca, que é da plataforma inteira: lá você vê todos, libera cada um a workspaces e agentes e enxerga quem usa o quê.
        </p>
        <div className="ui-actions">
          <button type="button" className="ui-button" onClick={() => openLibrary({ tab: "conectores", workspaceId })} data-testid="settings-connectors-open-library">
            Abrir na Biblioteca
          </button>
        </div>
      </section>
    </div>
  );
}
