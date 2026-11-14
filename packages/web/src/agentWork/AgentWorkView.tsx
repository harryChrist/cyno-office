import type { OfficeState } from "@cyno/shared";
import { useMemo, type ReactNode } from "react";
import { AgentConnectorIcons } from "../connectors/ConnectorIcon";
import { ConnectorMenu } from "../connectors/ConnectorPicker";
import { AgentUsageChips } from "../ui/AgentUsageChips";
import { useOfficeStore } from "../store/officeStore";
import { AvatarSprite } from "../ui/AvatarSprite";
import { percent } from "../ui/format";
import { ProgressBar } from "../ui/widgets";
import { agentWorkStatus } from "./maestroTimeline";
import { TerminalStatusBadge } from "./TerminalStatusBadge";
import type { TimelineItem } from "./timeline";
import { Timeline, type TimelineActions, type TimelineMode } from "./Timeline";
import { useWorkPanelStore } from "./workPanelStore";
import { WorkSplit } from "./WorkSplit";
import "./agentWork.css";

/** Uma lista da tela (a principal ou a lateral). */
export type WorkStream = {
  /** Nome acessível (e título, na lateral). */
  label: string;
  items: readonly TimelineItem[];
  empty: ReactNode;
  mode?: TimelineMode;
  footer?: ReactNode;
  testId?: string;
  /** Trocar remonta a lista (volta a grudar no fim): ex.: outra tarefa ou outra thread. */
  resetKey?: string;
  /** Acima da lista (ex.: o objetivo do subagente aberto). */
  header?: ReactNode;
};

export type AgentWorkViewProps = {
  /** null enquanto o escritório carrega (o cabeçalho mostra só o nome de reserva). */
  office: OfficeState | null;
  agentId: string | undefined;
  /** Nome enquanto o agente não aparece (ex.: "Maestro"). */
  fallbackName: string;
  /** Id do título: o dialog que envolve a tela usa em `aria-labelledby`. */
  titleId?: string;
  /** Linha abaixo do nome (ex.: "Sala do Maestro · Principal"). */
  subtitle?: ReactNode;
  /** Botões à direita do cabeçalho (ex.: fechar). */
  headerActions?: ReactNode;
  /** Barra entre o cabeçalho e a linha do tempo (ex.: o agente e os subagentes dele, em abas). */
  threadBar?: ReactNode;
  /** A linha do tempo principal (o Maestro: os pedidos; um agente: o trabalho dele). */
  timeline: WorkStream;
  /**
   * Corpo pronto (no lugar da linha do tempo e da lateral): o painel do Maestro usa para ter abas
   * (Terminal / Pedidos) à esquerda e a atividade por pedido à direita, com a mesma divisória.
   */
  body?: { main: ReactNode; asideLabel: string; aside: ReactNode };
  /** Selos ao lado do estado no cabeçalho (ex.: Remote Control do Maestro). */
  headerBadges?: ReactNode;
  /** Coluna lateral opcional (ex.: "Atividade", um stream compacto); some em telas estreitas; a divisória entre as duas se arrasta. */
  aside?: WorkStream;
  /** Com lateral: chave para lembrar a largura e se está recolhida (ex.: "maestro"). */
  splitKey?: string;
  actions?: TimelineActions;
  /** Caixa de pedido embaixo (só o Maestro tem). */
  compose?: ReactNode;
  testId?: string;
};

/**
 * Tela de trabalho de um agente: quem é, o estado ao vivo e o progresso (cabeçalho), o que ele fez
 * e está fazendo (linha do tempo), um stream lateral opcional e, se for o caso, onde pedir algo.
 * O Maestro usa como a tela principal do workspace; qualquer agente pode abrir a sua.
 */
