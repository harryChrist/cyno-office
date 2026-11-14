import { useConnectorsStore } from "../store/connectorsStore";
import { useOfficeStore } from "../store/officeStore";
import { ConnectorBadgeIcon, ConnectorIcon } from "./ConnectorIcon";
import { useConnectorDetail } from "./ConnectorDetail";
import { connectorStatus } from "./connectorView";

/**
 * Faixa dos conectores do workspace nos controles do Office: ícone + ponto de estado. Quando um
 * agente chama uma ferramenta de um conector, o ícone dele pulsa. Clique: o detalhe (estado, ferramentas, quem usa).
 * Sem conectores, não aparece (não ocupa espaço).
 */
export function ConnectorStrip() {
  const list = useConnectorsStore((state) => state.list);
  const active = useConnectorsStore((state) => state.byConnector);
  const agents = useOfficeStore((state) => state.office?.agents);
  if (!list || list.length === 0) return null;
  const nameOf = (agentId: string) => agents?.find((agent) => agent.id === agentId)?.name ?? agentId;
  return (
    <div className="connector-strip" data-testid="connector-strip">
      <span className="connector-strip__label" aria-hidden="true">
        Conectores
      </span>
      <ul className="connector-strip__list" aria-label="Conectores do workspace">
        {list.map((connector) => {
          const status = connectorStatus(connector);
          const mark = active[connector.id];
          const doing = mark ? ` · ${nameOf(mark.agentId)} ${mark.running ? "usando" : "usou"} ${mark.tool}` : "";
          const label = `${connector.name}: ${status.label}${doing}`;
          return (
            <li key={connector.id}>
              <button
                // Nova atividade = elemento novo (a animação do pulso recomeça).
                key={mark ? mark.at : "quieto"}
                type="button"
                className="connector-strip__item"
                title={label}
                aria-label={label}
                data-enabled={connector.enabled}
                data-active={mark ? (mark.running ? "running" : "done") : undefined}
                onClick={() => useConnectorDetail.getState().open(connector.id)}
                data-testid={`connector-strip-${connector.id}`}
              >
                <ConnectorBadgeIcon connector={connector} size={20} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Balão sobre o agente no mapa enquanto ele usa um conector (e alguns segundos depois): o ícone e
 * o nome da ferramenta. Só visual; fica dentro do rótulo do agente (que já segue a câmera).
 */
export function ConnectorBubble({ agentId }: { agentId: string }) {
  const mark = useConnectorsStore((state) => state.byAgent[agentId]);
  const connector = useConnectorsStore((state) => (mark ? state.list?.find((item) => item.id === mark.connectorId) : undefined));
  if (!mark || !connector) return null;
  return (
    <span key={mark.at} className="agent-label__connector" data-running={mark.running} data-testid="agent-connector-bubble">
      <ConnectorIcon connector={connector} size={16} />
      <span className="agent-label__connector-tool">{mark.tool}</span>
    </span>
  );
}
