import { maestroTeamIds, type OfficeState, type Team } from "@cyno/shared";
import { useState } from "react";
import { api } from "../api/client";
import { useViewStore } from "../store/viewStore";
import { AvatarSprite } from "./AvatarSprite";
import { CreateAgentDialog } from "./CreateDialogs";
import { AGENT_STATUS_LABELS, countLabel } from "./format";
import { joinNames, teamFootprint, type TeamWithAgents } from "./selectors";
import { TeamForm } from "./EntityForms";
import { isEmptyPatch, teamPatch, teamValues, type TeamFormValues } from "./formModels";
import { useWidePanel } from "./panelWidth";
import { useAsyncAction } from "./useAsyncAction";
import { ConfirmDialog, ErrorText, StatusBadge } from "./widgets";

/**
 * Editar o time dentro do bloco do time: o mesmo formulário da janela "Novo time". Enquanto está
 * aberto, o painel lateral alarga.
 */
function TeamEditForm({ team, onDone }: { team: Team; onDone: () => void }) {
  const [initial] = useState(() => teamValues(team));
  useWidePanel(true);
  const submit = async (values: TeamFormValues) => {
    const patch = teamPatch(initial, values);
    if (!isEmptyPatch(patch)) await api.updateTeam(team.id, patch);
    onDone();
  };
  return (
    <div className="team-block__form">
      <TeamForm
        mode="edit"
        initial={initial}
        label={`Editar o time ${team.name}`}
        onSubmit={submit}
        onCancel={onDone}
        testId={`team-edit-form-${team.id}`}
        submitTestId={`team-edit-save-${team.id}`}
      />
    </div>
  );
}

/** Líder do time: um dos agentes (ganha a cabeceira da ilha no escritório). Salva na hora. */
function TeamLeadSelect({ team, agents }: { team: Team; agents: TeamWithAgents["agents"] }) {
  const { pending, error, run } = useAsyncAction();
  const id = `team-lead-${team.id}`;
  return (
    <div className="team-block__lead">
      <label htmlFor={id}>Líder</label>
      <select
        id={id}
        className="ui-input ui-input--compact"
        value={team.leadAgentId ?? ""}
        disabled={pending}
        onChange={(e) => {
          const value = e.currentTarget.value;
          void run(() => api.updateTeam(team.id, { leadAgentId: value === "" ? null : value }));
        }}
        data-testid={id}
      >
        <option value="">Sem líder</option>
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/** Mensagem da confirmação: quais agentes saem junto e quantas tarefas ativas são canceladas. */
function DeleteTeamMessage({ office, team }: { office: OfficeState; team: Team }) {
  const { agents, activeTasks } = teamFootprint(office, team.id);
  return (
    <>
      <p>
        Excluir o time <strong>{team.name}</strong>?
      </p>
      <p data-testid="confirm-delete-team-agents">
        {agents.length === 0
          ? "O time não tem agentes."
          : `${agents.length === 1 ? "Sai junto 1 agente" : `Saem junto ${agents.length} agentes`}: ${joinNames(agents.map((agent) => agent.name))}.`}
      </p>
      {activeTasks > 0 && (
        <p data-testid="confirm-delete-team-tasks">{countLabel(activeTasks, "tarefa ativa será cancelada", "tarefas ativas serão canceladas")}.</p>
      )}
      <p>O histórico das tarefas continua. Isso não pode ser desfeito.</p>
    </>
  );
}

/** Um time no painel do quarto: nome, foco, agentes e as ações de editar, excluir e criar agente. */
export function TeamBlock({ entry, office }: { entry: TeamWithAgents; office: OfficeState }) {
  const select = useViewStore((state) => state.select);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { team, agents } = entry;
  // A Gerência (time da Sala do Maestro) tem só o Maestro e não é excluída.
  const internal = maestroTeamIds(office).has(team.id);
  return (
    <li className="team-block" data-testid={`room-team-${team.id}`}>
      {editing ? (
        <TeamEditForm key={team.id} team={team} onDone={() => setEditing(false)} />
      ) : (
        <div className="team-block__head">
          <div>
            <h4 className="team-block__name">{team.name}</h4>
            <p className="ui-muted team-block__focus">{team.focus}</p>
          </div>
          <div className="team-block__actions">
            {!internal && (
              <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => setAdding(true)} aria-label={`Novo agente no time ${team.name}`} data-testid={`add-agent-${team.id}`}>
                + Agente
              </button>
            )}
            <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => setEditing(true)} aria-label={`Editar o time ${team.name}`} data-testid={`team-edit-${team.id}`}>
              Editar
            </button>
            {!internal && (
              <button type="button" className="ui-button ui-button--danger ui-button--small" onClick={() => setConfirming(true)} aria-label={`Excluir o time ${team.name}`} data-testid={`team-delete-${team.id}`}>
                Excluir
              </button>
            )}
          </div>
        </div>
      )}
      {!internal && agents.length > 0 && <TeamLeadSelect team={team} agents={agents} />}
      {agents.length === 0 ? (
        <p className="ui-muted ui-empty">Sem agentes. Tarefas para este time precisam de pelo menos um.</p>
      ) : (
        <ul className="agent-list">
          {agents.map((agent) => (
            <li key={agent.id}>
              <button type="button" className="agent-row" onClick={() => select({ kind: "agent", id: agent.id })} data-testid={`room-agent-${agent.id}`} data-status={agent.status}>
                <span className="agent-row__face">
                  <AvatarSprite avatar={agent.avatar} seedId={agent.id} size={40} framing="head" />
                </span>
                <span className="agent-row__text">
                  <span className="agent-row__name">{agent.name}</span>
                  <span className="agent-row__role">{agent.role}</span>
                </span>
                <StatusBadge status={agent.status} label={AGENT_STATUS_LABELS[agent.status]} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding && <CreateAgentDialog teamId={team.id} onClose={() => setAdding(false)} />}
      {confirming && (
        <ConfirmDialog
          title="Excluir time"
          testId="confirm-delete-team"
          message={<DeleteTeamMessage office={office} team={team} />}
          confirmLabel="Excluir time"
          onConfirm={() => api.deleteTeam(team.id)}
          onClose={() => setConfirming(false)}
        />
      )}
    </li>
  );
}
