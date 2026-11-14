import type { AgentLogEntry } from "@cyno/shared";
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import { connectorForTool } from "../connectors/connectorView";
import { useConnectorsStore } from "../store/connectorsStore";
import { copyText } from "../ui/clipboard";
import { formatTime } from "../ui/format";
import { Markdown } from "../ui/markdown/Markdown";
import { entriesToTerminalLines, type TerminalLine } from "./agentTerminal";
import { TerminalFooter } from "./TerminalFooter";
import { TerminalToolbar } from "./TerminalToolbar";
import {
  collapsePreview,
  copyDetailOf,
  copyTextOf,
  filterLines,
  findMatches,
  foldQuery,
  hiddenAt,
  hitCounts,
  moreLabel,
  previewLimit,
  refAt,
  searchFields,
  splitByRanges,
  stepMatch,
  type TerminalFilter,
} from "./terminalSearch";
import { loadFilter, nextUnread, saveFilter, visibleRange, windowAround, WINDOW_STEP } from "./terminalView";
import "./agentTerminal.css";

/** Distância do fim (px) em que a tela ainda "gruda" no mais novo. */
const STICK_PX = 48;
const TIME_KEY = "agent-office:term-times";
const noWiki = () => null;

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function readTimes(): boolean {
  try {
    return window.localStorage.getItem(TIME_KEY) !== "0";
  } catch {
    return true;
  }
}

function saveTimes(value: boolean): void {
  try {
    window.localStorage.setItem(TIME_KEY, value ? "1" : "0");
  } catch {
    // Sem storage: só não lembra.
  }
}

/** Botão de copiar: avisa "copiado" por um instante. */
function CopyButton({ text, label, className = "aterm__copy" }: { text: string; label: string; className?: string }) {
  const [done, setDone] = useState<boolean | null>(null);
  useEffect(() => {
    if (done === null) return;
    const timer = window.setTimeout(() => setDone(null), 1500);
    return () => window.clearTimeout(timer);
  }, [done]);
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      title={label}
      data-done={done === null ? undefined : String(done)}
      onClick={() => void copyText(text).then(setDone)}
      data-testid="agent-terminal-copy"
    >
      {done === null ? "copiar" : done ? "copiado" : "não deu"}
    </button>
  );
}

type FieldProps = {
  text: string;
  limit: number;
  open: boolean;
  onToggle: () => void;
  /** Termo da busca já dobrado ("" = sem busca). Com busca o texto sai cru, com o destaque. */
  folded: string;
  /** Número do primeiro resultado deste campo na linha, e qual resultado da linha é o atual (-1 = nenhum). */
  hitBase: number;
  currentHit: number;
  markdown: boolean;
  className?: string;
  testId?: string;
  copy?: ReactNode;
};

/** Um bloco de texto da linha: recolhido ("… +N linhas") quando longo, com busca destacada ou em markdown seguro. */
function Field({ text, limit, open, onToggle, folded, hitBase, currentHit, markdown, className, testId, copy }: FieldProps) {
  const preview = collapsePreview(text, limit);
  const shown = !preview || open ? text : preview.shown;
  let body: ReactNode;
  if (folded) {
    const ranges = findMatches(text, folded).filter(([, end]) => end <= shown.length);
    body = splitByRanges(shown, ranges).map((piece, index) =>
      piece.hit === undefined ? (
        piece.text
      ) : (
        <mark key={index} className="aterm__hit" data-hit-current={currentHit === hitBase + piece.hit ? "true" : undefined}>
          {piece.text}
        </mark>
      ),
    );
  } else if (markdown) {
    body = <Markdown source={shown} resolveWiki={noWiki} headingOffset={3} plainLinks className="md--compact aterm__md" />;
  } else {
    body = shown;
  }
  return (
    <span className={markdown && !folded && className ? `${className} aterm__text--md` : className} data-testid={testId}>
      {body}
      {preview && (
        <button type="button" className="aterm__more" aria-expanded={open} onClick={onToggle} data-testid="agent-terminal-more">
          {open ? "… recolher" : moreLabel(preview)}
        </button>
      )}
      {copy}
    </span>
  );
}

