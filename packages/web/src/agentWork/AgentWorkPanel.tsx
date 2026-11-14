import { deliveriesOf, isConversationLogId, type AgentLogEntry, type AgentLogThread } from "@cyno/shared";
import { useCallback, useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { entriesOfThread, liveSummary, MAIN_THREAD, threadsOf } from "../store/agentLog";
import { livePhrase } from "../store/agentLog";
import { useAgentLogStore } from "../store/agentLogStore";
import { latestChatStatus, useChatStatusStore } from "../store/chatStatusStore";
import { useMediaStore } from "../store/mediaStore";
import { useNavStore } from "../store/navStore";
import { useOfficeStore } from "../store/officeStore";
import { useTaskFocus } from "../store/taskFocus";
import { useTerminalsStore } from "../store/terminalsStore";
import { useViewStore } from "../store/viewStore";
import { countLabel, truncate } from "../ui/format";
import { findAgentDetails } from "../ui/selectors";
import { useModalDialog } from "../ui/widgets";
import { agentChatItems, agentReplying } from "./agentChat";
import { AgentChatList, AgentCompose } from "./AgentChatPane";
import { AgentDeliveries } from "./AgentDeliveries";
import { engineLabel, entriesToSteps } from "./agentLogTimeline";
import { AgentTerminalView } from "./AgentTerminalView";
import { defaultTaskId, taskOptions, type TaskOption } from "./agentWorkModel";
import { AgentWorkView } from "./AgentWorkView";
import { Timeline, type TimelineActions, type TimelineMode } from "./Timeline";
import { useWorkPanelStore } from "./workPanelStore";

const NO_ENTRIES: readonly AgentLogEntry[] = [];
const MODE_KEY = "agent-office:work-mode";

/** Abas do lado esquerdo: o terminal (só leitura, tudo o que o agente fez) e a atividade estruturada por tarefa. */
type MainTab = "terminal" | "atividade" | "entregas" | "conversa";
const TAB_LABELS: Record<MainTab, string> = { terminal: "Terminal", atividade: "Atividade", entregas: "Entregas", conversa: "Conversa" };
const TAB_NOTES: Record<MainTab, string> = { terminal: "Todas as tarefas e conversas", atividade: "Por tarefa e subagente", entregas: "O fim de cada pedido", conversa: "Fale direto com o agente" };

/** Relógio de 15 em 15 s (o "respondendo…" expira sem evento nenhum). */
function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** Cartões ou terminal: lembrado neste navegador (só conveniência; sem storage, volta a "cartões"). */
function useWorkMode(): [TimelineMode, (mode: TimelineMode) => void] {
  const [mode, setMode] = useState<TimelineMode>(() => {
    try {
      return window.localStorage.getItem(MODE_KEY) === "terminal" ? "terminal" : "cards";
    } catch {
      return "cards";
    }
  });
  const change = (next: TimelineMode) => {
    setMode(next);
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      // Sem storage (aba privada, bloqueado): só não lembra.
    }
  };
  return [mode, change];
}

