import { CONNECTOR_ICON_MAX_BYTES, CONNECTOR_ICON_MIME_TYPES, type ConnectorImportCandidate, type LibraryConnector, type LibraryImportResponse } from "@cyno/shared";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api, describeError } from "../api/client";
import { useLibraryStore } from "../store/libraryStore";
import { useAsyncAction } from "../ui/useAsyncAction";
import { ErrorText, Field, Modal } from "../ui/widgets";
import { ConnectorIcon } from "./ConnectorIcon";
import { AuthChoice, GmailModeChoice, type OAuthDiscoveryState } from "./OAuthSection";
import {
  EMPTY_FORM,
  formErrors,
  formFromCandidate,
  formFromLibraryConnector,
  gmailModeOf,
  KIND_LABELS,
  libraryCreateBody,
  libraryPatchBody,
  MONOGRAM_COLORS,
  searchBrands,
  type ConnectorForm,
} from "./connectorView";
import "../pages/settings/connectorsSettings.css";

export type ConnectorEditing = { mode: "create"; form: ConnectorForm; note?: string } | { mode: "edit"; connector: LibraryConnector };
export { EMPTY_FORM, formFromCandidate };

/** Lê um arquivo como base64 (sem o "data:…;base64,"). */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error("Não foi possível ler a imagem"));
    reader.readAsDataURL(file);
  });
}

/** Escolha do ícone: marca (busca no conjunto do simple-icons), monograma com cor, ou imagem própria. */
function IconFields({ form, set, connector, onFile }: { form: ConnectorForm; set: (change: Partial<ConnectorForm>) => void; connector?: LibraryConnector; onFile: (file: File | null) => void }) {
  const [query, setQuery] = useState("");
  const brands = useMemo(() => searchBrands(query).slice(0, 48), [query]);
  const groupId = useId();
  const preview = { id: connector?.id ?? "novo", name: form.name || "Conector", icon: form.iconKind === "brand" && form.brand ? { kind: "brand" as const, slug: form.brand } : form.iconKind === "custom" && connector?.icon.kind === "custom" ? connector.icon : { kind: "monogram" as const }, ...(form.color ? { color: form.color } : {}) };
  return (
    <fieldset className="connector-form__fieldset">
      <legend className="ui-field__label">Ícone</legend>
      <div className="connector-form__icon-row">
        <ConnectorIcon connector={preview} size={40} />
        <div className="connector-form__radios" role="radiogroup" aria-labelledby={groupId}>
          <span id={groupId} className="sr-only">
            Tipo de ícone
          </span>
          {(["brand", "monogram", "custom"] as const).map((kind) => (
            <label key={kind} className="connector-form__radio">
              <input type="radio" name={`${groupId}-kind`} checked={form.iconKind === kind} onChange={() => set({ iconKind: kind })} data-testid={`connector-icon-${kind}`} />
              {kind === "brand" ? "Marca" : kind === "monogram" ? "Letras" : "Imagem própria"}
            </label>
          ))}
        </div>
      </div>
      {form.iconKind === "brand" && (
        <div className="connector-form__brands">
          <input className="ui-input ui-input--compact" type="search" placeholder="Buscar marca (Notion, GitHub…)" value={query} onChange={(event) => setQuery(event.currentTarget.value)} aria-label="Buscar marca" data-testid="connector-brand-search" />
          <ul className="connector-form__brand-grid" aria-label="Marcas">
            {brands.map((brand) => (
              <li key={brand.slug}>
                <button
                  type="button"
                  className="connector-form__brand"
                  aria-pressed={form.brand === brand.slug}
                  title={brand.title}
                  onClick={() => set({ brand: brand.slug, color: "" })}
                  data-testid={`connector-brand-${brand.slug}`}
                >
                  <ConnectorIcon connector={{ id: brand.slug, name: brand.title, icon: { kind: "brand", slug: brand.slug } }} size={26} />
                  <span>{brand.title}</span>
                </button>
              </li>
            ))}
            {brands.length === 0 && <li className="ui-muted">Nenhuma marca com esse nome: use Letras ou uma imagem própria.</li>}
          </ul>
        </div>
      )}
      {form.iconKind === "monogram" && (
        <div className="connector-form__colors" role="radiogroup" aria-label="Cor">
          {MONOGRAM_COLORS.map((color) => (
            <button key={color} type="button" role="radio" aria-checked={form.color === color} aria-label={`Cor ${color}`} className="connector-form__color" style={{ background: color }} onClick={() => set({ color })} />
          ))}
        </div>
      )}
      {form.iconKind === "custom" && (
        <Field label="Imagem (PNG ou WebP, até 256 KB)" hint="Para o seu próprio sistema. Quadrada fica melhor.">
          {(props) => <input {...props} type="file" accept={CONNECTOR_ICON_MIME_TYPES.join(",")} onChange={(event) => onFile(event.currentTarget.files?.[0] ?? null)} data-testid="connector-icon-file" />}
        </Field>
      )}
    </fieldset>
  );
}

