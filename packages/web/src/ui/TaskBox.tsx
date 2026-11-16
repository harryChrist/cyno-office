import { findMaestroAgent, MOCK_PROMPT_MARKERS, type Task } from "@cyno/shared";
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { DictationStatus, MicButton } from "../dictation/MicButton";
import { bindingKeys, bindingText, IS_MAC, useShortcuts } from "../hud/shortcuts";
import { useOverlayInsets } from "../hud/useOverlayInsets";
import { useChatStatusStore } from "../store/chatStatusStore";
import { useOfficeStore } from "../store/officeStore";
import { useTerminalsStore } from "../store/terminalsStore";
import { nextCheckIn, sendStatusText, viewSend, type SendState } from "../agentWork/composerModel";
import { useViewStore } from "../store/viewStore";
import { MaestroPanel } from "../agentWork/MaestroPanel";
import { useSimulated } from "./EngineFields";
import { useWorkPanelStore } from "../agentWork/workPanelStore";
import { maestroFeedback } from "./maestro";
import { useDockDismiss, useTaskboxHeight } from "./maestroDock";
import { MaestroQuotaNotice } from "./UnavailableBadge";
import { useMaestroDictation } from "./useMaestroDictation";
import { useMaestroPrompt } from "./useMaestroPrompt";

const FINISHED: Partial<Record<Task["status"], string>> = { done: " Concluído.", failed: " Não deu certo." };

/** "Enviado ao Maestro" e, quando ele decide, para qual time mandou e por quê. */
export function SentFeedback({ taskId, testId = "task-feedback" }: { taskId: string; testId?: string }) {
  const office = useOfficeStore((state) => state.office);
  const select = useViewStore((state) => state.select);
  const feedback = maestroFeedback(office, taskId);
  return (
    <p className="taskbox__feedback" role="status" data-testid={testId} data-task-id={taskId} data-kind={feedback.kind}>
      {feedback.kind === "sent" && "Enviado ao Maestro."}
      {feedback.kind === "waiting" && <span className="taskbox__feedback--attention">Maestro precisa de você: {feedback.question}.</span>}
      {feedback.kind === "delegated" && (
        <>
          Maestro mandou para o time {feedback.teamName}
          {feedback.reason ? ` (${feedback.reason})` : ""}
          {feedback.agent && (
            <>
              {" "}
              · com{" "}
              <button type="button" className="ui-link" onClick={() => select({ kind: "agent", id: feedback.agent!.id })} data-testid={`${testId}-agent`}>
                {feedback.agent.name}
              </button>
            </>
          )}
          .{FINISHED[feedback.status] ?? ""}
        </>
      )}
    </p>
  );
}

/**
 * A mensagem foi conversa: mostra em que pé ela está (na fila, entregue, respondeu, falhou) pelo que o servidor
 * conta (`agent:chat-status`; o terminal do Maestro é dele). Com o painel fechado, diz também onde a resposta vem.
 */
function ChatFeedback({ message, open }: { message: { id: string; text: string; at: number }; open: boolean }) {
  const byMessage = useChatStatusStore((state) => state.byMessage);
  const maestroId = useOfficeStore((state) => (state.office ? findMaestroAgent(state.office)?.id : undefined));
  const terminal = useTerminalsStore((state) => (maestroId ? state.byAgent[maestroId] : undefined));
  const [now, setNow] = useState(() => Date.now());
  const base: SendState = { phase: "queued", messageId: message.id, mode: "conversa", text: message.text, at: message.at };
  const view = viewSend(base, byMessage, now);
  useEffect(() => {
    const wait = nextCheckIn(view, Date.now());
    if (wait === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), wait + 50);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só o estado muda o prazo; o objeto `view` é novo a cada desenho
  }, [view?.phase, view?.at, view?.error]);
  const status = sendStatusText(view, now, terminal, "o Maestro");
  const failed = view?.phase === "failed";
  if (open && !status) return null;
  return (
    <p className={failed ? "ui-error taskbox__feedback" : "taskbox__feedback"} role={failed ? "alert" : "status"} data-testid="task-feedback" data-kind="chat" data-phase={view?.phase}>
      {status || "Enviado ao Maestro."}
      {!open && (
        <>
          {" "}
          Ele responde no{" "}
          <button type="button" className="ui-link" onClick={() => useWorkPanelStore.getState().openMaestro()} data-testid="task-feedback-open">
            painel dele
          </button>{" "}
          e abre um pedido quando for para fazer.
        </>
      )}
    </p>
  );
}

/** Seta do botão Enviar. */
function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" className="taskbox__send-icon">
      <path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Altura do campo acompanha o texto (de 1 linha até o teto do CSS, depois rola). */
function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const height = el.scrollHeight;
    el.style.height = `${height}px`;
    el.dataset.multiline = height > 44 ? "true" : "false";
  }, [ref, value]);
}

/**
 * Caixa fixa embaixo: "Fale com o Maestro". Com o Maestro de CLI é conversa (ele abre um pedido
 * quando entende que é para fazer); com o simulado, cada mensagem vira um pedido e ele escolhe o
 * time. À esquerda do campo, o anel do uso da assinatura (o detalhe abre por cima da caixa).
 *
 * Clicar (ou focar) no campo abre o painel do Maestro acoplado: a caixa cresce para cima e vira o
 * rodapé dele (conversa, pedidos, atividade, terminal). Não é modal: o escritório continua à vista
 * e clicável; Esc, o chevron ou um clique no escritório recolhem.
 */