export function AgentWorkView({ office, agentId, fallbackName, titleId, subtitle, headerActions, headerBadges, threadBar, timeline, body, aside, splitKey, actions, compose, testId }: AgentWorkViewProps) {
  const main = (
    <>
      {timeline.header}
      <Timeline key={timeline.resetKey} items={timeline.items} label={timeline.label} empty={timeline.empty} mode={timeline.mode} footer={timeline.footer} actions={actions} testId={timeline.testId} />
    </>
  );
  return (
    <div className={`work-view${aside || body ? " work-view--aside" : ""}`} data-testid={testId} data-agent-id={agentId}>
      <AgentWorkHeader office={office} agentId={agentId} fallbackName={fallbackName} titleId={titleId} subtitle={subtitle} actions={headerActions} badges={headerBadges} />
      {threadBar && <div className="work-view__threads">{threadBar}</div>}
      {body ? (
        <WorkSplit splitKey={splitKey} asideLabel={body.asideLabel} main={body.main} aside={body.aside} />
      ) : aside ? (
        <WorkSplit
          splitKey={splitKey}
          asideLabel={aside.label}
          main={main}
          aside={<Timeline key={aside.resetKey} items={aside.items} label={aside.label} empty={aside.empty} mode={aside.mode ?? "terminal"} footer={aside.footer} testId={aside.testId} />}
        />
      ) : (
        <div className="work-view__body">
          <div className="work-view__main">{main}</div>
        </div>
      )}
      {compose && <div className="work-view__compose">{compose}</div>}
    </div>
  );
}

type HeaderProps = {
  badges?: ReactNode;
  office: OfficeState | null;
  agentId: string | undefined;
  fallbackName: string;
  titleId?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
};

/** Avatar, nome, estado ao vivo (com pulso quando ocupado) e o progresso do que está fazendo. */
export function AgentWorkHeader({ office, agentId, fallbackName, titleId, subtitle, actions, badges }: HeaderProps) {
  const progress = useOfficeStore((state) => state.progress);
  const agent = office && agentId ? office.agents.find((candidate) => candidate.id === agentId) : undefined;
  const status = useMemo(() => (office && agentId ? agentWorkStatus(office, agentId, progress) : null), [office, agentId, progress]);
  const busy = status && status.tone !== "neutral";

  return (
    <header className="work-head">
      <div className={`work-head__avatar${busy ? " work-head__avatar--busy" : ""}`} aria-hidden="true">
        {agent && <AvatarSprite avatar={agent.avatar} seedId={agent.id} size={62} framing="head" animate />}
      </div>
      <div className="work-head__info">
        <div className="work-head__line">
          <h2 id={titleId} className="work-head__name">
            {agent?.name ?? fallbackName}
          </h2>
          <span className={`work-status work-status--${status?.tone ?? "neutral"}`} data-testid="work-status" aria-live="polite">
            <span className="work-status__dot" aria-hidden="true" />
            {status?.label ?? "Carregando…"}
          </span>
          {status && status.active > 1 && <span className="work-head__count">{status.active} pedidos ativos</span>}
          {agentId && <AgentConnectorIcons agentId={agentId} size={16} max={6} testId="work-connectors" />}
          {badges}
        </div>
        {subtitle && <p className="work-head__sub">{subtitle}</p>}
        {/* Terminal da CLI (todos os agentes reais, inclusive o Maestro): estado e Ligar/Desligar. */}
        {agent && (
          <div className="work-head__terminal">
            <TerminalStatusBadge agent={agent} />
          </div>
        )}
        {agentId && <AgentUsageChips agentId={agentId} />}
        {status?.detail && (
          <p className="work-head__detail" data-testid="work-status-detail">
            {status.detail}
          </p>
        )}
        {status?.progress !== undefined && (
          <div className="work-head__progress">
            <ProgressBar value={status.progress} label="Progresso do pedido em foco" testId="work-progress" />
            <span className="work-head__percent">{percent(status.progress)}</span>
          </div>
        )}
      </div>
      {(actions || agent) && (
        <div className="work-head__actions">
          {/* Conectores do agente (ferramentas externas): marcar/desmarcar aqui mesmo. */}
          {agent && <ConnectorMenu agentId={agent.id} agentName={agent.name} onNavigate={() => useWorkPanelStore.getState().close()} />}
          {actions}
        </div>
      )}
    </header>
  );
}
