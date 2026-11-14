import type { Availability } from "@cyno/shared";
import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useAgendaStore } from "../../store/agendaStore";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText, Field, Modal } from "../../ui/widgets";
import {
  availabilityToForm,
  hasAvailabilityErrors,
  NEW_WINDOW,
  toAvailability,
  validateAvailabilityForm,
  WEEKDAY_LABELS,
  WEEKDAY_ORDER,
  type AvailabilityErrors,
  type AvailabilityForm,
  type ExceptionForm,
  type WindowForm,
} from "./availabilityForm";

const NO_ERRORS: AvailabilityErrors = { days: {}, exceptions: {}, numbers: {} };

/** O editor da disponibilidade: o dono define uma vez os horários; os agentes só marcam dentro deles. */
export function AvailabilityDialog({ availability, onClose }: { availability: Availability; onClose: () => void }) {
  const [form, setForm] = useState<AvailabilityForm>(() => availabilityToForm(availability));
  const [errors, setErrors] = useState<AvailabilityErrors>(NO_ERRORS);
  const { pending, error, run } = useAsyncAction();

  const setWindows = (weekday: number, windows: WindowForm[]) => setForm((current) => ({ ...current, days: current.days.map((list, index) => (index === weekday ? windows : list)) }));
  const setException = (index: number, patch: Partial<ExceptionForm>) => setForm((current) => ({ ...current, exceptions: current.exceptions.map((item, at) => (at === index ? { ...item, ...patch } : item)) }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = validateAvailabilityForm(form);
    setErrors(found);
    if (hasAvailabilityErrors(found)) return;
    const saved = await run(() => api.saveAvailability(toAvailability(form, availability)));
    if (!saved) return;
    useAgendaStore.getState().applyEvent({ type: "agenda:availability", availability: saved });
    onClose();
  };

  return (
    <Modal title="Sua disponibilidade" onClose={onClose} testId="agenda-availability-dialog" wide>
      <form className="ui-form ag-avail" aria-label="Disponibilidade" noValidate onSubmit={(e) => void submit(e)}>
        <p className="ag-avail__intro">Os agentes e os Maestros só conseguem marcar nestes horários, e o servidor recusa o resto. Você ainda pode marcar fora deles pela tela.</p>
        <fieldset className="ag-avail__week">
          <legend className="ag-avail__legend">Horários da semana</legend>
          {WEEKDAY_ORDER.map((weekday) => {
            const windows = form.days[weekday]!;
            return (
              <div key={weekday} className="ag-avail__day" data-testid={`avail-day-${weekday}`}>
                <div className="ag-avail__dayname">
                  <label className="ag-avail__check">
                    <input
                      type="checkbox"
                      checked={windows.length > 0}
                      onChange={(e) => setWindows(weekday, e.currentTarget.checked ? [{ ...NEW_WINDOW }] : [])}
                      aria-label={`${WEEKDAY_LABELS[weekday]} disponível`}
                      data-testid={`avail-on-${weekday}`}
                    />
                    {WEEKDAY_LABELS[weekday]}
                  </label>
                </div>
                <div className="ag-avail__windows">
                  {windows.length === 0 ? (
                    <span className="ag-avail__off">Indisponível</span>
                  ) : (
                    windows.map((window, index) => (
                      <div key={index} className="ag-avail__window">
                        <input type="time" className="ui-input" value={window.from} aria-label={`${WEEKDAY_LABELS[weekday]}, janela ${index + 1}, início`} onChange={(e) => setWindows(weekday, windows.map((item, at) => (at === index ? { ...item, from: e.currentTarget.value } : item)))} data-testid={`avail-from-${weekday}-${index}`} />
                        <span aria-hidden="true">às</span>
                        <input type="time" className="ui-input" value={window.to === "24:00" ? "23:59" : window.to} aria-label={`${WEEKDAY_LABELS[weekday]}, janela ${index + 1}, fim`} onChange={(e) => setWindows(weekday, windows.map((item, at) => (at === index ? { ...item, to: e.currentTarget.value } : item)))} data-testid={`avail-to-${weekday}-${index}`} />
                        <button type="button" className="ui-icon-button" aria-label="Tirar a janela" onClick={() => setWindows(weekday, windows.filter((_, at) => at !== index))}>
                          ×
                        </button>
                      </div>
                    ))
                  )}
                  {windows.length > 0 && (
                    <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={() => setWindows(weekday, [...windows, { from: "14:00", to: "18:00" }])}>
                      + Janela
                    </button>
                  )}
                  {errors.days[weekday] && <p className="ui-field__error">{errors.days[weekday]}</p>}
                </div>
              </div>
            );
          })}
        </fieldset>

        <fieldset className="ag-avail__exceptions">
          <legend className="ag-avail__legend">Dias bloqueados ou diferentes</legend>
          {form.exceptions.length === 0 && <p className="ag-avail__off">Nenhuma exceção (feriado, viagem, um sábado de trabalho…).</p>}
          {form.exceptions.map((exception, index) => (
            <div key={index} className="ag-avail__exception" data-testid="avail-exception">
              <input type="date" className="ui-input" value={exception.date} aria-label="Dia da exceção" onChange={(e) => setException(index, { date: e.currentTarget.value })} />
              <select className="ui-input" value={exception.mode} aria-label="Tipo da exceção" onChange={(e) => setException(index, { mode: e.currentTarget.value as ExceptionForm["mode"] })}>
                <option value="off">Dia bloqueado</option>
                <option value="window">Horário diferente</option>
              </select>
              {exception.mode === "window" && (
                <>
                  <input type="time" className="ui-input" value={exception.from} aria-label="Início" onChange={(e) => setException(index, { from: e.currentTarget.value })} />
                  <span aria-hidden="true">às</span>
                  <input type="time" className="ui-input" value={exception.to} aria-label="Fim" onChange={(e) => setException(index, { to: e.currentTarget.value })} />
                </>
              )}
              <input className="ui-input ag-avail__note" value={exception.note} maxLength={120} placeholder="Motivo (opcional)" aria-label="Motivo" onChange={(e) => setException(index, { note: e.currentTarget.value })} />
              <button type="button" className="ui-icon-button" aria-label="Tirar a exceção" onClick={() => setForm((current) => ({ ...current, exceptions: current.exceptions.filter((_, at) => at !== index) }))}>
                ×
              </button>
              {errors.exceptions[index] && <p className="ui-field__error ag-avail__error">{errors.exceptions[index]}</p>}
            </div>
          ))}
          <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={() => setForm((current) => ({ ...current, exceptions: [...current.exceptions, { date: "", mode: "off", from: "09:00", to: "12:00", note: "" }] }))} data-testid="avail-add-exception">
            + Dia bloqueado
          </button>
        </fieldset>

        <div className="ui-form__row">
          <Field label="Antecedência mínima (min)" error={errors.numbers.minNoticeMinutes} hint="Ninguém marca para daqui a menos que isso.">
            {(props) => <input {...props} type="number" min={0} className="ui-input" value={form.minNoticeMinutes} onChange={(e) => setForm({ ...form, minNoticeMinutes: e.currentTarget.value })} data-testid="avail-notice" />}
          </Field>
          <Field label="Duração padrão (min)" error={errors.numbers.defaultDurationMinutes} hint="Quando quem marca não diz.">
            {(props) => <input {...props} type="number" min={5} className="ui-input" value={form.defaultDurationMinutes} onChange={(e) => setForm({ ...form, defaultDurationMinutes: e.currentTarget.value })} data-testid="avail-duration" />}
          </Field>
          <Field label="Intervalo entre compromissos (min)" error={errors.numbers.bufferMinutes} hint="Folga mínima entre um e outro.">
            {(props) => <input {...props} type="number" min={0} className="ui-input" value={form.bufferMinutes} onChange={(e) => setForm({ ...form, bufferMinutes: e.currentTarget.value })} data-testid="avail-buffer" />}
          </Field>
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="ui-actions">
          <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="ui-button" disabled={pending} data-testid="avail-save">
            {pending ? "Salvando…" : "Salvar disponibilidade"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
