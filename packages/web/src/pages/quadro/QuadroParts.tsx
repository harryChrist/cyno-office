import { BOARD_LIMITS, BOARD_SHARE_EXPIRY_DAY_OPTIONS, boardFileName, buildBoardDocument, publicBoardMeta, type Board, type BoardKitExportFormat, type BoardShare } from "@cyno/shared";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, describeError } from "../../api/client";
import { copyText } from "../../ui/clipboard";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ConfirmDialog, ErrorText, Field, Modal } from "../../ui/widgets";
import { currentExpiryOption, expiryOptionLabel, isLocalHostname, shareExpiryLabel, shareLink } from "./quadroView";

/** Ícones de traço (24x24) das ações do cabeçalho do quadro. */
const ICONS = {
  refresh: ["M21 12a9 9 0 1 1-3-6.7L21 8", "M21 3v5h-5"],
  edit: ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"],
  trash: ["M3 6h18", "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", "M10 11v6", "M14 11v6"],
  back: ["m15 18-6-6 6-6"],
  chevron: ["m6 9 6 6 6-6"],
  search: ["M11 3a8 8 0 1 0 0 16a8 8 0 1 0 0-16Z", "m21 21-4.3-4.3"],
  share: ["M18 2a3 3 0 1 0 0 6a3 3 0 1 0 0-6Z", "M6 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6Z", "M18 16a3 3 0 1 0 0 6a3 3 0 1 0 0-6Z", "m8.6 13.5 6.8 4", "m15.4 6.5-6.8 4"],
  download: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5", "M12 15V3"],
  info: ["M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20Z", "M12 16v-4", "M12 8h.01"],
} as const;

