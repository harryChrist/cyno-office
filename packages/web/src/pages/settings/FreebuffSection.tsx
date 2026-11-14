import { freebuffCostText, usageAgeLabel, type EngineStatus, type FreebuffModel } from "@cyno/shared";
import { useState } from "react";
import { api, describeError } from "../../api/client";
import { freebuffUsageView } from "../../hud/freebuffUsage";
import { ErrorText } from "../../ui/widgets";

const MAX_OPEN_CHOICES = [1, 2, 3, 4];

/** "DeepSeek V4.1 Flash · 2x" (o nome é o da tela do Freebuff). */
export const freebuffModelOption = (model: FreebuffModel) => `${model.name} · ${model.multiplier}x`;

/** Quanto custa a hora aberta do modelo escolhido, em frase ("gasta 2 horas por hora aberta"). */
export function freebuffChoiceLine(info: NonNullable<EngineStatus["freebuff"]>): string {
  return `${info.settings.model} · ${info.settings.effort} · gasta ${freebuffCostText(info.multiplier ?? 1)}`;
}

/** O aviso do "Testar": abre uma hora e gasta horas do dia. */
export function freebuffTestWarning(info: NonNullable<EngineStatus["freebuff"]>): string {
  const cost = info.multiplier ?? 1;
  return `Este teste abre uma hora do Freebuff: gasta ${cost === 1 ? "1 hora" : `${cost} horas`} das suas horas de hoje.`;
}

type Props = {
  engine: EngineStatus;
  now: number;
  onStatus: (engines: EngineStatus[]) => void;
  /** Mostra a confirmação do "Testar" (o botão Testar do cartão abre isto). */
  confirming: boolean;
  testing: boolean;
  onConfirmTest: () => void;
  onCancelTest: () => void;
};

/**
 * O que o Freebuff tem de diferente na tela Motores: o modelo da plataforma (um só para todos os agentes: a
 * escolha da TUI é global na máquina), "Atualizar modelos" (abre uma sondagem e lê o `/model`, sem mandar mensagem:
 * não gasta hora), o teto de horas abertas, as horas do dia e as horas abertas por agente, e a confirmação do Testar.
 */
