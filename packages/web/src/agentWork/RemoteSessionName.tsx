import { maestroSessionName, type AgentTerminalInfo, type Workspace } from "@cyno/shared";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, describeError } from "../api/client";
import { sessionNameError } from "../ui/workspaceForm";
import { copyText } from "./MaestroTerminal";
import { remoteSessionView } from "./remoteControl";

function Pencil() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M5 15V5a1 1 0 0 1 1-1h10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * "Remote Control: <nome>" no cabeçalho do painel do Maestro: o ponto diz se está ligado; dá para
 * copiar o nome, abrir a sessão (app do Claude / claude.ai/code) e trocar o nome ali mesmo (lápis:
 * Enter salva, Esc cancela). Com o Maestro ocupado, o nome novo entra quando ele ficar livre.
 */
export function RemoteSessionName({ info, workspace }: { info: AgentTerminalInfo | undefined; workspace: Workspace | undefined }) {
  const view = remoteSessionView(info, workspace);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!view || !workspace) return null;
  const custom = workspace.maestro?.sessionName ?? "";
  const defaultName = maestroSessionName(undefined, workspace.name);

  const start = () => {
    setDraft(custom || view.pending || view.name);
    setError(null);
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setError(null);
    editRef.current?.focus();
  };
  const save = async () => {
    const problem = sessionNameError(draft);
    if (problem) {
      setError(problem);
      return;
    }
    // Igual ao padrão = volta a seguir o nome do workspace.
    const next = draft.trim() === defaultName ? "" : draft.trim();
    if (next === custom) {
      cancel();
      return;
    }
    setSaving(true);
    try {
      await api.updateWorkspaceMaestro(workspace.id, { sessionName: next });
      setEditing(false);
      setError(null);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setSaving(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void save();
    } else if (event.key === "Escape") {
      // O Esc é do campo: não recolhe o painel.
      event.preventDefault();
      cancel();
    }
  };

  if (editing) {
    return (
      <span className="rc-name rc-name--editing" data-testid="maestro-session-name">
        <label className="rc-name__label" htmlFor="maestro-session-name-input">
          Remote Control
        </label>
        <input
          ref={inputRef}
          id="maestro-session-name-input"
          className="ui-input rc-name__input"
          value={draft}
          placeholder={defaultName}
          maxLength={90}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "maestro-session-name-error" : undefined}
          onChange={(e) => {
            setDraft(e.currentTarget.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          disabled={saving}
          data-testid="maestro-session-name-input"
        />
        <button type="button" className="rc-name__action rc-name__action--primary" onClick={() => void save()} disabled={saving} data-testid="maestro-session-name-save">
          {saving ? "Salvando…" : "Salvar"}
        </button>
        <button type="button" className="rc-name__action" onClick={cancel} disabled={saving}>
          Cancelar
        </button>
        <span className="rc-name__note">Vazio = “{defaultName}”</span>
        {error && (
          <span id="maestro-session-name-error" className="rc-name__error" role="alert">
            {error}
          </span>
        )}
      </span>
    );
  }

  return (
    <span className={`rc-name rc-name--${view.state}`} data-testid="maestro-session-name" data-state={view.state} title={view.hint}>
      <span className="rc-name__dot" aria-hidden="true" />
      <span className="rc-name__label">
        Remote Control <span className="rc-name__state">{view.stateLabel}</span>
      </span>
      <span className="rc-name__value" data-testid="maestro-session-name-value">
        {view.name}
      </span>
      <button ref={editRef} type="button" className="rc-name__icon" aria-label="Trocar o nome da sessão do Remote Control" title="Trocar o nome da sessão" onClick={start} data-testid="maestro-session-name-edit">
        <Pencil />
      </button>
      <button
        type="button"
        className="rc-name__icon"
        aria-label={copied ? "Nome copiado" : "Copiar o nome da sessão"}
        title={copied ? "Copiado" : "Copiar o nome"}
        onClick={() => {
          copyText(view.name);
          setCopied(true);
        }}
        data-testid="maestro-session-name-copy"
      >
        {copied ? "✓" : <CopyIcon />}
      </button>
      {view.state === "active" && (
        <a className="rc-name__open" href={view.href} target="_blank" rel="noopener noreferrer" data-testid="maestro-remote-control">
          abrir ↗
        </a>
      )}
      {view.pending && (
        <span className="rc-name__pending" role="status" data-testid="maestro-session-name-pending">
          “{view.pending}” entra quando o Maestro ficar livre
        </span>
      )}
    </span>
  );
}
