import { useCallback, useId, useRef, useState } from "react";
import { api, describeError } from "../api/client";
import { usePopover } from "../hud/usePopover";
import { useConnectorsStore } from "../store/connectorsStore";
import { useNavStore } from "../store/navStore";
import { openLibrary } from "../pages/library/libraryView";
import { ErrorText } from "../ui/widgets";
import { AgentSkills } from "../ui/AgentSkills";
import { AgentHas } from "./AgentHas";
import { useConnectorDetail } from "./ConnectorDetail";
import { ConnectorBadgeIcon } from "./ConnectorIcon";
import { connectorStatus, toolsLabel } from "./connectorView";

/** Leva à Biblioteca (onde os conectores se cadastram e se liberam), filtrada neste workspace. */
export function openConnectorSettings(): void {
  openLibrary({ tab: "conectores", workspaceId: useNavStore.getState().workspaceId });
}

/**
 * Conectores do agente (ou do Maestro): lista com caixa de marcar e ícone. Cada mudança manda a
 * lista inteira (PATCH agents/:id/connectors); o estado só muda pelo evento do WebSocket.
 * Um agente focado deve ficar só com o conector do sistema dele.
 */
export function ConnectorPicker({ agentId, agentName, onNavigate }: { agentId: string; agentName: string; onNavigate?: () => void }) {
  const list = useConnectorsStore((state) => state.list);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (list === null) return <p className="connector-picker__empty">Carregando conectores…</p>;
  if (list.length === 0) {
    return (
      <p className="connector-picker__empty" data-testid="connector-picker-empty">
        Nenhum conector liberado para este workspace.{" "}
        <button
          type="button"
          className="ui-link"
          onClick={() => {
            onNavigate?.();
            openConnectorSettings();
          }}
        >
          Liberar na Biblioteca
        </button>
      </p>
    );
  }

  const mine = list.filter((connector) => connector.agentIds.includes(agentId)).map((connector) => connector.id);
  const toggle = async (connectorId: string, on: boolean) => {
    setPending(connectorId);
    setError(null);
    try {
      await api.setAgentConnectors(agentId, on ? [...mine, connectorId] : mine.filter((id) => id !== connectorId));
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <ul className="connector-picker" aria-label={`Conectores de ${agentName}`} data-testid="connector-picker">
        {list.map((connector) => {
          const status = connectorStatus(connector);
          return (
            <li key={connector.id} className="connector-picker__row">
              <label className="connector-picker__item">
                <input
                  type="checkbox"
                  checked={mine.includes(connector.id)}
                  disabled={pending !== null}
                  aria-busy={pending === connector.id}
                  onChange={(event) => void toggle(connector.id, event.currentTarget.checked)}
                  data-testid={`connector-picker-${connector.id}`}
                />
                <ConnectorBadgeIcon connector={connector} size={24} />
                <span className="connector-picker__text">
                  <span className="connector-picker__name">{connector.name}</span>
                  <span className="connector-picker__meta">
                    {status.label} · {toolsLabel(connector.status.tools.length)}
                  </span>
                </span>
              </label>
              <button
                type="button"
                className="ui-icon-button connector-picker__info"
                aria-label={`Detalhes de ${connector.name}`}
                title="Detalhes: ferramentas e quem usa"
                onClick={() => useConnectorDetail.getState().open(connector.id)}
                data-testid={`connector-picker-info-${connector.id}`}
              >
                ›
              </button>
            </li>
          );
        })}
      </ul>
      <ErrorText>{error}</ErrorText>
    </>
  );
}

/** Botão "Conectores" com o seletor num popover (cabeçalho da tela de trabalho do agente/Maestro). */
export function ConnectorMenu({ agentId, agentName, onNavigate }: { agentId: string; agentName: string; onNavigate?: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popId = useId();
  const close = useCallback(() => setOpen(false), []);
  usePopover(open, close, rootRef, buttonRef);
  const count = useConnectorsStore((state) => (state.list ?? []).filter((connector) => connector.agentIds.includes(agentId)).length);
  return (
    <div className="connector-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="ui-button ui-button--secondary ui-button--small connector-menu__button"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => setOpen((on) => !on)}
        data-testid="connector-menu"
      >
        Conectores{count > 0 ? ` (${count})` : ""}
      </button>
      {open && (
        <div id={popId} className="connector-menu__pop" role="group" aria-label={`Conectores de ${agentName}`}>
          <p className="connector-menu__title">O que {agentName} tem</p>
          <AgentHas agentId={agentId} />
          <p className="connector-menu__title">Liberados a este workspace (marque para entregar)</p>
          <ConnectorPicker agentId={agentId} agentName={agentName} onNavigate={onNavigate} />
          <p className="connector-menu__title">Skills que {agentName} recebe</p>
          <AgentSkills agentId={agentId} testId="connector-menu-skills" />
        </div>
      )}
    </div>
  );
}