export function QIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICONS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** Relógio que faz o "há X min" andar sozinho. */
export function useNow(everyMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** Renomear: título e descrição do quadro (a página e os dados não mudam). */
export function RenameDialog({ board, onSubmit, onClose }: { board: Board; onSubmit: (body: { title: string; description: string }) => Promise<unknown>; onClose: () => void }) {
  const [title, setTitle] = useState(board.title);
  const [description, setDescription] = useState(board.description);
  const { pending, error, run } = useAsyncAction();
  const valid = title.trim().length > 0;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const done = await run(async () => {
      await onSubmit({ title: title.trim(), description: description.trim() });
      return true;
    });
    if (done) onClose();
  };
  return (
    <Modal title="Renomear o quadro" onClose={onClose} testId="quadro-rename-dialog">
      <form className="quadro-form" onSubmit={(event) => void submit(event)}>
        <Field label="Título">
          {(props) => <input {...props} className="ui-input" value={title} maxLength={BOARD_LIMITS.title} onChange={(event) => setTitle(event.target.value)} autoFocus onFocus={(event) => event.currentTarget.select()} data-testid="quadro-rename-title" />}
        </Field>
        <Field label="Descrição" hint="Uma linha sobre o que o quadro mostra.">
          {(props) => <textarea {...props} className="ui-input" rows={3} value={description} maxLength={BOARD_LIMITS.description} onChange={(event) => setDescription(event.target.value)} data-testid="quadro-rename-description" />}
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="ui-actions">
          <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="ui-button" disabled={!valid || pending} data-testid="quadro-rename-confirm">
            {pending ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Baixar ----------

/** Baixa um arquivo pelo navegador (Blob + link com `download`, o object URL é revogado). Nunca abre `blob:` numa aba: o script do agente rodaria na origem do app. */
function saveFile(name: string, content: Blob | string, type: string): void {
  const blob = typeof content === "string" ? new Blob([content], { type }) : content;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

type DownloadFormat = "html" | "pdf" | "md" | "csv" | "json";
const DOWNLOADS: { id: DownloadFormat; label: string; hint: string }[] = [
  { id: "html", label: "Página (HTML)", hint: "Abre em qualquer navegador, sem internet." },
  { id: "pdf", label: "PDF", hint: "Para imprimir ou mandar por mensagem." },
  { id: "md", label: "Texto (Markdown)", hint: "Títulos, tabelas e números em texto." },
  { id: "csv", label: "Planilha (CSV)", hint: "As tabelas do quadro, para abrir no Excel." },
  { id: "json", label: "Dados (JSON)", hint: "Os dados crus que alimentam o quadro." },
];

/** Botão "Baixar" do cabeçalho: menu com HTML, PDF, Markdown, CSV e JSON. `source` é a página e os dados atuais (null enquanto o quadro abre). */
export function DownloadMenu({ board, source, exportAs }: { board: Board; source: { html: string; data: unknown } | null; exportAs: ((format: BoardKitExportFormat) => Promise<string>) | null }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<DownloadFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    itemRefs.current[0]?.focus();
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const onMenuKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close(true);
      return;
    }
    const items = itemRefs.current.filter((item): item is HTMLButtonElement => Boolean(item) && !item?.disabled);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => {
      event.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(items.length - 1);
  };

  const choose = async (format: DownloadFormat) => {
    setError(null);
    setBusy(format);
    try {
      if (format === "pdf") {
        saveFile(boardFileName(board.title, "pdf"), await api.downloadBoardPdf(board.id), "application/pdf");
      } else if (!source) {
        throw new Error("O quadro ainda está abrindo. Tente de novo em instantes.");
      } else if (format === "html") {
        saveFile(boardFileName(board.title, "html"), buildBoardDocument({ html: source.html, data: source.data, meta: publicBoardMeta(board) }), "text/html");
      } else if (format === "json") {
        saveFile(boardFileName(board.title, "json"), JSON.stringify(source.data ?? null, null, 2), "application/json");
      } else {
        if (!exportAs) throw new Error("O quadro ainda está abrindo. Tente de novo em instantes.");
        const text = await exportAs(format);
        if (format === "csv" && !text.trim()) throw new Error("Este quadro não tem tabelas para exportar.");
        saveFile(boardFileName(board.title, format), text, format === "md" ? "text/markdown" : "text/csv");
      }
      close(true);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="quadro-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="ui-icon-button quadro-menu__trigger"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Baixar o quadro"
        title="Baixar"
        data-testid="quadro-download"
      >
        <QIcon name="download" />
      </button>
      {open && (
        <div className="quadro-menu__pop" role="menu" aria-label="Baixar o quadro" onKeyDown={onMenuKey} data-testid="quadro-download-menu">
          {DOWNLOADS.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
              role="menuitem"
              className="quadro-menu__item"
              disabled={busy !== null}
              onClick={() => void choose(item.id)}
              data-testid={`quadro-download-${item.id}`}
            >
              <span className="quadro-menu__label">{item.label}</span>
              <span className="quadro-menu__hint">{busy === item.id ? (item.id === "pdf" ? "Gerando o PDF…" : "Preparando…") : item.hint}</span>
            </button>
          ))}
        </div>
      )}
      {error && (
        <div className="quadro-menu__error" data-testid="quadro-download-error">
          <ErrorText>{error}</ErrorText>
          <button type="button" className="ui-icon-button" onClick={() => setError(null)} aria-label="Dispensar aviso">
            ×
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- Compartilhar ----------

type ShareConfirm = "rotate" | "disable" | null;

/** Compartilhar: liga, copia, troca a validade, gera novo link e desliga o link público do quadro. */
export function ShareDialog({ board, onClose }: { board: Board; onClose: () => void }) {
  const [share, setShare] = useState<BoardShare | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [days, setDays] = useState<number>(0);
  const [confirm, setConfirm] = useState<ShareConfirm>(null);
  const [copied, setCopied] = useState(false);
  const { pending, error, run, clearError } = useAsyncAction();
  const inputRef = useRef<HTMLInputElement>(null);
  const copiedTimer = useRef<number | null>(null);

  const fetchShare = useCallback(() => {
    api.getBoardShare(board.id).then(
      (state) => {
        setShare(state);
        setDays(currentExpiryOption(state, BOARD_SHARE_EXPIRY_DAY_OPTIONS));
      },
      (caught: unknown) => setLoadError(describeError(caught)),
    );
  }, [board.id]);
  const retry = () => {
    setLoadError(null);
    fetchShare();
  };
  useEffect(() => {
    fetchShare();
    return () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    };
  }, [fetchShare]);

  const apply = async (action: () => Promise<BoardShare | undefined>) => {
    const next = await run(async () => (await action()) ?? ({ shared: false } as BoardShare));
    if (next) {
      setShare(next);
      setDays(currentExpiryOption(next, BOARD_SHARE_EXPIRY_DAY_OPTIONS));
    }
  };
  const create = () => void apply(() => api.setBoardShare(board.id, { expiresInDays: days }));
  const changeExpiry = (value: number) => {
    setDays(value);
    void apply(() => api.setBoardShare(board.id, { expiresInDays: value }));
  };

  const link = share?.shared ? shareLink(window.location.origin, share.path) : "";
  const copy = async () => {
    clearError();
    if (await copyText(link)) {
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } else {
      // Sem permissão para copiar: deixa o texto selecionado para a pessoa copiar na mão.
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  };

  const expirySelect = (onChange: (value: number) => void) => (
    <Field label="Validade do link">
      {(props) => (
        <select {...props} className="ui-input" value={days} disabled={pending} onChange={(event) => onChange(Number(event.target.value))} data-testid="quadro-share-expiry">
          {BOARD_SHARE_EXPIRY_DAY_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {expiryOptionLabel(option)}
            </option>
          ))}
        </select>
      )}
    </Field>
  );

  if (confirm === "rotate") {
    return (
      <ConfirmDialog
        title="Gerar novo link"
        message={<p>O link atual para de funcionar.</p>}
        confirmLabel="Gerar novo link"
        pendingLabel="Gerando…"
        onConfirm={async () => {
          const next = await api.rotateBoardShare(board.id);
          setShare(next);
        }}
        onClose={() => setConfirm(null)}
        testId="quadro-share-rotate-dialog"
      />
    );
  }
  if (confirm === "disable") {
    return (
      <ConfirmDialog
        title="Desligar o link"
        message={<p>O link atual para de funcionar. Quem o tiver deixa de ver este quadro.</p>}
        confirmLabel="Desligar o link"
        pendingLabel="Desligando…"
        onConfirm={async () => {
          await api.deleteBoardShare(board.id);
          setShare({ shared: false });
          setDays(0);
        }}
        onClose={() => setConfirm(null)}
        testId="quadro-share-disable-dialog"
      />
    );
  }

  return (
    <Modal title="Compartilhar o quadro" onClose={onClose} testId="quadro-share-dialog">
      <div className="quadro-form quadro-share">
        {loadError ? (
          <div role="alert" data-testid="quadro-share-error">
            <ErrorText>{loadError}</ErrorText>
            <button type="button" className="ui-button ui-button--secondary" onClick={retry}>
              Tentar de novo
            </button>
          </div>
        ) : share === null ? (
          <div className="quadro-state quadro-state--inline" role="status" data-testid="quadro-share-loading">
            <span className="quadro-spinner" aria-hidden="true" />
            Carregando…
          </div>
        ) : !share.shared ? (
          <>
            <p>Crie um link para mostrar este quadro a outras pessoas. Quem tiver o link vê só este quadro, sem senha e sem acesso a mais nada.</p>
            {expirySelect(setDays)}
          </>
        ) : (
          <>
            <Field label="Link do quadro">
              {(props) => (
                <div className="quadro-share__row">
                  <input {...props} ref={inputRef} className="ui-input" readOnly value={link} onFocus={(event) => event.currentTarget.select()} data-testid="quadro-share-link" />
                  <button type="button" className="ui-button" onClick={() => void copy()} data-testid="quadro-share-copy">
                    {copied ? "Copiado" : "Copiar"}
                  </button>
                </div>
              )}
            </Field>
            {isLocalHostname(window.location.hostname) && (
              <p className="quadro-share__warn" role="note" data-testid="quadro-share-local">
                Este link usa o endereço da sua rede local e só abre para quem está nela. Para mandar a alguém de fora, abra o Cyno pelo endereço público e copie o link de lá.
              </p>
            )}
            <p className="quadro-share__expiry" data-testid="quadro-share-expiry-label">
              {shareExpiryLabel(share)}
            </p>
            {expirySelect(changeExpiry)}
            <div className="quadro-share__links">
              <button type="button" className="ui-button ui-button--secondary" onClick={() => setConfirm("rotate")} disabled={pending} data-testid="quadro-share-rotate">
                Gerar novo link
              </button>
              <button type="button" className="ui-button ui-button--secondary quadro-share__off" onClick={() => setConfirm("disable")} disabled={pending} data-testid="quadro-share-disable">
                Desligar o link
              </button>
            </div>
          </>
        )}
        <p className="quadro-share__note">O link mostra o quadro como ele estiver na hora em que a pessoa abrir. Tudo que aparece no quadro fica visível para quem tiver o link.</p>
        <ErrorText>{error}</ErrorText>
        <div className="ui-actions">
          <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
            Fechar
          </button>
          {share && !share.shared && (
            <button type="button" className="ui-button" onClick={create} disabled={pending} data-testid="quadro-share-create">
              {pending ? "Criando…" : "Criar link"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
