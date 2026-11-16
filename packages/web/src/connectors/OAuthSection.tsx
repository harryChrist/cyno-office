import { GMAIL_COMPOSE_SCOPE, effectiveRedirectMode, needsPasteBack, oauthRedirectFor, redirectOriginIssue, risksOf, scopeRisk, type LibraryConnector, type OAuthDiscoveryResult, type OAuthDiscoverySummary, type OAuthRedirectMode, type ScopeRisk } from "@cyno/shared";
import { useEffect, useRef, useState } from "react";
import { GmailGuide } from "./GmailGuide";
import { api } from "../api/client";
import { useLibraryStore } from "../store/libraryStore";
import { useAsyncAction } from "../ui/useAsyncAction";
import { ErrorText, Field } from "../ui/widgets";
import { GMAIL_API_OAUTH_INFO, GMAIL_MCP_URL, gmailApiScopes, gmailModeOf, type ConnectorForm, type GmailMode } from "./connectorView";
import "./oauth.css";

/** Resultado do "Verificar" (descoberta do OAuth do servidor, sem guardar nada). */
export type OAuthDiscoveryState = { status: "idle" | "checking" | "done"; result?: OAuthDiscoveryResult; error?: string };

const SCOPE_PREFIX = /^https:\/\/www\.googleapis\.com\/auth\//;
const RISK_LABEL: Record<Exclude<ScopeRisk, "none">, string> = { full: "acesso total", write: "escreve", send: "envia", delete: "exclui" };

/** O que o formulário sabe do OAuth do servidor: a descoberta mais nova, ou o que o conector guardou. */
export function oauthInfo(discovery: OAuthDiscoveryState, connector?: LibraryConnector): (OAuthDiscoverySummary & { connection?: NonNullable<LibraryConnector["oauth"]>["connection"] }) | null {
  if (discovery.result?.found) return discovery.result;
  return connector?.oauth ?? null;
}

/** Nome da API do Google a ativar, pelo endereço do servidor MCP (gmailmcp.googleapis.com vira Gmail API). */
export function googleApiName(resource: string): string {
  const host = /^https?:\/\/([^/]+)/i.exec(resource)?.[1] ?? "";
  const known: Record<string, string> = { "gmail.googleapis.com": "Gmail API", "gmailmcp.googleapis.com": "Gmail API", "drivemcp.googleapis.com": "Google Drive API", "calendarmcp.googleapis.com": "Google Calendar API" };
  return known[host] ?? "API do serviço";
}

const GMAIL_MODES: { mode: GmailMode; title: string; text: string }[] = [
  { mode: "api", title: "API do Gmail (funciona com qualquer conta, recomendado)", text: "O Cyno fala direto com a API pública do Gmail: lê conversas, lista marcadores e cria rascunhos, sem servidor de terceiros." },
  { mode: "mcp", title: "Servidor MCP oficial do Google (só contas Google Workspace inscritas no programa de prévia)", text: "Usa o servidor MCP que o Google mantém, que só atende projetos inscritos no Developer Preview Program, programa que não aceita endereço Gmail comum." },
];

/** Escolha de como falar com o Gmail. Trocar e salvar mantém o login: o servidor só troca o cliente e descarta a lista de ferramentas em cache. */
export function GmailModeChoice({ form, set, editing }: { form: ConnectorForm; set: (change: Partial<ConnectorForm>) => void; editing: boolean }) {
  const mode = gmailModeOf(form);
  const choose = (next: GmailMode) => {
    if (next === mode) return;
    if (next === "api") set({ builtin: "gmail-api", url: "", authMode: "oauth", authTouched: true, oauthScopes: gmailApiScopes(form.oauthScopes) });
    // Conector novo no modo MCP leva o endereço oficial; na edição o servidor volta sozinho a ele.
    else set({ builtin: null, url: editing ? "" : GMAIL_MCP_URL, authTouched: true });
  };
  return (
    <fieldset className="oauth-redirect gmail-mode" data-testid="gmail-mode">
      <legend className="ui-field__label">Como falar com o Gmail</legend>
      {GMAIL_MODES.map((option) => (
        <label key={option.mode} className="oauth-redirect__option">
          <input type="radio" name="gmail-mode" checked={mode === option.mode} onChange={() => choose(option.mode)} data-testid={`gmail-mode-${option.mode}`} />
          <span>
            <span className="oauth-redirect__title">{option.title}</span>
            <span className="oauth-redirect__hint">{option.text}</span>
          </span>
        </label>
      ))}
      {editing && <p className="connector-form__hint">Trocar e salvar mantém o seu login: não precisa entrar de novo.</p>}
    </fieldset>
  );
}