type LineProps = {
  line: TerminalLine;
  showTime: boolean;
  folded: string;
  currentHit: number;
  openText: boolean;
  openDetail: boolean;
  onToggle: (key: string) => void;
};

const Line = memo(function Line({ line, showTime, folded, currentHit, openText, openDetail, onToggle }: LineProps) {
  const connectors = useConnectorsStore((state) => state.list);
  const via = line.tool && !folded ? connectorForTool(connectors, line.tool) : null;
  if (line.tone === "section") {
    return (
      <div className="aterm__section" data-testid="agent-terminal-section">
        <span>{line.text}</span>
      </div>
    );
  }
  const markdown = line.kind === "text" || line.kind === "result" || (line.kind === "chat" && line.from === "agent");
  const fields = folded ? searchFields(line) : null;
  const detailBase = fields ? findMatches(fields.text, folded).length : 0;
  return (
    <div
      className={`aterm__line aterm__line--${line.tone}${line.thread ? " aterm__line--thread" : ""}`}
      data-testid="agent-terminal-line"
      data-tone={line.tone}
      data-line-id={line.id}
    >
      {showTime && (
        <time className="aterm__time" dateTime={line.at}>
          {formatTime(line.at)}
        </time>
      )}
      <span className="aterm__body">
        {line.thread && <span className="aterm__thread">│ {line.thread}</span>}
        <span className="aterm__prefix" aria-hidden="true">
          {line.prefix}
        </span>
        {via ? (
          <span className="aterm__text" title={line.tool}>
            <ConnectorIcon connector={via.connector} size={13} />
            <span className="aterm__connector">
              {via.connector.name} › {via.tool}
            </span>
            {line.text.slice(line.text.indexOf("(") >= 0 ? line.text.indexOf("(") : line.text.length)}
          </span>
        ) : (
          <Field
            text={line.text}
            limit={previewLimit(line, "text")}
            open={openText}
            onToggle={() => onToggle(`${line.id}:text`)}
            folded={folded}
            hitBase={0}
            currentHit={currentHit}
            markdown={markdown}
            className="aterm__text"
          />
        )}
        {line.meta && <span className="aterm__meta">{line.meta}</span>}
        <CopyButton text={copyTextOf(line)} label={line.kind === "tool" ? "Copiar o comando" : "Copiar"} />
        {line.detail && (
          <Field
            text={line.detail}
            limit={previewLimit(line, "detail")}
            open={openDetail}
            onToggle={() => onToggle(`${line.id}:detail`)}
            folded={folded}
            hitBase={detailBase}
            currentHit={currentHit}
            markdown={false}
            className="aterm__detail"
            copy={<CopyButton text={copyDetailOf(line)} label="Copiar a saída" className="aterm__copy aterm__copy--block" />}
          />
        )}
      </span>
    </div>
  );
});

type Props = {
  entries: readonly AgentLogEntry[];
  agentName: string;
  /** Guarda o filtro escolhido por agente. */
  agentId?: string;
  taskTitle?: (taskId: string) => string | undefined;
  /** O agente está no meio de um turno (o cursor pisca no fim). */
  live: boolean;
  empty: ReactNode;
  testId?: string;
};

/**
 * Terminal do agente, só de leitura: o log de trabalho dele (todas as tarefas e conversas) como uma
 * sessão de terminal, ao vivo. Filtros (Tudo, Só conversa, Sem ferramentas), busca sem acento com contador
 * que abre os blocos recolhidos, blocos longos recolhidos, copiar, texto das respostas em markdown seguro,
 * rodapé de estado e "novas mensagens" quando o dono rolou para cima. Desenha só as últimas linhas (a
 * busca e os filtros olham a conversa toda). Não aceita comando nenhum: falar com o agente é pela caixa.
 */