/** Põe o conector que acabou de voltar da API na Biblioteca já (o evento do socket confirma depois). */
function mergeIntoStore(saved: LibraryConnector): void {
  useLibraryStore.setState((state) => ({ connectors: state.connectors ? (state.connectors.some((item) => item.id === saved.id) ? state.connectors.map((item) => (item.id === saved.id ? saved : item)) : [...state.connectors, saved]) : state.connectors }));
}

const looksLikeUrl = (text: string) => /^https?:\/\/[^\s/]+\.[^\s/]+/i.test(text.trim()) || /^http:\/\/(localhost|127\.0\.0\.1)/i.test(text.trim());

/** Cadastro/edição de um conector. Segredos: só os nomes voltam do server; deixar vazio = manter. */
export function ConnectorFormDialog({ editing, onClose, onSaved }: { editing: ConnectorEditing; onClose: () => void; onSaved?: (saved: LibraryConnector) => void }) {
  // Conector com login OAuth recém-criado: a janela continua aberta, agora como edição, para entrar com a conta.
  const [created, setCreated] = useState<LibraryConnector | null>(null);
  const base = created ?? (editing.mode === "edit" ? editing.connector : undefined);
  const live = useLibraryStore((state) => (base ? state.connectors?.find((item) => item.id === base.id) : undefined));
  const connector = live ?? base;
  const [form, setForm] = useState<ConnectorForm>(() => (editing.mode === "edit" ? formFromLibraryConnector(editing.connector) : editing.form));
  const [file, setFile] = useState<File | null>(null);
  const [touched, setTouched] = useState(false);
  const [discovery, setDiscovery] = useState<OAuthDiscoveryState>({ status: "idle" });
  const checkId = useRef(0);
  const { pending, error, run } = useAsyncAction();
  const set = (change: Partial<ConnectorForm>) => setForm((current) => ({ ...current, ...change }));
  const errors = formErrors(form, Boolean(connector));
  const fileError = file && !(CONNECTOR_ICON_MIME_TYPES as readonly string[]).includes(file.type) ? "Use PNG ou WebP." : file && file.size > CONNECTOR_ICON_MAX_BYTES ? "A imagem passa de 256 KB." : undefined;

  /** "Verificar": descobre o OAuth do servidor (a URL do formulário, ou a guardada quando o campo está vazio na edição). */
  const verify = async () => {
    const url = form.url.trim();
    if (form.kind !== "http" || (!url && !connector)) return;
    if (url && !looksLikeUrl(url)) {
      setDiscovery({ status: "done", error: "Cole uma URL http:// ou https:// válida antes de verificar." });
      return;
    }
    const id = ++checkId.current;
    setDiscovery({ status: "checking" });
    try {
      const result = await api.discoverLibraryOAuth(url ? { url } : { connectorId: connector!.id });
      if (id !== checkId.current) return;
      setDiscovery({ status: "done", result });
      // Achou OAuth e o dono ainda não escolheu: já deixa em "Entrar com a conta" com os escopos sugeridos.
      if (result.found) {
        setForm((current) => {
          if (!connector && !current.authTouched) return { ...current, authMode: "oauth", oauthScopes: result.defaultScopes };
          if (current.authMode === "oauth" && current.oauthScopes.length === 0) return { ...current, oauthScopes: result.defaultScopes };
          return current;
        });
      }
    } catch (failure) {
      if (id === checkId.current) setDiscovery({ status: "done", error: describeError(failure) });
    }
  };
  const verifyRef = useRef(verify);
  useEffect(() => {
    verifyRef.current = verify;
  });

  // Conector novo com URL (digitada, colada ou vinda da importação do Claude Code): descobre sozinho.
  useEffect(() => {
    if (form.kind !== "http" || connector || !looksLikeUrl(form.url)) return;
    const timer = window.setTimeout(() => void verifyRef.current(), 700);
    return () => window.clearTimeout(timer);
  }, [form.url, form.kind, connector]);

  const persist = async (notify = true): Promise<LibraryConnector> => {
    const patch = connector ? libraryPatchBody(connector, form) : undefined;
    const saved = connector ? (Object.keys(patch ?? {}).length > 0 ? await api.updateLibraryConnector(connector.id, patch!) : connector) : await api.createLibraryConnector(libraryCreateBody(form));
    if (form.iconKind === "custom" && file) await api.uploadLibraryConnectorIcon(saved.id, { mime: file.type as (typeof CONNECTOR_ICON_MIME_TYPES)[number], dataBase64: await readBase64(file) });
    mergeIntoStore(saved);
    if (notify) onSaved?.(saved);
    return saved;
  };
  /** Conector OAuth novo: quem chamou (a Biblioteca abre o "Liberar…") só é avisado ao fechar, para a janela de entrar não ficar coberta. */
  const finish = () => {
    if (created && editing.mode === "create") onSaved?.(created);
    onClose();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length > 0 || fileError) return;
    const ok = await run(async () => {
      const wasCreate = !connector;
      const saved = await persist(wasCreate && !(form.kind === "http" && form.authMode === "oauth"));
      if (wasCreate && saved.oauth) {
        // Falta entrar com a conta: continua aberto, agora na edição do conector criado.
        setCreated(saved);
        setForm(formFromLibraryConnector(saved));
        return false;
      }
      set({ oauthClientSecret: "", oauthClientSecretStored: Boolean(saved.oauth?.clientSecretSet) });
      return true;
    });
    if (ok) finish();
  };

  const show = (key: keyof typeof errors) => (touched ? errors[key] : undefined);
  const secretLabel = form.kind === "http" ? "Cabeçalhos secretos" : "Variáveis de ambiente secretas";
  const staticFields = (
    <>
      {form.kind === "http" && (
        <Field label="Token (Bearer)" hint={form.bearerStored ? "Definido. Digite um novo para trocar." : "Vira o cabeçalho Authorization: Bearer …"}>
          {(props) => (
            <div className="connector-form__secret">
              <input
                {...props}
                className="ui-input"
                type="password"
                autoComplete="off"
                value={form.bearer}
                disabled={form.removeBearer}
                placeholder={form.bearerStored ? "•••••• (definido)" : ""}
                onChange={(event) => set({ bearer: event.currentTarget.value })}
                data-testid="connector-bearer"
              />
              {form.bearerStored && (
                <label className="connector-form__radio">
                  <input type="checkbox" checked={form.removeBearer} onChange={(event) => set({ removeBearer: event.currentTarget.checked, bearer: "" })} />
                  apagar
                </label>
              )}
            </div>
          )}
        </Field>
      )}
      <p className="ui-field__label connector-form__sublabel">{secretLabel}</p>
      <ul className="connector-form__secrets">
        {form.secrets.map((row, index) => (
          <li key={index} className="connector-form__secret">
            <input
              className="ui-input ui-input--compact"
              aria-label="Nome"
              value={row.name}
              disabled={row.stored}
              placeholder={form.kind === "http" ? "X-Api-Key" : "GITHUB_TOKEN"}
              onChange={(event) => set({ secrets: form.secrets.map((other, i) => (i === index ? { ...other, name: event.currentTarget.value } : other)) })}
            />
            <input
              className="ui-input ui-input--compact"
              aria-label={`Valor de ${row.name || "segredo"}`}
              type="password"
              autoComplete="off"
              value={row.value}
              disabled={row.remove}
              placeholder={row.stored ? "•••••• (definido)" : "valor"}
              onChange={(event) => set({ secrets: form.secrets.map((other, i) => (i === index ? { ...other, value: event.currentTarget.value } : other)) })}
            />
            <button
              type="button"
              className="ui-button ui-button--secondary ui-button--small"
              aria-pressed={row.remove}
              onClick={() => set({ secrets: row.stored ? form.secrets.map((other, i) => (i === index ? { ...other, remove: !other.remove, value: "" } : other)) : form.secrets.filter((_, i) => i !== index) })}
            >
              {row.stored ? (row.remove ? "Manter" : "Apagar") : "Tirar"}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => set({ secrets: [...form.secrets, { name: "", value: "", stored: false, remove: false }] })} data-testid="connector-add-secret">
        + {form.kind === "http" ? "Cabeçalho" : "Variável"}
      </button>
      <ErrorText>{show("secrets")}</ErrorText>
    </>
  );
  return (
    <Modal title={connector ? `Editar ${connector.name}` : "Novo conector"} onClose={finish} wide testId="connector-form-dialog">
      <form className="connector-form" noValidate onSubmit={(event) => void submit(event)}>
        {editing.mode === "create" && editing.note && !created && <p className="connector-form__note">{editing.note}</p>}
        {created && (
          <p className="connector-form__note" data-testid="connector-created-note">
            Conector criado. Falta entrar com a conta: use o botão Entrar na seção de credenciais.
          </p>
        )}
        <Field label="Nome" error={show("name")}>
          {(props) => <input {...props} className="ui-input" value={form.name} maxLength={60} onChange={(event) => set({ name: event.currentTarget.value })} data-testid="connector-name" />}
        </Field>
        <Field label="O que faz (opcional)" hint="Uma linha para reconhecer o conector na Biblioteca.">
          {(props) => <input {...props} className="ui-input" value={form.description} maxLength={300} placeholder="Lê o conteúdo de uma página da web" onChange={(event) => set({ description: event.currentTarget.value })} data-testid="connector-description" />}
        </Field>
        {!connector && !gmailModeOf(form) && (
          <fieldset className="connector-form__fieldset">
            <legend className="ui-field__label">Tipo</legend>
            <div className="connector-form__radios">
              {(["http", "stdio"] as const).map((kind) => (
                <label key={kind} className="connector-form__radio">
                  <input type="radio" name="connector-kind" checked={form.kind === kind} onChange={() => set({ kind, secrets: [], authMode: "static" })} data-testid={`connector-kind-${kind}`} />
                  {kind === "http" ? "HTTP (URL de um servidor MCP)" : "Local (um comando que roda aqui no servidor)"}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {form.kind === "http" && gmailModeOf(form) ? (
          <GmailModeChoice form={form} set={set} editing={Boolean(connector)} />
        ) : form.kind === "http" ? (
          <Field label="URL do servidor MCP" error={show("url")} hint={connector ? `Atual: ${form.urlPlaceholder}. Deixe vazio para manter.` : "Streamable HTTP (ex.: https://mcp.notion.com/mcp)."}>
            {(props) => <input {...props} className="ui-input" type="url" inputMode="url" value={form.url} placeholder={form.urlPlaceholder} onChange={(event) => set({ url: event.currentTarget.value })} data-testid="connector-url" />}
          </Field>
        ) : (
          <>
            <Field label="Comando" error={show("command")} hint="Roda sem shell, na pasta do conector, só quando um agente precisa (ex.: npx, uvx, node).">
              {(props) => <input {...props} className="ui-input" value={form.command} placeholder="npx" onChange={(event) => set({ command: event.currentTarget.value })} data-testid="connector-command" />}
            </Field>
            <Field label="Argumentos (um por linha)">
              {(props) => <textarea {...props} className="ui-input" rows={3} value={form.args} placeholder={"-y\n@modelcontextprotocol/server-github"} onChange={(event) => set({ args: event.currentTarget.value })} data-testid="connector-args" />}
            </Field>
          </>
        )}

        <fieldset className="connector-form__fieldset">
          <legend className="ui-field__label">Credenciais</legend>
          <p className="connector-form__hint">Ficam só no servidor (arquivo com permissão 0600). Os agentes nunca veem: o servidor conecta por eles.</p>
          {form.kind === "http" ? (
            <AuthChoice form={form} set={set} connector={connector} discovery={discovery} onVerify={() => void verify()} editing={Boolean(connector)} save={async () => void (await persist(false).then((saved) => set({ oauthClientSecret: "", oauthClientSecretStored: Boolean(saved.oauth?.clientSecretSet) })))}>
              {staticFields}
            </AuthChoice>
          ) : (
            staticFields
          )}
        </fieldset>

        <IconFields form={form} set={set} connector={connector} onFile={setFile} />
        <ErrorText>{touched ? fileError : undefined}</ErrorText>

        <ErrorText testId="connector-form-error">{error}</ErrorText>
        <div className="ui-actions">
          <button type="button" className="ui-button ui-button--secondary" onClick={finish}>
            {created ? "Fechar" : "Cancelar"}
          </button>
          <button type="submit" className="ui-button" disabled={pending} data-testid="connector-save">
            {pending ? "Salvando…" : connector ? "Salvar" : "Criar e testar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const SOURCE_STATUS: Record<string, string> = {
  connected: "conectado no Claude Code",
  needs_auth: "pede login no Claude Code",
  failed: "falhando no Claude Code",
  pending: "esperando aprovação no Claude Code",
};

/** Importar do Claude Code: a lista do `claude mcp list` (sem segredos); escolher um abre o formulário. */
export function ImportDialog({ onClose, onPick }: { onClose: () => void; onPick: (candidate: ConnectorImportCandidate) => void }) {
  const [result, setResult] = useState<LibraryImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.importLibraryConnectorsFromClaude().then(
      (response) => alive && setResult(response),
      (failure: unknown) => alive && setError(describeError(failure)),
    );
    return () => {
      alive = false;
    };
  }, []);
  return (
    <Modal title="Importar do Claude Code" onClose={onClose} wide testId="connector-import-dialog">
      <p className="connector-form__hint">
        Lido do <code>claude mcp list</code> deste computador, só leitura. Copiamos o nome e a URL/comando; tokens e senhas você digita no próximo passo (nada é lido dos arquivos de configuração do Claude Code).
      </p>
      <ErrorText>{error}</ErrorText>
      {!result && !error && (
        <p className="settings__card-hint" role="status">
          Perguntando ao Claude Code… (pode levar alguns segundos: ele testa cada servidor)
        </p>
      )}
      {result && !result.available && <p className="settings__card-hint">Não deu para ler: {result.reason}.</p>}
      {result?.available && result.candidates.length === 0 && <p className="settings__card-hint">O Claude Code não tem servidores MCP que dê para importar.</p>}
      {result?.available && result.candidates.length > 0 && (
        <ul className="connector-import" data-testid="connector-import-list">
          {result.candidates.map((candidate) => (
            <li key={candidate.sourceName} className="connector-import__row">
              <div className="connector-import__text">
                <span className="connector-import__name">
                  {candidate.name} <span className="settings__chip">{KIND_LABELS[candidate.kind]}</span>
                </span>
                <span className="connector-import__meta">
                  {candidate.kind === "http" ? candidate.url : [candidate.command, ...(candidate.args ?? [])].join(" ")}
                  {" · "}
                  {SOURCE_STATUS[candidate.sourceStatus] ?? candidate.sourceStatus}
                  {candidate.hostedByClaudeAi && " · conector do claude.ai (aqui precisa de token próprio)"}
                </span>
              </div>
              {candidate.alreadyImported ? (
                <span className="ui-badge ui-badge--neutral">Já importado</span>
              ) : (
                <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => onPick(candidate)} data-testid={`connector-import-${candidate.sourceName}`}>
                  Importar
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

