import { agentEngine, EFFORT_LABELS, ENGINE_LABELS, isCliEngine } from "@cyno/shared";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { agentList, type AgentListRow } from "../agentWork/agentList";
import { useWorkPanelStore } from "../agentWork/workPanelStore";
import { AgentConnectorIcons } from "../connectors/ConnectorIcon";
import { useAgentsNeedingAttention } from "../attention/agents";
import { useAgentLogStore } from "../store/agentLogStore";
import { useOfficeStore } from "../store/officeStore";
import { useTerminalsStore } from "../store/terminalsStore";
import { AccessBadges, useAgentAccess } from "../ui/AgentAccess";
import { FreebuffHourChip, useFreebuffAgentHour } from "../ui/FreebuffHour";
import { useAvailability } from "../ui/availability";
import { useSimulated } from "../ui/EngineFields";
import { AvatarSprite } from "../ui/AvatarSprite";
import { countLabel } from "../ui/format";
import { NavIcon } from "./navIcons";
import { usePopover } from "./usePopover";
import "./attention.css";

/** Motor, modelo e esforço do agente, em chips ("Claude Code" · "sonnet" · "médio"). */
function ModelChips({ agent }: { agent: AgentListRow["agent"] }) {
  const simulated = useSimulated();
  const engine = agentEngine(agent);
  const hour = useFreebuffAgentHour(agent);
  if (!isCliEngine(engine)) return <span className="agents-chip agents-chip--engine" title={simulated ? undefined : "Escolha um motor em Editar agente"}>{simulated ? "Simulado" : "Sem motor"}</span>;
  return (
    <>
      <span className={`agents-chip agents-chip--engine agents-chip--${engine}`} title="Motor">
        {ENGINE_LABELS[engine]}
      </span>
      <span className="agents-chip agents-chip--model" title={engine === "freebuff" ? "Modelo da plataforma (um só para todos os agentes de Freebuff)" : "Modelo"}>
        {engine === "freebuff" ? (hour.platformModel ?? "da plataforma") : (agent.model ?? "padrão")}
      </span>
      {engine === "freebuff" && <FreebuffHourChip agent={agent} />}
      {engine !== "freebuff" && agent.effort && (
        <span className="agents-chip" title="Esforço">
          {EFFORT_LABELS[agent.effort]}
        </span>
      )}
    </>
  );
}

/**
 * Uma linha por agente, em três níveis: nome e o estado do terminal; a função e o que faz agora;
 * motor · modelo · esforço, com acesso, conectores e "+N" subagentes.
 */
