import { GESTAO_WEEKDAYS, GESTAO_WEEKDAY_LABELS, gestaoSettings, parseGestaoWeekly, DEFAULT_GESTAO, type GestaoWeekday, type Workspace } from "@cyno/shared";
import { useId, useState } from "react";
import { api } from "../../api/client";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText } from "../../ui/widgets";
import { ResetDefaultButton } from "./ResetDefault";
import { OptionHead, SettingSwitch, StateBadge } from "./SettingsOption";

/** Custo estimado (equivalente à API) de um parágrafo do Maestro: ~2 mil tokens de entrada e 250 de saída (Sonnet). */
export const GESTAO_AI_COST = { daily: "US$ 0,01", weekly: "US$ 0,02" } as const;

const splitWeekly = (weekly: string): { day: GestaoWeekday; time: string } => {
  const parsed = parseGestaoWeekly(weekly);
  return { day: GESTAO_WEEKDAYS[(parsed?.weekday ?? 1) - 1] ?? "seg", time: weekly.split(/\s+/)[1] ?? "08:30" };
};

/**
 * Seção do workspace "Relatórios da Gestão": a que horas o servidor monta o resumo do dia e a revisão da semana (por código,
 * sem gastar IA) e os dois parágrafos opcionais que o Maestro escreve por cima dos números (desligados por padrão; cada um mostra o custo).
 */
export function GestaoSettings({ workspace }: { workspace: Workspace }) {
  const id = useId();
  const saved = gestaoSettings(workspace.gestao);
  const own = workspace.gestao !== undefined && Object.keys(workspace.gestao).length > 0;
  const savedWeekly = splitWeekly(saved.weekly);
  const [dailyAt, setDailyAt] = useState(saved.dailyAt ?? DEFAULT_GESTAO.dailyAt ?? "18:30");
  const [weekDay, setWeekDay] = useState<GestaoWeekday>(savedWeekly.day);
  const [weekTime, setWeekTime] = useState(savedWeekly.time);
  // Voltou ao padrão (ou mudou por outro lado): os campos acompanham o valor gravado.
  const savedKey = `${saved.dailyAt}/${saved.weekly}`;
  const [seenKey, setSeenKey] = useState(savedKey);
  if (seenKey !== savedKey) {
    setSeenKey(savedKey);
    setDailyAt(saved.dailyAt ?? DEFAULT_GESTAO.dailyAt ?? "18:30");
    setWeekDay(savedWeekly.day);
    setWeekTime(savedWeekly.time);
  }
  const { pending, error, run } = useAsyncAction();
  const [done, setDone] = useState(false);
  const weekly = `${weekDay} ${weekTime}`;
  const dirty = (saved.dailyAt !== null && dailyAt !== saved.dailyAt) || weekly !== saved.weekly;
  const patch = (gestao: Parameters<typeof api.updateWorkspaceGestao>[1]) => api.updateWorkspaceGestao(workspace.id, gestao);
  const saveTimes = async () => {
    setDone(false);
    const result = await run(() => patch({ ...(saved.dailyAt !== null ? { dailyAt } : {}), weekly }));
    if (result) setDone(true);
  };
  return (
    <section className="settings__card" data-testid="settings-gestao">
      <OptionHead
        title="Relatórios da Gestão"
        seal="workspace"
        inherited={!own}
        state={
          <StateBadge tone="value" testId="settings-gestao-state">
            {saved.dailyAt ? `dia ${saved.dailyAt}` : "dia só na mão"} · semana {saved.weekly}
          </StateBadge>
        }
        line="O servidor monta sozinho o resumo do dia e a revisão da semana, só com os números já calculados (sem IA, sem gastar cota) e guarda cada um congelado em Gestão > Relatórios. Um horário perdido com o servidor desligado gera só o último, na volta."
      />
      <ResetDefaultButton workspaceId={workspace.id} fields={["gestao.dailyAt", "gestao.weekly", "gestao.ai"]} own={own} testId="settings-gestao-reset" />
      <SettingSwitch
        title="Gerar o resumo do dia sozinho"
        line="Desligado: o resumo do dia só sai quando você pede em Gestão > Relatórios."
        checked={saved.dailyAt !== null}
        onToggle={(next) => patch({ dailyAt: next ? dailyAt : null })}
        seal="workspace"
        testId="settings-gestao-daily"
      />
      <div className="settings__dispatch">
        <label htmlFor={`${id}-daily`} className="settings__dispatch-field">
          <span>Hora do resumo do dia</span>
          <input id={`${id}-daily`} type="time" className="ui-input" value={dailyAt} disabled={saved.dailyAt === null} onChange={(event) => setDailyAt(event.currentTarget.value)} data-testid="settings-gestao-daily-at" />
        </label>
        <label htmlFor={`${id}-day`} className="settings__dispatch-field">
          <span>Dia da revisão da semana</span>
          <select id={`${id}-day`} className="ui-input" value={weekDay} onChange={(event) => setWeekDay(event.currentTarget.value as GestaoWeekday)} data-testid="settings-gestao-week-day">
            {GESTAO_WEEKDAYS.map((day) => (
              <option key={day} value={day}>
                {GESTAO_WEEKDAY_LABELS[day]}
                {day === "seg" ? " (semana anterior)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${id}-week`} className="settings__dispatch-field">
          <span>Hora da revisão da semana</span>
          <input id={`${id}-week`} type="time" className="ui-input" value={weekTime} onChange={(event) => setWeekTime(event.currentTarget.value)} data-testid="settings-gestao-week-at" />
        </label>
      </div>
      <ErrorText testId="settings-gestao-error">{error}</ErrorText>
      <div className="settings__models-actions">
        {done && !dirty && (
          <span className="settings__card-hint" role="status">
            Salvo.
          </span>
        )}
        <button type="button" className="ui-button ui-button--primary ui-button--small" onClick={() => void saveTimes()} disabled={!dirty || pending || !dailyAt || !weekTime} aria-busy={pending} data-testid="settings-gestao-save">
          {pending ? "Salvando…" : "Salvar horários"}
        </button>
      </div>
      <SettingSwitch
        title={`Parágrafo do Maestro no resumo do dia (cerca de ${GESTAO_AI_COST.daily} equivalente por resumo)`}
        line="O Maestro escreve até 3 frases por cima dos números, sem refazer a conta. Acorda o Maestro e gasta um pouco da cota do motor dele; desligado, nada é pedido a ninguém."
        checked={saved.ai.daily}
        onToggle={(next) => patch({ ai: { daily: next } })}
        seal="workspace"
        testId="settings-gestao-ai-daily"
      />
      <SettingSwitch
        title={`Parágrafo do Maestro na revisão da semana (cerca de ${GESTAO_AI_COST.weekly} equivalente por revisão)`}
        line={"Um parágrafo de “o que mudou” na revisão da semana fechada. Também gasta cota do motor do Maestro; vem desligado."}
        checked={saved.ai.weekly}
        onToggle={(next) => patch({ ai: { weekly: next } })}
        seal="workspace"
        testId="settings-gestao-ai-weekly"
      />
    </section>
  );
}
