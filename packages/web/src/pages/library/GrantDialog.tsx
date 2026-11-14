import type { LibraryConnector, LibrarySkillView, LibraryWorkspaceInfo } from "@cyno/shared";
import { useEffect, useMemo, useState } from "react";
import { api, describeError } from "../../api/client";
import { ConnectorBadgeIcon } from "../../connectors/ConnectorIcon";
import { useLibraryStore } from "../../store/libraryStore";
import { AvatarSprite } from "../../ui/AvatarSprite";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText, Modal } from "../../ui/widgets";
import { grantBudgetWarnings } from "./skillsView";
import { describeDraftChange, draftOf, grantsOf, hasSecret, sameDraft, toggleAgent, toggleAllAgents, toggleWorkspace, type GrantDraft } from "./libraryView";

/**
 * "Liberar…": escolhe os workspaces que recebem o conector e, dentro de cada um, os agentes. Marcar
 * só o workspace deixa o conector disponível a ele (o Maestro pode entregar a agentes); marcar
 * agentes entrega de uma vez. Salvar manda o mapa inteiro (o que foi desmarcado é retirado). Serve
 * para conector (`connector`) e para skill (`skill`, com o aviso dos limites por agente).
 */
export function GrantDialog({ connector, skill, onClose }: { connector?: LibraryConnector; skill?: LibrarySkillView; onClose: () => void }) {
  const item = (connector ?? skill)!;
  const allSkills = useLibraryStore((state) => state.skills);
  const [workspaces, setWorkspaces] = useState<LibraryWorkspaceInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const initial = useMemo(() => draftOf(item), [item.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState<GrantDraft>(initial);
  const save = useAsyncAction();

  useEffect(() => {
    let alive = true;
    api.listLibraryWorkspaces().then(
      (list) => alive && setWorkspaces(list),
      (error: unknown) => alive && setLoadError(describeError(error)),
    );
    return () => {
      alive = false;
    };
  }, []);

  const changes = workspaces ? describeDraftChange(initial, draft, workspaces) : [];
  const dirty = !sameDraft(initial, draft);
  const sharedSecret = connector ? hasSecret(connector) : false;
  const budgetWarnings = skill && workspaces ? grantBudgetWarnings(allSkills ?? [], skill, draft, workspaces) : [];
  const marked = Object.keys(draft).length;

  const submit = async () => {
    const saved = await save.run(async () => {
      if (skill) await api.setLibrarySkillGrants(skill.id, { grants: grantsOf(draft) });
      else await api.setLibraryGrants(item.id, { grants: grantsOf(draft) });
      return true;
    });
    if (saved) onClose();
  };

  return (
    <Modal title={`Liberar ${item.name}`} onClose={onClose} wide testId="library-grant-dialog">
      <div className="lib-grant">
        <p className="lib-grant__lead">
          {connector && <ConnectorBadgeIcon connector={connector} size={28} library />}
          {connector ? (
            <span>Marque os workspaces que recebem este conector e, dentro de cada um, os agentes que o usam. Um agente só enxerga as ferramentas se o workspace dele e ele mesmo estiverem marcados.</span>
          ) : (
            <span>Marque os workspaces que recebem esta skill e, dentro de cada um, os agentes que a usam. O agente recebe uma cópia na pasta dele e uma linha de índice nas instruções; ele lê o SKILL.md quando a tarefa pede. O Maestro pode entregar a skill a outros agentes só entre os workspaces marcados aqui.</span>
          )}
        </p>
        {sharedSecret && (
          <p className="lib-grant__note" role="note" data-testid="library-grant-secret">
            A credencial deste conector é uma só e vale para todos os workspaces liberados: quem receber usa a mesma conta.
          </p>
        )}
        {(connector?.warnings ?? skill?.warnings ?? []).map((warning) => (
          <p key={warning} className="lib-grant__note" role="note">
            {warning}
          </p>
        ))}
        {budgetWarnings.length > 0 && (
          <div className="lib-grant__note" role="note" data-testid="library-grant-budget">
            <strong>Passa dos limites (só um aviso, dá para salvar):</strong>
            <ul className="lib-grant__budget">
              {budgetWarnings.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
        <ErrorText>{loadError}</ErrorText>
        {workspaces === null && !loadError && (
          <p className="ui-muted" role="status">
            Carregando workspaces…
          </p>
        )}
        {workspaces?.length === 0 && <p className="ui-muted">Nenhum workspace aberto. Crie um workspace primeiro.</p>}
        <ul className="lib-grant__list">
          {(workspaces ?? []).map((workspace) => {
            const on = workspace.id in draft;
            const picked = draft[workspace.id]?.agentIds ?? [];
            const all = workspace.agents.length > 0 && picked.length === workspace.agents.length;
            return (
              <li key={workspace.id} className="lib-grant__ws" data-on={on} data-testid={`library-grant-ws-${workspace.id}`}>
                <label className="lib-grant__wsrow">
                  <input type="checkbox" checked={on} onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setDraft((current) => toggleWorkspace(current, workspace.id, checked));
                  }} data-testid={`library-grant-ws-check-${workspace.id}`} />
                  <span className="lib-grant__wsname">{workspace.name}</span>
                  <span className="ui-muted lib-grant__count">
                    {on ? `${picked.length} de ${workspace.agents.length} ${workspace.agents.length === 1 ? "agente" : "agentes"}` : `${workspace.agents.length} ${workspace.agents.length === 1 ? "agente" : "agentes"}`}
                  </span>
                </label>
                {on && workspace.agents.length > 0 && (
                  <div className="lib-grant__agents">
                    <label className="lib-grant__all">
                      <input type="checkbox" checked={all} onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setDraft((current) => toggleAllAgents(current, workspace, checked));
                      }} data-testid={`library-grant-all-${workspace.id}`} />
                      Todos do time
                    </label>
                    <ul className="lib-grant__agentlist">
                      {workspace.agents.map((agent) => (
                        <li key={agent.id}>
                          <label className="lib-grant__agent">
                            <input
                              type="checkbox"
                              checked={picked.includes(agent.id)}
                              onChange={(event) => {
                                const checked = event.currentTarget.checked;
                                setDraft((current) => toggleAgent(current, workspace.id, agent.id, checked));
                              }}
                              data-testid={`library-grant-agent-${workspace.id}-${agent.id}`}
                            />
                            <span className="lib-agent__face">
                              <AvatarSprite avatar={agent.avatar} seedId={agent.id} size={26} framing="head" />
                            </span>
                            <span>{agent.name}</span>
                            {agent.maestro && <span className="lib-agent__tag">Maestro</span>}
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="lib-grant__foot">
          <p className="lib-grant__summary" aria-live="polite" data-testid="library-grant-summary">
            {dirty ? changes.join(" · ") : marked === 0 ? "Ainda não liberado a ninguém." : "Sem mudanças."}
          </p>
          <ErrorText testId="library-grant-error">{save.error}</ErrorText>
          <div className="ui-actions">
            <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
              Cancelar
            </button>
            <button type="button" className="ui-button" disabled={!dirty || save.pending} onClick={() => void submit()} data-testid="library-grant-save">
              {save.pending ? "Salvando…" : "Salvar"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
