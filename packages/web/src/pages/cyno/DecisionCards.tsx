import { DANGEROUS_ACTION_LABELS, type Confirmation, type WorkspaceProposal } from "@cyno/shared";
import { useEffect, useState } from "react";
import { useCynoStore } from "../../store/cynoStore";
import { useNavStore } from "../../store/navStore";
import { agentEngineLabel, confirmationLabel, confirmationTone, liveStatus, pendingDecisions, proposalTotals, purposeLabel, remainingLabel, routineLabel } from "./cynoDecisions";
import "./cynoDecisions.css";

/** Um relógio de 1 s enquanto `active` (a contagem da validade); parado, não gasta nada. */
function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M12 4 2.8 19.5h18.4L12 4z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M12 10v4.5M12 17.2v.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function PackageIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M3.5 8 12 3.5 20.5 8v8L12 20.5 3.5 16V8z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M3.8 8.2 12 12.5l8.2-4.3M12 12.5v8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

/** O cartão de uma ação perigosa que o Cyno pediu: o que vai acontecer em linguagem clara, [Confirmar] [Recusar] e o resultado depois. */
export function ConfirmationCard({ confirmation }: { confirmation: Confirmation | undefined }) {
  const decide = useCynoStore((state) => state.decide);
  const busy = useCynoStore((state) => (confirmation ? state.deciding.includes(confirmation.id) : false));
  const waiting = confirmation?.status === "pendente";
  const now = useClock(waiting === true);
  if (!confirmation) {
    return (
      <div className="dcard dcard--idle" data-testid="confirmation-card" data-status="gone">
        <p className="dcard__gone">Este pedido de confirmação não está mais disponível.</p>
      </div>
    );
  }
  const status = liveStatus(confirmation, now);
  const tone = confirmationTone(status);
  const pending = status === "pendente";
  const isCommand = confirmation.action === "run_host_command";
  return (
    <article className={`dcard dcard--${tone}`} data-testid="confirmation-card" data-status={status} data-action={confirmation.action} aria-label={`${DANGEROUS_ACTION_LABELS[confirmation.action]}: ${confirmation.summary}`}>
      <header className="dcard__head">
        <span className="dcard__icon" aria-hidden="true">
          <WarnIcon />
        </span>
        <span className="dcard__kind">{DANGEROUS_ACTION_LABELS[confirmation.action]}</span>
        <span className={`dcard__state dcard__state--${tone}`} data-testid="confirmation-state">
          {confirmationLabel(status)}
        </span>
      </header>
      <p className="dcard__summary" data-testid="confirmation-summary">
        {confirmation.summary}
      </p>
      {confirmation.impact && !confirmation.summary.includes(confirmation.impact) && <p className="dcard__impact">{confirmation.impact}</p>}
      {confirmation.reason && (
        <p className="dcard__reason">
          <span className="dcard__reason-who">Cyno diz:</span> {confirmation.reason}
        </p>
      )}
      {confirmation.details.length > 0 && (
        <details className="dcard__details">
          <summary>Ver detalhes</summary>
          <ul>
            {confirmation.details.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </details>
      )}
      {pending ? (
        <footer className="dcard__foot">
          <button type="button" className="ui-button cyno-solid" disabled={busy} onClick={() => void decide("confirmation", confirmation.id, "approve")} data-testid="confirmation-approve">
            {busy ? "Aguarde…" : "Confirmar"}
          </button>
          <button type="button" className="ui-button ui-button--ghost" disabled={busy} onClick={() => void decide("confirmation", confirmation.id, "reject")} data-testid="confirmation-reject">
            Recusar
          </button>
          <span className="dcard__timer" data-testid="confirmation-timer">
            {remainingLabel(confirmation.expiresAt, now)}
          </span>
        </footer>
      ) : (
        <Outcome confirmation={confirmation} status={status} command={isCommand} />
      )}
    </article>
  );
}

function Outcome({ confirmation, status, command }: { confirmation: Confirmation; status: Confirmation["status"]; command: boolean }) {
  if (status === "expirada") return <p className="dcard__outcome">Passou de 30 minutos sem resposta: nada foi feito. Peça de novo ao Cyno se ainda quiser.</p>;
  if (status === "recusada") return <p className="dcard__outcome">Você recusou: nada foi feito e o Cyno foi avisado.</p>;
  if (status === "autorizada") return <p className="dcard__outcome">Executando…</p>;
  if (!confirmation.result) return null;
  return command ? (
    <pre className="dcard__output" data-testid="confirmation-result">
      {confirmation.result}
    </pre>
  ) : (
    <p className="dcard__outcome" data-testid="confirmation-result">
      {confirmation.result}
    </p>
  );
}

/** O cartão da proposta de um workspace inteiro: salas, equipe com motor/modelo, conectores, sites, rotinas e [Criar workspace] [Ajustar] [Recusar]. */
export function ProposalCard({ proposal, onAdjust }: { proposal: WorkspaceProposal | undefined; onAdjust: (proposal: WorkspaceProposal) => void }) {
  const decide = useCynoStore((state) => state.decide);
  const busy = useCynoStore((state) => (proposal ? state.deciding.includes(proposal.id) : false));
  const openWorkspace = (id: string) => {
    const nav = useNavStore.getState();
    nav.setWorkspace(id);
    nav.go("office");
  };
  if (!proposal) {
    return (
      <div className="dcard dcard--idle" data-testid="proposal-card" data-status="gone">
        <p className="dcard__gone">Esta proposta não está mais disponível.</p>
      </div>
    );
  }
  const { plan } = proposal;
  const open = proposal.status === "proposta" || proposal.status === "falhou";
  const tone = proposal.status === "criada" ? "ok" : proposal.status === "falhou" ? "bad" : proposal.status === "recusada" ? "idle" : "wait";
  const label = { proposta: "Aguardando você", aprovada: "Criando…", criando: "Criando…", criada: "Workspace criado", falhou: "Falhou e foi desfeito", recusada: "Você recusou" }[proposal.status];
  return (
    <article className={`dcard dcard--proposal dcard--${tone}`} data-testid="proposal-card" data-status={proposal.status} aria-label={`Proposta de workspace: ${plan.name}`}>
      <header className="dcard__head">
        <span className="dcard__icon dcard__icon--pkg" aria-hidden="true">
          <PackageIcon />
        </span>
        <span className="dcard__kind">
          Proposta de workspace{proposal.version > 1 ? ` · versão ${proposal.version}` : ""}
        </span>
        <span className={`dcard__state dcard__state--${tone}`} data-testid="proposal-state">
          {label}
        </span>
      </header>
      <h4 className="pcard__name">{plan.name}</h4>
      {plan.summary && <p className="pcard__summary">{plan.summary}</p>}
      <p className="pcard__totals">{proposalTotals(plan)}</p>

      <ul className="pcard__rooms">
        {plan.rooms.map((room) => (
          <li key={room.name} className="pcard__room">
            <div className="pcard__room-head">
              <span className="pcard__room-name">{room.name}</span>
              <span className="pcard__chip">{purposeLabel(room.purpose)}</span>
            </div>
            {room.teams.map((team) => (
              <div key={team.name} className="pcard__team">
                <div className="pcard__team-head">
                  <span className="pcard__team-name">{team.name}</span>
                  {team.focus && <span className="pcard__team-focus">{team.focus}</span>}
                </div>
                <ul className="pcard__agents">
                  {team.agents.map((agent) => (
                    <li key={agent.name} className="pcard__agent" data-engine={agent.engine}>
                      <span className="pcard__agent-name">{agent.name}</span>
                      {agent.role && <span className="pcard__agent-role">{agent.role}</span>}
                      <span className={`pcard__engine pcard__engine--${agent.engine}`}>{agentEngineLabel(agent)}</span>
                      {agent.connectors.map((connector) => (
                        <span key={connector} className="pcard__chip pcard__chip--connector">
                          {connector}
                        </span>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </li>
        ))}
      </ul>

      {(plan.connectors.length > 0 || plan.sites.length > 0 || plan.routines.length > 0) && (
        <dl className="pcard__extras">
          {plan.connectors.length > 0 && (
            <>
              <dt>Conectores</dt>
              <dd>{plan.connectors.map((connector) => connector.id).join(", ")}</dd>
            </>
          )}
          {plan.sites.length > 0 && (
            <>
              <dt>Sites com login seu</dt>
              <dd>{plan.sites.map((site) => site.domain).join(", ")}</dd>
            </>
          )}
          {plan.routines.length > 0 && (
            <>
              <dt>Rotinas</dt>
              <dd>{plan.routines.map(routineLabel).join(" · ")}</dd>
            </>
          )}
        </dl>
      )}
      {plan.notes && <p className="dcard__reason">{plan.notes}</p>}
      {proposal.warnings.length > 0 && (
        <ul className="pcard__warnings" data-testid="proposal-warnings">
          {proposal.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      {(proposal.status === "criando" || proposal.status === "falhou") && proposal.progress.length > 0 && (
        <ol className="pcard__progress" data-testid="proposal-progress">
          {proposal.progress.map((step) => (
            <li key={step.step} className={step.error ? "is-error" : step.done ? "is-done" : ""}>
              <span aria-hidden="true">{step.error ? "✕" : step.done ? "✓" : "…"}</span> {step.step}
              {step.error && <span className="pcard__progress-error"> — {step.error}</span>}
            </li>
          ))}
        </ol>
      )}
      {proposal.status === "falhou" && proposal.error && <p className="dcard__outcome dcard__outcome--bad">{proposal.error}</p>}
      {proposal.status === "criada" && (
        <div className="pcard__done">
          <p className="dcard__outcome">Tudo criado. {plan.sites.length > 0 ? `Falta você entrar em: ${plan.sites.map((site) => site.domain).join(", ")} (o login é sempre seu). ` : ""}As rotinas ficam esperando o seu OK em Aprovações.</p>
          {proposal.workspaceId && (
            <button type="button" className="ui-button cyno-solid" onClick={() => openWorkspace(proposal.workspaceId!)} data-testid="proposal-open">
              Abrir workspace
            </button>
          )}
        </div>
      )}
      {proposal.status === "recusada" && <p className="dcard__outcome">Você recusou: nada foi criado.</p>}
      {open && (
        <footer className="dcard__foot">
          <button type="button" className="ui-button cyno-solid" disabled={busy} onClick={() => void decide("proposal", proposal.id, "approve")} data-testid="proposal-create">
            {busy ? "Criando…" : proposal.status === "falhou" ? "Tentar de novo" : "Criar workspace"}
          </button>
          <button type="button" className="ui-button ui-button--ghost" disabled={busy} onClick={() => onAdjust(proposal)} data-testid="proposal-adjust">
            Ajustar
          </button>
          <button type="button" className="ui-button ui-button--ghost" disabled={busy} onClick={() => void decide("proposal", proposal.id, "reject")} data-testid="proposal-reject">
            Recusar
          </button>
        </footer>
      )}
    </article>
  );
}

/** "Aguardando sua confirmação": o que espera o dono agora, no topo do chat (some quando não há nada). */
export function PendingDecisions({ onAdjust }: { onAdjust: (proposal: WorkspaceProposal) => void }) {
  const confirmations = useCynoStore((state) => state.confirmations);
  const proposals = useCynoStore((state) => state.proposals);
  const decide = useCynoStore((state) => state.decide);
  const deciding = useCynoStore((state) => state.deciding);
  const raw = confirmations.some((item) => item.status === "pendente");
  const now = useClock(raw);
  const list = pendingDecisions(confirmations, proposals, now);
  if (list.length === 0) return null;
  const focus = (id: string) => document.querySelector(`[data-decision-id="${id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  return (
    <section className="pending" aria-labelledby="pending-title" data-testid="pending-decisions">
      <h3 className="pending__title" id="pending-title">
        <WarnIcon />
        Aguardando sua confirmação
        <span className="pending__count">{list.length}</span>
      </h3>
      <ul className="pending__list">
        {list.map((item) => (
          <li key={item.id} className="pending__item" data-testid="pending-item">
            <button type="button" className="pending__text" onClick={() => focus(item.id)} title="Ver o cartão no chat">
              {item.text}
            </button>
            {item.kind === "confirmation" ? (
              <span className="pending__actions">
                <span className="pending__timer">{remainingLabel(item.confirmation.expiresAt, now)}</span>
                <button type="button" className="ui-button cyno-solid pending__btn" disabled={deciding.includes(item.id)} onClick={() => void decide("confirmation", item.id, "approve")} data-testid="pending-approve">
                  Confirmar
                </button>
                <button type="button" className="ui-button ui-button--ghost pending__btn" disabled={deciding.includes(item.id)} onClick={() => void decide("confirmation", item.id, "reject")} data-testid="pending-reject">
                  Recusar
                </button>
              </span>
            ) : (
              <span className="pending__actions">
                <button type="button" className="ui-button cyno-solid pending__btn" onClick={() => focus(item.id)} data-testid="pending-view">
                  Ver proposta
                </button>
                <button type="button" className="ui-button ui-button--ghost pending__btn pending__adjust" onClick={() => onAdjust(item.proposal)}>
                  Ajustar
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
