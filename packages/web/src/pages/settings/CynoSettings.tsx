import { CYNO_SETTINGS_PATH, type CynoSettingsResponse, type UpdateCynoSettingsBody } from "@cyno/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { describeError, requestJson } from "../../api/client";
import { ErrorText } from "../../ui/widgets";
import { OptionHead, SettingSwitch, StateBadge } from "./SettingsOption";

/**
 * Seção da plataforma "Cyno": quanto tempo ele fica acordado sem ninguém falar, quantos turnos pode
 * usar por dia (protege a cota da assinatura: ao bater, o chat avisa) e o resumo diário opcional
 * (montado por código, desligado por padrão).
 */
export function CynoSettings() {
  const [data, setData] = useState<CynoSettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  const idleId = useId();
  const capId = useId();
  const timeId = useId();

  const load = useCallback(() => {
    requestJson<CynoSettingsResponse>(CYNO_SETTINGS_PATH).then(
      (next) => alive.current && setData(next),
      (caught: unknown) => alive.current && setError(describeError(caught)),
    );
  }, []);
  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const save = async (patch: UpdateCynoSettingsBody) => {
    setSaving(true);
    setError(null);
    try {
      const next = await requestJson<CynoSettingsResponse>(CYNO_SETTINGS_PATH, { method: "PATCH", body: patch });
      if (alive.current) setData(next);
      return next;
    } catch (caught) {
      if (alive.current) setError(describeError(caught));
      return undefined;
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  if (!data) {
    return (
      <div className="settings__groups">
        <ErrorText testId="settings-cyno-error">{error}</ErrorText>
        {!error && (
          <p className="settings__card-hint" role="status">
            Lendo as configurações do Cyno…
          </p>
        )}
      </div>
    );
  }

  const { settings, defaults, turnsToday } = data;
  const atCap = turnsToday >= settings.dailyTurnCap;
  return (
    <div className="settings__groups" data-testid="settings-cyno">
      <ErrorText testId="settings-cyno-error">{error}</ErrorText>
      <section className="settings__card" data-testid="settings-cyno-sleep">
        <OptionHead
          title="Quando o Cyno dorme"
          seal="plataforma"
          inherited={settings.idleMinutes === defaults.idleMinutes}
          state={<StateBadge tone="value">Dorme depois de {settings.idleMinutes} min parado</StateBadge>}
          line="O Cyno só fica de pé enquanto você conversa com ele. Sem mensagem por este tempo, o processo para (a conversa continua guardada) e a próxima mensagem o acorda de novo. Mexer aqui vale na próxima vez que ele subir."
        />
        <div className="settings__retention-row">
          <label htmlFor={idleId} className="settings__retention-label">
            Minutos até dormir
          </label>
          <input
            id={idleId}
            className="ui-input ui-input--compact"
            type="number"
            min={1}
            max={1440}
            defaultValue={settings.idleMinutes}
            key={settings.idleMinutes}
            disabled={saving || data.idleFromEnv}
            onBlur={(event) => {
              const value = Number(event.currentTarget.value);
              if (Number.isInteger(value) && value >= 1 && value <= 1440 && value !== settings.idleMinutes) void save({ idleMinutes: value });
            }}
            data-testid="settings-cyno-idle"
          />
          {data.idleFromEnv && <span className="settings__card-hint">Fixado pelo ambiente do servidor (CYNO_IDLE_MS).</span>}
        </div>
      </section>
      <section className="settings__card" data-testid="settings-cyno-cap">
        <OptionHead
          title="Teto de turnos por dia"
          seal="plataforma"
          inherited={settings.dailyTurnCap === defaults.dailyTurnCap}
          state={
            <StateBadge tone={atCap ? "warn" : "value"} testId="settings-cyno-turns">
              {turnsToday} de {settings.dailyTurnCap} hoje
            </StateBadge>
          }
          line="Cada mensagem sua (ou pedido de um Maestro) que acorda o Cyno conta um turno. Ao bater o teto, o Cyno para de responder até amanhã (horário de Brasília) e o chat explica. Protege a cota da sua assinatura."
        />
        <div className="settings__retention-row">
          <label htmlFor={capId} className="settings__retention-label">
            Turnos por dia
          </label>
          <input
            id={capId}
            className="ui-input ui-input--compact"
            type="number"
            min={1}
            max={1000}
            defaultValue={settings.dailyTurnCap}
            key={settings.dailyTurnCap}
            disabled={saving}
            onBlur={(event) => {
              const value = Number(event.currentTarget.value);
              if (Number.isInteger(value) && value >= 1 && value <= 1000 && value !== settings.dailyTurnCap) void save({ dailyTurnCap: value });
            }}
            data-testid="settings-cyno-cap-input"
          />
        </div>
      </section>
      <section className="settings__card" data-testid="settings-cyno-digest">
        <SettingSwitch
          title="Resumo diário no chat"
          line="Na hora marcada (Brasília), o chat do Cyno ganha uma mensagem com o resumo dos workspaces, montada por código: não acorda o Cyno nem gasta turno nem cota. Desligado por padrão."
          seal="plataforma"
          checked={settings.digest.enabled}
          inherited={!settings.digest.enabled}
          onToggle={(enabled) => save({ digest: { enabled } })}
          testId="settings-cyno-digest-switch"
        />
        {settings.digest.enabled && (
          <div className="settings__retention-row">
            <label htmlFor={timeId} className="settings__retention-label">
              Hora
            </label>
            <input
              id={timeId}
              className="ui-input ui-input--compact"
              type="time"
              defaultValue={settings.digest.time}
              key={settings.digest.time}
              disabled={saving}
              onBlur={(event) => {
                const value = event.currentTarget.value;
                if (/^\d{2}:\d{2}$/.test(value) && value !== settings.digest.time) void save({ digest: { time: value } });
              }}
              data-testid="settings-cyno-digest-time"
            />
            <select
              className="ui-input ui-input--compact"
              value={settings.digest.frequency}
              disabled={saving}
              onChange={(event) => void save({ digest: { frequency: event.currentTarget.value === "weekly" ? "weekly" : "daily" } })}
              aria-label="Frequência do resumo"
              data-testid="settings-cyno-digest-frequency"
            >
              <option value="daily">Todo dia</option>
              <option value="weekly">Toda segunda</option>
            </select>
          </div>
        )}
      </section>
    </div>
  );
}
