import { AGENT_EFFORTS, cynoChoiceOf, describeModelChoice, maestroKeepAlive, type AgentEffort, type ModelChoice, type ModelDefaults, type Workspace } from "@cyno/shared";
import { useEffect, useRef, useState } from "react";
import { api, describeError } from "../../api/client";
import { EngineFields, effortOptionLabel, useEngines } from "../../ui/EngineFields";
import { ErrorText, Field } from "../../ui/widgets";
import { ResetDefaultButton } from "./ResetDefault";
import { OptionHead, SettingSwitch, StateBadge } from "./SettingsOption";
import { choiceFromValues, choiceValues, modelShortName, sameModelDefaults, subagentFromValues, type ChoiceValues, type SettingsSeal } from "./settingsView";

/** Modelo + esforço padrão dos subagentes de um motor (vazio = o subagente herda o modelo do agente). */
function SubagentFields({
  engine,
  model,
  effort,
  onChange,
  testId,
}: {
  engine: "claude" | "gemini";
  model: string;
  effort: AgentEffort | "";
  onChange: (model: string, effort: AgentEffort | "") => void;
  testId: string;
}) {
  const engines = useEngines();
  const models = engines?.find((info) => info.engine === engine)?.models ?? [];
  const listId = `${testId}-models`;
  return (
    <div className="ui-form__row settings__models-row">
      <Field label={engine === "claude" ? "Claude Code" : "Antigravity"} hint={engine === "claude" ? "Vazio = o mesmo modelo do agente." : "Gemini Flash é o mais leve; o nível vem no nome."}>
        {(props) => (
          <>
            <input
              {...props}
              className="ui-input"
              value={model}
              placeholder="Mesmo do agente"
              maxLength={80}
              list={models.length > 0 ? listId : undefined}
              onChange={(e) => onChange(e.currentTarget.value, effort)}
              data-testid={`${testId}-model`}
            />
            {models.length > 0 && (
              <datalist id={listId}>
                {models.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label ?? option.id}
                  </option>
                ))}
              </datalist>
            )}
          </>
        )}
      </Field>
      {engine === "claude" && (
        <Field label="Esforço" hint="Vazio = o do agente.">
          {(props) => (
            <select {...props} className="ui-input" value={effort} onChange={(e) => onChange(model, e.currentTarget.value as AgentEffort | "")} data-testid={`${testId}-effort`}>
              <option value="">Mesmo do agente</option>
              {AGENT_EFFORTS.map((option) => (
                <option key={option} value={option}>
                  {effortOptionLabel(option)}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
    </div>
  );
}

type Draft = { maestro: ChoiceValues; agentes: ChoiceValues; claude: { model: string; effort: AgentEffort | "" }; gemini: { model: string; effort: AgentEffort | "" } };

const draftOf = (defaults: ModelDefaults): Draft => ({
  maestro: choiceValues(defaults.maestro),
  agentes: choiceValues(defaults.agentes),
  claude: { model: defaults.subagentes.claude?.model ?? "", effort: defaults.subagentes.claude?.effort ?? "" },
  gemini: { model: defaults.subagentes.gemini?.model ?? "", effort: defaults.subagentes.gemini?.effort ?? "" },
});

const defaultsOf = (draft: Draft): ModelDefaults => {
  const claude = subagentFromValues(draft.claude.model, draft.claude.effort);
  const gemini = subagentFromValues(draft.gemini.model, draft.gemini.effort);
  return {
    maestro: choiceFromValues(draft.maestro),
    agentes: choiceFromValues(draft.agentes),
    subagentes: { ...(claude ? { claude } : {}), ...(gemini ? { gemini } : {}) },
  };
};

/** "Claude Sonnet · Antigravity Gemini 3.8 Flash" (vazio = o subagente herda o modelo do agente). */
function subagentsState(defaults: ModelDefaults): string {
  const claude = defaults.subagentes.claude?.model;
  const gemini = defaults.subagentes.gemini?.model;
  const parts = [...(claude ? [`Claude ${modelShortName({ engine: "claude", model: claude })}`] : []), ...(gemini ? [`Antigravity ${modelShortName({ engine: "gemini", model: gemini })}`] : [])];
  return parts.length > 0 ? parts.join(" · ") : "Mesmo modelo do agente";
}

/** Um conjunto de padrões (do workspace ou global): Maestro, agentes e subagentes, com Salvar/Desfazer. */
function DefaultsCard({
  title,
  hint,
  maestroHint,
  value,
  onSave,
  testId,
  seal,
}: {
  title: string;
  hint: string;
  maestroHint: string;
  seal: SettingsSeal;
  value: ModelDefaults;
  onSave: (defaults: ModelDefaults) => Promise<unknown>;
  testId: string;
}) {
  const [draft, setDraft] = useState(() => draftOf(value));
  const [state, setState] = useState<{ saving: boolean; error: string | null; saved: boolean }>({ saving: false, error: null, saved: false });
  // O valor salvo mudou (outra aba, outro navegador, o próprio Salvar): o rascunho acompanha.
  const lastValue = useRef(value);
  useEffect(() => {
    if (sameModelDefaults(lastValue.current, value)) return;
    lastValue.current = value;
    setDraft(draftOf(value));
  }, [value]);
  const next = defaultsOf(draft);
  const dirty = !sameModelDefaults(next, value);
  const save = () => {
    setState({ saving: true, error: null, saved: false });
    onSave(next).then(
      () => setState({ saving: false, error: null, saved: true }),
      (error: unknown) => setState({ saving: false, error: describeError(error), saved: false }),
    );
  };
  return (
    <section className="settings__card" data-testid={testId}>
      <header className="settings__card-head">
        <h4 className="settings__card-title">{title}</h4>
        <p className="settings__card-hint">{hint}</p>
      </header>
      <div className="settings__models-group">
        <OptionHead level={5} title="Maestro" seal={seal} state={<StateBadge tone="value">{describeModelChoice(value.maestro)}</StateBadge>} line={maestroHint} />
        <div className="ui-form__row settings__models-row">
          <EngineFields values={draft.maestro} onChange={(maestro) => setDraft({ ...draft, maestro })} locked={state.saving} testIdPrefix={`${testId}-maestro`} role="cyno" />
        </div>
      </div>
      <div className="settings__models-group">
        <OptionHead
          level={5}
          title="Agentes"
          seal={seal}
          state={<StateBadge tone="value">{describeModelChoice(value.agentes)}</StateBadge>}
          line="Cada agente novo (pelo botão ou pelo Maestro) nasce com isto; depois, o motor/modelo é do agente (painel dele)."
        />
        <div className="ui-form__row settings__models-row">
          <EngineFields values={draft.agentes} onChange={(agentes) => setDraft({ ...draft, agentes })} locked={state.saving} testIdPrefix={`${testId}-agentes`} />
        </div>
      </div>
      <div className="settings__models-group">
        <OptionHead
          level={5}
          title="Subagentes"
          seal={seal}
          state={<StateBadge tone="value">{subagentsState(value)}</StateBadge>}
          line="Os subagentes internos das CLIs (cópias focadas do agente) usam isto por padrão; o agente pode pedir outro modelo para uma peça difícil."
        />
        <SubagentFields engine="claude" model={draft.claude.model} effort={draft.claude.effort} onChange={(model, effort) => setDraft({ ...draft, claude: { model, effort } })} testId={`${testId}-sub-claude`} />
        <SubagentFields engine="gemini" model={draft.gemini.model} effort={draft.gemini.effort} onChange={(model, effort) => setDraft({ ...draft, gemini: { model, effort } })} testId={`${testId}-sub-gemini`} />
      </div>
      <ErrorText testId={`${testId}-error`}>{state.error}</ErrorText>
      <div className="settings__models-actions">
        {state.saved && !dirty && (
          <span className="settings__card-hint" role="status">
            Salvo.
          </span>
        )}
        <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => setDraft(draftOf(value))} disabled={!dirty || state.saving}>
          Desfazer
        </button>
        <button type="button" className="ui-button ui-button--primary ui-button--small" onClick={save} disabled={!dirty || state.saving} aria-busy={state.saving} data-testid={`${testId}-save`}>
          {state.saving ? "Salvando…" : "Salvar"}
        </button>
      </div>
    </section>
  );
}

/** Lembrete comum às duas seções de modelos. */
function DefaultsNote() {
  return (
    <p className="settings__card-hint">
      Padrões são só o valor inicial: o agente guarda o próprio motor, modelo e esforço, e é isso que vale quando ele trabalha. Motor real (Claude Code, Antigravity) roda na sua assinatura.
    </p>
  );
}

/** Aponta para a outra seção de modelos (a do outro escopo). */
function SeeAlso({ children, action, onClick, testId }: { children: string; action: string; onClick: () => void; testId: string }) {
  return (
    <p className="settings__see-also">
      <span>{children}</span>
      <button type="button" className="settings__link" onClick={onClick} data-testid={testId}>
        {action}
      </button>
    </p>
  );
}

/**
 * Seção geral "Modelos padrão": os padrões GLOBAIS (DATA_DIR/models.json), copiados para os
 * padrões de cada workspace novo. Mudar aqui nunca mexe em workspaces que já existem.
 */
export function GlobalModelsSettings({ onOpenWorkspaceModels, onLoaded }: { onOpenWorkspaceModels?: () => void; onLoaded?: (defaults: ModelDefaults) => void }) {
  const [global, setGlobal] = useState<ModelDefaults | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.getModelDefaults().then(
      (response) => {
        if (!alive) return;
        setGlobal(response.defaults);
        onLoaded?.(response.defaults);
      },
      (failure: unknown) => alive && setError(describeError(failure)),
    );
    return () => {
      alive = false;
    };
    // Lê uma vez ao abrir; avisar o resumo do topo não deve refazer a leitura.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = (defaults: ModelDefaults) => {
    setGlobal(defaults);
    onLoaded?.(defaults);
  };

  return (
    <div className="settings__groups" data-testid="settings-models-defaults">
      <DefaultsNote />
      <ErrorText testId="settings-models-error">{error}</ErrorText>
      {global ? (
        <DefaultsCard
          title="Para workspaces novos"
          hint="Copiados para os padrões de cada workspace criado daqui para frente. Os workspaces que já existem não mudam."
          maestroHint="O Maestro de cada workspace novo nasce com isto."
          seal="plataforma"
          value={global}
          onSave={async (defaults) => apply((await api.updateModelDefaults(defaults)).defaults)}
          testId="settings-models-global"
        />
      ) : (
        !error && (
          <p className="settings__card-hint" role="status">
            Lendo os padrões globais…
          </p>
        )
      )}
      {global && <CynoModelCard value={cynoChoiceOf(global)} onSaved={() => void api.getModelDefaults().then((response) => apply(response.defaults), () => undefined)} />}
      {onOpenWorkspaceModels && (
        <SeeAlso action="Abrir Modelos e Maestro" onClick={onOpenWorkspaceModels} testId="settings-models-to-workspace">
          Os agentes novos do workspace aberto usam os padrões dele, não estes.
        </SeeAlso>
      )}
    </div>
  );
}

/**
 * Modelo do Cyno, o agente da plataforma (não preenche nada nos workspaces): vale na próxima vez que
 * ele acordar. Salva pela rota própria do Cyno, que reinicia o terminal dele quando estiver livre.
 */
function CynoModelCard({ value, onSaved }: { value: ModelChoice; onSaved: () => void }) {
  const [draft, setDraft] = useState<ChoiceValues>(() => choiceValues(value));
  const [state, setState] = useState<{ saving: boolean; error: string | null; saved: boolean }>({ saving: false, error: null, saved: false });
  const lastValue = useRef(value);
  useEffect(() => {
    if (JSON.stringify(lastValue.current) === JSON.stringify(value)) return;
    lastValue.current = value;
    setDraft(choiceValues(value));
  }, [value]);
  const next = choiceFromValues(draft);
  const dirty = JSON.stringify(next) !== JSON.stringify(choiceFromValues(choiceValues(value)));
  const save = () => {
    setState({ saving: true, error: null, saved: false });
    api.setCynoModel(next).then(
      () => {
        setState({ saving: false, error: null, saved: true });
        onSaved();
      },
      (error: unknown) => setState({ saving: false, error: describeError(error), saved: false }),
    );
  };
  return (
    <section className="settings__card" data-testid="settings-models-cyno">
      <OptionHead
        title="Modelo do Cyno"
        seal="plataforma"
        state={<StateBadge tone="value">{describeModelChoice(value)}</StateBadge>}
        line="O Cyno é o agente da plataforma (a página inicial). Trocar o modelo vale na próxima vez que ele acordar; trocar o motor faz a conversa dele recomeçar."
      />
      <div className="ui-form__row settings__models-row">
        <EngineFields values={draft} onChange={setDraft} locked={state.saving} testIdPrefix="settings-models-cyno" role="cyno" />
      </div>
      <ErrorText testId="settings-models-cyno-error">{state.error}</ErrorText>
      <div className="settings__models-actions">
        {state.saved && !dirty && (
          <span className="settings__card-hint" role="status">
            Salvo.
          </span>
        )}
        <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => setDraft(choiceValues(value))} disabled={!dirty || state.saving}>
          Desfazer
        </button>
        <button type="button" className="ui-button ui-button--primary ui-button--small" onClick={save} disabled={!dirty || state.saving} aria-busy={state.saving} data-testid="settings-models-cyno-save">
          {state.saving ? "Salvando…" : "Salvar"}
        </button>
      </div>
    </section>
  );
}

/**
 * Seção do workspace "Modelos e Maestro": os padrões do workspace (preenchem cada agente novo e
 * dizem o modelo dos subagentes) e se o Maestro daqui fica sempre rodando. Salvos no próprio
 * workspace (data/workspaces.json); os agentes que já existem não mudam.
 */
export function WorkspaceModelsSettings({ workspace, onOpenGlobalModels }: { workspace: Workspace; onOpenGlobalModels: () => void }) {
  const workspaceId = workspace.id;
  return (
    <div className="settings__groups" data-testid="settings-models">
      <DefaultsNote />
      <p className="settings__card-hint" data-testid="settings-models-copy-note">
        Estes padrões foram copiados dos padrões da plataforma quando o workspace foi criado. Mudar aqui não muda a plataforma, e mudar a plataforma não muda este workspace.
      </p>
      {workspace.models && (
        <DefaultsCard
          title="Padrões deste workspace"
          hint="Preenchem cada agente novo deste workspace e dizem o modelo dos subagentes. Os agentes que já existem não mudam."
          maestroHint="Só vale se este workspace ganhar um Maestro novo; para trocar o do Maestro atual, abra o painel dele."
          seal="workspace"
          value={workspace.models}
          onSave={(models) => api.updateWorkspaceModels(workspaceId, models)}
          testId="settings-models-workspace"
        />
      )}
      <section className="settings__card" data-testid="settings-maestro">
        <header className="settings__card-head">
          <h4 className="settings__card-title">Maestro deste workspace</h4>
          <p className="settings__card-hint">Vale para o Maestro com motor Claude Code (o terminal interativo dele, com comandos / e Remote Control).</p>
        </header>
        <SettingSwitch
          title="Manter o Maestro sempre rodando"
          line="Ligado: o terminal do Maestro sobe junto com o servidor, volta na mesma conversa depois de um reinício e nunca para por ociosidade (o Remote Control fica sempre disponível no app do Claude e em claude.ai/code). Desligado: sobe quando você pede algo ou abre o terminal, e para depois do tempo ocioso."
          seal="workspace"
          checked={maestroKeepAlive(workspace.maestro)}
          inherited={workspace.maestro?.keepAlive === undefined}
          onToggle={(keepAlive) => api.updateWorkspaceMaestro(workspaceId, { keepAlive })}
          testId="settings-maestro-keep-alive"
        />
        <ResetDefaultButton workspaceId={workspaceId} fields={["maestro.keepAlive"]} own={workspace.maestro?.keepAlive !== undefined} testId="settings-maestro-reset" />
      </section>
      <SeeAlso action="Abrir Modelos padrão" onClick={onOpenGlobalModels} testId="settings-models-to-global">
        Os padrões dos workspaces criados daqui para frente ficam na área "Da plataforma".
      </SeeAlso>
    </div>
  );
}
