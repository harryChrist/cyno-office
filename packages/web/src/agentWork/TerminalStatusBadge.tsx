import { agentEngine, terminalStateView, type Agent } from "@cyno/shared";
import { useState } from "react";
import { api, describeError } from "../api/client";
import { useTerminalsStore } from "../store/terminalsStore";
import { useAgentAvailability } from "../ui/availability";
import "./agentTerminal.css";

/** O estado do terminal do agente (pronto para a tela), com a cota/motor fora do ar. */
export function useTerminalState(agent: Agent | undefined) {
  const info = useTerminalsStore((state) => (agent ? state.byAgent[agent.id] : undefined));
  const availability = useAgentAvailability(agent);
  if (!agent) return null;
  return terminalStateView(agentEngine(agent), info, availability ? { label: availability.label, reason: availability.block.reason } : null);
}

/**
 * Selo do terminal no cabeçalho da tela de trabalho (🆕 criado, ⏳ iniciando, 🟢 ligado, 💤 desligado,
 * 🔴 com erro, 🚫 sem cota) com Ligar / Desligar / Tentar de novo. Desligar no meio de um turno pede
 * confirmação (o trabalho em curso é cortado); o server também recusa sem ela (409).
 */
export function TerminalStatusBadge({ agent }: { agent: Agent }) {
  const view = useTerminalState(agent);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!view || view.key === "simulado") return null;

  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    action().then(
      () => {
        setBusy(false);
        setConfirming(false);
      },
      (failure: unknown) => {
        setBusy(false);
        const message = describeError(failure);
        // Ficou ocupado entre o clique e o pedido: pede a confirmação.
        if (/meio de um turno/i.test(message)) setConfirming(true);
        else setError(message);
      },
    );
  };
  const start = () => run(() => api.startTerminal(agent.id));
  const stop = () => {
    if (view.midTurn && !confirming) {
      setConfirming(true);
      return;
    }
    run(() => api.stopTerminal(agent.id, confirming));
  };

  return (
    <span className="term-state" data-testid="terminal-state" data-state={view.key}>
      <span className="term-state__badge" data-state={view.key} title={view.detail}>
        <span aria-hidden="true">{view.emoji}</span>
        {view.label}
      </span>
      {view.key === "erro" && view.detail && (
        <span className="term-state__detail" title={view.detail} data-testid="terminal-state-detail">
          {view.detail}
        </span>
      )}
      {view.canStart && (
        <button type="button" className="term-state__action" onClick={start} disabled={busy} data-testid="terminal-start">
          {busy ? "…" : view.key === "erro" ? "Tentar de novo" : "Ligar"}
        </button>
      )}
      {view.canStop && !confirming && (
        <button type="button" className="term-state__action" onClick={stop} disabled={busy} data-testid="terminal-stop">
          Desligar
        </button>
      )}
      {confirming && (
        <>
          <span className="term-state__error" role="alert">
            Está no meio de um turno: desligar corta o trabalho.
          </span>
          <button type="button" className="term-state__action term-state__action--danger" onClick={stop} disabled={busy} data-testid="terminal-stop-confirm">
            Desligar assim mesmo
          </button>
          <button type="button" className="term-state__action" onClick={() => setConfirming(false)} disabled={busy}>
            Cancelar
          </button>
        </>
      )}
      {error && (
        <span className="term-state__error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