export function TaskBox() {
  const maestroKeys = useShortcuts().maestro;
  const maestro = useMaestroPrompt();
  // Marcadores [aprovar]/[falhar] só valem no modo simulado do servidor (só testes).
  const simulated = useSimulated();
  const rootRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const compose = useMaestroDictation(maestro, inputRef);
  const ids = { prompt: useId(), hint: useId(), panel: useId() };
  const open = useWorkPanelStore((state) => state.maestroOpen);
  const focusRequest = useWorkPanelStore((state) => state.maestroFocus);
  // Só a caixa (não o painel aberto) tira espaço da câmera: o escritório não reenquadra ao abrir.
  useOverlayInsets("task-box", ref, "bottom", true);
  useTaskboxHeight(ref);
  const collapse = useCallback(() => useWorkPanelStore.getState().collapseMaestro(), []);
  useDockDismiss(open, rootRef, collapse);
  const { message, sentId, sentChat, sentMessage, conversational } = maestro;

  // Texto pronto vindo de outra página (ex.: "Montar com o Maestro" na Gestão): preenche a caixa, sem enviar.
  const draft = useWorkPanelStore((state) => state.maestroDraft);
  const { change: changePrompt } = maestro;
  useEffect(() => {
    if (draft === null) return;
    changePrompt(draft);
    useWorkPanelStore.setState({ maestroDraft: null });
  }, [draft, changePrompt]);

  // Pedido para abrir (Ctrl/⌘+K, "Maestro" da barra, lista de agentes…): o foco vai para o campo.
  useEffect(() => {
    if (focusRequest > 0) inputRef.current?.focus({ preventScroll: true });
  }, [focusRequest]);

  const expand = () => {
    if (!useWorkPanelStore.getState().maestroOpen) useWorkPanelStore.setState({ maestroOpen: true });
  };
  // O chevron do painel some com ele; o foco sai do campo (focar o campo reabriria o painel).
  const collapseFromPanel = () => {
    collapse();
    inputRef.current?.blur();
  };
  useAutoGrow(inputRef, maestro.prompt);

  return (
    <div ref={rootRef} className={`taskbox${open ? " taskbox--open" : ""}`} data-testid="task-box" data-open={open ? "true" : "false"}>
      {open && <MaestroPanel id={ids.panel} onCollapse={collapseFromPanel} />}
      <form ref={ref} className="taskbox__form" aria-label="Fale com o Maestro" noValidate onSubmit={(e) => void compose.submit(e)}>
        <p id={ids.hint} className="taskbox__hint">
          <span className="taskbox__hint-text">
            {conversational ? (
              "O Maestro abre um pedido quando for para fazer."
            ) : !simulated ? (
              "O Maestro está sem motor: escolha Claude Code ou Antigravity para ele em Configurações › Modelos padrão."
            ) : (
              <>
                Cada mensagem vira um pedido · <code>{MOCK_PROMPT_MARKERS.approve}</code> pede aprovação · <code>{MOCK_PROMPT_MARKERS.fail}</code> simula falha
              </>
            )}
          </span>
          <span className="taskbox__keys">
            <span className="taskbox__shortcut" title={`${bindingText(maestroKeys, IS_MAC)} abre este chat de qualquer tela. Para trocar: Configurações, Atalhos do teclado.`} data-testid="taskbox-shortcut">
              {bindingKeys(maestroKeys, IS_MAC).map((key, index) => (
                <Fragment key={key}>
                  {index > 0 && "+"}
                  <kbd>{key}</kbd>
                </Fragment>
              ))}{" "}
              abre de qualquer tela
            </span>{" "}
            · <kbd>Enter</kbd> envia · <kbd>Shift</kbd>+<kbd>Enter</kbd> nova linha{open && <> · <kbd>Esc</kbd> recolhe</>}
          </span>
        </p>
        <div className="taskbox__compose">
          <label htmlFor={ids.prompt} className="sr-only">
            Mensagem para o Maestro
          </label>
          <textarea
            ref={inputRef}
            id={ids.prompt}
            className="ui-input taskbox__prompt"
            value={maestro.prompt}
            rows={1}
            placeholder={conversational ? "Converse ou peça algo ao Maestro…" : "Peça ao Maestro…"}
            aria-describedby={ids.hint}
            aria-invalid={maestro.invalid}
            onChange={(e) => compose.change(e.currentTarget.value)}
            onKeyDown={compose.onKeyDown}
            onFocus={expand}
            onPointerDown={expand}
            data-testid="task-prompt"
          />
          <MicButton dictation={compose.dictation} testId="task-mic" />
          <button
            type="submit"
            className="ui-button taskbox__send"
            disabled={!maestro.canSend}
            aria-label={maestro.pending ? "Enviando" : "Enviar"}
            title="Enviar (Enter)"
            data-testid="task-submit"
          >
            <span className="taskbox__send-label">{maestro.pending ? "Enviando…" : "Enviar"}</span>
            <SendIcon />
          </button>
        </div>
        <DictationStatus dictation={compose.dictation} className="taskbox__dictation" testId="task-dictation" />
        <MaestroQuotaNotice className="taskbox__feedback taskbox__feedback--attention" />
        {message && (
          <p className="ui-error taskbox__feedback" role="alert" data-testid="task-error">
            {message}
          </p>
        )}
        {!message && sentId && !open && <SentFeedback taskId={sentId} />}
        {!message && sentChat && sentMessage && <ChatFeedback message={sentMessage} open={open} />}
      </form>
    </div>
  );
}
