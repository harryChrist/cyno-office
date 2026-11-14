import { ROUTINE_KINDS, ROUTINE_KIND_LABELS, ROUTINE_LIMITS, ROUTINE_LIMITS_TABLE, ROUTINE_TYPES, ROUTINE_TYPE_LABELS, type Routine, type RoutineType } from "@cyno/shared";
import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useRoutinesStore } from "../../store/routinesStore";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText, Field, Modal, Switch } from "../../ui/widgets";
import { ScheduleEditor } from "./ScheduleEditor";
import { TrackingEditor } from "./TrackingEditor";
import { useAgentAddressOptions, useOwnerOptions } from "./gestaoHooks";
import { limitsText, targetWarning } from "./gestaoView";
import {
  ROUTINE_TEMPLATES,
  checkUpdateBody,
  emptyErrors,
  emptyRoutineForm,
  hasFormErrors,
  metaPreview,
  routineToForm,
  templateToForm,
  toCreateBody,
  toUpdateBody,
  validateRoutineForm,
  type RoutineFormErrors,
  type RoutineFormValues,
} from "./routineForm";
import { WEEKDAY_OPTIONS } from "./scheduleForm";

type Props = {
  /** Valores de partida de uma rotina nova (modelo); ignorado na edição. */
  initial?: RoutineFormValues;
  /** Com `routine`: edita (o tipo da rotina não muda; o tipo de atividade e o site sim). */
  routine?: Routine;
  onClose: () => void;
  /** Chamado com a rotina salva (para abrir o detalhe dela). */
  onSaved?: (routine: Routine) => void;
};

const TYPE_HINTS: Record<RoutineType, string> = {
  meta: "Um alvo por semana ou mês, como “2 posts por semana”. O servidor vigia o ritmo e só conta o que foi entregue com link.",
  acompanhamento: "Horários fixos em que o agente confere uma lista de itens (inscrições, pedidos…). Cada item tem status, histórico e prazo de vida; você é avisado quando algo muda.",
};

