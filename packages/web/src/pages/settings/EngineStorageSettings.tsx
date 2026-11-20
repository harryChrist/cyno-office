import {
  ENGINE_STORAGE_CLEANUP_PATH,
  ENGINE_STORAGE_PATH,
  ENGINE_STORAGE_PREVIEW_PATH,
  type EngineStorageCleanupResult,
  type EngineStoragePreview,
  type EngineStorageResponse,
  type EngineStorageSettings as EngineStorageSettingsValue,
} from "@cyno/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { describeError, requestJson } from "../../api/client";
import { ConfirmDialog, ErrorText } from "../../ui/widgets";
import { OptionHead, StateBadge } from "./SettingsOption";
import { anyCleanupOn, cleanupResultText, dayChoices, daysLabel, engineRows, itemText, lastCleanupText, oldestText, previewLines, removalText, removalTotal, type EngineStorageRowItem } from "./engineStorageView";
import "./engineStorage.css";

/**
 * Armazenamento dos motores: quanto cada motor guarda em disco e, se o dono ligar, a limpeza por idade do que é
 * dos agentes do Cyno (logs do Antigravity e chats do Freebuff). Componente autocontido: busca e grava sozinho
 * pela API (`/api/settings/engine-storage`). Tudo vem em "Nunca".
 */
