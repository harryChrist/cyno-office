import { STORAGE_PART_LABELS } from "@cyno/shared";
import type { StorageResponse, Workspace } from "@cyno/shared";
import { formatBytes } from "./settingsView";
import { barSegments, foldersTotal, shareLabel, storageLabel, storageTitle } from "./storageView";

/**
 * Cartão "Espaço em disco": quanto a pasta de dados do workspace pesa (barra dividida em Mídia, Agentes, Registros,
 * Cérebro, Quadros e Outros) e, abaixo, o total das pastas de trabalho (os repositórios e vaults reais do computador).
 * Os números vêm do servidor, medidos em segundo plano; enquanto não chegam, o cartão diz "calculando…".
 */
export function StorageCard({ workspace, data, failed, onRefresh }: { workspace: Workspace; data: StorageResponse | null; failed: boolean; onRefresh: () => void }) {
  const info = data?.workspace;
  const total = info ? foldersTotal(data.folders) : null;
  const segments = info ? barSegments(info.parts) : [];
  const folderCount = workspace.folders?.length ?? 0;
  const headline = !info ? (failed ? "sem acesso" : "calculando…") : storageLabel(info);
  return (
    <section className="settings__card storage" aria-label="Espaço em disco" data-testid="settings-storage">
      <header className="storage__head">
        <div className="storage__head-text">
          <h4 className="settings__card-title">Espaço em disco</h4>
          <p className="settings__card-hint">Quanto este workspace ocupa no computador. Só leitura: nada daqui apaga arquivos.</p>
        </div>
        <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={onRefresh} disabled={!info || info.state === "computing"} data-testid="settings-storage-refresh">
          Recalcular
        </button>
      </header>

      <div className="storage__total" aria-live="polite">
        <strong className="storage__bytes" title={info ? storageTitle(info) : undefined} data-testid="settings-storage-total">
          {headline}
        </strong>
        <span className="storage__total-label">na pasta de dados do workspace</span>
      </div>

      {info && info.state === "ready" && info.bytes > 0 && segments.length > 0 && (
        <>
          <div className="storage__bar" role="img" aria-label={`Divisão do espaço: ${segments.map((s) => `${s.label} ${formatBytes(s.bytes)}`).join(", ")}`} data-testid="settings-storage-bar">
            {segments.map((segment) => (
              <span key={segment.id} className={`storage__seg storage__seg--${segment.id}`} style={{ flexGrow: segment.share }} title={`${segment.label}: ${formatBytes(segment.bytes)}`} />
            ))}
          </div>
          <ul className="storage__legend" aria-label="Partes" data-testid="settings-storage-legend">
            {Object.keys(STORAGE_PART_LABELS).map((id) => {
              const part = info.parts.find((item) => item.id === id);
              if (!part || part.bytes === 0) return null;
              const segment = segments.find((item) => item.id === id);
              return (
                <li key={id} className="storage__item" data-testid={`settings-storage-part-${id}`}>
                  <span className={`storage__dot storage__seg--${id}`} aria-hidden="true" />
                  <span className="storage__item-label">{part.label}</span>
                  <span className="storage__item-value">{formatBytes(part.bytes)}</span>
                  <span className="storage__item-share">{segment ? shareLabel(segment.share) : ""}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {info?.state === "error" && <p className="settings__card-hint">Não consegui ler a pasta de dados deste workspace.</p>}

      <div className="storage__folders" data-testid="settings-storage-folders">
        <span className="storage__folders-label">Pastas de trabalho</span>
        <span className="storage__folders-value" title="Soma das pastas cadastradas (ficam no seu computador, fora da pasta de dados)" data-testid="settings-storage-folders-total">
          {folderCount === 0 ? "nenhuma cadastrada" : !total ? "calculando…" : total.pending > 0 && total.bytes === 0 ? "calculando…" : formatBytes(total.bytes)}
        </span>
        {total && folderCount > 0 && (total.pending > 0 || total.failed > 0) && (
          <span className="storage__folders-note">
            {total.pending > 0 ? `${total.pending} ainda calculando` : ""}
            {total.pending > 0 && total.failed > 0 ? " · " : ""}
            {total.failed > 0 ? `${total.failed} sem acesso` : ""}
          </span>
        )}
      </div>
    </section>
  );
}
