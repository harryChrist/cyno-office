import { agentEngine, describeModelChoice, findMaestroAgent, isCliEngine, MAESTRO } from "@cyno/shared";
import { useEffect, useId, useMemo, type ReactNode } from "react";
import { useAgentLogStore } from "../store/agentLogStore";
import { useNavStore } from "../store/navStore";
import { useOfficeStore } from "../store/officeStore";
import { useTaskFocus } from "../store/taskFocus";
import { useTerminalsStore } from "../store/terminalsStore";
import { useViewStore } from "../store/viewStore";
import { currentWorkspaceName, useWorkspaceStore } from "../store/workspaceStore";
import { AvatarSprite } from "../ui/AvatarSprite";
import { useSimulated } from "../ui/EngineFields";
import { countLabel, percent, truncate } from "../ui/format";
import { MaestroActivity } from "./MaestroActivity";
import { maestroActivityGroups } from "./maestroActivity";
import { MaestroChat } from "./MaestroChat";
import { awaitingReply, maestroChatItems } from "./maestroChat";
import { MaestroTerminal } from "./MaestroTerminal";
import { agentWorkStatus, maestroOf, maestroRequests } from "./maestroTimeline";
import { RemoteSessionName } from "./RemoteSessionName";
import { TerminalStatusBadge } from "./TerminalStatusBadge";
import { activeRequests, currentMaestroTab, maestroTabs } from "./maestroTabs";
import { Timeline, type TimelineActions } from "./Timeline";
import { useWorkPanelStore, type MaestroTab } from "./workPanelStore";
import "./agentWork.css";
import "./maestroPanel.css";

const TAB_LABELS: Record<MaestroTab, string> = { conversa: "Conversa", pedidos: "Pedidos", atividade: "Atividade", terminal: "Terminal" };

/** Quantos pedidos em andamento o resumo do cabeçalho mostra (o resto vira "+N"). */
const ACTIVE_SHOWN = 3;

function ChevronDown() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="work-empty">
      <p className="work-empty__title">{title}</p>
      <p className="work-empty__text">{children}</p>
    </div>
  );
}

/**
 * Painel do Maestro acoplado à caixa "Fale com o Maestro" (a caixa cresce para cima e vira o
 * rodapé dele): quem é e como está (terminal, motor, Remote Control), os pedidos em andamento e,
 * em abas, a conversa, os pedidos, a atividade e o terminal. Faz parte da página: sem fundo
 * escurecido, o escritório continua à vista e clicável. Quem abre e recolhe é a TaskBox.
 */