/** Texto (quebra em várias linhas, sem cortar no celular) com botão de copiar; funciona também em http de rede, onde a área de transferência moderna não existe. */
export function CopyField({ value, label, testId }: { value: string; label: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className="oauth-copy">
      <code className="oauth-copy__text" role="textbox" aria-readonly="true" aria-label={label} data-testid={testId}>
        {value}
      </code>
      <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => void copy()}>
        {copied ? "Copiado" : "Copiar"}
      </button>
    </div>
  );
}

/** Passo a passo curto para criar o cliente OAuth no Google Cloud (o Google não faz cadastro automático). `builtin`: Gmail pela API (só a Gmail API; sem nada de servidor MCP). */
function GoogleSteps({ redirectUri, apiName, builtin, scopes, onGuide }: { redirectUri: string; apiName: string; builtin: boolean; scopes: string[]; onGuide?: () => void }) {
  return (
    <details className="oauth-steps" open data-testid="oauth-google-steps">
      <summary>Como criar o ID e o segredo no Google (passo a passo)</summary>
      <ol>
        <li>
          Abra o <strong>Google Cloud Console</strong> (console.cloud.google.com) e crie um projeto novo, ou escolha um seu.
        </li>
        <li>
          {builtin ? (
            <>
              No projeto, ative <strong>só a Gmail API</strong> (<code>gmail.googleapis.com</code>). Nenhuma outra API é necessária.
            </>
          ) : apiName === "Gmail API" ? (
            <>
              No projeto, <strong>ative as duas APIs, as duas são obrigatórias</strong>: a <strong>Gmail API</strong> e a <strong>Gmail MCP API</strong> (<code>gmailmcp.googleapis.com</code>). Sem a segunda o login funciona, mas toda chamada volta HTTP 403.
            </>
          ) : (
            <>
              Na Biblioteca de APIs, ative a <strong>{apiName}</strong>. Se a biblioteca também listar um item de MCP do mesmo serviço, ative-o.
            </>
          )}
        </li>
        <li>
          Configure a <strong>tela de consentimento OAuth</strong> (tipo Externo): nome do app, seu e-mail e, em Escopos, os que você marcou abaixo
          {scopes.length > 0 ? ` (${scopes.length})` : ""}. Em Usuários de teste, adicione a sua conta do Google.
        </li>
        <li>
          Em Credenciais, crie um <strong>ID do cliente OAuth</strong> do tipo <strong>Aplicativo da Web</strong>. Em “URIs de redirecionamento autorizados”, cole este endereço:
          <CopyField value={redirectUri} label="Endereço de retorno" testId="oauth-redirect-uri" />
        </li>
        <li>
          {builtin ? (
            <>Salve e copie o ID e o segredo para os campos abaixo.</>
          ) : (
            <>
              Marque a opção <strong>“Use this client for an AI-powered agent”</strong> (a que o Google pede para servidores MCP; em português pode aparecer como uso para um agente de IA). Salve e copie o ID e o segredo para os campos abaixo.
            </>
          )}
        </li>
      </ol>
      <p className="oauth-steps__warn" role="note">
        <strong>Atenção:</strong> enquanto o app estiver em modo de teste, o Google derruba a autorização a cada 7 dias e você precisa entrar de novo. Para ela não vencer, publique o app como <strong>“Em produção”</strong> na tela de consentimento. Aí o Google mostra o aviso de app não verificado ao entrar: clique em “Avançado” e continue (o app é seu).
      </p>
      {onGuide && (
        <p className="oauth-steps__more">
          <button type="button" className="oauth-link" onClick={onGuide} data-testid="oauth-guide-link">
            Ver o guia completo
          </button>
        </p>
      )}
    </details>
  );
}