export function AgentTerminalView({ entries, agentName, agentId, taskTitle, live, empty, testId = "agent-terminal" }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const stick = useRef(true);
  const pendingScroll = useRef(false);
  const heightBefore = useRef<number | null>(null);
  const previousTotal = useRef(0);
  const [atEnd, setAtEnd] = useState(true);
  const [unread, setUnread] = useState(0);
  const [showTime, setShowTime] = useState(readTimes);
  const [filter, setFilter] = useState<TerminalFilter>(() => loadFilter(agentId, storage()));
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(-1);
  const [limit, setLimit] = useState(WINDOW_STEP);
  /** A janela do salto da busca (as linhas ao redor do resultado); null = o fim da conversa. */
  const [focus, setFocus] = useState<{ start: number; end: number } | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());

  // Trocou de agente: volta o filtro dele e esquece a busca.
  const lastAgent = useRef(agentId);
  useEffect(() => {
    if (lastAgent.current === agentId) return;
    lastAgent.current = agentId;
    setFilter(loadFilter(agentId, storage()));
    setQuery("");
    setLimit(WINDOW_STEP);
    setFocus(null);
    setOpen(new Set());
  }, [agentId]);

  const lines = useMemo(() => entriesToTerminalLines(entries, { agentName, taskTitle }), [entries, agentName, taskTitle]);
  const filtered = useMemo(() => filterLines(lines, filter), [lines, filter]);
  const deferredQuery = useDeferredValue(query);
  const folded = foldQuery(deferredQuery);
  const counts = useMemo(() => hitCounts(filtered, folded), [filtered, folded]);
  const total = useMemo(() => counts.reduce((sum, [, n]) => sum + n, 0), [counts]);
  const current = hit >= 0 && hit < total ? hit : -1;
  const ref = refAt(counts, current);

  const win = visibleRange(filtered.length, limit, focus);
  const shown = win.start === 0 && win.end === filtered.length ? filtered : filtered.slice(win.start, win.end);
  const hiddenUp = win.start;
  const hiddenDown = filtered.length - win.end;

  // Termo novo ou filtro novo: começa do primeiro resultado.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sincroniza o resultado atual com o termo novo
    setHit(folded && counts.length ? 0 : -1);
    pendingScroll.current = folded !== "";
    if (!folded) {
      // Fechou a busca: volta para o fim da conversa.
      setFocus(null);
      setLimit(WINDOW_STEP);
      stick.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folded, filter]);

  // O resultado atual: entra na janela e abre o bloco recolhido que o esconde.
  useEffect(() => {
    if (!ref) return;
    const position = filtered.findIndex((line) => line.id === ref.key);
    if (position < 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- o resultado atual precisa estar na janela desenhada
    if (position < win.start || position >= win.end) setFocus(windowAround(filtered.length, position));
    const line = filtered[position]!;
    const { text, detail } = searchFields(line);
    const inText = findMatches(text, folded);
    const field = ref.index < inText.length ? "text" : "detail";
    const range = field === "text" ? inText[ref.index] : findMatches(detail, folded)[ref.index - inText.length];
    if (!range) return;
    if (hiddenAt(field === "text" ? text : detail, previewLimit(line, field), range[0])) {
      setOpen((value) => (value.has(`${line.id}:${field}`) ? value : new Set(value).add(`${line.id}:${field}`)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref?.key, ref?.index, folded]);

  const toggle = useCallback((key: string) => {
    setOpen((value) => {
      const next = new Set(value);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  // Roda a cada desenho de propósito: acompanha o fim da conversa e leva o resultado da busca à vista.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = screen.current;
    if (!el) return;
    if (pendingScroll.current) {
      const target = el.querySelector<HTMLElement>('[data-hit-current="true"]');
      if (target) {
        pendingScroll.current = false;
        stick.current = false;
        setAtEnd(false);
        target.scrollIntoView({ block: "center" });
        return;
      }
      if (folded) return;
    }
    if (heightBefore.current !== null) {
      // Carregou linhas antigas no topo: o texto que o dono lia não pula.
      el.scrollTop += el.scrollHeight - heightBefore.current;
      heightBefore.current = null;
      return;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  });

  // Novas mensagens enquanto o dono lê mais acima (sem puxar a tela).
  useEffect(() => {
    setUnread((value) => nextUnread(value, previousTotal.current, lines.length, stick.current));
    previousTotal.current = lines.length;
  }, [lines.length]);

  // A tela muda de tamanho (painel abrindo, divisória, aba voltando): se estava no fim, continua no fim.
  useEffect(() => {
    const el = screen.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Ctrl+F dentro da tela de trabalho abre a busca daqui; fora dela, o do navegador segue valendo.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "f" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const box = root.current;
      if (!box || box.offsetParent === null) return; // aba do terminal escondida
      event.preventDefault();
      searchInput.current?.focus();
      searchInput.current?.select();
    };
    // No documento (e não só na tela de trabalho): com o foco no corpo da página, a tecla não passa pelo diálogo.
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const onScroll = () => {
    const el = screen.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    if (stick.current !== atEnd) setAtEnd(stick.current);
    if (stick.current && unread) setUnread(0);
  };

  const jump = () => {
    const el = screen.current;
    if (!el) return;
    stick.current = true;
    setAtEnd(true);
    setUnread(0);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const showOlder = () => {
    heightBefore.current = screen.current?.scrollHeight ?? null;
    if (focus) setFocus({ start: Math.max(0, win.start - WINDOW_STEP), end: win.end });
    else setLimit((value) => value + WINDOW_STEP);
  };

  const showNewer = () => {
    const end = win.end + WINDOW_STEP;
    if (end >= filtered.length) {
      setLimit(filtered.length - win.start);
      setFocus(null);
    } else setFocus({ start: win.start, end });
  };

  const step = (dir: 1 | -1) => {
    pendingScroll.current = true;
    setHit((value) => stepMatch(value >= 0 && value < total ? value : -1, total, dir));
  };

  const chooseFilter = (next: TerminalFilter) => {
    setFilter(next);
    setLimit(WINDOW_STEP);
    setFocus(null);
    saveFilter(agentId, next, storage());
  };

  const closeSearch = () => {
    setQuery("");
    searchInput.current?.blur();
    screen.current?.focus();
  };

  const toggleTimes = () => {
    setShowTime((value) => {
      saveTimes(!value);
      return !value;
    });
  };

  return (
    <div className="aterm" data-testid={testId} ref={root}>
      <TerminalToolbar
        live={live}
        filter={filter}
        onFilter={chooseFilter}
        query={query}
        onQuery={setQuery}
        current={current}
        total={total}
        onStep={step}
        onCloseSearch={closeSearch}
        inputRef={searchInput}
        showTime={showTime}
        onToggleTimes={toggleTimes}
      />
      <div ref={screen} className="aterm__screen" onScroll={onScroll} tabIndex={0} role="log" aria-label={`Terminal de ${agentName} (só leitura)`} aria-live="off" data-testid={`${testId}-screen`}>
        {lines.length === 0 ? (
          <div className="aterm__empty">{empty}</div>
        ) : filtered.length === 0 ? (
          <div className="aterm__empty">Nada para mostrar com este filtro.</div>
        ) : (
          <>
            {hiddenUp > 0 && (
              <button type="button" className="aterm__older" onClick={showOlder} data-testid="agent-terminal-older">
                ↑ Mostrar {Math.min(WINDOW_STEP, hiddenUp)} anteriores ({hiddenUp} escondidas)
              </button>
            )}
            {shown.map((line) => (
              <Line
                key={line.id}
                line={line}
                showTime={showTime}
                folded={folded}
                currentHit={ref?.key === line.id ? ref.index : -1}
                openText={open.has(`${line.id}:text`)}
                openDetail={open.has(`${line.id}:detail`)}
                onToggle={toggle}
              />
            ))}
            {hiddenDown > 0 && (
              <button type="button" className="aterm__older" onClick={showNewer} data-testid="agent-terminal-newer">
                ↓ Mostrar {Math.min(WINDOW_STEP, hiddenDown)} mais recentes ({hiddenDown} escondidas)
              </button>
            )}
          </>
        )}
        {live && !folded && hiddenDown === 0 && (
          <div className="aterm__cursor" aria-hidden="true">
            <span className="aterm__prefix">❯</span>
            <span className="aterm__caret" />
          </div>
        )}
      </div>
      {!atEnd && filtered.length > 0 && (
        <button type="button" className="aterm__jump" data-unread={unread > 0 ? "true" : undefined} onClick={jump} data-testid="agent-terminal-jump">
          <span aria-hidden="true">↓</span> {unread > 0 ? `Novas mensagens (${unread})` : "Ir para o fim"}
        </button>
      )}
      <TerminalFooter entries={entries} live={live} />
    </div>
  );
}
