import { type SentRequestView } from "@cyno/shared";
import { useState } from "react";
import { useCynoStore } from "../../store/cynoStore";
import { isOpenRequest, openRequestProject, requestLine, requestTone, stateLabel, tasksLabel } from "./cynoRequests";
import "./cynoRequests.css";

/**
 * O cartão compacto de um pedido que o Cyno enviou a um Maestro, ao vivo ("Enviado ao LinkedIn · Post da
 * semana · 2/4 tarefas · esperando você (1)"), com o link para o projeto na tela Trabalho do workspace.
 * `view` ausente (o workspace foi apagado): mostra só o título.
 */
export function RequestCard({ view, fallback, compact = false }: { view: SentRequestView | undefined; fallback: { workspace: string; title: string }; compact?: boolean }) {
  if (!view) {
    return (
      <div className="rcard rcard--gone" data-testid="request-card">
        <span className="rcard__line">Enviado a {fallback.workspace} · {fallback.title}</span>
      </div>
    );
  }
  const tone = requestTone(view.state);
  return (
    <div className={`rcard rcard--${tone}${compact ? " rcard--compact" : ""}`} data-testid="request-card" data-state={view.state} data-request-id={view.projectId}>
      <span className="rcard__mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16">
          <path d="M4 12l15-7-4 15-3.5-5.5L4 12z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="rcard__body">
        <span className="rcard__line" title={requestLine(view)}>
          <span className="rcard__to">Enviado ao {view.workspaceName}</span>
          <span className="rcard__sep" aria-hidden="true">·</span>
          <span className="rcard__title">{view.title}</span>
          {tasksLabel(view) && (
            <>
              <span className="rcard__sep" aria-hidden="true">·</span>
              <span className="rcard__tasks">{tasksLabel(view)}</span>
            </>
          )}
        </span>
        <span className="rcard__meta">
          {compact && <span className="rcard__where">{view.workspaceName}</span>}
          {compact && tasksLabel(view) && <span className="rcard__tasks">{tasksLabel(view)}</span>}
          <span className={`rcard__state rcard__state--${tone}`} data-testid="request-state">
            {view.state === "esperando_voce" && view.waitingForYou > 0 ? `esperando você (${view.waitingForYou})` : stateLabel(view)}
          </span>
          {view.stage && <span className="rcard__stage">{view.stage}</span>}
        </span>
      </span>
      <button type="button" className="rcard__open" onClick={() => openRequestProject(view.workspace, view.projectId)} aria-label={`Abrir ${view.title} em Projetos e tarefas de ${view.workspaceName}`} data-testid="request-open">
        Abrir
        <span aria-hidden="true"> ↗</span>
      </button>
    </div>
  );
}

const SHOWN = 8;

/** Uma linha de pedido para o Resumo: título, para onde foi e o estado; clicar abre o projeto. */
export function RequestRow({ view }: { view: SentRequestView }) {
  const tone = requestTone(view.state);
  return (
    <button type="button" className="rrow" onClick={() => openRequestProject(view.workspace, view.projectId)} aria-label={`Abrir ${view.title} em Projetos e tarefas de ${view.workspaceName}`} data-testid="request-row" data-state={view.state}>
      <span className="rrow__main">
        <span className="rrow__title">{view.title}</span>
        <span className="rrow__meta">
          {view.workspaceName}
          {tasksLabel(view) ? ` · ${tasksLabel(view)}` : ""}
        </span>
      </span>
      <span className={`rcard__state rcard__state--${tone}`}>{view.state === "esperando_voce" && view.waitingForYou > 0 ? `esperando você (${view.waitingForYou})` : stateLabel(view)}</span>
    </button>
  );
}

/** "Pedidos enviados" completo (aba Workspaces): o estado de cada pedido que o Cyno mandou aos Maestros, os abertos primeiro; some sem pedidos. */
export function SentRequestsSection() {
  const requests = useCynoStore((state) => state.requests);
  const [all, setAll] = useState(false);
  if (requests.length === 0) return null;
  const sorted = [...requests].sort((a, b) => Number(isOpenRequest(b)) - Number(isOpenRequest(a)) || b.sentAt.localeCompare(a.sentAt));
  const open = sorted.filter(isOpenRequest).length;
  const shown = all ? sorted : sorted.slice(0, SHOWN);
  return (
    <section className="rsec" aria-labelledby="rsec-title" data-testid="sent-requests" data-expanded="true">
      <header className="rsec__head">
        <h3 className="rsec__title" id="rsec-title">
          Pedidos enviados
        </h3>
        <span className={`rsec__count${open > 0 ? " rsec__count--on" : ""}`}>{open > 0 ? `${open} ${open === 1 ? "aberto" : "abertos"}` : `${sorted.length} ${sorted.length === 1 ? "fechado" : "fechados"}`}</span>
      </header>
      <ul className="rsec__list" id="rsec-list">
        {shown.map((view) => (
          <li key={view.projectId}>
            <RequestCard view={view} fallback={{ workspace: view.workspace, title: view.title }} compact />
          </li>
        ))}
      </ul>
      {sorted.length > SHOWN && (
        <button type="button" className="rsec__more" onClick={() => setAll((value) => !value)}>
          {all ? "Mostrar menos" : `Ver todos (${sorted.length})`}
        </button>
      )}
    </section>
  );
}
