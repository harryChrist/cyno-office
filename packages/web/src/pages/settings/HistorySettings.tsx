import type { DiskUsage, RetentionResponse, RetentionSettings } from "@cyno/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api, describeError } from "../../api/client";
import { countLabel, formatDateTime } from "../../ui/format";
import { ConfirmDialog, ErrorText } from "../../ui/widgets";
import { OptionHead, StateBadge } from "./SettingsOption";
import { formatBytes, retentionLabel, retentionOptions } from "./settingsView";

type State = { data: RetentionResponse | null; error: string | null; saving: boolean };

const usageText = (usage: DiskUsage) => `${formatBytes(usage.bytes)} · ${countLabel(usage.files, "arquivo", "arquivos")}`;

/** Uma categoria apagável: o que é, quanto ocupa e por quanto tempo fica (select). */
function RetentionCard({
  title,
  hint,
  more,
  usage,
  kind,
  value,
  disabled,
  onChange,
  testId,
}: {
  title: string;
  hint: string;
  more?: string;
  usage: DiskUsage;
  kind: "transcripts" | "logs";
  value: number;
  disabled: boolean;
  onChange: (days: number) => void;
  testId: string;
}) {
  const selectId = useId();
  return (
    <section className="settings__card" data-testid={testId}>
      <OptionHead title={title} line={hint} seal="plataforma" state={<StateBadge tone="value">{value <= 0 ? "Nunca apaga" : `Guarda ${retentionLabel(value)}`}</StateBadge>} />
      <div className="settings__retention-row">
        <label htmlFor={selectId} className="settings__retention-label">
          Guardar por
        </label>
        <select id={selectId} className="ui-input ui-input--compact" value={value} disabled={disabled} onChange={(event) => onChange(Number(event.currentTarget.value))} data-testid={`${testId}-days`}>
          {retentionOptions(kind, value).map((days) => (
            <option key={days} value={days}>
              {retentionLabel(days)}
            </option>
          ))}
        </select>
        <span className="settings__retention-usage" data-testid={`${testId}-usage`}>
          {usageText(usage)}
        </span>
      </div>
      {more && (
        <details className="settings__more">
          <summary>Saiba mais</summary>
          <p>{more}</p>
        </details>
      )}
    </section>
  );
}

