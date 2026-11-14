import { isMaestroAgent } from "@cyno/shared";
import { create } from "zustand";
import { api } from "../api/client";
import { useWorkPanelStore } from "../agentWork/workPanelStore";
import { useConnectorsStore } from "../store/connectorsStore";
import { useNavStore } from "../store/navStore";
import { useOfficeStore } from "../store/officeStore";
import { useViewStore } from "../store/viewStore";
import { AvatarSprite } from "../ui/AvatarSprite";
import { findAgentDetails } from "../ui/selectors";
import { useAsyncAction } from "../ui/useAsyncAction";
import { ErrorText, Modal } from "../ui/widgets";
import { ConnectorBadgeIcon } from "./ConnectorIcon";
import { openConnectorSettings } from "./ConnectorPicker";
import { connectorStatus, KIND_LABELS, toolsLabel } from "./connectorView";

/** Qual conector está com o detalhe aberto (um por vez; quem desenha é o ConnectorDetailHost). */
export const useConnectorDetail = create<{ connectorId: string | null; open: (connectorId: string) => void; close: () => void }>()((set) => ({
  connectorId: null,
  open: (connectorId) => set({ connectorId }),
  close: () => set({ connectorId: null }),
}));

/** Leva ao agente: painel dele selecionado e a câmera nele, no escritório (como os outros links de agente). */
function goToAgent(agentId: string): void {
  const office = useOfficeStore.getState().office;
  const details = office ? findAgentDetails(office, agentId) : null;
  useConnectorDetail.getState().close();
  useWorkPanelStore.getState().close();
  useNavStore.getState().go("office");
  const view = useViewStore.getState();
  view.select({ kind: "agent", id: agentId });
  if (details?.room) view.showAgent(agentId, details.room.id);
}

/**
 * Detalhe de um conector: estado (com o motivo), as ferramentas que ele expõe aos agentes e a lista
 * de agentes que o usam (clicar abre o agente e foca nele no mapa). Abre da faixa do HUD, das
 * Configurações e do painel do agente.
 */
function ConnectorDetailDialog({ connectorId }: { connectorId: string }) {
  const connector = useConnectorsStore((state) => state.list?.find((item) => item.id === connectorId));
  const office = useOfficeStore((state) => state.office);
  const close = useConnectorDetail((state) => state.close);
  const test = useAsyncAction();
  if (!connector) return null;
  const status = connectorStatus(connector);
  const agents = office ? connector.agentIds.map((id) => office.agents.find((agent) => agent.id === id)).filter((agent) => agent !== undefined) : [];
  if (office) agents.sort((a, b) => Number(isMaestroAgent(office, b)) - Number(isMaestroAgent(office, a)) || a.name.localeCompare(b.name));
  const target = connector.kind === "http" ? connector.url : [connector.command, ...(connector.args ?? [])].join(" ");
  return (
    <Modal title={connector.name} onClose={close} testId="connector-detail">
      <div className="connector-detail">
        <header className="connector-detail__head">
          <ConnectorBadgeIcon connector={connector} size={40} />
          <div className="connector-detail__title">
            <span className={`ui-badge ui-badge--${status.tone}`} data-testid="connector-detail-status">
              {status.label}
            </span>
            <span className="connector-detail__target" title={target}>
              {KIND_LABELS[connector.kind]} · {target}
            </span>
          </div>
        </header>
        {connector.status.reason && connector.enabled && <p className={`connector-detail__reason connector-detail__reason--${status.tone}`}>{connector.status.reason}</p>}

        <section aria-labelledby="connector-detail-agents">
          <h3 id="connector-detail-agents" className="connector-detail__section">
            Quem usa ({agents.length})
          </h3>
          {agents.length === 0 ? (
            <p className="connector-detail__empty">Nenhum agente ainda. Ligue no painel do agente ou na Biblioteca.</p>
          ) : (
            <ul className="connector-detail__agents" data-testid="connector-detail-agents">
              {agents.map((agent) => (
                <li key={agent.id}>
                  <button type="button" className="connector-detail__agent" onClick={() => goToAgent(agent.id)} data-testid={`connector-detail-agent-${agent.id}`}>
                    <span className="connector-detail__avatar" aria-hidden="true">
                      <AvatarSprite avatar={agent.avatar} seedId={agent.id} size={40} framing="head" />
                    </span>
                    <span className="connector-detail__agent-name">{agent.name}</span>
                    <span className="connector-detail__agent-role">{office && isMaestroAgent(office, agent) ? "Maestro" : agent.role}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="connector-detail-tools">
          <h3 id="connector-detail-tools" className="connector-detail__section">
            Ferramentas ({toolsLabel(connector.status.tools.length)})
          </h3>
          {connector.status.tools.length === 0 ? (
            <p className="connector-detail__empty">{connector.status.state === "connected" ? "O servidor não anunciou ferramentas." : "Teste a conexão para ver as ferramentas."}</p>
          ) : (
            <ul className="connector-detail__tools" data-testid="connector-detail-tools">
              {connector.status.tools.map((tool) => (
                <li key={tool.name}>
                  <code>{tool.name}</code>
                  {tool.description && tool.description !== tool.name && <span>{tool.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <ErrorText>{test.error}</ErrorText>
        <div className="ui-actions">
          <button type="button" className="ui-button ui-button--secondary" disabled={test.pending || !connector.enabled} onClick={() => void test.run(() => api.testConnector(connector.id))}>
            {test.pending ? "Testando…" : "Testar conexão"}
          </button>
          <button
            type="button"
            className="ui-button"
            onClick={() => {
              close();
              useWorkPanelStore.getState().close();
              openConnectorSettings();
            }}
          >
            Abrir na Biblioteca
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Desenha o detalhe aberto (montado uma vez, na barra de cima). */
export function ConnectorDetailHost() {
  const connectorId = useConnectorDetail((state) => state.connectorId);
  return connectorId ? <ConnectorDetailDialog key={connectorId} connectorId={connectorId} /> : null;
}
