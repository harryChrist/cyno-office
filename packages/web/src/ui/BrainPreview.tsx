import type { BrainContext, OfficeState, Room } from "@cyno/shared";
import { useEffect, useMemo, useState } from "react";
import { api, describeError } from "../api/client";
import { countLabel } from "./format";
import { summarizeBrain } from "./selectors";

type BrainState = { key: string; context: BrainContext | null; error: string | null };

/**
 * Preview do contexto (GET /api/rooms/:id/context): de quais Cérebros os agentes do quarto
 * leem notas, e quais ficam de fora. Recarrega quando o compartilhamento muda ou uma tarefa termina
 * (tarefa concluída vira nota).
 */
export function BrainPreview({ room, office }: { room: Room; office: OfficeState }) {
  const doneCount = office.tasks.filter((task) => task.status === "done").length;
  const key = `${room.id}|${room.readsGlobalBrain}|${[...room.readsBrainsOf].sort().join(",")}|${doneCount}`;
  const [state, setState] = useState<BrainState>({ key: "", context: null, error: null });

  useEffect(() => {
    let stale = false;
    // Sem AbortController: um fetch abortado vira "requestfailed" no navegador. A resposta velha só é ignorada.
    api
      .getContext(room.id)
      .then((context) => !stale && setState({ key, context, error: null }))
      .catch((error: unknown) => !stale && setState({ key, context: null, error: describeError(error) }));
    return () => {
      stale = true;
    };
  }, [key, room.id]);

  const summary = useMemo(() => (state.context ? summarizeBrain(state.context, room, office.rooms) : null), [state.context, room, office.rooms]);
  const loading = state.key !== key;

  return (
    <div className="brain" data-testid="brain-preview" data-loading={loading} aria-busy={loading}>
      <p className="ui-muted brain__intro">O que os agentes desta sala leem do Cérebro ao trabalhar (regras, briefing, índice e as notas que cabem; o resto eles buscam):</p>
      {state.error && <p className="ui-error">Não foi possível ler o Cérebro: {state.error}</p>}
      {!summary && !state.error && <p className="ui-muted">Carregando…</p>}
      {summary && (
        <>
          <ul className="brain__sources">
            {summary.sources.map((source) => (
              <li key={`${source.kind}-${source.id}`} className={`brain-source brain-source--${source.kind}`} data-testid={`brain-source-${source.kind}-${source.id}`}>
                <details>
                  <summary>
                    <span className="brain-source__kind">{source.label}</span>
                    <span className="brain-source__name">{source.name}</span>
                    <span className="brain-source__count" data-testid="brain-note-count">
                      {countLabel(source.notes.length, "nota", "notas")}
                      {source.omitted > 0 && ` (+${source.omitted} pela busca)`}
                    </span>
                  </summary>
                  {source.notes.length === 0 ? (
                    <p className="ui-muted ui-empty">Sem notas ainda.</p>
                  ) : (
                    <ul className="brain-source__notes">
                      {source.notes.map((title, index) => (
                        <li key={`${index}-${title}`}>{title}</li>
                      ))}
                    </ul>
                  )}
                </details>
              </li>
            ))}
          </ul>
          {summary.hidden.length > 0 && (
            <div className="brain__hidden" data-testid="brain-hidden">
              <p className="brain__hidden-title">Não enxerga:</p>
              <ul>
                {summary.hidden.map((item) => (
                  <li key={item.id} data-testid={`brain-hidden-${item.id}`}>
                    {item.name} <span className="ui-muted">({item.reason})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