/** Criar uma rotina (do zero ou de um modelo) ou editar uma existente: Meta ou Acompanhamento, com a lista de horários. */
export function RoutineDialog({ initial, routine, onClose, onSaved }: Props) {
  const editing = routine !== undefined;
  const [values, setValues] = useState<RoutineFormValues>(() => (routine ? routineToForm(routine) : (initial ?? emptyRoutineForm())));
  const [errors, setErrors] = useState<RoutineFormErrors>(emptyErrors());
  const { pending, error, run } = useAsyncAction();
  const owners = useOwnerOptions();
  const agents = useAgentAddressOptions();
  const change = (patch: Partial<RoutineFormValues>) => setValues((current) => ({ ...current, ...patch }));
  const meta = values.type === "meta";
  const limits = ROUTINE_LIMITS_TABLE[values.kind];
  const warning = meta ? targetWarning(values.kind, Number(values.target)) : "";
  const ownerMissing = values.owner !== "" && !owners.some((owner) => owner.value === values.owner);
  const ownerName = owners.find((owner) => owner.value === values.owner)?.label.replace(/^Time /, "time ") ?? "responsável";

  const pickTemplate = (id: string) => {
    const template = ROUTINE_TEMPLATES.find((candidate) => candidate.id === id);
    if (template) setValues((current) => ({ ...templateToForm(template), owner: current.owner }));
    setErrors(emptyErrors());
  };
  const setType = (type: RoutineType) => {
    if (type === values.type) return;
    setValues((current) => ({ ...emptyRoutineForm(type), owner: current.owner, title: current.title }));
    setErrors(emptyErrors());
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = validateRoutineForm(values, editing);
    setErrors(found);
    if (hasFormErrors(found)) return;
    const saved = await run(async () => {
      if (!routine) return api.createRoutine(toCreateBody(values));
      const body = toUpdateBody(values, routine);
      const problem = checkUpdateBody(body);
      if (problem) throw new Error(problem);
      return Object.keys(body).length === 0 ? routine : api.updateRoutine(routine.id, body);
    });
    if (!saved) return;
    void useRoutinesStore.getState().load();
    onSaved?.(saved);
    onClose();
  };

  const title = editing ? `Editar ${meta ? "meta" : "acompanhamento"} · ${routine.id}` : "Nova rotina";

  return (
    <Modal title={title} onClose={onClose} testId="routine-dialog" wide>
      <form className="ui-form rform" aria-label={title} noValidate onSubmit={(e) => void submit(e)}>
        {!editing && (
          <div className="rform__block">
            <span className="ui-field__label">Começar de um modelo</span>
            <div className="rform__templates" role="group" aria-label="Modelos">
              {ROUTINE_TEMPLATES.map((template) => (
                <button key={template.id} type="button" className="rform__tpl" onClick={() => pickTemplate(template.id)} title={template.description} data-testid={`template-${template.id}`}>
                  <strong>{template.name}</strong>
                  <span>{template.description}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="rform__block">
          <span className="ui-field__label" id="rform-type">
            Tipo
          </span>
          <div className="sed__seg rform__types" role="radiogroup" aria-labelledby="rform-type">
            {ROUTINE_TYPES.map((type) => (
              <button key={type} type="button" role="radio" aria-checked={values.type === type} disabled={editing && values.type !== type} className="sed__seg-btn" onClick={() => setType(type)} data-testid={`routine-type-${type}`}>
                {ROUTINE_TYPE_LABELS[type]}
              </button>
            ))}
          </div>
          <p className="ui-field__hint">{editing ? "O tipo não muda depois de criada." : TYPE_HINTS[values.type]}</p>
        </div>

        <div className="ui-form__row">
          <Field label="Nome" error={errors.fields.title}>
            {(props) => <input {...props} className="ui-input" value={values.title} maxLength={ROUTINE_LIMITS.title + 10} autoFocus onChange={(e) => change({ title: e.currentTarget.value })} data-testid="routine-title" />}
          </Field>
          <Field label="Quem executa" error={errors.fields.owner} hint="Um agente, ou um time (o servidor escolhe o agente do time).">
            {(props) => (
              <select {...props} className="ui-input" value={values.owner} onChange={(e) => change({ owner: e.currentTarget.value })} data-testid="routine-owner">
                <option value="">Escolha…</option>
                {ownerMissing && <option value={values.owner}>(dono removido)</option>}
                {owners.map((owner) => (
                  <option key={owner.value} value={owner.value}>
                    {owner.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>

        {meta && (
          <section className="rform__section" aria-label="A meta">
            <h3 className="rform__h">A meta</h3>
            <div className="ui-form__row">
              <Field label="O que se conta" error={errors.fields.unit} hint="No singular: convite, post…">
                {(props) => <input {...props} className="ui-input" value={values.unit} maxLength={ROUTINE_LIMITS.unit + 10} onChange={(e) => change({ unit: e.currentTarget.value })} data-testid="routine-unit" />}
              </Field>
              <Field label="Tipo de atividade" hint={`Limites: ${limitsText(limits)}.`}>
                {(props) => (
                  <select {...props} className="ui-input" value={values.kind} onChange={(e) => change({ kind: e.currentTarget.value as RoutineFormValues["kind"] })} data-testid="routine-kind">
                    {ROUTINE_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {ROUTINE_KIND_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Site" error={errors.fields.site} hint="Só o domínio.">
                {(props) => <input {...props} className="ui-input" value={values.site} placeholder="linkedin.com" onChange={(e) => change({ site: e.currentTarget.value })} data-testid="routine-site" />}
              </Field>
            </div>
            <div className="ui-form__row">
              <Field label="Alvo" error={errors.fields.target} hint={warning || undefined}>
                {(props) => <input {...props} className="ui-input" inputMode="numeric" value={values.target} onChange={(e) => change({ target: e.currentTarget.value })} data-testid="routine-target" />}
              </Field>
              <div className="ui-field">
                <span className="ui-field__label" id="rform-period">
                  Por
                </span>
                <div className="sed__seg" role="radiogroup" aria-labelledby="rform-period">
                  {(["week", "month"] as const).map((period) => (
                    <button key={period} type="button" role="radio" aria-checked={values.period === period} className="sed__seg-btn" onClick={() => change({ period })} data-testid={`routine-period-${period}`}>
                      {period === "week" ? "Semana" : "Mês"}
                    </button>
                  ))}
                </div>
              </div>
              <Field label="Preparar opções" hint="Prepara mais opções do que o alvo para você escolher as melhores.">
                {(props) => (
                  <select {...props} className="ui-input" value={values.prepareFactor} onChange={(e) => change({ prepareFactor: e.currentTarget.value })} data-testid="routine-prepare">
                    <option value="1">1x (só o necessário)</option>
                    <option value="2">2x (o dobro)</option>
                    <option value="3">3x (o triplo)</option>
                  </select>
                )}
              </Field>
            </div>
            <div className="ui-field">
              <span className="ui-field__label" id="rform-prefdays">
                Dias preferidos (sugestão, nunca bloqueia)
              </span>
              <div className="sed__weekdays" role="group" aria-labelledby="rform-prefdays">
                {WEEKDAY_OPTIONS.map((day) => (
                  <button
                    key={day.value}
                    type="button"
                    className="sed__day"
                    aria-pressed={values.preferredDays.includes(day.value)}
                    onClick={() => change({ preferredDays: values.preferredDays.includes(day.value) ? values.preferredDays.filter((d) => d !== day.value) : [...values.preferredDays, day.value].sort() })}
                    data-testid={`routine-prefday-${day.value}`}
                  >
                    {day.short}
                  </button>
                ))}
              </div>
            </div>
            <Switch label="Parar ao bater o alvo" description="Bateu a meta, o servidor não pede mais nada até o próximo período." checked={values.stopOnHit} onChange={(stopOnHit) => change({ stopOnHit })} testId="routine-stop-on-hit" />
            <p className="rform__preview" data-testid="meta-preview">
              {metaPreview(values)}
            </p>
          </section>
        )}

        {!meta && <TrackingEditor values={values} errors={errors.fields} trackingFields={errors.trackingFields} trackingStatuses={errors.trackingStatuses} onChange={change} editing={editing} />}

        <section className="rform__section" aria-label="Horários">
          <h3 className="rform__h">Horários</h3>
          <p className="ui-field__hint">{meta ? "Opcional: horários que acordam o agente para checar a meta em dias e horas fixos." : "Quando o agente confere os itens. Cada horário tem a sua ação."}</p>
          <ScheduleEditor schedules={values.schedules} errors={errors.schedules} onChange={(schedules) => change({ schedules })} ownerName={ownerName} agents={agents} showScope={!meta} error={typeof errors.fields.schedules === "string" ? errors.fields.schedules : undefined} />
        </section>

        <Field label="Instruções gerais" error={errors.fields.instruction} hint="Como fazer e o que registrar, valem para todos os horários. Opcional.">
          {(props) => <textarea {...props} className="ui-input" rows={3} value={values.instruction} onChange={(e) => change({ instruction: e.currentTarget.value })} data-testid="routine-instruction" />}
        </Field>
        <Field label="Teto por dia" error={errors.fields.dailyCap} hint={`Opcional. Vazio = o do tipo${meta && limits.daily !== undefined ? ` (${limits.daily})` : ""}; nunca passa dele.`}>
          {(props) => <input {...props} className="ui-input rform__cap" inputMode="numeric" value={values.dailyCap} onChange={(e) => change({ dailyCap: e.currentTarget.value })} data-testid="routine-cap" />}
        </Field>
        <p className="ui-field__hint" data-testid="routine-mode-hint">
          A rotina começa em Pede OK: cada ação sensível espera a sua aprovação em Aprovações. O Automático é ligado depois, no detalhe da rotina.
        </p>
        <ErrorText>{errors.fields.general ?? error}</ErrorText>
        <div className="ui-actions">
          <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="ui-button" disabled={pending} data-testid="routine-submit">
            {pending ? "Salvando…" : editing ? "Salvar" : "Criar rotina"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
