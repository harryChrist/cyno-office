import { agentEngine, findMaestroAgent, isCliEngine, type Agent } from "@cyno/shared";
import { useState } from "react";
import { api, describeError } from "../api/client";
import { useOfficeStore } from "../store/officeStore";
import { useAgentAvailability } from "./availability";

/**
 * Selo "sem cota · volta às 14:30" (ou "motor indisponível") de um agente cujo motor está fora: as
 * tarefas dele esperam na fila e andam sozinhas quando a cota voltar. "Tentar agora" manda o server
 * tentar já (se ainda faltar cota, elas voltam a esperar). Nada troca de motor.
 */
export function UnavailableBadge({ agent, retry = true }: { agent: Agent; retry?: boolean }) {
  const availability = useAgentAvailability(agent);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  if (!availability) return null;
  const engine = agentEngine(agent);
  const quota = availability.block.reason === "quota";
  const hour = availability.block.reason === "hour";
  const tryNow = () => {
    if (!isCliEngine(engine)) return;
    setState({ busy: true, error: null });
    api.retryEngine(engine).then(
      () => setState({ busy: false, error: null }),
      (error: unknown) => setState({ busy: false, error: describeError(error) }),
    );
  };
  return (
    <span className="unavailable" data-testid="agent-unavailable">
      <span
        className={`ui-badge ui-badge--${hour ? "attention" : "danger"}`}
        title={
          quota
            ? "A cota da assinatura deste motor acabou: as tarefas esperam na fila e seguem sozinhas quando ela voltar."
            : hour
              ? "O Freebuff cobra por hora aberta e o teto de horas abertas ao mesmo tempo foi atingido: as tarefas esperam na fila e seguem sozinhas quando a hora do outro agente acabar (ou o teto subir em Configurações › Motores)."
              : "A CLI deste motor não está disponível no servidor."
        }
      >
        {availability.label}
      </span>
      {retry && quota && (
        <button type="button" className="ui-link unavailable__retry" onClick={tryNow} disabled={state.busy} data-testid="agent-unavailable-retry">
          {state.busy ? "Tentando…" : "Tentar agora"}
        </button>
      )}
      {state.error && <span className="ui-field__error">{state.error}</span>}
    </span>
  );
}

/**
 * Aviso na caixa "Peça ao Maestro" quando o Maestro está sem cota: o pedido entra assim mesmo, fica
 * na fila e segue sozinho quando a cota voltar (nada troca de motor).
 */
export function MaestroQuotaNotice({ className, testId = "maestro-unavailable" }: { className?: string; testId?: string }) {
  const office = useOfficeStore((state) => state.office);
  const maestro = office ? findMaestroAgent(office) : undefined;
  const availability = useAgentAvailability(maestro);
  if (!availability) return null;
  const why = availability.block.reason === "quota" ? `Maestro ${availability.label}` : "O motor do Maestro está indisponível";
  return (
    <p className={className} role="status" data-testid={testId}>
      {why}: seus pedidos ficam na fila e seguem sozinhos quando ele voltar.
    </p>
  );
}
