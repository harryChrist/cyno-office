import type { ConnectorImportCandidate, LibraryConnector } from "@cyno/shared";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { ConnectorFormDialog, EMPTY_FORM, formFromCandidate, ImportDialog, type ConnectorEditing } from "../../connectors/ConnectorFormDialog";
import { ConnectorBadgeIcon } from "../../connectors/ConnectorIcon";
import { connectorStatus, KIND_LABELS, toolsLabel } from "../../connectors/connectorView";
import { useLibraryStore } from "../../store/libraryStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { AvatarSprite } from "../../ui/AvatarSprite";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { AsyncSwitch, ConfirmDialog, ErrorText } from "../../ui/widgets";
import { GrantDialog } from "./GrantDialog";
import { filterConnectors, filterCounts, LIBRARY_FILTERS, ORIGIN_LABELS, openLibrary, usageLabel, type LibraryFilterId } from "./libraryView";

/** "Quem usa": cada workspace liberado com os agentes (avatar e nome) que o recebem. */
export function WhoUses({ connector }: { connector: Pick<LibraryConnector, "id" | "uses"> }) {
  if (connector.uses.length === 0) return <p className="lib-card__none ui-muted">Ninguém usa ainda. Use “Liberar…” para escolher workspaces e agentes.</p>;
  return (
    <ul className="lib-uses" data-testid={`library-uses-${connector.id}`}>
      {connector.uses.map((use) => (
        <li key={use.workspaceId} className="lib-uses__ws" data-testid={`library-use-${connector.id}-${use.workspaceId}`}>
          <span className="lib-uses__name">{use.workspaceName}</span>
          {use.agents.length === 0 ? (
            <span className="lib-uses__empty ui-muted">liberado ao workspace, nenhum agente ainda</span>
          ) : (
            <ul className="lib-uses__agents">
              {use.agents.map((agent) => (
                <li key={agent.id} className="lib-agent" title={agent.maestro ? `${agent.name} (Maestro)` : agent.name}>
                  <span className="lib-agent__face">
                    <AvatarSprite avatar={agent.avatar} seedId={agent.id} size={26} framing="head" />
                  </span>
                  <span className="lib-agent__name">{agent.name}</span>
                  {agent.maestro && <span className="lib-agent__tag">Maestro</span>}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Um conector da Biblioteca: o que é, estado, ferramentas (recolhíveis), quem usa e as ações. */
function LibraryConnectorCard({ connector, onGrant, onEdit, onRemove }: { connector: LibraryConnector; onGrant: () => void; onEdit: () => void; onRemove: () => void }) {
  const status = connectorStatus(connector);
  const test = useAsyncAction();
  const target = connector.kind === "http" ? connector.url : [connector.command, ...(connector.args ?? [])].join(" ");
  const secrets = connector.kind === "http" ? connector.secretHeaders : connector.secretEnv;
  return (
    <li className="lib-card" data-testid={`library-card-${connector.id}`} data-state={connector.status.state}>
      <header className="lib-card__head">
        <ConnectorBadgeIcon connector={connector} size={36} library />
        <div className="lib-card__title">
          <h3 className="lib-card__name">{connector.name}</h3>
          <p className="lib-card__target" title={target}>
            <span className="lib-chip">{KIND_LABELS[connector.kind]}</span>
            <span className="lib-chip">{ORIGIN_LABELS[connector.origin]}</span>
            <span className="lib-card__url">{target}</span>
          </p>
        </div>
        <span className={`ui-badge ui-badge--${status.tone}`} data-testid={`library-status-${connector.id}`}>
          {status.label}
        </span>
      </header>
      {connector.description && <p className="lib-card__desc">{connector.description}</p>}
      {connector.status.reason && connector.enabled && (
        <p className={`lib-card__reason lib-card__reason--${status.tone}`} role="note">
          {connector.status.reason}
        </p>
      )}

      <div className="lib-card__body">
        <section className="lib-card__col" aria-label="Ferramentas">
          <h4 className="lib-card__label">Ferramentas</h4>
          {connector.status.tools.length > 0 ? (
            <details className="lib-tools" data-testid={`library-tools-${connector.id}`}>
              <summary>
                {toolsLabel(connector.status.tools.length)}
                {connector.weightTokens > 0 && <span className="ui-muted"> · ~{connector.weightTokens} tokens por turno</span>}
              </summary>
              <ul className="lib-tools__list">
                {connector.status.tools.map((tool) => (
                  <li key={tool.name}>
                    <code>
                      {connector.toolPrefix}__{tool.name}
                    </code>
                    {tool.description && <span className="lib-tools__desc">{tool.description}</span>}
                  </li>
                ))}
              </ul>
            </details>
          ) : (
            <span className="ui-muted">{connector.status.state === "connected" ? "nenhuma" : "teste a conexão para ver"}</span>
          )}
          <h4 className="lib-card__label">Credenciais</h4>
          <span className={secrets.length > 0 ? "" : "ui-muted"}>{secrets.length > 0 ? secrets.map((name) => `${name} (definido)`).join(", ") : "nenhuma"}</span>
        </section>
        <section className="lib-card__col lib-card__col--uses" aria-label="Quem usa">
          <h4 className="lib-card__label">
            Quem usa{connector.uses.length > 0 && <span className="ui-muted"> · {usageLabel(connector)}</span>}
          </h4>
          <WhoUses connector={connector} />
        </section>
      </div>

      <footer className="lib-card__actions">
        <AsyncSwitch label="Ligado" checked={connector.enabled} testId={`library-enabled-${connector.id}`} onToggle={(next) => api.updateLibraryConnector(connector.id, { enabled: next })} />
        <div className="ui-actions">
          <button type="button" className="ui-button ui-button--small" onClick={onGrant} data-testid={`library-grant-${connector.id}`}>
            Liberar…
          </button>
          <button
            type="button"
            className="ui-button ui-button--secondary ui-button--small"
            disabled={test.pending || !connector.enabled}
            aria-busy={test.pending}
            onClick={() => void test.run(() => api.testLibraryConnector(connector.id))}
            data-testid={`library-test-${connector.id}`}
          >
            {test.pending ? "Testando…" : "Testar"}
          </button>
          <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={onEdit} data-testid={`library-edit-${connector.id}`}>
            Editar
          </button>
          {connector.appId ? (
            // Conector de app: excluir aqui deixaria o app sem conector. Ele some junto com o app (aba Apps > Desinstalar).
            <span className="ui-muted lib-card__owned" data-testid={`library-owned-${connector.id}`} title="Este conector pertence a um app instalado. Para tirá-lo, desinstale o app na aba Apps.">
              Do app {connector.appId}
            </span>
          ) : (
            <button type="button" className="ui-button ui-button--danger ui-button--small" onClick={onRemove} data-testid={`library-remove-${connector.id}`}>
              Excluir
            </button>
          )}
        </div>
      </footer>
      <ErrorText>{test.error}</ErrorText>
    </li>
  );
}

/**
 * Aba Conectores: todos os servidores MCP guardados no sistema, com o estado, as ferramentas e quem
 * usa cada um. Liberar escolhe os workspaces e, dentro deles, os agentes. Filtros: todos, em uso,
 * sem uso, com problema; busca; e um filtro por workspace (o link das Configurações usa ele).
 */
export function LibraryConnectorsTab({ workspaceId }: { workspaceId: string | null }) {
  const connectors = useLibraryStore((state) => state.connectors);
  const loadError = useLibraryStore((state) => state.error);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const [filter, setFilter] = useState<LibraryFilterId>("todos");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<ConnectorEditing | null>(null);
  const [importing, setImporting] = useState(false);
  const [granting, setGranting] = useState<string | null>(null);
  const [removing, setRemoving] = useState<LibraryConnector | null>(null);

  useEffect(() => {
    void useLibraryStore.getState().load();
  }, []);

  const all = useMemo(() => connectors ?? [], [connectors]);
  const counts = useMemo(() => filterCounts(all, workspaceId), [all, workspaceId]);
  const shown = useMemo(() => filterConnectors(all, { filter, query, workspaceId }), [all, filter, query, workspaceId]);
  const grantingItem = granting ? all.find((item) => item.id === granting) : undefined;

  return (
    <div className="lib-tab" data-testid="library-connectors">
      <p className="lib__intro">Conectores (MCP) são as ferramentas externas que os agentes podem usar. Cada um é guardado uma vez aqui e você libera a workspaces e, dentro deles, a agentes.</p>
      <div className="lib-toolbar">
        <input className="ui-input lib-toolbar__search" type="search" placeholder="Buscar conector, ferramenta, workspace ou agente" value={query} onChange={(event) => setQuery(event.currentTarget.value)} aria-label="Buscar" data-testid="library-search" />
        <div className="ui-actions lib-toolbar__actions">
          <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => setImporting(true)} data-testid="library-import">
            Importar do Claude Code
          </button>
          <button type="button" className="ui-button ui-button--small" onClick={() => setEditing({ mode: "create", form: EMPTY_FORM })} data-testid="library-new">
            + Novo conector
          </button>
        </div>
      </div>

      <div className="lib-filters">
        <div className="lib-filters__chips" role="group" aria-label="Filtro">
          {LIBRARY_FILTERS.map((item) => (
            <button key={item.id} type="button" className="lib-filter" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)} data-testid={`library-filter-${item.id}`}>
              {item.label} <span className="lib-filter__count">{counts[item.id]}</span>
            </button>
          ))}
        </div>
        <label className="lib-filters__ws">
          <span className="ui-muted">Workspace</span>
          <select className="ui-input ui-input--compact" value={workspaceId ?? ""} onChange={(event) => openLibrary({ tab: "conectores", workspaceId: event.currentTarget.value || null })} data-testid="library-workspace-filter">
            <option value="">Todos</option>
            {(workspaces ?? []).map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ErrorText>{loadError}</ErrorText>
      {connectors === null ? (
        !loadError && (
          <p className="ui-muted" role="status">
            Carregando conectores…
          </p>
        )
      ) : all.length === 0 ? (
        <section className="lib-empty">
          <h3 className="lib-card__name">A Biblioteca ainda não tem conectores</h3>
          <p className="ui-muted">Cadastre a URL de um servidor MCP (ex.: Notion, GitHub, Context7) ou importe os que você já usa no Claude Code. Depois use “Liberar…” para escolher quais workspaces e agentes recebem.</p>
        </section>
      ) : shown.length === 0 ? (
        <p className="lib-empty ui-muted" data-testid="library-none">
          Nenhum conector com esse filtro.
        </p>
      ) : (
        <ul className="lib-list" data-testid="library-list">
          {shown.map((connector) => (
            <LibraryConnectorCard key={connector.id} connector={connector} onGrant={() => setGranting(connector.id)} onEdit={() => setEditing({ mode: "edit", connector })} onRemove={() => setRemoving(connector)} />
          ))}
        </ul>
      )}

      {editing && <ConnectorFormDialog key={editing.mode === "edit" ? editing.connector.id : "novo"} editing={editing} onClose={() => setEditing(null)} onSaved={(saved) => editing.mode === "create" && setGranting(saved.id)} />}
      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onPick={(candidate: ConnectorImportCandidate) => {
            setImporting(false);
            setEditing({
              mode: "create",
              form: formFromCandidate(candidate),
              note: candidate.urlMasked ? "A URL tinha uma chave: cole a URL inteira e confira as credenciais." : "Confira os dados e preencha o token (se o servidor pedir).",
            });
          }}
        />
      )}
      {grantingItem && <GrantDialog connector={grantingItem} onClose={() => setGranting(null)} />}
      {removing && (
        <ConfirmDialog
          title="Excluir conector"
          testId="confirm-delete-library-connector"
          message={
            <p>
              Excluir <strong>{removing.name}</strong> da Biblioteca? {removing.uses.length > 0 ? `Ele sai de ${removing.uses.length === 1 ? "1 workspace" : `${removing.uses.length} workspaces`} e os agentes perdem as ferramentas. ` : ""}
              As credenciais guardadas são apagadas.
            </p>
          }
          confirmLabel="Excluir conector"
          onConfirm={() => api.deleteLibraryConnector(removing.id)}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}
