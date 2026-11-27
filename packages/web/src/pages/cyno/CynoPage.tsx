import { CYNO_STATUS_LABELS, engineBlockLabel, type CynoState, type WorkspaceProposal } from "@cyno/shared";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { cynoChatItems, cynoThinking, type CynoChatItem, type CynoWorkStep } from "../../agentWork/cynoChat";
import { clockLabel } from "../../agentWork/timelineView";
import { useCynoStore } from "../../store/cynoStore";
import { Markdown } from "../../ui/markdown/Markdown";
import { CynoPet } from "./CynoPet";
import { CynoModelPicker } from "./CynoModelPicker";
import { ConfirmationCard, PendingDecisions, ProposalCard } from "./DecisionCards";
import { RequestCard } from "./RequestsPanel";
import { CynoChips, CynoRail, CynoSide, useSideCounts } from "./CynoSide";
import { clampSideWidth, loadSideCollapsed, loadSideTab, loadSideWidth, saveSideCollapsed, saveSideTab, saveSideWidth, SIDE_WIDTH_DEFAULT, SIDE_WIDTH_MAX, SIDE_WIDTH_MIN, SIDE_WIDTH_STEP, type SideTabId } from "./cynoSideView";
import { JointCard } from "../joint/JointCard";
import { CidadeFaixa } from "../../cena/cidade/CidadeFaixa";
import "./cynoRequests.css";
import "../../agentWork/maestroPanel.css";
import "./cyno.css";

const STICK_PX = 64;
const noWiki = () => null;
const MAX_CHARS = 8000;

const SUGGESTIONS = ["Um post curto sobre café, com revisão", "O que está parado em cada workspace?", "Como estão os pedidos que você enviou?"];

/** O avatar do Cyno: o bichinho (cabeça no cabeçalho, corpo inteiro no estado vazio). */
function Orb({ status, size = "md" }: { status: CynoState["status"] | undefined; size?: "md" | "lg" }) {
  return <CynoPet status={status} size={size} />;
}

function StatusPill({ state, now }: { state: CynoState | null; now: Date }) {
  const status = state?.status ?? "sleeping";
  const label = state?.block ? engineBlockLabel(state.block, now.getTime()) : CYNO_STATUS_LABELS[status];
  const tone = state?.block ? "attention" : status;
  return (
    <span className={`cyno-status cyno-status--${tone}`} role="status" aria-live="polite" data-testid="cyno-status" data-status={status}>
      <span className="cyno-status__dot" aria-hidden="true" />
      {state?.block ? `Cyno ${label}` : label}
    </span>
  );
}

function Step({ step, now }: { step: CynoWorkStep; now: Date }) {
  return (
    <li className={`cyno-step cyno-step--${step.tone}${step.running ? " cyno-step--running" : ""}`} data-kind={step.kind} data-testid="cyno-step">
      <span className="cyno-step__icon" aria-hidden="true">
        {step.running ? <span className="cyno-spinner" /> : step.kind === "tool" ? "⌕" : "·"}
      </span>
      <span className="cyno-step__body">
        <span className="cyno-step__label">{step.label}</span>
        {step.detail && <span className="cyno-step__detail">{step.detail}</span>}
      </span>
      <time className="cyno-step__time" dateTime={step.at}>
        {clockLabel(step.at, now)}
      </time>
    </li>
  );
}

