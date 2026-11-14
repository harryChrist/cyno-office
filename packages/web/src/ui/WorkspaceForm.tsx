import { defaultMaestroSessionName, describeModelChoice, MAESTRO, MAESTRO_SESSION_NAME_MAX, type ModelChoice, type Workspace } from "@cyno/shared";
import { useEffect, useId, useState, type FormEvent } from "react";
import { api } from "../api/client";
import { choiceFromValues } from "../pages/settings/settingsView";
import { AvatarEditor } from "./AvatarEditor";
import { randomAvatar } from "./avatarOptions";
import { AvatarSprite } from "./AvatarSprite";
import { EngineFields } from "./EngineFields";
import { useAsyncAction } from "./useAsyncAction";
import { hasErrors, LIMITS, type FieldErrors } from "./validation";
import { accessLabel } from "./AgentAccess";
import { ErrorText, Field, Switch } from "./widgets";
import "./workspaceForm.css";
import { createWorkspaceBody, maestroEngineValues, newWorkspaceValues, validateNewWorkspace, type MaestroDraft, type WorkspaceFormValues } from "./workspaceForm";

type WorkspaceFormProps = {
  /** "hero": o estado vazio (campo grande, sem Cancelar); "dialog": o "Novo workspace" do seletor. */
  variant: "hero" | "dialog";
  onCreated: (workspace: Workspace) => void;
  onCancel?: () => void;
};

/**
 * Criar workspace: o nome em destaque e, recolhida, a parte "Personalizar o Maestro" (nome de
 * exibição, aparência, motor/modelo/esforço com os padrões globais e instruções). Sem mexer no
 * Maestro, ele nasce como sempre.
 */
