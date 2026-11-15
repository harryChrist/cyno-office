import { isMaestroRoom, type OfficeState } from "@cyno/shared";
import { useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { AvatarEditor } from "./AvatarEditor";
import { AgentAccessFields, AgentFolderFields } from "./AgentAccess";
import { EngineFields } from "./EngineFields";
import type { AgentFormValues, FormMode, RoomFormValues, TeamFormValues } from "./formModels";
import { teamsByRoom } from "./selectors";
import { ThemePicker } from "./ThemePicker";
import { useAsyncAction } from "./useAsyncAction";
import { hasErrors, LIMITS, validateAgentForm, validateRoomForm, validateTeamForm, type FieldErrors } from "./validation";
import { ErrorText, Field } from "./widgets";

/**
 * Um formulário por entidade (quarto, time, agente), o MESMO para criar (janela) e editar (painel
 * lateral): mesmos campos, mesma ordem, mesmos seletores e mesma validação. Muda só o botão
 * ("Criar …" ou "Salvar") e quem chama decide o que mandar para a API (ver formModels.ts).
 * O que só existe depois de criado (Cérebro, líder, outro layout, excluir) fica no painel.
 */
type EntityFormProps<V> = {
  mode: FormMode;
  initial: V;
  /** Recebe os valores já validados. Erro lançado aparece no formulário. */
  onSubmit: (values: V) => Promise<unknown>;
  onCancel: () => void;
  /** Nome acessível do formulário. */
  label: string;
  testId?: string;
  submitTestId: string;
};

type FormState<V, K extends string> = {
  values: V;
  setValues: Dispatch<SetStateAction<V>>;
  errors: FieldErrors<K>;
  pending: boolean;
  error: string | null;
  submit: (event: FormEvent) => void;
};

function useFormState<V, K extends string>(initial: V, validate: (values: V) => FieldErrors<K>, onSubmit: (values: V) => Promise<unknown>): FormState<V, K> {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<FieldErrors<K>>({});
  const { pending, error, run } = useAsyncAction();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = validate(values);
    setErrors(found);
    if (hasErrors(found)) return;
    void run(() => onSubmit(values));
  };
  return { values, setValues, errors, pending, error, submit };
}

type FormShellProps = Pick<EntityFormProps<unknown>, "mode" | "onCancel" | "label" | "testId" | "submitTestId"> & {
  createLabel: string;
  pending: boolean;
  error: string | null;
  onSubmit: (event: FormEvent) => void;
  children: ReactNode;
};

function FormShell({ mode, onCancel, label, testId, submitTestId, createLabel, pending, error, onSubmit, children }: FormShellProps) {
  const busyLabel = mode === "create" ? "Criando…" : "Salvando…";
  return (
    <form className="ui-form entity-form" aria-label={label} noValidate onSubmit={onSubmit} data-testid={testId} data-mode={mode}>
      {children}
      <ErrorText>{error}</ErrorText>
      <div className="ui-actions">
        <button type="button" className="ui-button ui-button--secondary" onClick={onCancel}>
          Cancelar
        </button>
        <button type="submit" className="ui-button" disabled={pending} data-testid={submitTestId}>
          {pending ? busyLabel : mode === "create" ? createLabel : "Salvar"}
        </button>
      </div>
    </form>
  );
}

// ---------- Quarto ----------

type RoomFormProps = EntityFormProps<RoomFormValues>;

/** Sala: nome e tema (tamanho e função saíram com o mapa novo; os dados antigos ficam no office.json, intactos). */
export function RoomForm({ initial, onSubmit, ...shell }: RoomFormProps) {
  const form = useFormState(initial, validateRoomForm, onSubmit);
  const { values, errors } = form;
  const set = (patch: Partial<RoomFormValues>) => form.setValues((current) => ({ ...current, ...patch }));
  return (
    <FormShell {...shell} createLabel="Criar sala" pending={form.pending} error={form.error} onSubmit={form.submit}>
      <Field label="Nome" error={errors.name} hint={shell.mode === "create" ? "A sala ganha o próximo lugar do prédio, depois das outras." : undefined}>
        {(props) => <input {...props} className="ui-input" value={values.name} maxLength={LIMITS.roomName + 10} autoFocus onChange={(e) => set({ name: e.currentTarget.value })} />}
      </Field>
      <ThemePicker value={values.theme} onChange={(theme) => set({ theme })} error={errors.theme} />
    </FormShell>
  );
}

// ---------- Time ----------