/** O trabalho do Cyno entre a fala e a resposta: aberto e ao vivo enquanto trabalha, recolhido depois. */
function Work({ item, now }: { item: Extract<CynoChatItem, { kind: "work" }>; now: Date }) {
  const tools = item.steps.filter((step) => step.kind === "tool").length;
  const summary = item.live ? (tools > 0 ? `Trabalhando · ${tools} ${tools === 1 ? "ferramenta" : "ferramentas"}` : "Trabalhando…") : tools > 0 ? `Trabalhou · ${tools} ${tools === 1 ? "ferramenta" : "ferramentas"}` : "Trabalho do Cyno";
  return (
    <li className="cyno-work-item">
      <details className={`cyno-work${item.live ? " cyno-work--live" : ""}`} open={item.live} data-testid="cyno-work" data-live={item.live ? "true" : undefined}>
        <summary className="cyno-work__head">
          {item.live ? <span className="cyno-spinner" aria-hidden="true" /> : <span className="cyno-work__tick" aria-hidden="true">✓</span>}
          <span>{summary}</span>
        </summary>
        <ol className="cyno-steps">
          {item.steps.map((step) => (
            <Step key={step.id} step={step} now={now} />
          ))}
        </ol>
      </details>
    </li>
  );
}

/** O cartão do pedido que o Cyno enviou: o estado vem ao vivo da lista de pedidos. */
function RequestItem({ item }: { item: Extract<CynoChatItem, { kind: "request" }> }) {
  const view = useCynoStore((state) => state.requests.find((request) => request.projectId === item.projectId));
  return (
    <li className="cyno-request-item" data-testid="cyno-request">
      <RequestCard view={view} fallback={{ workspace: item.workspace, title: item.title }} />
    </li>
  );
}

/** O cartão do projeto conjunto no chat: o estado de cada parte vem ao vivo da lista de projetos conjuntos. */
function JointItem({ item }: { item: Extract<CynoChatItem, { kind: "joint" }> }) {
  return (
    <li className="cyno-joint-item" data-testid="cyno-joint">
      <JointCard jointId={item.jointId} fallbackTitle={item.title} />
    </li>
  );
}

/** O cartão de confirmação no chat: o estado ao vivo vem da lista de confirmações. */
function ConfirmationItem({ item }: { item: Extract<CynoChatItem, { kind: "confirmation" }> }) {
  const confirmation = useCynoStore((state) => state.confirmations.find((candidate) => candidate.id === item.confirmationId));
  return (
    <li className="cyno-decision-item" data-decision-id={item.confirmationId}>
      <ConfirmationCard confirmation={confirmation} />
    </li>
  );
}

function ProposalItem({ item, onAdjust }: { item: Extract<CynoChatItem, { kind: "proposal" }>; onAdjust: (proposal: WorkspaceProposal) => void }) {
  const proposal = useCynoStore((state) => state.proposals.find((candidate) => candidate.id === item.proposalId));
  return (
    <li className="cyno-decision-item" data-decision-id={item.proposalId}>
      <ProposalCard proposal={proposal} onAdjust={onAdjust} />
    </li>
  );
}

function Item({ item, now, onAdjust }: { item: CynoChatItem; now: Date; onAdjust: (proposal: WorkspaceProposal) => void }) {
  if (item.kind === "work") return <Work item={item} now={now} />;
  if (item.kind === "confirmation") return <ConfirmationItem item={item} />;
  if (item.kind === "proposal") return <ProposalItem item={item} onAdjust={onAdjust} />;
  if (item.kind === "request") return <RequestItem item={item} />;
  if (item.kind === "joint") return <JointItem item={item} />;
  if (item.kind === "ask") {
    return (
      <li className="cyno-ask-item" data-testid="cyno-ask">
        <span className="cyno-ask-item__tag">ask_cyno</span>
        <span className="cyno-ask-item__text">{item.text}</span>
      </li>
    );
  }
  const time = (
    <time className="mchat__time" dateTime={item.at}>
      {clockLabel(item.at, now)}
    </time>
  );
  if (item.kind === "notice") {
    return (
      <li className={`mchat__notice cyno-notice cyno-notice--${item.tone}`} data-testid="cyno-notice">
        {item.text} · {time}
      </li>
    );
  }
  return (
    <li className={`mchat__msg mchat__msg--${item.from}`} data-testid="cyno-message" data-from={item.from}>
      <div className="mchat__bubble">{item.from === "agent" ? <Markdown source={item.text} resolveWiki={noWiki} headingOffset={3} className="mchat__md" /> : <p className="mchat__text">{item.text}</p>}</div>
      <span className="mchat__meta">
        {item.from === "user" ? "Você" : "Cyno"} · {time}
      </span>
    </li>
  );
}