/** Escolha do endereço de retorno (credencial manual): localhost não depende do domínio do app; o endereço atual é um clique só. */
function RedirectChoice({ mode, origin, onChange }: { mode: OAuthRedirectMode; origin: string; onChange: (mode: OAuthRedirectMode) => void }) {
  const host = origin.replace(/^https?:\/\//, "");
  return (
    <fieldset className="oauth-redirect" data-testid="oauth-redirect-choice">
      <legend className="ui-field__label">Endereço de retorno</legend>
      <label className="oauth-redirect__option">
        <input type="radio" name="oauth-redirect" checked={mode === "local"} onChange={() => onChange("local")} data-testid="oauth-redirect-local" />
        <span>
          <span className="oauth-redirect__title">localhost (não depende do endereço do app)</span>
          <span className="oauth-redirect__hint">Continua valendo se você mudar o domínio do app, mas ao entrar você cola um endereço de volta aqui.</span>
        </span>
      </label>
      <label className="oauth-redirect__option">
        <input type="radio" name="oauth-redirect" checked={mode === "app"} onChange={() => onChange("app")} data-testid="oauth-redirect-app" />
        <span>
          <span className="oauth-redirect__title">Endereço atual do app ({host})</span>
          <span className="oauth-redirect__hint">É um clique só, mas precisa ser recadastrado no serviço se o domínio mudar.</span>
        </span>
      </label>
    </fieldset>
  );
}

/** Passo final do retorno em localhost: o dono cola o endereço que o navegador tentou abrir. */
export function PasteBack({ pending, error, onFinish }: { pending: boolean; error?: string | null; onFinish: (url: string) => void }) {
  const [url, setUrl] = useState("");
  return (
    <div className="oauth-paste" role="group" aria-label="Concluir o login colando o endereço" data-testid="oauth-paste">
      <p className="oauth-paste__text">
        Depois de autorizar, o navegador vai tentar abrir um endereço que começa com <strong>http://localhost</strong> e mostrar erro de página não encontrada. É esperado. Copie o endereço inteiro da barra do navegador e cole aqui.
      </p>
      <Field label="Endereço copiado da barra do navegador">
        {(props) => <input {...props} className="ui-input" autoComplete="off" spellCheck={false} value={url} placeholder="http://localhost:3067/api/library/oauth/callback?code=…&state=…" onChange={(event) => setUrl(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (url.trim() && !pending) onFinish(url); } }} data-testid="oauth-paste-url" />}
      </Field>
      <div className="ui-actions">
        <button type="button" className="ui-button ui-button--small" disabled={pending || !url.trim()} onClick={() => onFinish(url)} aria-busy={pending} data-testid="oauth-paste-finish">
          {pending ? "Concluindo…" : "Concluir"}
        </button>
      </div>
      <ErrorText testId="oauth-paste-error">{error}</ErrorText>
    </div>
  );
}

