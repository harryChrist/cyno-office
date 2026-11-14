import { AGENDA_KINDS, AGENDA_KIND_LABELS, AGENDA_LIMITS, type AgendaEvent, type AgendaKind, type Availability, type SlotCheck } from "@cyno/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useAgendaStore } from "../../store/agendaStore";
import { useNavStore } from "../../store/navStore";
import { useTaskFocus } from "../../store/taskFocus";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { hasErrors } from "../../ui/validation";
import { ConfirmDialog, ErrorText, Field, Modal } from "../../ui/widgets";
import { emptyAgendaForm, eventToAgendaForm, slotOf, toCreateBody, toUpdateBody, validateAgendaForm, type AgendaFormErrors, type AgendaFormValues } from "./agendaForm";
import { eventTimeLabel, shortDay, splitInstant, timeLabel, workspaceColor, dayKeyOf } from "./agendaTime";

type Props = {
  /** Sem `event`: novo compromisso no dia `date`. */
  event?: AgendaEvent;
  date: string;
  startMinutes?: number;
  availability: Availability;
  workspaces: { id: string; name: string }[];
  /** Workspace sugerido no compromisso novo (o filtro da página). */
  defaultWorkspace: string;
  nameOf?: (workspace: string | undefined) => string;
  onClose: () => void;
};

const KIND_OPTIONS: AgendaKind[] = [...AGENDA_KINDS];

/**
 * Marcar, mover ou cancelar um compromisso pela tela. Confere o horário ao vivo no servidor (a mesma
 * regra das ferramentas dos agentes): com choque ou fora da disponibilidade, mostra o motivo e 3
 * horários livres para usar; só o dono, aqui, marca por cima (confirmando).
 */