export function EngineStorageSettings() {
  const [data, setData] = useState<EngineStorageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<EngineStoragePreview | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [result, setResult] = useState<EngineStorageCleanupResult | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await requestJson<EngineStorageResponse>(ENGINE_STORAGE_PATH);
      if (alive.current) {
        setData(next);
        setError(null);
      }
    } catch (failure) {
      if (alive.current) setError(describeError(failure));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const first = setTimeout(() => void load(), 0);
    return () => {
      alive.current = false;
      clearTimeout(first);
    };
  }, [load]);

  const change = async (patch: Partial<EngineStorageSettingsValue>) => {
    setSaving(true);
    setError(null);
    try {
      const next = await requestJson<EngineStorageResponse>(ENGINE_STORAGE_PATH, { method: "PUT", body: patch });
      if (alive.current) setData(next);
    } catch (failure) {
      if (alive.current) setError(describeError(failure));
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const openCleanup = async () => {
    setPreparing(true);
    setError(null);
    setResult(null);
    try {
      const preview = await requestJson<EngineStoragePreview>(ENGINE_STORAGE_PREVIEW_PATH);
      if (alive.current) setConfirming(preview);
    } catch (failure) {
      if (alive.current) setError(describeError(failure));
    } finally {
      if (alive.current) setPreparing(false);
    }
  };

  const runCleanup = async () => {
    const done = await requestJson<EngineStorageCleanupResult>(ENGINE_STORAGE_CLEANUP_PATH, { method: "POST" });
    if (!alive.current) return;
    setResult(done);
    await load();
  };

  if (!data) {
    return (
      <div className="settings__groups">
        <ErrorText testId="engine-storage-error">{error}</ErrorText>
        {!error && (
          <p className="settings__card-hint" role="status">
            Medindo o que cada motor guarda…
          </p>
        )}
      </div>
    );
  }

  const rows = engineRows(data.usage);
  const cleanupOn = anyCleanupOn(data.settings);
  return (
    <div className="settings__groups" data-testid="engine-storage">
      <div className="settings__toolbar">
        <div>
          <p className="settings__card-hint">Quanto cada motor guarda. A limpeza por idade vem desligada.</p>
          <details className="settings__more">
            <summary>O que é apagado</summary>
            <p>
              Só os logs do Antigravity (todos os antigos, inclusive os do seu uso pessoal) e os chats dos agentes do Cyno no Freebuff, e só o que passou do prazo. As conversas do Antigravity ficam intactas. Nada com menos de 24 horas e nunca o chat em uso. A limpeza roda sozinha uma vez por dia e ao ligar o servidor.
            </p>
          </details>
        </div>
        <button type="button" className="ui-button ui-button--secondary ui-button--small es__clean" onClick={() => void openCleanup()} disabled={preparing} data-testid="engine-storage-clean">
          {preparing ? "Calculando…" : "Limpar agora"}
        </button>
      </div>
      <ErrorText testId="engine-storage-error">{error}</ErrorText>
      {result && (
        <p className="settings__card-hint" role="status" data-testid="engine-storage-result">
          {cleanupResultText(result)}
        </p>
      )}
      {rows.map((row) => (
        <section key={row.id} className="settings__card es" data-testid={`engine-storage-${row.id}`} aria-label={row.title}>
          <OptionHead title={row.title} seal="plataforma" state={<StateBadge tone="value">{itemText(row.total)}</StateBadge>} />
          <ul className="es__items">
            {row.items.map((item) => (
              <ItemRow key={item.id} item={item} days={item.setting ? data.settings[item.setting] : undefined} disabled={saving} onChange={(days) => item.setting && void change({ [item.setting]: days })} />
            ))}
          </ul>
        </section>
      ))}
      <p className="settings__card-hint" role="status" data-testid="engine-storage-last">
        {lastCleanupText(data.lastCleanup)}
      </p>
      {confirming && (
        <ConfirmDialog
          title="Limpar o armazenamento agora?"
          message={<PreviewBody preview={confirming} armed={cleanupOn} />}
          confirmLabel={removalTotal(confirming).files === 0 ? "Limpar agora" : `Apagar ${removalText(removalTotal(confirming))}`}
          pendingLabel="Apagando…"
          onConfirm={runCleanup}
          onClose={() => setConfirming(null)}
          testId="engine-storage-confirm"
        />
      )}
    </div>
  );
}

function PreviewBody({ preview, armed }: { preview: EngineStoragePreview; armed: boolean }) {
  const lines = previewLines(preview);
  if (!armed) return <p data-testid="engine-storage-preview">Tudo está em Nunca. Escolha um prazo em Antigravity ou Freebuff para poder limpar.</p>;
  if (lines.length === 0) return <p data-testid="engine-storage-preview">Nada passou do prazo. Não há o que apagar agora.</p>;
  return (
    <div data-testid="engine-storage-preview">
      <p>Vai apagar, e não dá para desfazer:</p>
      <ul className="es__preview">
        {lines.map((line) => (
          <li key={line.label}>
            <span>{line.label}</span> <strong>{line.text}</strong>
          </li>
        ))}
      </ul>
      <p className="es__preview-note">Nada com menos de 24 horas e nenhum chat em uso é apagado.</p>
    </div>
  );
}

function ItemRow({ item, days, disabled, onChange }: { item: EngineStorageRowItem; days: number | undefined; disabled: boolean; onChange: (days: number) => void }) {
  const selectId = useId();
  const oldest = oldestText(item.usage);
  return (
    <li className="es__item" data-testid={`engine-storage-item-${item.id}`}>
      <div className="es__main">
        <span className="es__label">{item.label}</span>
        <span className="es__usage" data-testid={`engine-storage-usage-${item.id}`}>
          {itemText(item.usage)}
        </span>
      </div>
      <p className="es__note">
        {item.note}
        {oldest ? ` · ${oldest}` : ""}
      </p>
      {days !== undefined && (
        <div className="es__select">
          <label htmlFor={selectId} className="settings__retention-label">
            Apagar sozinho depois de
          </label>
          <select id={selectId} className="ui-input ui-input--compact es__days" value={days} disabled={disabled} onChange={(event) => onChange(Number(event.currentTarget.value))} data-testid={`engine-storage-days-${item.id}`}>
            {dayChoices(days).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
          <span className="es__state">{days > 0 ? `Apaga o que tem mais de ${daysLabel(days)}` : "Desligado"}</span>
        </div>
      )}
    </li>
  );
}
