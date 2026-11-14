import { ACCESS_LABELS, effectiveAccess, workspaceAccess, type Agent, type EffectiveAccess, type WorkspaceAccess } from "@cyno/shared";
import { useNavStore } from "../store/navStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { Switch } from "./widgets";

/** A política de acesso do workspace aberto (com os padrões; workspace antigo = os padrões). */
export function useWorkspaceAccess(): WorkspaceAccess {
  const id = useNavStore((state) => state.workspaceId);
  const raw = useWorkspaceStore((state) => state.workspaces?.find((ws) => ws.id === id)?.access);
  return workspaceAccess(raw);
}

/** Acesso efetivo do agente no workspace aberto. */
export function useAgentAccess(agent: Pick<Agent, "internet" | "browser" | "terminal">): EffectiveAccess {
  return effectiveAccess(useWorkspaceAccess(), agent);
}

/** "Internet · Navegador" (o que está ligado) ou "Só o escritório". */
export function accessLabel(access: EffectiveAccess): string {
  const on = (Object.keys(ACCESS_LABELS) as (keyof EffectiveAccess)[]).filter((key) => access[key]).map((key) => ACCESS_LABELS[key].short);
  return on.length > 0 ? on.join(" · ") : "Só o escritório";
}

/** Selo discreto da lista de agentes: globo (internet), janela (navegador) e ">_" (terminal), só o que está ligado. */
export function AccessBadges({ access }: { access: EffectiveAccess }) {
  if (!access.internet && !access.terminal) return null;
  return (
    <span className="access-badges" title={`Acesso: ${accessLabel(access)}`} data-testid="agent-access-badges">
      {access.internet && (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" data-access="internet">
          <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M1.8 8h12.4M8 1.8c2 2.2 2 10.2 0 12.4M8 1.8c-2 2.2-2 10.2 0 12.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )}
      {access.browser && (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" data-access="browser">
          <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M1.8 5.8h12.4" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )}
      {access.terminal && (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" data-access="terminal" className="access-badges__terminal">
          <path d="M2.5 4.5 6 8l-3.5 3.5M7.5 12h6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      <span className="sr-only">Acesso: {accessLabel(access)}</span>
    </span>
  );
}

type AccessValues = { internet: boolean; browser: boolean; terminal: boolean };

/**
 * Interruptores do acesso de um agente: só restringem o que o workspace permite. Desligado no
 * workspace = interruptor desligado e travado, com a dica de onde mudar.
 */
export function AgentAccessFields({ values, onChange, testIdPrefix = "agent-edit" }: { values: AccessValues; onChange: (values: AccessValues) => void; testIdPrefix?: string }) {
  const ws = useWorkspaceAccess();
  const offInWorkspace = "Desligado em Configurações › Acesso dos agentes.";
  const restart = "Trocar reinicia o terminal do agente quando ele estiver livre.";
  return (
    <fieldset className="agent-access" data-testid={`${testIdPrefix}-access`}>
      <legend className="agent-access__legend">Acesso</legend>
      <Switch
        label="Internet (pesquisa e páginas)"
        description={ws.internet ? restart : offInWorkspace}
        checked={ws.internet && values.internet}
        disabled={!ws.internet}
        onChange={(internet) => onChange({ ...values, internet })}
        testId={`${testIdPrefix}-internet`}
      />
      <Switch
        label="Navegador compartilhado"
        description={!ws.internet || !ws.browser ? offInWorkspace : values.internet ? "Precisa da internet." : "Ligue a internet do agente para usar o navegador."}
        checked={ws.internet && ws.browser && values.internet && values.browser}
        disabled={!ws.internet || !ws.browser || !values.internet}
        onChange={(browser) => onChange({ ...values, browser })}
        testId={`${testIdPrefix}-browser`}
      />
      <Switch
        label="Terminal no servidor"
        description={ws.terminal ? "Roda comandos na sua máquina, dentro da pasta do agente." : offInWorkspace}
        checked={ws.terminal && values.terminal}
        disabled={!ws.terminal}
        onChange={(terminal) => onChange({ ...values, terminal })}
        testId={`${testIdPrefix}-terminal`}
      />
    </fieldset>
  );
}
