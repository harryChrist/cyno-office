import { THEMES, agentEngine, describeModelChoice, effectiveAccess, isCliEngine, isMaestroAgent, isRoomThemeId, type OfficeState } from "@cyno/shared";
import { useMemo, useState } from "react";
import { api } from "../api/client";
import { useWorkPanelStore } from "../agentWork/workPanelStore";
import { AgentHas } from "../connectors/AgentHas";
import { ConnectorPicker } from "../connectors/ConnectorPicker";
import { AgentSkills } from "./AgentSkills";
import { useSocialDoAgente } from "../cena/useSocialDoAgente";
import { useOfficeStore } from "../store/officeStore";
import { useViewStore } from "../store/viewStore";
import { accessLabel, useWorkspaceAccess } from "./AgentAccess";
import { AvatarSprite } from "./AvatarSprite";
import { AgentUsageChips } from "./AgentUsageChips";
import { AgentForm } from "./EntityForms";
import { agentPatch, agentValues, isEmptyPatch, type AgentFormValues } from "./formModels";
import { AGENT_STATUS_LABELS, countLabel } from "./format";
import { useWidePanel } from "./panelWidth";
import { agentTasks, currentWork, findAgentDetails, type AgentDetails } from "./selectors";
import { MaestroCoordination } from "./MaestroCoordination";
import { CurrentTask, TaskHistoryItem } from "./TaskViews";
import { UnavailableBadge } from "./UnavailableBadge";
import { FreebuffHourChip, useFreebuffAgentHour } from "./FreebuffHour";
import { ConfirmDialog, StatusBadge } from "./widgets";

const HISTORY_PAGE = 20;

/**
 * Editar o agente: o mesmo formulário da janela "Novo agente". Enquanto está aberto, o painel
 * lateral alarga. Com tarefas ativas, time e motor ficam travados.
 */
function AgentEditForm({ office, details, busy, onDone }: { office: OfficeState; details: AgentDetails; busy: boolean; onDone: () => void }) {
  const { agent } = details;
  const [initial] = useState(() => agentValues(agent));
  useWidePanel(true);
  const submit = async (values: AgentFormValues) => {
    const patch = agentPatch(initial, values);
    if (!isEmptyPatch(patch)) await api.updateAgent(agent.id, patch);
    onDone();
  };
  return (
    <section className="panel-section" aria-labelledby="agent-edit-title">
      <h3 id="agent-edit-title" className="panel-section__title">
        Editar agente
      </h3>
      <AgentForm
        mode="edit"
        initial={initial}
        office={office}
        locked={busy}
        teamFixed={isMaestroAgent(office, agent)}
        label={`Editar ${agent.name}`}
        onSubmit={submit}
        onCancel={onDone}
        testId="agent-edit-form"
        submitTestId="agent-edit-save"
      />
    </section>
  );
}

function AgentHistory({ office, agentId }: { office: OfficeState; agentId: string }) {
  const tasks = useMemo(() => agentTasks(office.tasks, agentId), [office.tasks, agentId]);
  const [limit, setLimit] = useState(HISTORY_PAGE);
  return (
    <section className="panel-section" aria-labelledby="agent-history-title">
      <h3 id="agent-history-title" className="panel-section__title">
        Histórico <span className="ui-muted">({tasks.length})</span>
      </h3>
      {tasks.length === 0 ? (
        <p className="ui-muted ui-empty">Nenhuma tarefa ainda. Envie uma pela caixa de tarefa.</p>
      ) : (
        <ol className="history" data-testid="agent-history">
          {tasks.slice(0, limit).map((task) => (
            <TaskHistoryItem key={task.id} task={task} />
          ))}
        </ol>
      )}
      {tasks.length > limit && (
        <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => setLimit((n) => n + HISTORY_PAGE)}>
          Mostrar mais ({tasks.length - limit})
        </button>
      )}
    </section>
  );
}

/**
 * Painel do agente: avatar grande, dados, tarefa atual com progresso/aprovação e histórico.
 * "Ver trabalho" abre a tela de trabalho dele (o log ao vivo, com os subagentes).
 */
