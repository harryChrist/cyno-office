import { accessSummary, effectiveAccess, normalizeDomain, workspaceAccess, type UpdateWorkspaceAccessBody, type Workspace, type WorkspaceAccess } from "@cyno/shared";
import { useId, useState } from "react";
import { api } from "../../api/client";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText } from "../../ui/widgets";
import { ResetDefaultButton } from "./ResetDefault";
import { OptionHead, SettingSwitch, StateBadge } from "./SettingsOption";

/** "Os agentes deste workspace podem: pesquisar na web, navegar · não podem: usar o terminal". */
export function accessSummaryText(access: WorkspaceAccess): string {
  const { can, cannot } = accessSummary(effectiveAccess(access, {}));
  const parts = [can.length > 0 ? `podem: ${can.join(", ")}` : "não usam nada além do escritório", ...(cannot.length > 0 && can.length > 0 ? [`não podem: ${cannot.join(", ")}`] : [])];
  return `Os agentes deste workspace ${parts.join(" · ")}.`;
}

/** Um campo da política nunca gravado neste workspace = vale o padrão da plataforma. */
const isDefault = (workspace: Workspace, key: keyof WorkspaceAccess) => (workspace.access as Record<string, unknown> | undefined)?.[key] === undefined;

/**
 * Seção do workspace "O que os agentes acessam": a política do projeto (o que os agentes PODEM usar
 * além do escritório e da pasta deles). Cada chave salva na hora; cada agente só pode ter menos
 * (painel dele). Trocar reinicia os terminais quando estiverem livres.
 */
export function AccessSettings({ workspace }: { workspace: Workspace }) {
  const access = workspaceAccess(workspace.access);
  const save = (change: UpdateWorkspaceAccessBody) => api.updateWorkspaceAccess(workspace.id, change);
  return (
    <div className="settings__groups" data-testid="settings-access">
      <p className={`settings__access-summary${access.terminal ? " settings__access-summary--warn" : ""}`} role="status" data-testid="settings-access-summary">
        {accessSummaryText(access)}
      </p>
      <section className="settings__card">
        <header className="settings__card-head">
          <h4 className="settings__card-title">O que os agentes podem usar</h4>
          <p className="settings__card-hint">Vale para todos os agentes deste workspace, o Maestro também.</p>
          <details className="settings__more">
            <summary>Saiba mais</summary>
            <p>No painel de cada agente dá para desligar só para ele, nunca ligar além daqui. Trocar reinicia o terminal de cada agente quando ele estiver livre.</p>
          </details>
        </header>
        <div className="settings__switches">
          <SettingSwitch
            title="Internet"
            line="Os agentes pesquisam na web e leem páginas, citando as fontes. Desligado: só usam o que têm aqui."
            seal="workspace"
            checked={access.internet}
            inherited={isDefault(workspace, "internet")}
            onToggle={(internet) => save({ internet })}
            testId="settings-access-internet"
          />
          <details className="settings__more">
            <summary>Saiba mais</summary>
            <p>O conteúdo das páginas é tratado como dado, nunca como ordem.</p>
          </details>
          <SettingSwitch
            title="Navegador dos agentes"
            line={access.internet ? "Um navegador do Cyno que os agentes abrem e você acompanha ao vivo." : "Precisa da internet ligada."}
            seal="workspace"
            checked={access.internet && access.browser}
            disabled={!access.internet}
            inherited={isDefault(workspace, "browser")}
            stateText={!access.internet ? "Desligado · precisa da internet" : undefined}
            onToggle={(browser) => save({ browser })}
            testId="settings-access-browser"
          />
          <SettingSwitch
            title="Terminal no servidor"
            line="Os agentes rodam comandos NA SUA MÁQUINA (o servidor do Cyno). Desligado por padrão: ligue só se precisar."
            seal="workspace"
            checked={access.terminal}
            inherited={isDefault(workspace, "terminal")}
            onToggle={(terminal) => save({ terminal })}
            testId="settings-access-terminal"
          />
          {access.terminal && (
            <p className="settings__access-warn" role="note" data-testid="settings-access-terminal-warn">
              Atenção: um agente pode rodar programas, alterar ou apagar arquivos e acessar a rede da sua máquina. As instruções pedem cuidado, mas não são uma barreira técnica.
            </p>
          )}
        </div>
        <ResetDefaultButton workspaceId={workspace.id} fields={["access.internet", "access.browser", "access.terminal"]} own={!isDefault(workspace, "internet") || !isDefault(workspace, "browser") || !isDefault(workspace, "terminal")} testId="settings-access-reset" />
      </section>
    </div>
  );
}