export function WorkspaceForm({ variant, onCreated, onCancel }: WorkspaceFormProps) {
  const [values, setValues] = useState<WorkspaceFormValues>(newWorkspaceValues);
  const [defaults, setDefaults] = useState<ModelChoice | null>(null);
  const [customizing, setCustomizing] = useState(false);
  const [editingLook, setEditingLook] = useState(false);
  const [errors, setErrors] = useState<FieldErrors<"name" | "maestroName" | "instructions" | "sessionName">>({});
  const { pending, error, run } = useAsyncAction();
  const panelId = useId();
  const maestro = values.maestro;
  const setMaestro = (patch: Partial<MaestroDraft>) => setValues((current) => ({ ...current, maestro: { ...current.maestro, ...patch } }));
  const setAccess = (patch: Partial<WorkspaceFormValues["access"]>) => setValues((current) => ({ ...current, access: { ...current.access, ...patch } }));

  // Motor/modelo/esforço do Maestro: os padrões globais (Configurações › Modelos).
  useEffect(() => {
    let alive = true;
    api.getModelDefaults().then(
      ({ defaults: global }) => {
        if (!alive) return;
        setDefaults(global.maestro);
        setValues((current) => (current.maestro.engine ? current : { ...current, maestro: { ...current.maestro, engine: maestroEngineValues(global.maestro) } }));
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = validateNewWorkspace(values);
    setErrors(found);
    if (found.maestroName || found.instructions || found.sessionName) setCustomizing(true);
    if (hasErrors(found)) return;
    const created = await run(() => api.createWorkspace(createWorkspaceBody(values, defaults)));
    if (created) onCreated(created);
  };

  const shownName = maestro.name.trim() || MAESTRO.agentName;
  const engineSummary = maestro.engine ? describeModelChoice(choiceFromValues(maestro.engine)) : "padrão das Configurações";
  const hero = variant === "hero";

  return (
    <form className={`ui-form ws-form ws-form--${variant}`} aria-label="Novo workspace" noValidate onSubmit={(e) => void submit(e)} data-testid="workspace-form">
      <Field label="Nome do workspace" error={errors.name} hint="Ex.: LinkedIn, Loja, Cliente X. Dá para renomear depois.">
        {(props) => (
          <input
            {...props}
            className={`ui-input${hero ? " ws-form__name" : ""}`}
            value={values.name}
            placeholder={hero ? "Meu primeiro workspace" : undefined}
            maxLength={LIMITS.workspaceName + 10}
            autoFocus
            onChange={(e) => setValues({ ...values, name: e.currentTarget.value })}
            data-testid="workspace-name"
          />
        )}
      </Field>

      <section className="ws-form__maestro" aria-label="Maestro do workspace">
        <button
          type="button"
          className="ws-form__maestro-toggle"
          aria-expanded={customizing}
          aria-controls={panelId}
          onClick={() => setCustomizing((on) => !on)}
          data-testid="workspace-maestro-toggle"
        >
          <span className="ws-form__maestro-face" aria-hidden="true">
            <AvatarSprite avatar={maestro.avatar} maestro size={40} framing="head" />
          </span>
          <span className="ws-form__maestro-text">
            <span className="ws-form__maestro-name">
              {shownName} <span className="ws-form__maestro-role">· Maestro</span>
            </span>
            <span className="ws-form__maestro-engine">{engineSummary}</span>
          </span>
          <span className="ws-form__maestro-action">
            <span className="ws-form__maestro-action-label">{customizing ? "Recolher" : "Personalizar o Maestro"}</span>
            <span className="ws-form__caret" aria-hidden="true">
              ▾
            </span>
          </span>
        </button>

        {customizing && (
          <div id={panelId} className="ws-form__maestro-panel" data-testid="workspace-maestro-panel">
            <p className="ws-form__maestro-intro">O Maestro coordena o workspace: recebe os pedidos, divide em tarefas e escolhe quem faz cada uma.</p>
            <div className="ws-form__maestro-grid">
              <div className="ws-form__look">
                <div className="avatar-stage ws-form__stage">
                  <AvatarSprite avatar={maestro.avatar} maestro scale={4} animate testId="workspace-maestro-preview" />
                </div>
                <div className="ws-form__look-actions">
                  <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => setMaestro({ avatar: randomAvatar() })} data-testid="workspace-maestro-random">
                    Sortear
                  </button>
                  <button
                    type="button"
                    className="ui-button ui-button--secondary ui-button--small"
                    aria-expanded={editingLook}
                    onClick={() => setEditingLook((on) => !on)}
                    data-testid="workspace-maestro-look"
                  >
                    {editingLook ? "Fechar visual" : "Editar visual"}
                  </button>
                </div>
              </div>
              <div className="ws-form__fields">
                <Field label="Nome do Maestro" error={errors.maestroName} hint="Só o nome que aparece no escritório.">
                  {(props) => (
                    <input
                      {...props}
                      className="ui-input"
                      value={maestro.name}
                      placeholder={MAESTRO.agentName}
                      maxLength={LIMITS.agentName + 10}
                      onChange={(e) => setMaestro({ name: e.currentTarget.value })}
                      data-testid="workspace-maestro-name"
                    />
                  )}
                </Field>
                {maestro.engine ? (
                  <EngineFields values={maestro.engine} onChange={(engine) => setMaestro({ engine })} locked={false} testIdPrefix="workspace-maestro" role="maestro" />
                ) : (
                  <p className="ui-field__hint">Carregando os modelos padrão…</p>
                )}
              </div>
            </div>
            {editingLook && <AvatarEditor value={maestro.avatar} onChange={(avatar) => setMaestro({ avatar })} previewScale={4} />}
            <Field label="Instruções e personalidade" error={errors.instructions} hint="Opcional. Vazio = as instruções padrão do Maestro.">
              {(props) => (
                <textarea
                  {...props}
                  className="ui-input"
                  rows={3}
                  value={maestro.instructions}
                  placeholder={MAESTRO.instructions}
                  onChange={(e) => setMaestro({ instructions: e.currentTarget.value })}
                  data-testid="workspace-maestro-instructions"
                />
              )}
            </Field>
            <Field
              label="Nome da sessão no Remote Control"
              error={errors.sessionName}
              hint="Opcional. É como a conversa do Maestro aparece no app do Claude e em claude.ai/code. Dá para trocar depois no painel do Maestro."
            >
              {(props) => (
                <input
                  {...props}
                  className="ui-input"
                  value={maestro.sessionName}
                  placeholder={defaultMaestroSessionName(values.name.trim() || "<workspace>")}
                  maxLength={MAESTRO_SESSION_NAME_MAX + 10}
                  onChange={(e) => setMaestro({ sessionName: e.currentTarget.value })}
                  data-testid="workspace-maestro-session-name"
                />
              )}
            </Field>
          </div>
        )}
      </section>

      <details className="ws-form__access" data-testid="workspace-access">
        <summary className="ws-form__access-summary">Acesso dos agentes · {accessLabel({ ...values.access, browser: values.access.internet && values.access.browser })}</summary>
        <div className="ws-form__access-panel">
          <p className="ui-field__hint">O que os agentes deste workspace podem usar. Domínios e o resto ficam em Configurações › Acesso dos agentes.</p>
          <Switch label="Internet (pesquisa e páginas)" checked={values.access.internet} onChange={(internet) => setAccess({ internet })} testId="workspace-access-internet" />
          <Switch
            label="Navegador compartilhado"
            checked={values.access.internet && values.access.browser}
            disabled={!values.access.internet}
            onChange={(browser) => setAccess({ browser })}
            testId="workspace-access-browser"
          />
          <Switch
            label="Terminal no servidor"
            description={values.access.terminal ? "Atenção: os agentes poderão rodar comandos na sua máquina." : undefined}
            checked={values.access.terminal}
            onChange={(terminal) => setAccess({ terminal })}
            testId="workspace-access-terminal"
          />
        </div>
      </details>

      <ErrorText>{error}</ErrorText>
      <div className={`ui-actions${hero ? " ws-form__actions--hero" : ""}`}>
        {onCancel && (
          <button type="button" className="ui-button ui-button--secondary" onClick={onCancel}>
            Cancelar
          </button>
        )}
        <button type="submit" className={`ui-button${hero ? " ws-form__submit" : ""}`} disabled={pending} data-testid="create-workspace-submit">
          {pending ? "Criando…" : "Criar workspace"}
        </button>
      </div>
    </form>
  );
}