/** Abas: o próprio agente ("Principal") e cada subagente, com o estado dele. Setas trocam de aba. */
function ThreadTabs({ threads, active, onChange, mainCount }: { threads: readonly AgentLogThread[]; active: string; onChange: (id: string) => void; mainCount: number }) {
  const ids = [MAIN_THREAD, ...threads.map((thread) => thread.id)];
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = ids[(ids.indexOf(active) + (event.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length]!;
    onChange(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-thread="${CSS.escape(next)}"]`)?.focus();
  };
  return (
    <div className="work-tabs" role="tablist" aria-label="Agente e subagentes" onKeyDown={onKeyDown} data-testid="work-threads">
      <button
        type="button"
        role="tab"
        className="work-tabs__tab"
        aria-selected={active === MAIN_THREAD}
        tabIndex={active === MAIN_THREAD ? 0 : -1}
        data-thread={MAIN_THREAD}
        onClick={() => onChange(MAIN_THREAD)}
        data-testid="work-thread-main"
      >
        <span className="work-tabs__label">Principal</span>
        {mainCount > 0 && <span className="work-tabs__count">{mainCount}</span>}
      </button>
      {threads.map((thread) => (
        <button
          key={thread.id}
          type="button"
          role="tab"
          className="work-tabs__tab"
          aria-selected={active === thread.id}
          tabIndex={active === thread.id ? 0 : -1}
          title={[thread.model ? `${thread.label} · ${thread.model}` : thread.label, thread.goal].filter(Boolean).join(": ")}
          data-thread={thread.id}
          onClick={() => onChange(thread.id)}
          data-testid="work-thread"
        >
          <span className={`work-tabs__dot work-tabs__dot--${thread.status}`} aria-hidden="true" />
          <span className="work-tabs__label">{thread.label}</span>
          {thread.model && <span className="work-tabs__model">{thread.model}</span>}
          <span className="sr-only">{thread.status === "running" ? " (trabalhando)" : thread.status === "ok" ? " (terminou)" : " (falhou)"}</span>
        </button>
      ))}
    </div>
  );
}

/** Seletor de tarefa: a atual em cima, as anteriores embaixo. */
function TaskSelect({ options, value, onChange }: { options: readonly TaskOption[]; value: string | undefined; onChange: (id: string) => void }) {
  if (options.length <= 1) return null;
  const current = options.filter((option) => option.current);
  const previous = options.filter((option) => !option.current);
  return (
    <select className="ui-input work-bar__task" aria-label="Tarefa" value={value} onChange={(e) => onChange(e.currentTarget.value)} data-testid="work-task-select">
      {current.length > 0 && (
        <optgroup label={current.length === 1 ? "Tarefa atual" : "Tarefas atuais"}>
          {current.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </optgroup>
      )}
      {previous.length > 0 && (
        <optgroup label="Anteriores">
          {previous.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

function ModeToggle({ mode, onChange }: { mode: TimelineMode; onChange: (mode: TimelineMode) => void }) {
  return (
    <div className="work-mode" role="group" aria-label="Visualização do log">
      <button type="button" className="work-mode__option" aria-pressed={mode === "cards"} onClick={() => onChange("cards")} data-testid="work-mode-cards">
        Cartões
      </button>
      <button type="button" className="work-mode__option" aria-pressed={mode === "terminal"} onClick={() => onChange("terminal")} data-testid="work-mode-terminal">
        Terminal
      </button>
    </div>
  );
}

/**
 * Tela de trabalho de um agente (o "terminal" dele): quem é e o estado ao vivo, abas para o próprio
 * agente e cada subagente, o log da tarefa escolhida (cartões ou terminal) e atalhos para a tarefa
 * e o mapa. Dialog grande no centro, como o painel do Maestro: a câmera do escritório não mexe.
 */
export function AgentWorkPanel({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const ref = useModalDialog(onClose);
  const titleId = useId();
  const office = useOfficeStore((state) => state.office);
  const generation = useAgentLogStore((state) => state.generation);
  const agentEntries = useAgentLogStore((state) => state.byAgent[agentId]) ?? NO_ENTRIES;
  const agentLoad = useAgentLogStore((state) => state.agentLoad[agentId]);
  const [mode, setMode] = useWorkMode();
  const [chosenTask, setChosenTask] = useState<string | null>(null);
  const [chosenThread, setChosenThread] = useState(MAIN_THREAD);
  const [tab, setTab] = useState<MainTab>("terminal");
  const tabIds = { terminal: useId(), atividade: useId(), entregas: useId(), conversa: useId() };
  const mediaItems = useMediaStore((state) => state.items);
  const ensureMedia = useMediaStore((state) => state.ensureLoaded);
  useEffect(() => ensureMedia(), [ensureMedia]);
  const terminalInfo = useTerminalsStore((state) => state.byAgent[agentId]);
  const now = useClock();

  // Histórico do agente ao abrir (e de novo a cada reconexão).
  useEffect(() => {
    void useAgentLogStore.getState().loadAgent(agentId);
  }, [agentId, generation]);

  const details = office ? findAgentDetails(office, agentId) : null;
  const options = useMemo(() => taskOptions(office, agentId, agentEntries), [office, agentId, agentEntries]);
  // Sem escolha do usuário, acompanha a tarefa atual (muda sozinha quando ele pega outra).
  const taskId = chosenTask && options.some((option) => option.id === chosenTask) ? chosenTask : defaultTaskId(options, agentEntries);

  useEffect(() => {
    if (taskId) void useAgentLogStore.getState().loadTask(taskId);
  }, [taskId, generation]);

  const taskEntries = useAgentLogStore((state) => (taskId ? state.byTask[taskId] : undefined));
  const taskLoad = useAgentLogStore((state) => (taskId ? state.taskLoad[taskId] : undefined));
  // O log completo da tarefa, se já veio; senão o que o buffer do agente tem dela.
  const entries = useMemo(() => taskEntries ?? agentEntries.filter((entry) => entry.taskId === taskId), [taskEntries, agentEntries, taskId]);
  const threads = useMemo(() => threadsOf(entries), [entries]);
  const thread = threads.some((candidate) => candidate.id === chosenThread) ? chosenThread : MAIN_THREAD;
  const threadEntries = useMemo(() => entriesOfThread(entries, thread), [entries, thread]);
  const steps = useMemo(() => entriesToSteps(threadEntries), [threadEntries]);
  const mainCount = useMemo(() => (thread === MAIN_THREAD ? threadEntries.length : entriesOfThread(entries, MAIN_THREAD).length), [entries, thread, threadEntries]);
  const openThread = threads.find((candidate) => candidate.id === thread);
  const activeSubagents = liveSummary(agentEntries).activeSubagents;
  const engine = engineLabel(details?.agent, agentEntries);

  const close = () => ref.current?.close();
  const showOnMap = () => {
    const roomId = details?.room?.id;
    if (!roomId) return;
    close();
    useNavStore.getState().go("office");
    const view = useViewStore.getState();
    view.select({ kind: "agent", id: agentId });
    view.showAgent(agentId, roomId);
  };
  const openTask = (id: string) => {
    close();
    useTaskFocus.getState().open(id);
  };
  const actions: TimelineActions = {
    onOpenThread: setChosenThread,
    onOpenAgent: (id) => {
      if (id !== agentId) useWorkPanelStore.getState().openAgent(id);
    },
  };
  const chooseTask = (id: string) => {
    setChosenTask(id);
    setChosenThread(MAIN_THREAD);
  };

  const name = details?.agent.name ?? "Agente";
  const tasks = office?.tasks;
  const taskTitle = useCallback(
    (id: string) => {
      const task = tasks?.find((candidate) => candidate.id === id);
      return task ? truncate((task.prompt.split("\n")[0] ?? task.prompt).trim(), 70) : undefined;
    },
    [tasks],
  );
  // Tarefa em andamento: a caixa manda uma nota para ela (senão é conversa).
  const workingTask = tasks?.find((task) => task.agentId === agentId && (task.status === "in_progress" || task.status === "waiting_approval"));
  const chatItems = useMemo(() => agentChatItems(agentEntries, agentId), [agentEntries, agentId]);
  const deliveries = useMemo(() => deliveriesOf({ tasks: tasks ?? [], agentId, entries: agentEntries, media: mediaItems ?? [] }), [tasks, agentId, agentEntries, mediaItems]);
  // A última mensagem falhou (o terminal caiu) ou já foi respondida: ele não está mais "respondendo".
  const lastChat = useChatStatusStore((state) => latestChatStatus(state.byMessage, agentId));
  const thinking = agentReplying({ items: chatItems, now, terminal: terminalInfo, lastStatus: lastChat?.status });
  const live = terminalInfo?.status === "busy" || (terminalInfo === undefined && details?.agent.status === "working");
  const loading = (taskLoad?.state === "loading" || (!taskId && agentLoad?.state === "loading")) && entries.length === 0;
  const failure = taskLoad?.state === "error" ? taskLoad.message : !taskId && agentLoad?.state === "error" ? agentLoad.message : null;
  const empty = !office ? (
    <p className="work-empty__text">Carregando…</p>
  ) : !details ? (
    <div className="work-empty">
      <p className="work-empty__title">Este agente não existe mais.</p>
    </div>
  ) : failure ? (
    <div className="work-empty" role="alert">
      <p className="work-empty__title">Não deu para carregar o log.</p>
      <p className="work-empty__text">{failure}</p>
      <button
        type="button"
        className="ui-button ui-button--secondary ui-button--small"
        onClick={() => {
          const store = useAgentLogStore.getState();
          void (taskId ? store.loadTask(taskId, true) : store.loadAgent(agentId, true));
        }}
      >
        Tentar de novo
      </button>
    </div>
  ) : loading ? (
    <p className="work-empty__text">Carregando o log…</p>
  ) : !taskId ? (
    <div className="work-empty">
      <p className="work-empty__title">Nenhum trabalho registrado ainda.</p>
      <p className="work-empty__text">Quando {name} pegar uma tarefa, cada passo aparece aqui: o que está fazendo, as ferramentas, o progresso e o resultado.</p>
    </div>
  ) : (
    <div className="work-empty">
      <p className="work-empty__title">{thread === MAIN_THREAD ? "Esta tarefa ainda não tem log." : "Este subagente ainda não registrou nada."}</p>
      <p className="work-empty__text">Os passos aparecem aqui ao vivo, assim que o trabalho começar.</p>
    </div>
  );

  // O que ele faz agora, em frase ("📖 Lendo App.tsx"): só enquanto trabalha e com uma ferramenta na mão.
  const phrase = live ? livePhrase(agentEntries, now) : undefined;
  const subtitle = details ? (
    <>
      {details.agent.role}
      {details.team && ` · time ${details.team.name}`}
      {details.room && ` · ${details.room.name}`}
      {engine && (
        <span className="work-chip" data-testid="work-engine">
          {engine}
        </span>
      )}
      {phrase && (
        <span className="work-chip work-chip--phrase" data-testid="work-phrase">
          <span aria-hidden="true">{phrase.icon}</span> {phrase.text}
        </span>
      )}
      {activeSubagents > 0 && (
        <span className="work-chip work-chip--sub" data-testid="work-subagents">
          +{countLabel(activeSubagents, "subagente", "subagentes")}
        </span>
      )}
    </>
  ) : undefined;

  return (
    <dialog ref={ref} className="work-panel" aria-labelledby={titleId} data-testid="agent-work-dialog">
      <AgentWorkView
        office={office}
        agentId={details ? agentId : undefined}
        fallbackName={name}
        titleId={titleId}
        subtitle={subtitle}
        headerActions={
          <div className="work-head__buttons">
            {taskId && !isConversationLogId(taskId) && (
              <button type="button" className="tl-action" onClick={() => openTask(taskId)} data-testid="agent-work-open-task">
                Abrir em Projetos e tarefas
              </button>
            )}
            {details?.room && (
              <button type="button" className="tl-action" onClick={showOnMap} data-testid="agent-work-show">
                Ver no mapa
              </button>
            )}
            <button type="button" className="ui-icon-button" aria-label="Fechar" onClick={close} data-testid="agent-work-close">
              ×
            </button>
          </div>
        }
        body={{
          main: (
            <div className="maestro-main">
              <div className="maestro-tabs" role="tablist" aria-label={`Trabalho de ${name}`}>
                {(["terminal", "atividade", "entregas", "conversa"] as const).map((id) => (
                  <button
                    key={id}
                    id={tabIds[id]}
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    className={`maestro-tab${tab === id ? " maestro-tab--active" : ""}${id === "conversa" ? " maestro-tab--narrow-only" : ""}`}
                    onClick={() => setTab(id)}
                    data-testid={`agent-work-tab-${id}`}
                  >
                    {TAB_LABELS[id]}
                    {id === "entregas" && deliveries.length > 0 && <span className="work-tabs__count"> {deliveries.length}</span>}
                  </button>
                ))}
                <span className="maestro-tabs__note">{TAB_NOTES[tab]}</span>
              </div>
              <div className="maestro-pane" role="tabpanel" aria-labelledby={tabIds.terminal} hidden={tab !== "terminal"}>
                <AgentTerminalView
                  entries={agentEntries}
                  agentId={agentId}
                  agentName={name}
                  taskTitle={taskTitle}
                  live={live}
                  empty={
                    agentLoad?.state === "loading" ? (
                      "Carregando o log…"
                    ) : (
                      <>
                        Nada por aqui ainda. Quando {name} trabalhar ou conversar com você, cada passo aparece aqui ao vivo: o que ele escreve, as ferramentas, os subagentes, o
                        progresso e o resultado.
                      </>
                    )
                  }
                />
              </div>
              {/* Celular: a coluna da conversa some e vira esta aba (só existe na tela estreita; no desktop a aba nem aparece). */}
              {tab === "conversa" && (
                <div className="maestro-pane maestro-pane--narrow-only" role="tabpanel" aria-labelledby={tabIds.conversa} data-testid="agent-work-conversa-pane">
                  <AgentChatList
                    items={chatItems}
                    agentName={name}
                    thinking={thinking}
                    empty={
                      <div className="work-empty">
                        <p className="work-empty__title">Fale direto com {name}.</p>
                        <p className="work-empty__text">Livre, é uma conversa. Trabalhando numa tarefa, sua mensagem vira uma nota para ela. Trabalho novo é com o Maestro.</p>
                      </div>
                    }
                  />
                </div>
              )}
              <div className="maestro-pane" role="tabpanel" aria-labelledby={tabIds.entregas} hidden={tab !== "entregas"}>
                <AgentDeliveries cards={deliveries} agentName={name} onOpenTask={openTask} />
              </div>
              <div className="maestro-pane" role="tabpanel" aria-labelledby={tabIds.atividade} hidden={tab !== "atividade"}>
                {details && (
                  <div className="work-view__threads">
                    <div className="work-bar">
                      <ThreadTabs threads={threads} active={thread} onChange={setChosenThread} mainCount={mainCount} />
                      <div className="work-bar__controls">
                        <TaskSelect options={options} value={taskId} onChange={chooseTask} />
                        <ModeToggle mode={mode} onChange={setMode} />
                      </div>
                    </div>
                  </div>
                )}
                {openThread?.goal && (
                  <p className="work-goal" data-testid="work-thread-goal">
                    <strong>Objetivo:</strong> {openThread.goal}
                  </p>
                )}
                <Timeline
                  key={`${taskId ?? ""}:${thread}:${mode}`}
                  items={steps}
                  label={openThread ? `Log do subagente ${openThread.label}` : `Log de trabalho de ${name}`}
                  empty={empty}
                  mode={mode}
                  actions={actions}
                  testId="agent-work-log"
                />
              </div>
            </div>
          ),
          asideLabel: "Conversa",
          aside: (
            <AgentChatList
              items={chatItems}
              agentName={name}
              thinking={thinking}
              empty={
                <div className="work-empty">
                  <p className="work-empty__title">Fale direto com {name}.</p>
                  <p className="work-empty__text">
                    Livre, é uma conversa (dúvidas, ideias, ajustes). Trabalhando numa tarefa, sua mensagem vira uma nota para ela. Nada vira pedido: trabalho novo é com o Maestro.
                  </p>
                </div>
              }
            />
          ),
        }}
        splitKey="agent"
        compose={details ? <AgentCompose agentId={agentId} agentName={name} taskTitle={workingTask ? taskTitle(workingTask.id) : undefined} /> : undefined}
        timeline={{
          label: openThread ? `Log do subagente ${openThread.label}` : `Log de trabalho de ${name}`,
          items: steps,
          mode,
          empty,
          resetKey: `${taskId ?? ""}:${thread}:${mode}`,
          testId: "agent-work-log",
          header: openThread?.goal ? (
            <p className="work-goal" data-testid="work-thread-goal">
              <strong>Objetivo:</strong> {openThread.goal}
            </p>
          ) : undefined,
        }}
        actions={actions}
        testId="agent-work"
      />
    </dialog>
  );
}
