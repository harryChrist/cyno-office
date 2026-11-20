import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { GlobeIcon } from "../browser/GlobeIcon";
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import { connectorForTool } from "../connectors/connectorView";
import { Markdown } from "../ui/markdown/Markdown";
import { useConnectorsStore } from "../store/connectorsStore";
import { useScriptsStore } from "../store/scriptsStore";
import { plainText } from "../ui/markdown/markdown";
import { percent } from "../ui/format";
import { ProgressBar } from "../ui/widgets";
import { formatDuration } from "./agentLogTimeline";
import { isBrowserTool, officeToolDoneWith, officeToolName } from "./officeTools";
import { scriptLaunchedBy } from "./scriptTool";
import { clockLabel, type RequestItem, type StepItem, type TimelineItem } from "./timeline";

/** O que os itens podem abrir (cada tela decide para onde levar). */
export type TimelineActions = {
  /** "Abrir em Projetos e tarefas": os detalhes da tarefa. */
  onOpenTask?: (taskId: string) => void;
  /** "Ver no mapa": o agente no escritório (`roomId` = o quarto de casa, se não souber onde ele está). */
  onShowAgent?: (agentId: string, roomId: string) => void;
  /** "Ver trabalho": a tela de trabalho do agente (o terminal dele). */
  onOpenAgent?: (agentId: string) => void;
  /** "Abrir": a thread de um subagente (troca a aba). */
  onOpenThread?: (threadId: string) => void;
  /** "Ver saída ao vivo": a página Scripts, no script que a ferramenta lançou. */
  onOpenScript?: (scriptId: string) => void;
};

/** Os links internos de um texto do log não levam a lugar nenhum (só o Cérebro tem notas). */
const noWiki = () => null;

/**
 * "cards": conversa (pedidos em balões, passos com respiro). "terminal": linhas compactas em fonte
 * mono, para streams longos (o log de trabalho cru de um agente, por exemplo).
 */
export type TimelineMode = "cards" | "terminal";

type TimelineProps = {
  items: readonly TimelineItem[];
  /** Nome acessível da lista. */
  label: string;
  empty: ReactNode;
  actions?: TimelineActions;
  mode?: TimelineMode;
  /** Abaixo do último item (ex.: "ver todas em Tarefas"). */
  footer?: ReactNode;
  testId?: string;
};

/** Distância do fim (px) em que a lista ainda "gruda" no mais novo quando chega item. */
const STICK_PX = 64;

/** Linha do tempo de um agente, a mais nova embaixo; acompanha o fim enquanto o usuário não sobe. */
export function Timeline({ items, label, empty, actions = {}, mode = "cards", footer, testId }: TimelineProps) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atEnd, setAtEnd] = useState(true);
  const [now] = useState(() => new Date());

  // Depois de cada render: se estava no fim (ou acabou de abrir), continua no fim.
  useLayoutEffect(() => {
    const scroller = ref.current;
    if (scroller && stick.current) scroller.scrollTop = scroller.scrollHeight;
  });

  const onScroll = () => {
    const scroller = ref.current;
    if (!scroller) return;
    stick.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_PX;
    if (stick.current !== atEnd) setAtEnd(stick.current);
  };

  const jumpToEnd = () => {
    const scroller = ref.current;
    if (!scroller) return;
    stick.current = true;
    setAtEnd(true);
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  };

  return (
    // Focável: dá para rolar pelo teclado (região rolável acessível).
    <div ref={ref} className={`timeline timeline--${mode}`} onScroll={onScroll} tabIndex={0} role="region" aria-label={label} data-testid={testId}>
      {items.length === 0 ? (
        <div className="timeline__empty">{empty}</div>
      ) : (
        <ol className="timeline__list">
          {items.map((item) =>
            item.kind === "request" ? (
              <RequestEntry key={item.id} item={item} actions={actions} now={now} />
            ) : (
              <StepEntry key={item.id} item={item} now={now} mode={mode} actions={actions} />
            ),
          )}
        </ol>
      )}
      {footer && <div className="timeline__footer">{footer}</div>}
      {!atEnd && items.length > 0 && (
        <button type="button" className="timeline__jump" onClick={jumpToEnd} data-testid="timeline-jump">
          <span aria-hidden="true">↓</span> Ir para o mais novo
        </button>
      )}
    </div>
  );
}

/** Resultados longos ficam recolhidos (o primeiro trecho aparece; o resto abre no clique). */
const RESULT_PREVIEW = 280;

