import { useEffect } from "react";
import { useConnectorsStore } from "../store/connectorsStore";
import { useLibraryStore } from "../store/libraryStore";
import { useNavStore } from "../store/navStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { ORIGIN_LABELS, openLibrary } from "../pages/library/libraryView";
import { ConnectorBadgeIcon } from "./ConnectorIcon";
import { connectorsOfAgent, connectorStatus } from "./connectorView";

/**
 * "O que este agente tem": os conectores que chegam a ele e de onde vêm (Biblioteca, com a origem
 * do cadastro e o workspace que liberou), com o atalho para a Biblioteca já filtrada neste workspace.
 * Quem libera ou tira é a Biblioteca (ou o seletor logo abaixo, só entre o que o workspace recebeu).
 */
export function AgentHas({ agentId }: { agentId: string }) {
  const list = useConnectorsStore((state) => state.list);
  const library = useLibraryStore((state) => state.connectors);
  const workspaceId = useNavStore((state) => state.workspaceId);
  const workspaceName = useWorkspaceStore((state) => state.workspaces?.find((workspace) => workspace.id === workspaceId)?.name ?? workspaceId);

  useEffect(() => {
    if (useLibraryStore.getState().connectors === null) void useLibraryStore.getState().load();
  }, []);

  const mine = connectorsOfAgent(list, agentId);
  return (
    <div className="agent-has-wrap" data-testid="agent-has">
      {mine.length === 0 ? (
        <p className="ui-muted ui-empty" data-testid="agent-has-empty">
          Nenhum conector chega a este agente.
        </p>
      ) : (
        <ul className="agent-has" aria-label="Conectores deste agente">
          {mine.map((connector) => {
            const status = connectorStatus(connector);
            const libraryItem = library?.find((item) => item.id === connector.id);
            const origin = libraryItem?.origin;
            // Conector de um app abre o cartão do app; os outros, o cartão do conector (já filtrado neste workspace).
            const appId = libraryItem?.appId;
            return (
              <li key={connector.id} className="agent-has__row" data-testid={`agent-has-${connector.id}`}>
                <ConnectorBadgeIcon connector={connector} size={24} />
                <span className="agent-has__text">
                  <span className="agent-has__name">{connector.name}</span>
                  <span className="agent-has__from">
                    Da Biblioteca{origin ? ` · ${ORIGIN_LABELS[origin].toLowerCase()}` : ""} · liberado ao workspace {workspaceName}{status.tone === "success" ? "" : ` · ${status.label}`}
                  </span>
                </span>
                <button
                  type="button"
                  className="ui-link agent-has__open"
                  onClick={() => (appId ? openLibrary({ tab: "apps", item: appId }) : openLibrary({ tab: "conectores", workspaceId, item: connector.id }))}
                  aria-label={`Abrir ${connector.name} na Biblioteca`}
                  data-testid={`agent-has-open-${connector.id}`}
                >
                  Abrir
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" className="ui-link" onClick={() => openLibrary({ tab: "conectores", workspaceId })} data-testid="agent-has-library">
        Abrir na Biblioteca
      </button>
    </div>
  );
}