export function AgendaEventDialog({ event, date, startMinutes, availability, workspaces, defaultWorkspace, nameOf, onClose }: Props) {
  const [values, setValues] = useState<AgendaFormValues>(() => (event ? eventToAgendaForm(event) : emptyAgendaForm(date, startMinutes, availability.defaultDurationMinutes, defaultWorkspace)));
  const [errors, setErrors] = useState<AgendaFormErrors>({});
  // O resultado da conferência fica ligado ao horário que foi conferido: mudou o horário, vale como "ainda conferindo".
  const [result, setResult] = useState<{ key: string; check: SlotCheck | null } | null>(null);
  const [overrideKey, setOverrideKey] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const { pending, error, run } = useAsyncAction();
  const editing = event !== undefined;
  const change = (patch: Partial<AgendaFormValues>) => setValues((current) => ({ ...current, ...patch }));
  const slot = slotOf(values);
  const slotKey = slot ? `${slot.start}|${slot.end}` : "";
  const settled = result !== null && result.key === slotKey;
  const check = settled ? result.check : null;
  const checking = slot !== null && !settled;
  // "Marcar mesmo assim" vale só para o horário em que foi marcado.
  const override = overrideKey === slotKey && slotKey !== "";
  const setOverride = (on: boolean) => setOverrideKey(on ? slotKey : null);

  // Confere o horário ao vivo (espera o dono parar de digitar).
  useEffect(() => {
    if (!slot) return;
    let current = true;
    const timer = window.setTimeout(() => {
      api
        .checkAgendaSlot({ ...slot, ...(event ? { ignoreId: event.id } : {}) })
        .then((checked) => current && setResult({ key: slotKey, check: checked }))
        .catch(() => current && setResult({ key: slotKey, check: null }));
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotKey, event?.id]);

  const blocked = check !== null && !check.ok && !override;
  const unchangedTime = event && slot && slot.start === new Date(event.start).toISOString() && slot.end === new Date(event.end).toISOString();

  const submit = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    const found = validateAgendaForm(values);
    setErrors(found);
    if (hasErrors(found) || blocked) return;
    const saved = await run(() => {
      if (!event) return api.createAgendaEvent(toCreateBody({ ...values }, override));
      const body = toUpdateBody(values, event, override);
      return Object.keys(body).length === 0 ? Promise.resolve(event) : api.updateAgendaEvent(event.id, body);
    });
    if (!saved) return;
    useAgendaStore.getState().show(saved);
    onClose();
  };

  const useSlot = (start: string, end: string) => {
    const from = splitInstant(start);
    const to = splitInstant(end);
    change({ date: from.date, start: from.time, end: to.date === from.date ? to.time : "23:59" });
  };

  const openTask = () => {
    if (!event?.workspace) return;
    useNavStore.getState().setWorkspace(event.workspace);
    if (event.taskId) useTaskFocus.getState().open(event.taskId);
    else useNavStore.getState().go("trabalho");
    onClose();
  };

  if (confirmingCancel && event) {
    return (
      <ConfirmDialog
        title="Cancelar compromisso"
        message={
          <p>
            Cancelar <strong>{event.title}</strong> ({shortDay(dayKeyOf(event.start))}, {eventTimeLabel(event)})? O horário volta a ficar livre.
          </p>
        }
        confirmLabel="Cancelar compromisso"
        pendingLabel="Cancelando…"
        onConfirm={async () => useAgendaStore.getState().show(await api.cancelAgendaEvent(event.id))}
        onClose={() => {
          setConfirmingCancel(false);
          if (useAgendaStore.getState().events.find((item) => item.id === event.id)?.status === "cancelado") onClose();
        }}
        testId="agenda-cancel-dialog"
      />
    );
  }

  const label = editing ? "Editar compromisso" : "Novo compromisso";
  return (
    <Modal title={label} onClose={onClose} testId="agenda-event-dialog">
      <form className="ui-form" aria-label={label} noValidate onSubmit={(e) => void submit(e)}>
        {event && <Provenance event={event} nameOf={nameOf} onOpenTask={openTask} />}
        <Field label="Título" error={errors.title}>
          {(props) => <input {...props} className="ui-input" value={values.title} maxLength={AGENDA_LIMITS.title + 10} autoFocus onChange={(e) => change({ title: e.currentTarget.value })} data-testid="agenda-title-input" />}
        </Field>
        <div className="ui-form__row ag-form__when">
          <Field label="Tipo">
            {(props) => (
              <select {...props} className="ui-input" value={values.kind} onChange={(e) => change({ kind: e.currentTarget.value as AgendaKind })} data-testid="agenda-kind">
                {KIND_OPTIONS.map((kind) => (
                  <option key={kind} value={kind}>
                    {AGENDA_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Dia" error={errors.date}>
            {(props) => <input {...props} type="date" className="ui-input" value={values.date} required onChange={(e) => change({ date: e.currentTarget.value })} data-testid="agenda-date" />}
          </Field>
          <Field label="Início" error={errors.start}>
            {(props) => <input {...props} type="time" className="ui-input" value={values.start} required onChange={(e) => change({ start: e.currentTarget.value })} data-testid="agenda-start" />}
          </Field>
          <Field label="Fim" error={errors.end}>
            {(props) => <input {...props} type="time" className="ui-input" value={values.end} required onChange={(e) => change({ end: e.currentTarget.value })} data-testid="agenda-end" />}
          </Field>
        </div>

        <SlotStatus check={check} checking={checking} hasSlot={slot !== null} unchanged={Boolean(unchangedTime)} override={override} onOverride={setOverride} onUse={useSlot} nameOf={nameOf} zone={availability.timezone} />

        <Field label="Workspace">
          {(props) => (
            <select {...props} className="ui-input" value={values.workspace} onChange={(e) => change({ workspace: e.currentTarget.value })} disabled={editing} data-testid="agenda-workspace-input">
              <option value="">Nenhum (marcado por você)</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="ui-form__row">
          <Field label="Link">{(props) => <input {...props} className="ui-input" value={values.link} placeholder="https://…" onChange={(e) => change({ link: e.currentTarget.value })} data-testid="agenda-link-input" />}</Field>
          <Field label="Local">{(props) => <input {...props} className="ui-input" value={values.location} onChange={(e) => change({ location: e.currentTarget.value })} data-testid="agenda-location-input" />}</Field>
        </div>
        <Field label="Observações" error={errors.notes}>
          {(props) => <textarea {...props} className="ui-input" rows={2} value={values.notes} onChange={(e) => change({ notes: e.currentTarget.value })} data-testid="agenda-notes-input" />}
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="ui-actions ag-form__actions">
          {event && (
            <button type="button" className="ui-button ui-button--danger ag-form__cancel" onClick={() => setConfirmingCancel(true)} data-testid="agenda-cancel-event">
              Cancelar compromisso
            </button>
          )}
          <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
            Fechar
          </button>
          <button type="submit" className="ui-button" disabled={pending || blocked} data-testid="agenda-submit">
            {pending ? "Salvando…" : editing ? "Salvar" : override ? "Marcar por cima" : "Marcar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** "Quem marcou", quando, e o caminho de volta para a tarefa/projeto. */
function Provenance({ event, nameOf, onOpenTask }: { event: AgendaEvent; nameOf?: (workspace: string | undefined) => string; onOpenTask: () => void }) {
  const who = event.by.kind === "dono" ? "Você" : event.by.kind === "cyno" ? "O Cyno" : (event.by.name ?? "Um agente");
  const created = splitInstant(event.createdAt);
  return (
    <div className="ag-prov" data-testid="agenda-provenance">
      <span className="ag-prov__who">
        <span className="ag-chip__dot" style={{ background: workspaceColor(event.workspace) }} />
        Marcado por <strong>{who}</strong>
        {event.workspace && <> · {nameOf?.(event.workspace) ?? event.workspace}</>}
      </span>
      <span className="ag-prov__when">
        em {shortDay(created.date)} {created.time}
        {event.movedFrom && <> · movido (era {shortDay(dayKeyOf(event.movedFrom))} {timeLabel(event.movedFrom)})</>}
      </span>
      {(event.taskId || event.projectId) && event.workspace && (
        <button type="button" className="ui-button ui-button--ghost ui-button--small ag-prov__link" onClick={onOpenTask} data-testid="agenda-open-task">
          {event.taskId ? "Abrir a tarefa em Projetos e tarefas" : "Abrir o projeto em Projetos e tarefas"}
        </button>
      )}
      {event.link && (
        <a className="ag-prov__link" href={event.link} target="_blank" rel="noreferrer noopener">
          Abrir o link
        </a>
      )}
    </div>
  );
}

type StatusProps = {
  check: SlotCheck | null;
  checking: boolean;
  hasSlot: boolean;
  unchanged: boolean;
  override: boolean;
  onOverride: (on: boolean) => void;
  onUse: (start: string, end: string) => void;
  nameOf?: (workspace: string | undefined) => string;
  zone: string;
};

/** O resultado ao vivo da conferência do horário. */
function SlotStatus({ check, checking, hasSlot, unchanged, override, onOverride, onUse, nameOf, zone }: StatusProps) {
  if (!hasSlot) return <p className="ag-check ag-check--idle">Escolha o dia e o horário para conferir se está livre.</p>;
  if (!check) return <p className="ag-check ag-check--idle">{checking ? "Conferindo o horário…" : ""}</p>;
  if (check.ok) {
    return (
      <p className="ag-check ag-check--ok" role="status" data-testid="agenda-check-ok">
        {unchanged ? "Este é o horário atual." : "Horário livre e dentro da sua disponibilidade."}
      </p>
    );
  }
  return (
    <div className="ag-check ag-check--bad" role="status" data-testid="agenda-check-bad">
      {check.problem === "conflict" && check.conflicts.length > 0 ? (
        <>
          <p className="ag-check__reason">Choca com {check.conflicts.length === 1 ? "outro compromisso" : `${check.conflicts.length} compromissos`}:</p>
          <ul className="ag-check__conflicts">
            {check.conflicts.map((conflict) => (
              <li key={conflict.id}>
                {conflict.title}
                {conflict.workspace ? ` (${nameOf?.(conflict.workspace) ?? conflict.workspace})` : ""} · {shortDay(dayKeyOf(conflict.start))}, {eventTimeLabel(conflict, zone)}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="ag-check__reason">{check.reason}.</p>
      )}
      {check.nextFree.length > 0 && (
        <div className="ag-check__suggest">
          <span className="ag-check__label">Horários livres mais próximos</span>
          <div className="ag-check__buttons">
            {check.nextFree.map((free) => (
              <button key={free.start} type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => onUse(free.start, free.end)} data-testid="agenda-suggestion">
                {shortDay(dayKeyOf(free.start))} · {eventTimeLabel(free, zone)}
              </button>
            ))}
          </div>
        </div>
      )}
      <label className="ag-check__override">
        <input type="checkbox" checked={override} onChange={(e) => onOverride(e.currentTarget.checked)} data-testid="agenda-override" />
        Marcar mesmo assim, por cima do que já existe
      </label>
    </div>
  );
}