/** As aprovações decididas: quanto tempo ficam na lista viva antes de irem para o arquivo (nada é apagado). */
function ApprovalsCard({ value, disabled, onChange }: { value: number; disabled: boolean; onChange: (days: number) => void }) {
  const selectId = useId();
  const testId = "settings-history-approvals";
  return (
    <section className="settings__card" data-testid={testId}>
      <OptionHead
        title="Aprovações decididas"
        line="Depois do prazo, vai para o arquivo (em Mais antigos). Nada é apagado."
        seal="plataforma"
        state={<StateBadge tone="value">{value <= 0 ? "Nunca arquiva" : `Na lista por ${retentionLabel(value)}`}</StateBadge>}
      />
      <div className="settings__retention-row">
        <label htmlFor={selectId} className="settings__retention-label">
          Manter na lista por
        </label>
        <select id={selectId} className="ui-input ui-input--compact" value={value} disabled={disabled} onChange={(event) => onChange(Number(event.currentTarget.value))} data-testid={`${testId}-days`}>
          {retentionOptions("approvals", value).map((days) => (
            <option key={days} value={days}>
              {retentionLabel(days, "approvals")}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}

/**
 * Seção "Histórico": quanto tempo o server guarda as conversas internas das CLIs dos agentes e os
 * logs das tarefas (configuração do server, para todos os navegadores), o uso de disco de cada
 * coisa e "Limpar agora". Tarefas, resultados e o Cérebro ficam para sempre.
 */
export function HistorySettings() {
  const [state, setState] = useState<State>({ data: null, error: null, saving: false });
  const [confirming, setConfirming] = useState(false);
  const alive = useRef(true);
  const apply = useCallback((data: RetentionResponse) => {
    if (alive.current) setState({ data, error: null, saving: false });
  }, []);
  const fail = useCallback((error: unknown) => {
    if (alive.current) setState((current) => ({ ...current, error: describeError(error), saving: false }));
  }, []);

  useEffect(() => {
    alive.current = true;
    api.getRetention().then(apply, fail);
    return () => {
      alive.current = false;
    };
  }, [apply, fail]);

  const change = (patch: Partial<RetentionSettings>) => {
    setState((current) => ({ ...current, error: null, saving: true }));
    api.updateRetention(patch).then(apply, fail);
  };

  const { data, error, saving } = state;
  if (!data) {
    return (
      <div className="settings__groups">
        <ErrorText testId="settings-history-error">{error}</ErrorText>
        {!error && (
          <p className="settings__card-hint" role="status">
            Lendo o histórico guardado…
          </p>
        )}
      </div>
    );
  }

  const last = data.lastCleanup;
  const freed = last ? last.transcripts.files + last.logs.files : 0;
  return (
    <div className="settings__groups" data-testid="settings-history">
      <div className="settings__toolbar">
        <div>
          <p className="settings__card-hint">Vale para o servidor inteiro. A limpeza roda sozinha uma vez por dia.</p>
          <details className="settings__more">
            <summary>O que nunca é apagado</summary>
            <p>Tarefas, resultados e o Cérebro nunca são apagados. A limpeza também roda ao ligar o servidor.</p>
          </details>
        </div>
        <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => setConfirming(true)} data-testid="settings-history-clean">
          Limpar agora
        </button>
      </div>
      <ErrorText testId="settings-history-error">{error}</ErrorText>
      <RetentionCard
        title="Conversas internas das CLIs"
        hint={data.transcriptsManaged ? "O histórico que o Claude Code guarda de cada agente. A conversa em uso nunca sai." : "O servidor não sabe onde o Claude Code guarda as conversas. Nada é apagado lá."}
        more="Só as pastas dos nossos agentes são limpas. O Antigravity guarda as conversas dele junto com as suas e não é mexido."
        usage={data.usage.transcripts}
        kind="transcripts"
        value={data.settings.transcriptsDays}
        disabled={saving || !data.transcriptsManaged}
        onChange={(days) => change({ transcriptsDays: days })}
        testId="settings-history-transcripts"
      />
      <RetentionCard
        title="Logs de trabalho das tarefas"
        hint="O passo a passo de cada tarefa. O resultado continua guardado."
        usage={data.usage.logs}
        kind="logs"
        value={data.settings.logsDays}
        disabled={saving}
        onChange={(days) => change({ logsDays: days })}
        testId="settings-history-logs"
      />
      <ApprovalsCard value={data.settings.approvalsLiveDays} disabled={saving} onChange={(days) => change({ approvalsLiveDays: days })} />
      <section className="settings__card" data-testid="settings-history-kept">
        <OptionHead title="Guardados para sempre" seal="plataforma" state={<StateBadge tone="on">Nunca são apagados</StateBadge>} />
        <ul className="settings__retention-kept">
          <li>
            <span>Tarefas e resultados</span> <span className="settings__retention-usage">{usageText(data.usage.tasks)}</span>
          </li>
          <li>
            <span>Cérebro (notas e histórico)</span> <span className="settings__retention-usage">{usageText(data.usage.brains)}</span>
          </li>
        </ul>
      </section>
      <p className="settings__card-hint" role="status" data-testid="settings-history-last">
        {last
          ? `Última limpeza: ${formatDateTime(last.at)} · ${freed === 0 ? "nada para apagar" : `${countLabel(freed, "arquivo apagado", "arquivos apagados")} (${formatBytes(last.transcripts.bytes + last.logs.bytes)})`}`
          : "Nenhuma limpeza ainda."}
      </p>
      {confirming && (
        <ConfirmDialog
          title="Limpar o histórico agora?"
          message={
            <p>
              Apaga as conversas das CLIs com mais de {retentionLabel(data.settings.transcriptsDays).toLowerCase()} e os logs de tarefas com mais de{" "}
              {retentionLabel(data.settings.logsDays).toLowerCase()} (o que estiver em &quot;Nunca apagar&quot; fica). Não dá para desfazer.
            </p>
          }
          confirmLabel="Limpar agora"
          pendingLabel="Limpando…"
          onConfirm={async () => apply(await api.cleanupRetention())}
          onClose={() => setConfirming(false)}
          testId="settings-history-confirm"
        />
      )}
    </div>
  );
}