/** Time: nome e foco. */
export function TeamForm({ initial, onSubmit, ...shell }: EntityFormProps<TeamFormValues>) {
  const form = useFormState(initial, validateTeamForm, onSubmit);
  const { values, errors } = form;
  const set = (patch: Partial<TeamFormValues>) => form.setValues((current) => ({ ...current, ...patch }));
  return (
    <FormShell {...shell} createLabel="Criar time" pending={form.pending} error={form.error} onSubmit={form.submit}>
      <Field label="Nome do time" error={errors.name}>
        {(props) => <input {...props} className="ui-input" value={values.name} maxLength={LIMITS.teamName + 10} autoFocus onChange={(e) => set({ name: e.currentTarget.value })} />}
      </Field>
      <Field label="Foco" error={errors.focus} hint="O que esse time faz. As tarefas vão para os agentes dele.">
        {(props) => <input {...props} className="ui-input" value={values.focus} maxLength={LIMITS.focus + 10} onChange={(e) => set({ focus: e.currentTarget.value })} />}
      </Field>
    </FormShell>
  );
}

// ---------- Agente ----------

/** Escolha do time (de qualquer quarto, menos a Sala do Maestro). Travado com tarefas ativas (o server daria 409). */
function TeamSelect({ office, value, onChange, locked }: { office: OfficeState; value: string; onChange: (teamId: string) => void; locked: boolean }) {
  const groups = teamsByRoom(office).filter(({ room }) => !isMaestroRoom(room));
  return (
    <Field label="Time" hint={locked ? "Espere as tarefas ativas terminarem para mudar de time." : "Pode ser um time de qualquer sala: o agente senta lá."}>
      {(props) => (
        <select {...props} className="ui-input" value={value} disabled={locked} onChange={(e) => onChange(e.currentTarget.value)} data-testid="agent-edit-team">
          {groups.map(({ room, teams }) => (
            <optgroup key={room.id} label={room.name}>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name} ({room.name})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      )}
    </Field>
  );
}

type AgentFormProps = EntityFormProps<AgentFormValues> & {
  office: OfficeState | null;
  /** Agente com tarefas ativas: time e motor ficam travados. */
  locked?: boolean;
  /** O Maestro não troca de time (o server também recusa). */
  teamFixed?: boolean;
};

/** Agente: nome, papel, instruções, time, motor/modelo e avatar. */
export function AgentForm({ initial, onSubmit, office, locked = false, teamFixed = false, ...shell }: AgentFormProps) {
  const form = useFormState(initial, validateAgentForm, onSubmit);
  const { values, errors } = form;
  const set = (patch: Partial<AgentFormValues>) => form.setValues((current) => ({ ...current, ...patch }));
  return (
    <FormShell {...shell} createLabel="Criar agente" pending={form.pending} error={form.error} onSubmit={form.submit}>
      <div className="ui-form__row">
        <Field label="Nome" error={errors.name}>
          {(props) => <input {...props} className="ui-input" value={values.name} maxLength={LIMITS.agentName + 10} autoFocus onChange={(e) => set({ name: e.currentTarget.value })} />}
        </Field>
        <Field label="Papel" error={errors.role}>
          {(props) => <input {...props} className="ui-input" value={values.role} maxLength={LIMITS.role + 10} onChange={(e) => set({ role: e.currentTarget.value })} />}
        </Field>
      </div>
      <Field label="Instruções" error={errors.instructions} hint={`Como o agente deve trabalhar (opcional, até ${LIMITS.instructions} caracteres).`}>
        {(props) => <textarea {...props} className="ui-input" rows={4} value={values.instructions} onChange={(e) => set({ instructions: e.currentTarget.value })} />}
      </Field>
      <div className="ui-form__row entity-form__engine">
        {office && !teamFixed && <TeamSelect office={office} value={values.teamId} onChange={(teamId) => set({ teamId })} locked={locked} />}
        <EngineFields values={{ engine: values.engine, model: values.model, effort: values.effort }} onChange={(engine) => set(engine)} locked={locked} />
      </div>
      {values.engine !== "mock" && <AgentAccessFields values={{ internet: values.internet, browser: values.browser, terminal: values.terminal }} onChange={(access) => set(access)} />}
      {values.engine !== "mock" && <AgentFolderFields values={values.folders} onChange={(folders) => set({ folders })} engine={values.engine} terminal={values.terminal} />}
      <AvatarEditor value={values.avatar} onChange={(avatar) => set({ avatar })} />
      {errors.avatar && <p className="ui-field__error">{errors.avatar}</p>}
    </FormShell>
  );
}