/** Seção do workspace "Segurança na web": vale para o navegador compartilhado e para a leitura de páginas. */
export function SecuritySettings({ workspace }: { workspace: Workspace }) {
  const access = workspaceAccess(workspace.access);
  const save = (change: UpdateWorkspaceAccessBody) => api.updateWorkspaceAccess(workspace.id, change);
  return (
    <div className="settings__groups" data-testid="settings-security">
      <section className="settings__card">
        <header className="settings__card-head">
          <h4 className="settings__card-title">Navegador e leitura de páginas</h4>
          <p className="settings__card-hint">Vale para o navegador compartilhado e a leitura de páginas dos agentes.</p>
        </header>
        <div className="settings__switches">
          <SettingSwitch
            title="Aprovação antes de publicar, enviar ou comprar"
            line="Publicar, enviar mensagem ou comprar no navegador espera o seu OK em Aprovações. Desligado: o agente faz sem perguntar."
            seal="workspace"
            checked={access.approveSensitiveActions}
            inherited={isDefault(workspace, "approveSensitiveActions")}
            onToggle={(approveSensitiveActions) => save({ approveSensitiveActions })}
            testId="settings-access-approve"
          />
          <SettingSwitch
            title="Rede local"
            line="Deixa abrir endereços da sua rede e da máquina (localhost, 192.168.*). Desligado: só a internet pública."
            seal="workspace"
            checked={access.allowLocalNetwork}
            inherited={isDefault(workspace, "allowLocalNetwork")}
            onToggle={(allowLocalNetwork) => save({ allowLocalNetwork })}
            testId="settings-access-local"
          />
          {access.allowLocalNetwork && (
            <p className="settings__access-warn" role="note" data-testid="settings-access-local-warn">
              Um agente pode abrir painel de roteador, impressoras e outros serviços da sua rede.
            </p>
          )}
        </div>
        <ResetDefaultButton
          workspaceId={workspace.id}
          fields={["access.approveSensitiveActions", "access.allowLocalNetwork"]}
          own={!isDefault(workspace, "approveSensitiveActions") || !isDefault(workspace, "allowLocalNetwork")}
          testId="settings-security-reset"
        />
      </section>
      <section className="settings__card">
        <OptionHead
          title="Domínios"
          seal="workspace"
          line="Vale também para subdomínios (exemplo.com cobre www.exemplo.com). Bloqueado vence permitido."
          inherited={isDefault(workspace, "allowedDomains") && isDefault(workspace, "blockedDomains")}
          state={
            <StateBadge tone="value">
              {access.allowedDomains.length === 0 ? "Todos permitidos" : `${access.allowedDomains.length} permitido${access.allowedDomains.length === 1 ? "" : "s"}`}
              {access.blockedDomains.length > 0 ? ` · ${access.blockedDomains.length} bloqueado${access.blockedDomains.length === 1 ? "" : "s"}` : ""}
            </StateBadge>
          }
        />
        <DomainList
          label="Permitidos"
          hint="Vazio libera todos. Com domínios aqui, os agentes só abrem páginas deles."
          more="A busca ainda pode mostrar outros sites."
          domains={access.allowedDomains}
          onSave={(allowedDomains) => save({ allowedDomains })}
          testId="settings-access-allowed"
        />
        <DomainList label="Bloqueados" hint="Os agentes nunca abrem páginas destes domínios." domains={access.blockedDomains} onSave={(blockedDomains) => save({ blockedDomains })} testId="settings-access-blocked" />
        <ResetDefaultButton workspaceId={workspace.id} fields={["access.allowedDomains", "access.blockedDomains"]} own={!isDefault(workspace, "allowedDomains") || !isDefault(workspace, "blockedDomains")} testId="settings-domains-reset" />
      </section>
    </div>
  );
}

/** Lista de domínios em chips: adicionar (Enter ou botão) e tirar salvam a lista inteira na hora. */
function DomainList({ label, hint, more, domains, onSave, testId }: { label: string; hint: string; more?: string; domains: string[]; onSave: (domains: string[]) => Promise<unknown>; testId: string }) {
  const id = useId();
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const { pending, error, run } = useAsyncAction();
  const add = async () => {
    const domain = normalizeDomain(text);
    if (!domain) {
      setInvalid(text.trim() ? `"${text.trim()}" não é um domínio (ex.: exemplo.com).` : "Digite um domínio.");
      return;
    }
    setInvalid(null);
    if (domains.includes(domain)) {
      setText("");
      return;
    }
    const result = await run(() => onSave([...domains, domain]));
    if (result) setText("");
  };
  return (
    <div className="settings__domains" data-testid={testId}>
      <label htmlFor={`${id}-input`} className="settings__domains-label">
        {label}
      </label>
      <p className="settings__card-hint">{hint}</p>
      {more && (
        <details className="settings__more">
          <summary>Saiba mais</summary>
          <p>{more}</p>
        </details>
      )}
      {domains.length > 0 && (
        <ul className="settings__chips" aria-label={`Domínios ${label.toLowerCase()}`}>
          {domains.map((domain) => (
            <li key={domain} className="settings__chip settings__chip--removable">
              {domain}
              <button
                type="button"
                className="settings__chip-remove"
                onClick={() => void run(() => onSave(domains.filter((item) => item !== domain)))}
                disabled={pending}
                aria-label={`Tirar ${domain}`}
                data-testid={`${testId}-remove`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="settings__domains-add">
        <input
          id={`${id}-input`}
          className="ui-input"
          value={text}
          placeholder="exemplo.com"
          maxLength={260}
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void add();
            }
          }}
          data-testid={`${testId}-input`}
        />
        <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => void add()} disabled={pending} aria-busy={pending} data-testid={`${testId}-add`}>
          Adicionar
        </button>
      </div>
      <ErrorText>{invalid ?? error}</ErrorText>
    </div>
  );
}