function ResultText({ text, failed }: { text: string; failed: boolean }) {
  const body = <Markdown source={text} resolveWiki={noWiki} headingOffset={3} className="md--compact tl-result__text" testId="maestro-request-result" />;
  const preview = text.length > RESULT_PREVIEW ? plainText(text) : "";
  return (
    <div className={`tl-result${failed ? " tl-result--failed" : ""}`}>
      <p className="tl-result__label">{failed ? "Motivo" : "Resultado"}</p>
      {text.length <= RESULT_PREVIEW ? (
        body
      ) : (
        <details className="tl-result__more">
          <summary>
            <span className="tl-result__preview">{preview.slice(0, RESULT_PREVIEW).trimEnd()}…</span>
            <span className="tl-result__toggle">ver tudo</span>
          </summary>
          {body}
        </details>
      )}
    </div>
  );
}

function RequestEntry({ item, actions, now }: { item: RequestItem; actions: TimelineActions; now: Date }) {
  const { stage, team, room, agent, reason, progress, result } = item;
  const thinking = stage === "queued" || stage === "triage";
  const asking = stage === "waiting_you" && !team;
  const finished = stage === "done" || stage === "failed";
  return (
    <li className="tl-request" data-testid="maestro-request" data-task-id={item.id} data-stage={stage}>
      <div className="tl-ask">
        <p className="tl-ask__text">{item.prompt}</p>
        <time className="tl-time" dateTime={item.at}>
          {clockLabel(item.at, now)}
        </time>
      </div>

      <div className={`tl-reply tl-reply--${item.tone}`} aria-busy={thinking || undefined}>
        <div className="tl-reply__head">
          <span className="tl-reply__who">Maestro</span>
          <span className={`ui-badge ui-badge--${item.tone}`} data-testid="maestro-request-stage">
            {item.stageLabel}
          </span>
          {finished && (
            <time className="tl-time" dateTime={item.updatedAt}>
              {clockLabel(item.updatedAt, now)}
            </time>
          )}
        </div>

        {thinking && (
          <p className="tl-reply__line tl-thinking">
            {stage === "queued" ? "Recebi. Já vou olhar" : "Analisando o pedido para escolher o time"}
            <span className="tl-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </p>
        )}

        {asking && reason && (
          <p className="tl-reply__line tl-reply__ask" data-testid="maestro-request-question">
            {reason}.
          </p>
        )}

        {team && (
          <p className="tl-reply__line" data-testid="maestro-request-route">
            Mandei para o <strong>time {team.name}</strong>
            {room && <span className="tl-muted"> · {room.name}</span>}
            {agent && (
              <>
                {" "}
                com <strong>{agent.name}</strong>
              </>
            )}
            .
          </p>
        )}

        {team && reason && (
          <p className="tl-reply__why" data-testid="maestro-request-reason">
            <span className="tl-reply__why-label">Por quê</span>
            {reason}
          </p>
        )}

        {progress && (
          <div className="tl-progress">
            <ProgressBar value={progress.value} label={`Progresso: ${progress.message}`} />
            <p className="tl-progress__text">
              <span>{progress.message}</span>
              <span className="tl-progress__value">{percent(progress.value)}</span>
            </p>
          </div>
        )}

        {result && <ResultText text={result} failed={stage === "failed"} />}

        {(actions.onOpenTask || (actions.onShowAgent && agent?.roomId) || (actions.onOpenAgent && agent)) && (
          <div className="tl-reply__actions">
            {actions.onOpenTask && (
              <button type="button" className="tl-action" onClick={() => actions.onOpenTask!(item.id)} data-testid="maestro-request-open">
                Abrir em Projetos e tarefas
              </button>
            )}
            {actions.onOpenAgent && agent && (
              <button type="button" className="tl-action" onClick={() => actions.onOpenAgent!(agent.id)} data-testid="maestro-request-work">
                Ver trabalho de {agent.name}
              </button>
            )}
            {actions.onShowAgent && agent?.roomId && (
              <button type="button" className="tl-action" onClick={() => actions.onShowAgent!(agent.id, agent.roomId!)} data-testid="maestro-request-agent">
                Ver {agent.name} no mapa
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/** O input da ferramenta (JSON guardado no log), para o rótulo do navegador. */
function parseInput(json: string | undefined): Record<string, unknown> | undefined {
  if (!json) return undefined;
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const TOOL_STATE_LABELS: Partial<Record<StepItem["state"], string>> = { running: "rodando…", ok: "ok", error: "erro" };

/** Ferramenta: nome, resumo, estado e duração; a saída (e o input) abrem no clique. Ferramenta de conector: ícone + "Conector › ferramenta". */
function ToolLine({ item, actions }: { item: StepItem; actions: TimelineActions }) {
  const tool = item.tool!;
  const connectors = useConnectorsStore((state) => state.list);
  const viaConnector = connectorForTool(connectors, tool.name);
  const scriptId = scriptLaunchedBy(tool.name, tool.output);
  const script = useScriptsStore((state) => (scriptId ? state.runs?.find((run) => run.id === scriptId) : undefined));
  const scriptsLoaded = useScriptsStore((state) => state.runs !== null);
  const office = officeToolName(tool.name);
  const browser = office && isBrowserTool(office) ? office : undefined;
  const meta = [TOOL_STATE_LABELS[item.state], tool.durationMs !== undefined ? formatDuration(tool.durationMs) : undefined].filter(Boolean).join(" · ");
  return (
    <>
      <p className="tl-tool">
        {browser ? (
          <span className="tl-tool__name tl-tool__name--connector" title={tool.name} data-testid="work-tool-browser">
            <GlobeIcon size={14} />
            {officeToolDoneWith(browser, parseInput(tool.input))}
          </span>
        ) : viaConnector ? (
          <span className="tl-tool__name tl-tool__name--connector" title={tool.name} data-testid="work-tool-connector">
            <ConnectorIcon connector={viaConnector.connector} size={15} />
            {viaConnector.connector.name} › {viaConnector.tool}
          </span>
        ) : tool.phrase ? (
          <span className="tl-tool__phrase" title={tool.name} data-testid="work-tool-phrase">
            <span aria-hidden="true">{tool.phrase.icon}</span> {tool.phrase.text}
          </span>
        ) : (
          <span className="tl-tool__name">{tool.name}</span>
        )}
        {tool.summary && (!tool.phrase || tool.phrase.icon === "🛠️") && <span className="tl-tool__summary">{tool.summary}</span>}
        {meta && <span className="tl-tool__meta">{meta}</span>}
        {scriptId && actions.onOpenScript && (script || !scriptsLoaded) && (
          <button type="button" className="tl-step__link tl-tool__script" onClick={() => actions.onOpenScript!(scriptId)} data-testid="timeline-script-open">
            {script?.status === "running" ? "Ver saída ao vivo" : "Ver saída"}
          </button>
        )}
      </p>
      {(tool.output || tool.input) && (
        <details className="tl-tool__more">
          <summary>{tool.output ? (item.state === "error" ? "ver erro" : "ver saída") : "ver entrada"}</summary>
          {tool.input && (
            <pre className="tl-pre" aria-label="Entrada da ferramenta">
              {tool.input}
            </pre>
          )}
          {tool.output && (
            <pre className={`tl-pre${item.state === "error" ? " tl-pre--error" : ""}`} aria-label="Saída da ferramenta">
              {tool.output}
            </pre>
          )}
        </details>
      )}
    </>
  );
}

function StepActions({ item, actions }: { item: StepItem; actions: TimelineActions }) {
  const thread = item.threadId && actions.onOpenThread ? item.threadId : undefined;
  const agent = item.agentId && actions.onOpenAgent ? item.agentId : undefined;
  if (!thread && !agent) return null;
  return (
    <span className="tl-step__actions">
      {thread && (
        <button type="button" className="tl-step__link" onClick={() => actions.onOpenThread!(thread)} data-testid="work-step-thread">
          abrir subagente →
        </button>
      )}
      {agent && (
        <button type="button" className="tl-step__link" onClick={() => actions.onOpenAgent!(agent)} data-testid="work-step-agent">
          ver trabalho →
        </button>
      )}
    </span>
  );
}

function StepEntry({ item, now, mode, actions }: { item: StepItem; now: Date; mode: TimelineMode; actions: TimelineActions }) {
  const terminal = mode === "terminal";
  // No terminal o texto fica cru (como numa CLI); o resultado continua formatado (é para ler).
  const rich = item.markdown && (!terminal || item.variant === "result");
  return (
    <li className={`tl-step tl-step--${item.state}`} data-variant={item.variant ?? "event"} data-testid="work-step">
      <span className="tl-step__dot" aria-hidden="true" />
      <time className="tl-time" dateTime={item.at}>
        {clockLabel(item.at, now)}
      </time>
      <div className={`tl-step__body${item.variant === "result" ? " tl-step__body--result" : ""}`}>
        {item.variant === "result" && !terminal && <p className="tl-result__label">Resultado</p>}
        {item.tool ? (
          <ToolLine item={item} actions={actions} />
        ) : rich ? (
          <Markdown source={item.text} resolveWiki={noWiki} headingOffset={3} className="md--compact" />
        ) : (
          <p className={`tl-step__text${terminal && (item.markdown || item.variant === "raw") ? " tl-step__text--pre" : ""}`}>
            {terminal && item.tag && <span className="tl-step__tag">{item.tag}</span>}
            {item.text}
          </p>
        )}
        {item.detail && <p className="tl-step__detail">{item.detail}</p>}
        {item.variant === "progress" && item.progress !== undefined && <ProgressBar value={item.progress} label={item.text} />}
        <StepActions item={item} actions={actions} />
      </div>
    </li>
  );
}