function Empty({ state, onPick }: { state: CynoState | null; onPick: (text: string) => void }) {
  return (
    <div className="cyno-empty" data-testid="cyno-empty">
      <Orb status={state?.status} size="lg" />
      <h3 className="cyno-empty__title">Oi, eu sou o Cyno</h3>
      <p className="cyno-empty__text">Este bichinho é a minha cara por aqui. Fico acima de todos os workspaces. {state?.everStarted === false ? "Ainda estou dormindo. " : ""}Acordo quando você fala comigo e durmo de novo depois de um tempo parado; a conversa continua de onde parou.</p>
      <ul className="cyno-suggestions" aria-label="Sugestões">
        {SUGGESTIONS.map((text) => (
          <li key={text}>
            <button type="button" className="cyno-suggestion" onClick={() => onPick(text)}>
              {text}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A caixa de mensagem: Enter envia, Shift+Enter quebra a linha. */
function Composer({ text, setText, inputRef, blocked, waking }: { text: string; setText: (text: string) => void; inputRef: RefObject<HTMLTextAreaElement | null>; blocked: boolean; waking: boolean }) {
  const inputId = useId();
  const send = useCynoStore((state) => state.send);
  const sending = useCynoStore((state) => state.sending);
  const error = useCynoStore((state) => state.error);
  const clearError = useCynoStore((state) => state.clearError);
  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && trimmed.length <= MAX_CHARS && !sending;

  const submit = async () => {
    if (!canSend) return;
    if (await send(trimmed)) setText("");
    inputRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };
  return (
    <form
      className="cyno-compose"
      noValidate
      aria-label="Mensagem para o Cyno"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        Mensagem para o Cyno
      </label>
      <div className="cyno-compose__box">
        <textarea
          ref={inputRef}
          id={inputId}
          className="cyno-compose__input"
          rows={2}
          value={text}
          maxLength={MAX_CHARS}
          placeholder="Diga o que você quer: o Cyno escolhe o workspace e manda o pedido ao Maestro…"
          onChange={(event) => {
            if (error) clearError();
            setText(event.currentTarget.value);
          }}
          onKeyDown={onKeyDown}
          data-testid="cyno-input"
        />
        <button type="submit" className="cyno-compose__send" disabled={!canSend} aria-label="Enviar" data-testid="cyno-send">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="cyno-compose__send-text">{sending ? "Enviando…" : "Enviar"}</span>
        </button>
      </div>
      {error && (
        <p className="cyno-compose__error" role="alert" data-testid="cyno-error">
          {error}
        </p>
      )}
      <p className="cyno-compose__hint">
        <kbd>Enter</kbd> envia · <kbd>Shift</kbd>+<kbd>Enter</kbd> nova linha
        {waking ? " · acordando o Cyno…" : blocked ? " · a mensagem espera o motor voltar" : ""}
      </p>
    </form>
  );
}

/** Um relógio que anda de minuto em minuto (as idades dos itens e "hoje 18h" não ficam velhos com a página aberta). */
function useNow(everyMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}

/**
 * A alça entre a conversa e o painel (só no computador): arrastar, setas, Home/End e duplo clique.
 * O ponteiro fica "capturado" na alça, então nem o chat nem iframes roubam o arraste.
 */
function SideResizer({ width, available, onChange, onCommit, onDragging }: { width: number; available: number; onChange: (width: number) => void; onCommit: (width: number) => void; onDragging: (dragging: boolean) => void }) {
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);
  const max = clampSideWidth(SIDE_WIDTH_MAX, available);
  const move = (next: number) => {
    const value = clampSideWidth(next, available);
    onChange(value);
    return value;
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width, last: width };
    onDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    current.last = move(current.width - (event.clientX - current.x));
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    onDragging(false);
    onCommit(current.last);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = width + SIDE_WIDTH_STEP;
    else if (event.key === "ArrowRight") next = width - SIDE_WIDTH_STEP;
    else if (event.key === "Home") next = SIDE_WIDTH_MIN;
    else if (event.key === "End") next = max;
    if (next === null) return;
    event.preventDefault();
    onCommit(move(next));
  };
  return (
    <div
      className="cyno-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Largura do painel lateral: arraste ou use as setas"
      aria-valuenow={width}
      aria-valuemin={SIDE_WIDTH_MIN}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onCommit(move(SIDE_WIDTH_DEFAULT))}
      data-testid="cyno-resizer"
    >
      <span className="cyno-resizer__line" aria-hidden="true" />
    </div>
  );
}

/**
 * Página inicial (`#/cyno`, fora dos workspaces). A conversa com o agente da plataforma ocupa a coluna
 * principal; ao lado, um único painel com abas (Resumo, Workspaces, Agenda, Mural) que pode ser recolhido.
 * No celular a conversa ocupa a tela e o painel vira uma folha aberta por uma fileira de chips. Dentro
 * de um workspace nada muda: o chat do meio continua sendo do Maestro.
 */
export function CynoPage() {
  const state = useCynoStore((store) => store.state);
  const entries = useCynoStore((store) => store.entries);
  const loaded = useCynoStore((store) => store.loaded);
  const socket = useCynoStore((store) => store.socket);
  const connect = useCynoStore((store) => store.connect);
  const newConversation = useCynoStore((store) => store.newConversation);
  const now = useNow();
  const loadCards = useCynoStore((store) => store.loadCards);
  const noWorkspaces = useCynoStore((store) => store.cardsLoaded && store.cards.length === 0);
  const counts = useSideCounts(now);
  const [tab, setTab] = useState<SideTabId>(loadSideTab);
  const [collapsed, setCollapsed] = useState(loadSideCollapsed);
  // Largura do painel no computador (lembrada) e do espaço disponível, que limita o que ela pode valer.
  const [sideWidth, setSideWidth] = useState(loadSideWidth);
  const [available, setAvailable] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
  const [resizing, setResizing] = useState(false);
  const layoutRef = useRef<HTMLDivElement>(null);
  // Celular: o painel é uma folha que sobe de baixo; no computador este estado não faz nada.
  const [sheet, setSheet] = useState(false);
  const picked = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // As sugestões do estado vazio escrevem no campo (enviar continua sendo do dono).
  const pick = (text: string) => {
    setDraft(text);
    inputRef.current?.focus();
  };

  // "Ajustar" na proposta: o ajuste é conversa (o Cyno gera uma versão nova).
  const adjust = (proposal: WorkspaceProposal) => pick(`Ajuste na proposta do workspace ${proposal.plan.name}: `);

  useEffect(() => connect(), [connect]);
  useEffect(() => {
    void loadCards();
  }, [loadCards]);
  // Sem nenhum workspace, o painel abre direto na aba onde se cria o primeiro (a menos que o dono já tenha escolhido outra).
  useEffect(() => {
    if (noWorkspaces && !picked.current) setTab("workspaces");
  }, [noWorkspaces]);
  useLayoutEffect(() => {
    const element = layoutRef.current;
    if (!element) return;
    const measure = () => setAvailable(element.clientWidth || window.innerWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const effectiveWidth = clampSideWidth(sideWidth, available);
  const chooseTab = (next: SideTabId) => {
    picked.current = true;
    setTab(next);
    saveSideTab(next);
  };
  const setSideCollapsed = (value: boolean) => {
    setCollapsed(value);
    saveSideCollapsed(value);
  };
  const openPanel = (next: SideTabId) => {
    chooseTab(next);
    setSideCollapsed(false);
    setSheet(true);
  };

  const working = state?.status === "working";
  const waking = state?.status === "waking";
  const items = useMemo(() => cynoChatItems(entries, working || waking), [entries, working, waking]);
  const thinking = cynoThinking(items, working, waking);

  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  });
  const onScroll = () => {
    const element = scroller.current;
    if (element) stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX;
  };

  const startNew = async () => {
    setConfirming(false);
    await newConversation();
  };

  return (
    <section className="page page--fill cyno" aria-labelledby="cyno-title" data-side={collapsed ? "closed" : "open"} data-resizing={resizing ? "true" : undefined} data-testid="cyno-page">
      <div ref={layoutRef} className="cyno-layout" style={{ "--cyno-side-w": `${effectiveWidth}px` } as CSSProperties}>
        <div className="cyno-conv">
          <header className="cyno-head">
            <div className="cyno-head__who">
              <Orb status={state?.status} />
              <h2 id="cyno-title" className="cyno-head__title">
                Cyno
              </h2>
              <StatusPill state={state} now={now} />
            </div>
            <div className="cyno-head__tools">
              {state && <CynoModelPicker choice={state.choice} />}
              {confirming ? (
                <span className="cyno-confirm" role="group" aria-label="Confirmar nova conversa">
                  <span className="cyno-confirm__text">O Cyno esquece esta conversa?</span>
                  <button type="button" className="ui-button ui-button--ghost" onClick={() => setConfirming(false)}>
                    Não
                  </button>
                  <button type="button" className="ui-button cyno-solid" onClick={() => void startNew()} data-testid="cyno-new-confirm">
                    Sim, começar do zero
                  </button>
                </span>
              ) : (
                <button type="button" className="ui-button ui-button--ghost cyno-new" onClick={() => setConfirming(true)} disabled={!state || state.newConversation} title={state?.newConversation ? "A próxima mensagem já abre uma conversa nova" : "Começar uma conversa nova (o Cyno não lembra da atual)"} data-testid="cyno-new">
                  {state?.newConversation ? "Nova conversa na próxima mensagem" : "Nova conversa"}
                </button>
              )}
            </div>
          </header>

          <CynoChips counts={counts} noWorkspaces={noWorkspaces} onOpen={openPanel} />

          <CidadeFaixa />

          <div className="cyno-chat" data-testid="cyno-chat">
            <PendingDecisions onAdjust={adjust} />
            <div ref={scroller} className="mchat cyno-chat__scroll" onScroll={onScroll} tabIndex={0} role="log" aria-label="Conversa com o Cyno">
              {!loaded && items.length === 0 ? (
                <p className="cyno-loading">{socket === "reconnecting" ? "Reconectando…" : "Carregando a conversa…"}</p>
              ) : items.length === 0 ? (
                <Empty state={state} onPick={pick} />
              ) : (
                <ol className="mchat__list cyno-list">
                  {items.map((item) => (
                    <Item key={item.id} item={item} now={now} onAdjust={adjust} />
                  ))}
                  {thinking && (
                    <li className="mchat__msg mchat__msg--agent" aria-live="polite" data-testid="cyno-thinking">
                      <div className="mchat__bubble mchat__bubble--thinking">{waking ? "Acordando o Cyno…" : "O Cyno está respondendo…"}</div>
                    </li>
                  )}
                </ol>
              )}
            </div>
            <Composer text={draft} setText={setDraft} inputRef={inputRef} blocked={state?.block !== undefined} waking={waking} />
          </div>
        </div>

        {!collapsed && (
          <SideResizer
            width={effectiveWidth}
            available={available}
            onChange={setSideWidth}
            onCommit={(value) => {
              setSideWidth(value);
              saveSideWidth(value);
            }}
            onDragging={setResizing}
          />
        )}
        {collapsed && <CynoRail counts={counts} onOpen={openPanel} />}
        <CynoSide now={now} tab={tab} onTab={chooseTab} counts={counts} onCollapse={() => setSideCollapsed(true)} sheet={sheet} onClose={() => setSheet(false)} />
      </div>
    </section>
  );
}