/** Lista de escopos marcáveis, com o risco de cada um e o aviso de escrita/envio/exclusão. */
function ScopePicker({ info, form, set }: { info: OAuthDiscoverySummary; form: ConnectorForm; set: (change: Partial<ConnectorForm>) => void }) {
  const selected = new Set(form.oauthScopes);
  const toggle = (scope: string) => {
    const next = new Set(selected);
    if (next.has(scope)) next.delete(scope);
    else next.add(scope);
    set({ oauthScopes: info.scopesSupported.filter((item) => next.has(item)).concat([...next].filter((item) => !info.scopesSupported.includes(item))), authTouched: true });
  };
  const risks = risksOf(form.oauthScopes);
  if (info.scopesSupported.length === 0) return <p className="connector-form__hint">O servidor não lista escopos: o login pede os padrões dele.</p>;
  return (
    <div className="oauth-scopes" data-testid="oauth-scopes">
      <div className="oauth-scopes__head">
        <span className="ui-field__label">
          Permissões (escopos) <span className="oauth-scopes__count">{form.oauthScopes.length} de {info.scopesSupported.length} marcados</span>
        </span>
        <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => set({ oauthScopes: info.defaultScopes, authTouched: true })}>
          Usar a sugestão
        </button>
      </div>
      <ul className="oauth-scopes__list">
        {info.scopesSupported.map((scope) => {
          const risk = scopeRisk(scope);
          return (
            <li key={scope}>
              <label className="oauth-scope" title={scope}>
                <input type="checkbox" checked={selected.has(scope)} onChange={() => toggle(scope)} data-testid={`oauth-scope-${scope.replace(SCOPE_PREFIX, "")}`} />
                <span className="oauth-scope__name">{scope.replace(SCOPE_PREFIX, "")}</span>
                {risk !== "none" && <span className={`oauth-scope__risk oauth-scope__risk--${risk}`}>{RISK_LABEL[risk]}</span>}
              </label>
              {form.builtin && scope === GMAIL_COMPOSE_SCOPE && (
                <p className="oauth-scope__hint" data-testid="oauth-compose-hint">
                  Para o Cyno criar rascunhos. No Google, esta permissão também permite enviar e-mails; o Cyno só oferece criar rascunho, mas o acesso concedido é este. Deixe desmarcada se só quer leitura.
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {risks.full.length > 0 && (
        <p className="oauth-scopes__warn oauth-scopes__warn--danger" role="alert" data-testid="oauth-warn-full">
          Você marcou acesso total. O agente poderia ler, mudar e apagar tudo da conta. Prefira só o que precisa.
        </p>
      )}
      {risks.full.length === 0 && (risks.write.length > 0 || risks.send.length > 0 || risks.delete.length > 0) && (
        <p className="oauth-scopes__warn" role="note" data-testid="oauth-warn-write">
          Atenção: há permissões para {[risks.write.length > 0 && "escrever", risks.send.length > 0 && "enviar", risks.delete.length > 0 && "excluir"].filter(Boolean).join(", ")}. Os agentes liberados poderão fazer isso na sua conta.
        </p>
      )}
    </div>
  );
}

/** Entrar, entrar de novo e desconectar: o mesmo hook serve ao formulário e ao cartão da lista. */
export function useOAuthSignIn(connectorId: string | undefined) {
  const connector = useLibraryStore((state) => state.connectors?.find((item) => item.id === connectorId));
  const load = useLibraryStore((state) => state.load);
  const action = useAsyncAction();
  const finishAction = useAsyncAction();
  const [waiting, setWaiting] = useState(false);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const baseline = useRef<string | undefined>(undefined);

  // A tela atualiza sozinha: o evento library:upserted traz o conector conectado; a consulta a cada 3 s é só um reforço.
  useEffect(() => {
    if (!waiting) return;
    const done = connector?.oauth?.connection === "connected" && connector.oauth.connectedAt !== baseline.current;
    if (done) {
      setWaiting(false);
      setLoginUrl(null);
      return;
    }
    const poll = window.setInterval(() => void load(), 3000);
    const stop = window.setTimeout(() => setWaiting(false), 5 * 60_000);
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(stop);
    };
  }, [waiting, connector, load]);

  /** `beforeStart`: salva o que o dono mudou no formulário (escopos, cliente) antes de abrir o login. */
  const signIn = (beforeStart?: () => Promise<void>) =>
    action.run(async () => {
      if (!connectorId) return;
      // Abre a aba já no clique (senão o navegador trata como pop-up) e manda para o serviço quando a URL chegar.
      const tab = window.open("", "_blank");
      if (tab) tab.opener = null;
      try {
        await beforeStart?.();
        const started = await api.startLibraryOAuth(connectorId, { origin: window.location.origin });
        baseline.current = useLibraryStore.getState().connectors?.find((item) => item.id === connectorId)?.oauth?.connectedAt;
        setLoginUrl(started.authorizationUrl);
        setWaiting(true);
        if (tab) tab.location.href = started.authorizationUrl;
      } catch (error) {
        tab?.close();
        throw error;
      }
    });

  /** Termina o login com o endereço que o dono colou (retorno em localhost fora da máquina do servidor). */
  const finish = (callbackUrl: string) =>
    finishAction.run(async () => {
      if (!connectorId) return;
      await api.finishLibraryOAuth(connectorId, { callbackUrl });
      await load();
      setWaiting(false);
      setLoginUrl(null);
    });

  const disconnect = () =>
    action.run(async () => {
      if (connectorId) await api.disconnectLibraryOAuth(connectorId);
      setWaiting(false);
      setLoginUrl(null);
    });

  return { connector, signIn, finish, finishPending: finishAction.pending, finishError: finishAction.error, disconnect, pending: action.pending, error: action.error, waiting, cancelWaiting: () => setWaiting(false), loginUrl };
}

type SectionProps = {
  form: ConnectorForm;
  set: (change: Partial<ConnectorForm>) => void;
  connector?: LibraryConnector;
  discovery: OAuthDiscoveryState;
  onVerify: () => void;
  /** Salva o que mudou no formulário (usado antes de entrar). */
  save: () => Promise<void>;
  editing: boolean;
};

const CONNECTION_TEXT = { not_connected: "Não conectado", connected: "Conectado", needs_login: "Precisa entrar de novo" } as const;

/** Credenciais de um conector HTTP: token fixo ou entrar com a conta (OAuth), com escopos, cliente e o botão de entrar. */
export function AuthChoice({ form, set, connector, discovery, onVerify, save, editing, children }: SectionProps & { children: React.ReactNode }) {
  // Gmail pela API: os dados do Google são fixos, não há o que verificar.
  const info = form.builtin ? GMAIL_API_OAUTH_INFO : oauthInfo(discovery, connector);
  const sign = useOAuthSignIn(connector?.id);
  const live = sign.connector ?? connector;
  const origin = window.location.origin;
  const redirectMode = effectiveRedirectMode(form.oauthRedirect ?? undefined, info?.registration ?? "dynamic");
  const redirectUri = oauthRedirectFor(redirectMode, origin);
  const originIssue = info?.provider === "google" && redirectMode === "app" ? redirectOriginIssue(origin) : undefined;
  const pasteBack = needsPasteBack(redirectMode, origin);
  const connection = live?.oauth?.connection;
  const oauthAvailable = Boolean(info);
  const [guide, setGuide] = useState(false);
  const choose = (authMode: ConnectorForm["authMode"]) => {
    set({ authMode, authTouched: true, ...(authMode === "oauth" && form.oauthScopes.length === 0 && info ? { oauthScopes: info.defaultScopes } : {}) });
    if (authMode === "oauth" && !info && discovery.status === "idle") onVerify();
  };

  return (
    <>
      {!form.builtin && (
        <>
          <div className="connector-form__radios" role="radiogroup" aria-label="Como entrar no serviço">
            <label className="connector-form__radio">
              <input type="radio" name="connector-auth" checked={form.authMode === "static"} onChange={() => choose("static")} data-testid="connector-auth-static" />
              Token fixo
            </label>
            <label className="connector-form__radio">
              <input type="radio" name="connector-auth" checked={form.authMode === "oauth"} onChange={() => choose("oauth")} data-testid="connector-auth-oauth" />
              Entrar com a conta (OAuth)
            </label>
          </div>

          <div className="oauth-verify" data-testid="oauth-verify">
            <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={discovery.status === "checking"} aria-busy={discovery.status === "checking"} onClick={onVerify} data-testid="oauth-verify-button">
              {discovery.status === "checking" ? "Verificando…" : "Verificar"}
            </button>
            <span className="oauth-verify__text" role="status" data-testid="oauth-verify-text">
              {discovery.status === "checking" && "Procurando o login OAuth deste servidor…"}
              {discovery.status === "done" && discovery.result?.found && `OAuth encontrado (${hostOf(discovery.result.issuer)}).`}
              {discovery.status === "done" && discovery.result && !discovery.result.found && `Sem OAuth: ${discovery.result.reason}.`}
              {discovery.status === "idle" && (oauthAvailable ? `OAuth do servidor ${hostOf(info!.issuer)}.` : "Confere se este servidor pede login OAuth.")}
            </span>
          </div>
          <ErrorText>{discovery.error}</ErrorText>
        </>
      )}

      {form.authMode === "static" ? (
        children
      ) : !info ? (
        <p className="connector-form__hint" data-testid="oauth-needs-verify">
          Clique em Verificar para o Cyno descobrir como esse servidor faz o login.
        </p>
      ) : (
        <div className="oauth-panel" data-testid="oauth-panel">
          {info.registration === "dynamic" ? (
            <p className="oauth-note" data-testid="oauth-dynamic">
              <strong>Cadastro automático.</strong> O Cyno se registra sozinho no servidor de autorização como “Cyno Office”. Você não precisa preencher nada: é só entrar.
            </p>
          ) : (
            <div className="oauth-manual" data-testid="oauth-manual">
              <p className="oauth-note">Este servidor não faz cadastro automático. Crie uma credencial OAuth no serviço e cole o ID e o segredo aqui.</p>
              {info.provider === "google" ? (
                <GoogleSteps redirectUri={redirectUri} apiName={googleApiName(info.resource)} builtin={Boolean(form.builtin)} scopes={form.oauthScopes} onGuide={googleApiName(info.resource) === "Gmail API" ? () => setGuide(true) : undefined} />
              ) : (
                <div className="oauth-steps oauth-steps--plain">
                  <p className="connector-form__hint">No painel do serviço, crie um app OAuth e cadastre este endereço de retorno:</p>
                  <CopyField value={redirectUri} label="Endereço de retorno" testId="oauth-redirect-uri" />
                </div>
              )}
              <RedirectChoice mode={redirectMode} origin={origin} onChange={(oauthRedirect) => set({ oauthRedirect, authTouched: true })} />
              {originIssue && (
                <p className="oauth-origin-warn" role="alert" data-testid="oauth-origin-warn">
                  {originIssue}
                </p>
              )}
              <div className="oauth-manual__fields">
                <Field label="ID do cliente">
                  {(props) => <input {...props} className="ui-input" autoComplete="off" value={form.oauthClientId} placeholder="xxxx.apps.googleusercontent.com" onChange={(event) => set({ oauthClientId: event.currentTarget.value })} data-testid="oauth-client-id" />}
                </Field>
                <Field label="Segredo do cliente" hint={form.oauthClientSecretStored ? "Definido. Digite um novo para trocar." : undefined}>
                  {(props) => <input {...props} className="ui-input" type="password" autoComplete="off" value={form.oauthClientSecret} placeholder={form.oauthClientSecretStored ? "•••••• (definido)" : ""} onChange={(event) => set({ oauthClientSecret: event.currentTarget.value })} data-testid="oauth-client-secret" />}
                </Field>
              </div>
            </div>
          )}

          <ScopePicker info={info} form={form} set={set} />

          {editing && live?.oauth ? (
            <div className="oauth-connection" data-testid="oauth-connection" data-connection={connection}>
              <div className="oauth-connection__state">
                <span className={`ui-badge ui-badge--${connection === "connected" ? "success" : "attention"}`}>{CONNECTION_TEXT[connection ?? "not_connected"]}</span>
                {live.oauth.reason && connection !== "not_connected" && <span className="oauth-connection__reason">{live.oauth.reason}</span>}
              </div>
              <div className="ui-actions">
                {connection !== "not_connected" && (
                  <button type="button" className="ui-button ui-button--danger ui-button--small" disabled={sign.pending} onClick={() => void sign.disconnect()} data-testid="oauth-disconnect">
                    Desconectar
                  </button>
                )}
                <button type="button" className="ui-button ui-button--small" disabled={sign.pending || sign.waiting || Boolean(originIssue)} aria-busy={sign.pending} onClick={() => void sign.signIn(save)} data-testid="oauth-sign-in">
                  {sign.waiting ? "Esperando o login…" : connection === "not_connected" ? "Entrar" : "Entrar de novo"}
                </button>
              </div>
              {sign.waiting && (
                <p className="connector-form__hint" data-testid="oauth-waiting">
                  O login abriu em outra aba. Termine lá e esta tela atualiza sozinha.{" "}
                  {sign.loginUrl && (
                    <a href={sign.loginUrl} target="_blank" rel="noopener noreferrer">
                      Abrir a tela de login de novo
                    </a>
                  )}{" "}
                  <button type="button" className="oauth-link" onClick={sign.cancelWaiting}>
                    Cancelar
                  </button>
                </p>
              )}
              {sign.waiting && pasteBack && <PasteBack pending={sign.finishPending} error={sign.finishError} onFinish={(url) => void sign.finish(url)} />}
              <ErrorText testId="oauth-sign-in-error">{sign.error}</ErrorText>
            </div>
          ) : (
            <p className="connector-form__hint" data-testid="oauth-save-first">
              Salve o conector para poder entrar com a conta.
            </p>
          )}
        </div>
      )}
      {guide && <GmailGuide onClose={() => setGuide(false)} />}
    </>
  );
}

function hostOf(url: string): string {
  return /^https?:\/\/([^/]+)/i.exec(url)?.[1] ?? url;
}
