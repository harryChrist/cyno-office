import type { AgentRulesResponse, OfficeState } from "@cyno/shared";
import { useEffect, useId, useRef, useState } from "react";
import { api, describeError } from "../../api/client";
import { Markdown } from "../../ui/markdown/Markdown";
import { agentRulesHash, agentRulesState, brainAgents, brainHash } from "./brainView";
import { BrainIcon } from "./brainIcons";
import { RulesEditor } from "./RulesEditor";

const noWiki = () => null;

type Loaded = { key: string; rules: Record<string, string>; failed: boolean };

/**
 * "Regras por agente": os agentes da sala com o estado das regras de cada um (sem regras ou quantas
 * linhas). Clicar abre as regras dele no leitor. `version` muda quando alguma regra foi salva.
 */
export function AgentRulesBlock({
  workspaceId,
  brainId,
  office,
  activeAgentId,
  version,
}: {
  workspaceId: string;
  brainId: string;
  office: OfficeState | null;
  activeAgentId: string | null;
  version: number;
}) {
  const agents = brainAgents(office, brainId);
  const ids = agents.map((agent) => agent.id).join(",");
  const key = `${ids}|${version}`;
  const [loaded, setLoaded] = useState<Loaded>({ key: "", rules: {}, failed: false });

  useEffect(() => {
    if (!ids) return;
    let stale = false;
    Promise.all(ids.split(",").map((id) => api.getAgentRules(id).then((response) => [id, response.content] as const)))
      .then((pairs) => !stale && setLoaded({ key, rules: Object.fromEntries(pairs), failed: false }))
      .catch(() => !stale && setLoaded((previous) => ({ ...previous, key, failed: true })));
    return () => {
      stale = true;
    };
  }, [ids, key]);

  if (agents.length === 0) return null;
  const ready = loaded.key === key;
  return (
    <div className="brain-group brain-agents" data-testid="brain-agent-rules">
      <p className="brain-group__title">
        Regras por agente <span className="brain-group__count">{agents.length}</span>
      </p>
      <p className="brain-group__hint">Cada agente recebe só as regras dele, em toda tarefa.</p>
      <ul className="brain-notes">
        {agents.map((agent) => {
          const content = loaded.rules[agent.id];
          const state = content === undefined ? (ready && loaded.failed ? "não carregou" : "…") : agentRulesState(content);
          return (
            <li key={agent.id}>
              <a
                className="brain-note brain-agent"
                href={agentRulesHash(workspaceId, brainId, agent.id)}
                aria-current={agent.id === activeAgentId ? "page" : undefined}
                data-testid={`brain-agent-${agent.id}`}
              >
                <span className="brain-agent__avatar" aria-hidden="true">
                  {agent.name.charAt(0).toUpperCase()}
                </span>
                <span className="brain-note__main">
                  <span className="brain-note__title">{agent.name}</span>
                  <span className="brain-note__meta">
                    <span className="brain-agent__state" data-empty={content !== undefined && state === "sem regras"}>
                      {state}
                    </span>
                  </span>
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type State = { data: AgentRulesResponse | null; error: string | null };

/** Regras de um agente no leitor: texto como nota e o mesmo fluxo de edição. Monte com `key` = agente. */
export function AgentRulesReader({
  workspaceId,
  brainId,
  agentId,
  agentName,
  onSaved,
}: {
  workspaceId: string;
  brainId: string;
  agentId: string;
  agentName: string;
  onSaved: () => void;
}) {
  const [state, setState] = useState<State>({ data: null, error: null });
  const [editing, setEditing] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();

  useEffect(() => {
    let stale = false;
    api
      .getAgentRules(agentId)
      .then((data) => !stale && setState({ data, error: null }))
      .catch((error: unknown) => !stale && setState({ data: null, error: describeError(error) }));
    return () => {
      stale = true;
    };
  }, [agentId]);

  useEffect(() => {
    if (state.data) titleRef.current?.focus();
  }, [state.data]);

  const back = (
    <a className="brain-back brain-reader__back" href={brainHash(workspaceId, brainId)} data-testid="brain-back-notes">
      <BrainIcon name="voltar" size={16} />
      Notas
    </a>
  );
  if (!state.data) {
    return (
      <article className="brain-col brain-col--reader brain-reader" aria-busy={!state.error} data-testid="brain-agent-reader">
        {back}
        {state.error ? <p className="brain-error">{state.error}</p> : <p className="brain-empty">Abrindo as regras…</p>}
      </article>
    );
  }
  const { content } = state.data;
  return (
    <article className="brain-col brain-col--reader brain-reader brain-reader--regras" aria-labelledby={titleId} data-testid="brain-agent-reader">
      {back}
      <div className="brain-reader__inner">
        <header className="brain-reader__header">
          <p className="brain-reader__eyebrow">
            <span className="brain-reader__type">
              <BrainIcon name="regras" size={14} />
              Regras do agente
            </span>
          </p>
          <h3 id={titleId} ref={titleRef} tabIndex={-1} className="brain-reader__title" data-testid="brain-reader-title">
            Regras de {agentName}
          </h3>
          <p className="brain-reader__hint">Só {agentName} recebe estas regras, em toda tarefa.</p>
          {!editing && (
            <div className="brain-reader__tools">
              <button type="button" className="ui-button ui-button--small ui-button--secondary" onClick={() => setEditing(true)} data-testid="brain-rules-edit">
                Editar
              </button>
            </div>
          )}
        </header>
        {editing ? (
          <RulesEditor
            testId="brain-rules-editor"
            label={`Regras de ${agentName}`}
            initial={content}
            onCancel={() => setEditing(false)}
            onSave={async (next) => {
              const saved = await api.setAgentRules(agentId, next);
              setState({ data: saved, error: null });
              setEditing(false);
              onSaved();
            }}
          />
        ) : (
          <div className="brain-reader__body" data-testid="brain-reader-body">
            {content.trim() ? <Markdown source={content} resolveWiki={noWiki} idPrefix={titleId} /> : <p className="brain-empty">Nenhuma regra ainda. Clique em Editar para escrever a primeira.</p>}
          </div>
        )}
      </div>
    </article>
  );
}
