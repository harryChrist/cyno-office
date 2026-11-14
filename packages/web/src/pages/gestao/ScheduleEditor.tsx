import { useId } from "react";
import { GIcon } from "./GIcon";
import { DAYS_MODE_LABELS, WEEKDAY_OPTIONS, emptySchedule, schedulePreview, type DaysMode, type ScheduleErrors, type ScheduleFormValues } from "./scheduleForm";

type Props = {
  schedules: ScheduleFormValues[];
  errors: ScheduleErrors[];
  onChange: (next: ScheduleFormValues[]) => void;
  /** Nome de quem executa, para a prévia ("o ECO vai…"). */
  ownerName: string;
  /** Agentes que podem ter um horário próprio (valor = endereço). */
  agents: { value: string; label: string }[];
  /** Só o acompanhamento tem "só itens vencidos". */
  showScope: boolean;
  /** Mensagem do erro geral da lista (ex.: "precisa de pelo menos um horário"). */
  error?: string | undefined;
};

const MODES: DaysMode[] = ["todo_dia", "uteis", "semana", "mes"];

/** Editor da lista de horários da rotina: cada horário tem os seus dias, horas, ação, agente e escopo. */
export function ScheduleEditor({ schedules, errors, onChange, ownerName, agents, showScope, error }: Props) {
  const update = (index: number, patch: Partial<ScheduleFormValues>) => onChange(schedules.map((schedule, i) => (i === index ? { ...schedule, ...patch } : schedule)));
  const remove = (index: number) => onChange(schedules.filter((_, i) => i !== index));
  const agentName = (address: string) => agents.find((agent) => agent.value === address)?.label;

  return (
    <div className="sed" data-testid="schedule-editor">
      {schedules.length === 0 && <p className="sed__empty">Sem horários: esta rotina só roda pelo vigia da meta. Adicione um horário para ela também acordar o agente em dias e horas fixos.</p>}
      {schedules.map((schedule, index) => (
        <ScheduleCard
          key={schedule.id ?? `new-${index}`}
          index={index}
          schedule={schedule}
          errors={errors[index] ?? {}}
          ownerName={ownerName}
          who={`o ${schedule.agent ? (agentName(schedule.agent) ?? "agente") : ownerName}`}
          agents={agents}
          showScope={showScope}
          onChange={(patch) => update(index, patch)}
          onRemove={() => remove(index)}
        />
      ))}
      {error && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="ui-button ui-button--secondary ui-button--small sed__add" onClick={() => onChange([...schedules, emptySchedule({ mode: showScope ? "todo_dia" : "uteis", ...(showScope ? { scope: "geral" as const } : {}) })])} data-testid="schedule-add">
        <GIcon name="plus" size={13} />
        Adicionar horário
      </button>
    </div>
  );
}

type CardProps = {
  index: number;
  schedule: ScheduleFormValues;
  errors: ScheduleErrors;
  who: string;
  ownerName: string;
  agents: Props["agents"];
  showScope: boolean;
  onChange: (patch: Partial<ScheduleFormValues>) => void;
  onRemove: () => void;
};

function ScheduleCard({ index, schedule, errors, who, ownerName, agents, showScope, onChange, onRemove }: CardProps) {
  const id = useId();
  const toggleDay = (day: (typeof WEEKDAY_OPTIONS)[number]["value"]) => onChange({ weekdays: schedule.weekdays.includes(day) ? schedule.weekdays.filter((d) => d !== day) : [...schedule.weekdays, day].sort() });
  const setTime = (at: number, value: string) => onChange({ times: schedule.times.map((time, i) => (i === at ? value : time)) });

  return (
    <fieldset className={`sed__card${schedule.enabled ? "" : " sed__card--off"}`} data-testid={`schedule-card-${index}`}>
      <legend className="sed__legend">Horário {index + 1}</legend>
      <div className="sed__head">
        <input className="ui-input sed__label" value={schedule.label} maxLength={80} placeholder="Nome (opcional), ex.: E-mail" aria-label={`Nome do horário ${index + 1}`} onChange={(e) => onChange({ label: e.currentTarget.value })} data-testid={`schedule-label-${index}`} />
        <label className="sed__toggle">
          <input type="checkbox" checked={schedule.enabled} onChange={(e) => onChange({ enabled: e.currentTarget.checked })} data-testid={`schedule-enabled-${index}`} />
          Ligado
        </label>
        <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={onRemove} aria-label={`Remover o horário ${index + 1}`} data-testid={`schedule-remove-${index}`}>
          <GIcon name="close" size={13} />
          Remover
        </button>
      </div>

      <div className="sed__block">
        <span className="ui-field__label" id={`${id}-days`}>
          Dias
        </span>
        <div className="sed__seg" role="radiogroup" aria-labelledby={`${id}-days`}>
          {MODES.map((mode) => (
            <button key={mode} type="button" role="radio" aria-checked={schedule.mode === mode} className="sed__seg-btn" onClick={() => onChange({ mode })} data-testid={`schedule-mode-${index}-${mode}`}>
              {DAYS_MODE_LABELS[mode]}
            </button>
          ))}
        </div>
        {schedule.mode === "semana" && (
          <div className="sed__weekdays" role="group" aria-label="Dias da semana">
            {WEEKDAY_OPTIONS.map((day) => (
              <button key={day.value} type="button" className="sed__day" aria-pressed={schedule.weekdays.includes(day.value)} onClick={() => toggleDay(day.value)} data-testid={`schedule-day-${index}-${day.value}`}>
                {day.short}
              </button>
            ))}
          </div>
        )}
        {schedule.mode === "mes" && (
          <label className="sed__month">
            No dia
            <input className="ui-input ui-input--compact sed__month-input" inputMode="numeric" value={schedule.monthDay} onChange={(e) => onChange({ monthDay: e.currentTarget.value })} aria-label="Dia do mês" data-testid={`schedule-monthday-${index}`} />
            de cada mês
          </label>
        )}
        {errors.days && <p className="ui-field__error">{errors.days}</p>}
      </div>

      <div className="sed__block">
        <span className="ui-field__label">Horas</span>
        <div className="sed__times">
          {schedule.times.map((time, at) => (
            <span key={at} className="sed__time">
              <input type="time" className="ui-input ui-input--compact" value={time} aria-label={`Hora ${at + 1} do horário ${index + 1}`} onChange={(e) => setTime(at, e.currentTarget.value)} data-testid={`schedule-time-${index}-${at}`} />
              {schedule.times.length > 1 && (
                <button type="button" className="sed__time-x" aria-label={`Remover a hora ${at + 1}`} onClick={() => onChange({ times: schedule.times.filter((_, i) => i !== at) })}>
                  ×
                </button>
              )}
            </span>
          ))}
          <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={() => onChange({ times: [...schedule.times, ""] })} data-testid={`schedule-addtime-${index}`}>
            <GIcon name="plus" size={13} />
            Hora
          </button>
        </div>
        {errors.times && <p className="ui-field__error">{errors.times}</p>}
      </div>

      <div className="sed__block">
        <label className="ui-field__label" htmlFor={`${id}-action`}>
          O que fazer
        </label>
        <p className="ui-field__hint">Escreva no infinitivo (“olhar posts novos”): a prévia lê “o agente vai olhar posts novos”.</p>
        <textarea id={`${id}-action`} className="ui-input" rows={3} value={schedule.action} aria-invalid={Boolean(errors.action)} placeholder="Ex.: olhar posts novos e preparar comentários" onChange={(e) => onChange({ action: e.currentTarget.value })} data-testid={`schedule-action-${index}`} />
        {errors.action && <p className="ui-field__error">{errors.action}</p>}
      </div>

      <div className="ui-form__row">
        <div className="sed__block">
          <label className="ui-field__label" htmlFor={`${id}-agent`}>
            Quem faz
          </label>
          <select id={`${id}-agent`} className="ui-input" value={schedule.agent} onChange={(e) => onChange({ agent: e.currentTarget.value })} data-testid={`schedule-agent-${index}`}>
            <option value="">Mesmo da rotina ({ownerName})</option>
            {agents.map((agent) => (
              <option key={agent.value} value={agent.value}>
                {agent.label}
              </option>
            ))}
          </select>
        </div>
        {showScope && (
          <div className="sed__block">
            <label className="ui-field__label" htmlFor={`${id}-scope`}>
              Quando roda
            </label>
            <select id={`${id}-scope`} className="ui-input" value={schedule.scope === "geral" ? "" : schedule.scope} onChange={(e) => onChange({ scope: e.currentTarget.value === "itens_vencidos" ? "itens_vencidos" : "geral" })} data-testid={`schedule-scope-${index}`}>
              <option value="">Sempre (procura novidades)</option>
              <option value="itens_vencidos">Só se houver item vencido para conferir</option>
            </select>
          </div>
        )}
      </div>

      <p className="sed__preview" data-testid={`schedule-preview-${index}`}>
        {schedulePreview(schedule, who)}
      </p>
    </fieldset>
  );
}