export function FreebuffSection({ engine, now, onStatus, confirming, testing, onConfirmTest, onCancelTest }: Props) {
  const info = engine.freebuff;
  const [busy, setBusy] = useState<"models" | "settings" | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!info) return null;
  const usage = freebuffUsageView(
    { provider: "freebuff", windows: [], updatedAt: new Date(now).toISOString(), freebuff: { settings: { ...info.settings, multiplier: info.multiplier ?? 1 }, hours: info.hours, sessions: info.sessions } },
    now,
  );
  const chosen = info.models.find((model) => model.name === info.settings.model);
  const efforts = chosen && chosen.efforts.length > 0 ? chosen.efforts : [info.settings.effort];
  const save = async (body: Parameters<typeof api.setFreebuffSettings>[0]) => {
    setBusy("settings");
    setError(null);
    try {
      onStatus((await api.setFreebuffSettings(body)).engines);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(null);
    }
  };
  const refresh = async () => {
    setBusy("models");
    setError(null);
    try {
      onStatus((await api.refreshFreebuffModels()).engines);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(null);
    }
  };
  const readAge = info.modelsReadAt ? `lida ${usageAgeLabel(Math.max(0, Math.floor((now - Date.parse(info.modelsReadAt)) / 60_000)))}` : "ainda não lida";
  return (
    <div className="freebuff" data-testid="freebuff-section">
      <p className="freebuff__line" data-testid="freebuff-choice">
        <span className="freebuff__label">Modelo da plataforma</span>
        <strong>{freebuffChoiceLine(info)}</strong>
      </p>
      <div className="freebuff__controls">
        <label className="freebuff__field">
          <span className="engine-config__label">Modelo</span>
          <select
            className="ui-input"
            value={info.settings.model}
            disabled={busy !== null}
            onChange={(event) => void save({ model: event.currentTarget.value })}
            data-testid="freebuff-model"
          >
            {!chosen && <option value={info.settings.model}>{info.settings.model}</option>}
            {info.models.map((model) => (
              <option key={model.name} value={model.name}>
                {freebuffModelOption(model)}
              </option>
            ))}
          </select>
        </label>
        <label className="freebuff__field freebuff__field--small">
          <span className="engine-config__label">Esforço</span>
          <select className="ui-input" value={info.settings.effort} disabled={busy !== null} onChange={(event) => void save({ effort: event.currentTarget.value })} data-testid="freebuff-effort">
            {!efforts.includes(info.settings.effort) && <option value={info.settings.effort}>{info.settings.effort}</option>}
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
        <label className="freebuff__field freebuff__field--small">
          <span className="engine-config__label">Horas abertas ao mesmo tempo</span>
          <select className="ui-input" value={info.settings.maxOpenHours} disabled={busy !== null} onChange={(event) => void save({ maxOpenHours: Number(event.currentTarget.value) })} data-testid="freebuff-max-open">
            {[...new Set([...MAX_OPEN_CHOICES, info.settings.maxOpenHours])].sort().map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
        </label>
      </div>
      <details className="oneshot__more freebuff__more">
        <summary>Como esta escolha vale</summary>
        <p className="freebuff__hint">
          Vale para a próxima hora aberta (uma hora já aberta segue no modelo dela). A escolha é uma só para todos os agentes: o Freebuff guarda o modelo por máquina, não por agente. Cada agente com mensagem abre a própria hora, por isso o teto
          padrão é 1: os outros esperam na fila.
        </p>
      </details>
      <div className="freebuff__row">
        <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => void refresh()} disabled={busy !== null || engine.state === "not_installed"} aria-busy={busy === "models"} data-testid="freebuff-refresh-models">
          {busy === "models" ? "Lendo os modelos…" : "Atualizar modelos"}
        </button>
        <span className="freebuff__hint" data-testid="freebuff-models-read">
          {info.models.length > 0 ? `${info.models.length} modelos, lista ${readAge}.` : "Lista ainda não lida: o Cyno abre um Freebuff de sondagem e lê o /model (não manda mensagem, não gasta hora)."}
        </span>
      </div>
      {usage && (
        <div className="freebuff__hours" data-testid="freebuff-hours-line">
          {usage.total !== undefined && usage.used !== undefined ? (
            <p className="freebuff__line">
              <span className="freebuff__label">Horas de hoje</span>
              <span className={usage.old ? "freebuff__old" : undefined}>
                <strong>
                  {usage.shortText}
                </strong>{" "}
                usadas{usage.remaining !== undefined ? ` · restam ${usage.remaining} h` : ""}
                {usage.wallet ? ` · ${usage.wallet} h na carteira` : ""}
                {usage.resetLabel ? ` · ${usage.resetLabel}` : ""}
              </span>
            </p>
          ) : (
            <p className="freebuff__hint">As horas do dia ainda não foram lidas (aparecem quando o Cyno abre o Freebuff).</p>
          )}
          <p className="freebuff__hint">
            {usage.measuredLabel ? `Medido: ${usage.measuredLabel}.` : ""}
            {usage.estimated ? ` Estimado: o Cyno abriu ${usage.openedSince} h depois dessa leitura.` : ""}
          </p>
          {usage.sessions.length > 0 && (
            <ul className="freebuff__sessions" aria-label="Horas abertas">
              {usage.sessions.map((session) => (
                <li key={session.key} data-testid="freebuff-open-hour">
                  <strong>{session.agentName}</strong>: {session.label} ({session.untilLabel}) · {session.modelLabel}
                  {!session.hasProcess && " · sem processo agora"}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {confirming && (
        <div className="freebuff__confirm" role="alertdialog" aria-label="Confirmar o teste do Freebuff" data-testid="freebuff-test-confirm">
          <p>
            <strong>{freebuffTestWarning(info)}</strong> A hora fica aberta por 60 minutos; os agentes não usam essa hora (cada agente abre a dele).
          </p>
          <div className="engine-card__actions">
            <button type="button" className="ui-button ui-button--small" onClick={onConfirmTest} disabled={testing} data-testid="freebuff-test-go">
              {testing ? "Testando…" : "Gastar e testar"}
            </button>
            <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={onCancelTest} disabled={testing} data-testid="freebuff-test-cancel">
              Cancelar
            </button>
          </div>
        </div>
      )}
      <ErrorText testId="freebuff-error">{error}</ErrorText>
    </div>
  );
}