export function MaestroPanel({ id, onCollapse }: { id: string; onCollapse: () => void }) {
  const titleId = useId();
  const office = useOfficeStore((state) => state.office);
  const progress = useOfficeStore((state) => state.progress);
  const workspaceId = useNavStore((state) => state.workspaceId);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const workspaceName = currentWorkspaceName(workspaces, workspaceId);
  const workspace = workspaces?.find((candidate) => candidate.id === workspaceId);
  const maestro = useMemo(() => maestroOf(office), [office]);
  const maestroId = maestro?.id;
  const maestroAgent = useMemo(() => (office ? findMaestroAgent(office) : undefined), [office]);

  const history = useMemo(() => (office && maestroId ? maestroRequests(office, maestroId, progress) : { items: [], total: 0 }), [office, maestroId, progress]);
  const active = useMemo(() => activeRequests(history.items), [history.items]);
  const status = useMemo(() => (office && maestroId ? agentWorkStatus(office, maestroId, progress) : null), [office, maestroId, progress]);
  const generation = useAgentLogStore((state) => state.generation);
  const log = useAgentLogStore((state) => (maestroId ? state.byAgent[maestroId] : undefined));
  const terminalInfo = useTerminalsStore((state) => (maestroId ? state.byAgent[maestroId] : undefined));

  const hasTerminal = terminalInfo?.mode === "pty";
  const conversational = maestroAgent !== undefined && isCliEngine(agentEngine(maestroAgent));
  const simulated = useSimulated();
  const mode = hasTerminal ? "terminal" : conversational ? "conversa" : "simulado";
  const { tabs } = maestroTabs(mode);
  const chosenTab = useWorkPanelStore((state) => state.maestroTab);
  const setTab = useWorkPanelStore((state) => state.setMaestroTab);
  const tab = currentMaestroTab(chosenTab, mode);
  const tabIds = { conversa: useId(), pedidos: useId(), atividade: useId(), terminal: useId() };
  const paneIds = { conversa: useId(), pedidos: useId(), atividade: useId(), terminal: useId() };

  // O log de trabalho de verdade do Maestro (e de novo a cada reconexão).
  useEffect(() => {
    if (maestroId) void useAgentLogStore.getState().loadAgent(maestroId);
  }, [maestroId, generation]);
  const groups = useMemo(() => (office && log ? maestroActivityGroups(log, office, progress) : []), [log, office, progress]);
  const chat = useMemo(() => (office && maestroId && mode === "conversa" ? maestroChatItems(log ?? [], office, maestroId, progress) : []), [log, office, maestroId, progress, mode]);
  const thinking = awaitingReply(chat, maestroAgent?.status === "working");

  const collapse = () => useWorkPanelStore.getState().collapseMaestro();
  const actions: TimelineActions = {
    onOpenTask(taskId) {
      collapse();
      useTaskFocus.getState().open(taskId);
    },
    onShowAgent(agentId, roomId) {
      collapse();
      const view = useViewStore.getState();
      view.select({ kind: "agent", id: agentId });
      view.showAgent(agentId, roomId);
    },
    onOpenAgent(agentId) {
      // A tela do agente abre por cima (dialog); o painel do Maestro fica onde está.
      useWorkPanelStore.getState().openAgent(agentId);
    },
  };
  const seeAll = () => {
    collapse();
    useNavStore.getState().go("trabalho");
  };

  const shown = history.items.length;
  const footer =
    history.total > 0 ? (
      <p className="work-footnote">
        {history.total > shown ? `Os ${shown} pedidos mais recentes de ${history.total}.` : countLabel(history.total, "pedido", "pedidos")}{" "}
        <button type="button" className="ui-link" onClick={seeAll} data-testid="maestro-see-all">
          Ver todos em Projetos e tarefas
        </button>
      </p>
    ) : null;
  const requests = (
    <Timeline
      items={history.items}
      label="Pedidos ao Maestro"
      actions={actions}
      testId="maestro-history"
      footer={footer}
      empty={
        <Empty title="Nenhum pedido ainda.">
          {conversational
            ? "Converse com o Maestro: quando for para fazer algo, ele abre o pedido, escolhe o time, explica por quê e acompanha até a entrega."
            : "Diga o que você precisa na caixa aqui embaixo. O Maestro escolhe o time, explica por quê e acompanha até a entrega."}
        </Empty>
      }
    />
  );
  const pane = (which: MaestroTab, content: ReactNode) =>
    tabs.includes(which) && (
      <div key={which} id={paneIds[which]} className="maestro-pane mdock__pane" role="tabpanel" aria-labelledby={tabIds[which]} hidden={tab !== which} data-testid={`maestro-pane-${which}`}>
        {content}
      </div>
    );

  const model = maestroAgent ? describeModelChoice({ engine: agentEngine(maestroAgent), model: maestroAgent.model, effort: maestroAgent.effort }) : null;
  const extra = active.length - ACTIVE_SHOWN;

  return (
    <section id={id} className="mdock" aria-labelledby={titleId} data-testid="maestro-panel" data-agent-id={maestroId} data-tab={tab}>
      <header className="mdock__head">
        <div className={`mdock__avatar${status && status.tone !== "neutral" ? " mdock__avatar--busy" : ""}`} aria-hidden="true">
          {maestroAgent && <AvatarSprite avatar={maestroAgent.avatar} seedId={maestroAgent.id} maestro size={40} framing="head" animate />}
        </div>
        <div className="mdock__who">
          <div className="mdock__line">
            <h2 id={titleId} className="mdock__name">
              {maestroAgent?.name ?? MAESTRO.agentName}
            </h2>
            <span className={`work-status work-status--${status?.tone ?? "neutral"}`} data-testid="work-status" aria-live="polite">
              <span className="work-status__dot" aria-hidden="true" />
              {status?.label ?? "Carregando…"}
            </span>
            {workspaceName && <span className="mdock__where">{workspaceName}</span>}
          </div>
          <div className="mdock__meta">
            {model && (
              <span className="mdock__model" title="Motor · modelo · esforço" data-testid="maestro-model">
                {model}
              </span>
            )}
            {maestroAgent && <TerminalStatusBadge agent={maestroAgent} />}
            <RemoteSessionName info={terminalInfo} workspace={workspace} />
          </div>
        </div>
        <button type="button" className="ui-icon-button mdock__collapse" aria-label="Recolher o painel do Maestro" title="Recolher (Esc)" onClick={onCollapse} data-testid="maestro-collapse">
          <ChevronDown />
        </button>
      </header>

      {active.length > 0 && (
        <div className="mdock__active" data-testid="maestro-active">
          <span className="mdock__active-label">Em andamento</span>
          <ul className="mdock__active-list">
            {active.slice(0, ACTIVE_SHOWN).map((item) => (
              <li key={item.id}>
                <button type="button" className={`mdock__req mdock__req--${item.tone}`} onClick={() => actions.onOpenTask?.(item.id)} title={`${item.prompt}\n${item.stageLabel}${item.team ? ` · time ${item.team.name}` : ""}`} data-testid="maestro-active-request">
                  <span className="mdock__req-dot" aria-hidden="true" />
                  <span className="mdock__req-text">{truncate(item.prompt.split("\n")[0] ?? item.prompt, 48)}</span>
                  <span className="mdock__req-stage">
                    {item.stageLabel}
                    {item.team ? ` · ${item.team.name}` : ""}
                    {item.progress ? ` · ${percent(item.progress.value)}` : ""}
                  </span>
                </button>
              </li>
            ))}
            {extra > 0 && <li className="mdock__active-more">+{extra}</li>}
          </ul>
        </div>
      )}

      <div className="maestro-tabs mdock__tabs" role="tablist" aria-label="Maestro">
        {tabs.map((which) => (
          <button
            key={which}
            id={tabIds[which]}
            type="button"
            role="tab"
            aria-selected={tab === which}
            aria-controls={paneIds[which]}
            tabIndex={tab === which ? 0 : -1}
            className={`maestro-tab${tab === which ? " maestro-tab--active" : ""}`}
            onClick={() => setTab(which)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
              event.preventDefault();
              const next = tabs[(tabs.indexOf(which) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]!;
              setTab(next);
              document.getElementById(tabIds[next])?.focus();
            }}
            data-testid={`maestro-tab-${which}`}
          >
            {TAB_LABELS[which]}
            {which === "pedidos" && history.total > 0 && <span className="maestro-tab__count">{history.total}</span>}
            {which === "conversa" && mode === "simulado" && history.total > 0 && <span className="maestro-tab__count">{history.total}</span>}
          </button>
        ))}
      </div>

      <div className="mdock__body">
        {pane(
          "conversa",
          mode === "conversa" ? (
            <MaestroChat
              items={chat}
              thinking={thinking}
              onOpenTask={actions.onOpenTask}
              empty={<Empty title="Converse com o Maestro.">Pense em voz alta, tire dúvidas, planeje. Quando for para fazer algo, ele pergunta o que faltar, abre o pedido e passa para o time.</Empty>}
            />
          ) : (
            requests
          ),
        )}
        {mode !== "simulado" && pane("pedidos", requests)}
        {pane(
          "atividade",
          <MaestroActivity
            groups={groups}
            office={office}
            actions={actions}
            empty={<p className="work-empty__text">Sem atividade ainda. Cada pedido aparece aqui com o que o Maestro fez (consultou a equipe, delegou, pediu aprovação, respondeu); a conversa fica em trocas leves entre eles.</p>}
          />,
        )}
        {pane(
          "terminal",
          hasTerminal && workspaceId ? (
            <MaestroTerminal workspaceId={workspaceId} visible={tab === "terminal"} />
          ) : (
            <Empty title={mode === "simulado" ? (simulated ? "O Maestro simulado não tem terminal." : "O Maestro está sem motor.") : "Este Maestro conversa sem terminal interativo."}>
              {mode === "simulado"
                ? !simulated
                  ? "Escolha o Claude Code ou o Antigravity como motor do Maestro em Configurações › Modelos padrão (ou em Editar agente) para ele voltar a trabalhar."
                  : "Com o Claude Code como motor do Maestro, o terminal dele aparece aqui ao vivo: dá para ler, digitar e acompanhar pelo Remote Control."
                : "Só o Maestro com o Claude Code interativo tem um terminal para acompanhar aqui. A conversa e os pedidos ficam nas outras abas."}
            </Empty>
          ),
        )}
      </div>
    </section>
  );
}