function AgentRow({ row, onOpen }: { row: AgentListRow; onOpen: (row: AgentListRow) => void }) {
  const access = useAgentAccess(row.agent);
  const cli = isCliEngine(agentEngine(row.agent));
  // O agente que precisa do dono ganha destaque (a faixa âmbar e o selo "Espera você").
  const waiting = useAgentsNeedingAttention().get(row.agent.id);
  return (
    <li>
      <button type="button" className={`agents-row${waiting ? " agents-row--attention" : ""}`} onClick={() => onOpen(row)} data-testid="agents-row" data-agent-id={row.agent.id}>
        <span className="agents-row__avatar" aria-hidden="true">
          <AvatarSprite avatar={row.agent.avatar} seedId={row.agent.id} size={40} framing="head" />
          <span className={`agents-row__dot agents-row__dot--${row.tone}`} />
        </span>
        <span className="agents-row__main">
          <span className="agents-row__line">
            <span className="agents-row__name">{row.agent.name}</span>
            <span className="sr-only">, {row.statusLabel}</span>
            <span className="agents-row__state">
              {waiting && (
                <span className="agents-row__attention" title={waiting.count > 1 ? `${waiting.count} coisas esperando você` : "Esperando você"} data-testid="agents-row-attention">
                  <NavIcon name="mao" /> Espera você
                </span>
              )}
              {row.unavailable && (
                <span className="ui-badge ui-badge--danger agents-row__unavailable" data-testid="agents-row-unavailable">
                  {row.unavailable}
                </span>
              )}
              {row.terminal && row.terminal.key !== "sem_cota" && (
                <span className="agents-row__term" data-state={row.terminal.key} title={row.terminal.detail ? `${row.terminal.label}: ${row.terminal.detail}` : row.terminal.label} data-testid="agents-row-terminal">
                  <span aria-hidden="true">{row.terminal.emoji}</span> {row.terminal.label}
                </span>
              )}
            </span>
          </span>
          <span className="agents-row__sub-line">
            <span className="agents-row__role">{row.agent.role}</span>
            {row.activity && <span className="agents-row__activity"> · {row.activity}</span>}
          </span>
          <span className="agents-row__meta">
            <ModelChips agent={row.agent} />
            <span className="agents-row__extras">
              {cli && <AccessBadges access={access} />}
              <AgentConnectorIcons agentId={row.agent.id} size={14} max={3} />
              {row.activeSubagents > 0 && (
                <span className="agents-row__sub" title={countLabel(row.activeSubagents, "subagente trabalhando", "subagentes trabalhando")}>
                  +{row.activeSubagents}
                  <span className="sr-only"> {row.activeSubagents === 1 ? "subagente" : "subagentes"}</span>
                </span>
              )}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}

/** A lista (só monta com o popover aberto). Carrega o log de quem está ocupado, para os "+N". */
function AgentListBody({ onOpen }: { onOpen: (row: AgentListRow) => void }) {
  const office = useOfficeStore((state) => state.office);
  const progress = useOfficeStore((state) => state.progress);
  const logs = useAgentLogStore((state) => state.byAgent);
  const summaries = useAgentLogStore((state) => state.summaries);
  const unavailable = useAvailability(office?.agents);
  const terminals = useTerminalsStore((state) => state.byAgent);
  const list = useMemo(() => (office ? agentList(office, logs, progress, summaries, unavailable, terminals) : null), [office, logs, progress, summaries, unavailable, terminals]);

  const busyIds = useMemo(() => office?.agents.filter((agent) => agent.status === "working" || agent.status === "waiting_approval").map((agent) => agent.id) ?? [], [office]);
  useEffect(() => {
    const store = useAgentLogStore.getState();
    for (const id of busyIds) void store.loadAgent(id);
  }, [busyIds]);

  if (!list) return <p className="agents__empty">Carregando…</p>;
  if (list.total === 0) return <p className="agents__empty">Nenhum agente neste workspace.</p>;
  return (
    <div className="agents__groups">
      {list.maestro && (
        <section className="agents__group" aria-label="Maestro">
          <ul className="agents__list">
            <AgentRow row={list.maestro} onOpen={onOpen} />
          </ul>
        </section>
      )}
      {list.rooms.map((room) => {
        const titleId = `agents-room-${room.key}`;
        return (
          <section key={room.key} className="agents__room" aria-labelledby={titleId}>
            <h3 id={titleId} className="agents__room-title">
              {room.roomName}
            </h3>
            {room.teams.map((team) => (
              <div key={team.key} className="agents__team" role="group" aria-label={`Time ${team.teamName}${team.leadName ? `, líder ${team.leadName}` : ""}`}>
                <p className="agents__team-label" aria-hidden="true">
                  <span>{team.teamName}</span>
                  {team.leadName && <span className="agents__team-lead">líder {team.leadName}</span>}
                </p>
                <ul className="agents__list">
                  {team.rows.map((row) => (
                    <AgentRow key={row.agent.id} row={row} onOpen={onOpen} />
                  ))}
                </ul>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

/** Contagens da pílula de status (barra de cima e entrada "Agentes" da barra lateral). */
export function useAgentsSummary() {
  const socket = useOfficeStore((state) => state.socket);
  const rooms = useOfficeStore((state) => state.office?.rooms.length ?? 0);
  const teams = useOfficeStore((state) => state.office?.teams.length ?? 0);
  const agents = useOfficeStore((state) => state.office?.agents.length ?? 0);
  const working = useOfficeStore((state) => state.office?.agents.filter((agent) => agent.status === "working").length ?? 0);
  return { live: socket === "open", rooms, teams, agents, working };
}

/** Abre a tela de trabalho de quem foi escolhido na lista (o Maestro ou um agente). */
function openWorkPanel(row: AgentListRow): void {
  const panel = useWorkPanelStore.getState();
  if (row.isMaestro) panel.openMaestro();
  else panel.openAgent(row.agent.id);
}

/**
 * Conteúdo da lista de agentes (cabeçalho, grupos por quarto e time, rodapé): o popover da pílula
 * e o painel que abre ao lado da barra lateral mostram o mesmo.
 */
export function AgentsContent({ onClose, titleId }: { onClose: () => void; titleId?: string }) {
  const { agents, working } = useAgentsSummary();
  const openRow = (row: AgentListRow) => {
    onClose();
    openWorkPanel(row);
  };
  return (
    <>
      <header className="agents__head">
        <h2 className="agents__title" id={titleId}>
          Agentes
        </h2>
        <span className="agents__summary ui-tabular">
          {countLabel(agents, "agente", "agentes")} · {working} trabalhando
        </span>
      </header>
      <div className="agents__body">
        <AgentListBody onOpen={openRow} />
      </div>
      <footer className="agents__foot">Escolha um agente para ver o trabalho dele ao vivo.</footer>
    </>
  );
}

/**
 * Pílula "● N agentes · M trabalhando" (o ponto pulsa com gente trabalhando e mostra a conexão).
 * Clicar abre a lista de agentes do workspace; escolher um abre a tela de trabalho dele. O uso da
 * assinatura fica no bloco "Uso do plano" do menu lateral (NavUsage) e no painel dele (UsagePanel).
 */
export function StatusPill() {
  const { live, rooms, teams, agents, working } = useAgentsSummary();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const close = useCallback(() => setOpen(false), []);
  usePopover(open, close, rootRef, buttonRef);

  return (
    <div className="agents" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`status-pill${live ? "" : " status-pill--offline"}${working > 0 && live ? " status-pill--busy" : ""}`}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => setOpen((on) => !on)}
        data-testid="hud-status"
      >
        <span className="status-pill__dot" aria-hidden="true" />
        <span className="sr-only">Agentes do escritório: </span>
        <span className="sr-only" data-testid="hud-rooms">
          {countLabel(rooms, "sala", "salas")}
        </span>
        <span className="sr-only">, </span>
        <span className="sr-only" data-testid="hud-teams">
          {countLabel(teams, "time", "times")}
        </span>
        <span className="sr-only">, </span>
        <span className="status-pill__text ui-tabular">
          <span data-testid="hud-agents">{countLabel(agents, "agente", "agentes")}</span>
          <span className="status-pill__sep" aria-hidden="true">
            ·
          </span>
          <span className="sr-only">, </span>
          <span className="status-pill__working" data-testid="hud-working">
            {working} trabalhando
          </span>
        </span>
      </button>
      {open && (
        <section id={popoverId} className="agents__popover" aria-label="Agentes do workspace" data-testid="agents-popover">
          <AgentsContent onClose={close} />
        </section>
      )}
    </div>
  );
}
