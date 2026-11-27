import type { OfficeState } from "@cyno/shared";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ProjectLink } from "../pages/work/ProjectLink";
import { AvatarSprite } from "../ui/AvatarSprite";
import type { ActivityGroup, ActivityStep, ActivityStepKind } from "./maestroActivityView";
import { clockLabel } from "./timelineView";
import type { TimelineActions } from "./Timeline";

/** Ícone curto de cada tipo de passo (texto, para ficar nítido em qualquer tela). */
const KIND_ICON: Record<ActivityStepKind, string> = {
  received: "↳",
  tool: "⌕",
  delegation: "→",
  approval: "?",
  decision: "✓",
  note: "·",
  waiting: "…",
  resumed: "↻",
  result: "✓",
  failure: "!",
};

const STICK_PX = 64;

function Step({ step, office, now, actions }: { step: ActivityStep; office: OfficeState | null; now: Date; actions: TimelineActions }) {
  const agent = step.agentId && office ? office.agents.find((candidate) => candidate.id === step.agentId) : undefined;
  return (
    <li className={`mact-step mact-step--${step.tone}`} data-kind={step.kind} data-testid="maestro-activity-step">
      <time className="mact-step__time" dateTime={step.at}>
        {clockLabel(step.at, now)}
      </time>
      <span className="mact-step__icon" aria-hidden="true">
        {KIND_ICON[step.kind]}
      </span>
      <div className="mact-step__body">
        <p className="mact-step__label">
          {step.label}
          {step.count && step.count > 1 && <span className="mact-step__count">×{step.count}</span>}
        </p>
        {step.detail && <p className={`mact-step__detail${step.kind === "result" ? " mact-step__detail--result" : ""}`}>{step.detail}</p>}
      </div>
      {agent && (
        <button type="button" className="mact-step__agent" onClick={() => actions.onOpenAgent?.(agent.id)} title={`Ver o trabalho de ${agent.name}`} data-testid="maestro-activity-agent">
          <span className="mact-step__avatar" aria-hidden="true">
            <AvatarSprite avatar={agent.avatar} seedId={agent.id} size={24} framing="head" />
          </span>
          <span className="mact-step__agent-name">{agent.name}</span>
        </button>
      )}
    </li>
  );
}

/** Troca de conversa (sem pedido): leve e fechada; abre para ver o que o Maestro fez no turno. */
function ChatGroup({ group, office, now, actions }: { group: ActivityGroup; office: OfficeState | null; now: Date; actions: TimelineActions }) {
  const work = group.steps.filter((step) => !(step.kind === "result" && step.label === "Respondeu"));
  return (
    <details className="mact-chat" data-testid="maestro-activity-chat" data-tone={group.tone}>
      <summary className="mact-chat__head">
        <span className="mact-chat__tag">conversa</span>
        <span className="mact-chat__said" title={group.prompt}>
          {group.prompt}
        </span>
        {group.fromTerminal && <span className="mact-chip">pelo terminal</span>}
        {group.tone !== "neutral" && <span className={`ui-badge ui-badge--${group.tone}`}>{group.stageLabel}</span>}
        <time className="mact-group__time" dateTime={group.at}>
          {clockLabel(group.at, now)}
        </time>
      </summary>
      {group.reply && <p className="mact-chat__reply">{group.reply}</p>}
      {work.length > 0 && (
        <ol className="mact-steps">
          {work.map((step) => (
            <Step key={step.id} step={step} office={office} now={now} actions={actions} />
          ))}
        </ol>
      )}
    </details>
  );
}

function Group({ group, office, now, actions }: { group: ActivityGroup; office: OfficeState | null; now: Date; actions: TimelineActions }) {
  if (group.kind === "conversa") return <ChatGroup group={group} office={office} now={now} actions={actions} />;
  return (
    <section className="mact-group" data-testid="maestro-activity-group" data-task-id={group.taskId}>
      <header className="mact-group__head">
        <p className="mact-group__prompt" title={group.prompt}>
          {group.prompt.split("\n")[0]}
        </p>
        <div className="mact-group__meta">
          {group.fromTerminal && <span className="mact-chip">pelo terminal</span>}
          {group.fromChat && <span className="mact-chip">da conversa</span>}
          <ProjectLink requestId={group.taskId} />
          <span className={`ui-badge ui-badge--${group.tone}`}>{group.stageLabel}</span>
          <time className="mact-group__time" dateTime={group.at}>
            {clockLabel(group.at, now)}
          </time>
          {actions.onOpenTask && (
            <button type="button" className="mact-group__open" onClick={() => actions.onOpenTask!(group.taskId)} aria-label="Abrir em Projetos e tarefas" title="Abrir em Projetos e tarefas">
              ↗
            </button>
          )}
        </div>
      </header>
      {group.steps.length > 0 ? (
        <ol className="mact-steps">
          {group.steps.map((step) => (
            <Step key={step.id} step={step} office={office} now={now} actions={actions} />
          ))}
        </ol>
      ) : (
        <p className="mact-group__empty">Sem passos registrados.</p>
      )}
    </section>
  );
}

/**
 * Atividade do Maestro: cada pedido com o seu selo de estado e os passos em linguagem de gente
 * (consultou a equipe, delegou para fulano com o porquê, pediu aprovação, respondeu); as trocas de
 * conversa ficam leves e fechadas entre eles. Gruda no fim enquanto o usuário não sobe a lista.
 */
export function MaestroActivity({ groups, office, actions, empty }: { groups: readonly ActivityGroup[]; office: OfficeState | null; actions: TimelineActions; empty: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [now] = useState(() => new Date());
  useLayoutEffect(() => {
    const scroller = ref.current;
    if (scroller && stick.current) scroller.scrollTop = scroller.scrollHeight;
  });
  const onScroll = () => {
    const scroller = ref.current;
    if (scroller) stick.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_PX;
  };
  return (
    <div ref={ref} className="mact" onScroll={onScroll} tabIndex={0} role="region" aria-label="Atividade do Maestro: pedidos e conversa" data-testid="maestro-activity">
      {groups.length === 0 ? <div className="mact__empty">{empty}</div> : groups.map((group) => <Group key={group.taskId} group={group} office={office} now={now} actions={actions} />)}
    </div>
  );
}