export function AgentPanel({ office, agentId }: { office: OfficeState; agentId: string }) {
  const details = findAgentDetails(office, agentId);
  const progress = useOfficeStore((state) => state.progress);
  const select = useViewStore((state) => state.select);
  const showAgent = useViewStore((state) => state.showAgent);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const workspaceAccess = useWorkspaceAccess();
  const social = useSocialDoAgente(agentId);
  const freebuffHour = useFreebuffAgentHour(details?.agent);

  if (!details) {
    return <p className="ui-muted ui-empty">Este agente não existe mais (ou ainda está chegando).</p>;
  }
  const { agent, team, room } = details;
  const access = effectiveAccess(workspaceAccess, agent);
  const work = currentWork(office.tasks, agent.id);
  const theme = room && isRoomThemeId(room.theme) ? THEMES[room.theme] : THEMES.lobby;

  return (
    <div className="agent-panel" data-testid="agent-panel" data-agent-id={agent.id}>
      <div className="agent-hero">
        <div
          className="avatar-stage avatar-stage--room"
          style={{ ["--stage-wall" as string]: `var(--p-${theme.wall})`, ["--stage-floor-a" as string]: `var(--p-${theme.floorA})`, ["--stage-floor-b" as string]: `var(--p-${theme.floorB})` }}
        >
          <AvatarSprite avatar={agent.avatar} seedId={agent.id} maestro={isMaestroAgent(office, agent)} scale={4} testId="agent-avatar" />
        </div>
        <div className="agent-hero__info">
          <h2 className="panel-title" data-testid="agent-name">
            {agent.name}
          </h2>
          <p className="agent-hero__role" data-testid="agent-role">
            {agent.role}
          </p>
          <StatusBadge status={agent.status} label={AGENT_STATUS_LABELS[agent.status]} testId="agent-status" />
          <UnavailableBadge agent={agent} />
          {agentEngine(agent) === "freebuff" && <FreebuffHourChip agent={agent} />}
          <dl className="agent-hero__meta">
            <dt>Modelo</dt>
            <dd data-testid="agent-model">
              {agentEngine(agent) === "freebuff"
                ? `Freebuff · ${freebuffHour.platformModel ?? "modelo da plataforma"}${freebuffHour.label ? ` · ${freebuffHour.label}` : ""}`
                : describeModelChoice({ engine: agentEngine(agent), model: agent.model, effort: agent.effort })}
            </dd>
            {isCliEngine(agentEngine(agent)) && (
              <>
                <dt>Acesso</dt>
                <dd data-testid="agent-access">{accessLabel(access)}</dd>
              </>
            )}
            <dt>Time</dt>
            <dd data-testid="agent-team">{team?.name ?? "—"}</dd>
            <dt>Sala</dt>
            <dd>
              {room ? (
                <button type="button" className="ui-link" onClick={() => select({ kind: "room", id: room.id })} data-testid="agent-room">
                  {room.name}
                </button>
              ) : (
                "—"
              )}
            </dd>
            {social && (
              <>
                <dt>Moedinhas</dt>
                <dd data-testid="agent-coins" title="Moedinhas da cena: tarefa concluída, pedido atendido e entrega de subagente rendem; só enfeite, nada se compra.">
                  🪙 {social.coins}
                </dd>
                {social.doing && (
                  <>
                    <dt>Agora</dt>
                    <dd data-testid="agent-doing">{social.doing}</dd>
                  </>
                )}
              </>
            )}
          </dl>
        </div>
      </div>

      <AgentUsageChips agentId={agent.id} />

      <div className="ui-actions ui-actions--start">
        <button type="button" className="ui-button ui-button--small" onClick={() => useWorkPanelStore.getState().openAgent(agent.id)} aria-haspopup={isMaestroAgent(office, agent) ? undefined : "dialog"} data-testid="agent-open-work">
          Ver trabalho
        </button>
        <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={!room} onClick={() => room && showAgent(agent.id, room.id)} data-testid="agent-show-on-map">
          Ver no mapa
        </button>
        <button type="button" className="ui-button ui-button--secondary ui-button--small" aria-pressed={editing} onClick={() => setEditing((on) => !on)} data-testid="agent-edit">
          Editar
        </button>
        {!isMaestroAgent(office, agent) && (
          <button type="button" className="ui-button ui-button--danger ui-button--small" onClick={() => setConfirming(true)} data-testid="agent-delete">
            Excluir
          </button>
        )}
      </div>

      {editing ? (
        <AgentEditForm key={agent.id} office={office} details={details} busy={work.task !== null} onDone={() => setEditing(false)} />
      ) : (
        <section className="panel-section" aria-labelledby="agent-instructions-title">
          <h3 id="agent-instructions-title" className="panel-section__title">
            Instruções
          </h3>
          <p className={`agent-instructions${agent.instructions ? "" : " ui-muted ui-empty"}`} data-testid="agent-instructions">
            {agent.instructions || "Sem instruções."}
          </p>
        </section>
      )}

      {isMaestroAgent(office, agent) ? (
        <MaestroCoordination office={office} maestroId={agent.id} />
      ) : (
        <section className="panel-section" aria-labelledby="agent-current-title">
          <h3 id="agent-current-title" className="panel-section__title">
            Tarefa atual
          </h3>
          {work.task ? (
            <CurrentTask task={work.task} progress={progress[work.task.id]} queued={work.queued} />
          ) : (
            <p className="ui-muted ui-empty" data-testid="agent-no-task">
              Livre. Os pedidos chegam pelo Maestro.
            </p>
          )}
        </section>
      )}

      <section className="panel-section" aria-labelledby="agent-tools-title" data-testid="agent-connectors">
        <h3 id="agent-tools-title" className="panel-section__title">
          O que este agente tem
        </h3>
        <h4 className="agent-tools__sub">Conectores (MCP)</h4>
        <AgentHas agentId={agent.id} />
        <p className="ui-muted agent-connectors__hint">
          {isMaestroAgent(office, agent)
            ? "Entregue ao Maestro o que a Biblioteca liberou a este workspace (ele pode ter vários)."
            : "Entregue a este agente o que a Biblioteca liberou a este workspace. Um agente focado fica só com o conector do sistema dele."}
        </p>
        <ConnectorPicker agentId={agent.id} agentName={agent.name} />
        <h4 className="agent-tools__sub">Skills</h4>
        <AgentSkills agentId={agent.id} />
      </section>

      <AgentHistory office={office} agentId={agent.id} />

      {confirming && (
        <ConfirmDialog
          title="Excluir agente"
          testId="confirm-delete-agent"
          message={
            <p>
              Excluir <strong>{agent.name}</strong>? {work.task ? `${countLabel(work.queued + 1, "tarefa ativa será cancelada", "tarefas ativas serão canceladas")}. ` : ""}
              Isso não pode ser desfeito.
            </p>
          }
          confirmLabel="Excluir agente"
          onConfirm={async () => {
            await api.deleteAgent(agent.id);
            select(null);
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
