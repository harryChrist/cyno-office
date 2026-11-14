import type { SettingsSectionId, SettingsWarning, SummaryItem } from "./settingsView";

/**
 * Resumo do topo: os pontos que o dono mais confere (senha, motores, modelo padrão, conectores),
 * cada um levando à sua seção, e os avisos de estados incomuns (terminal ligado, rede local liberada,
 * senha desligada).
 */
export function SettingsSummary({ items, warnings, onJump }: { items: SummaryItem[]; warnings: SettingsWarning[]; onJump: (section: SettingsSectionId) => void }) {
  return (
    <div className="settings__top" data-testid="settings-summary">
      <ul className="settings__summary" aria-label="Resumo">
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" className={`settings__summary-item settings__summary-item--${item.tone}`} onClick={() => onJump(item.section)} data-testid={`settings-summary-${item.id}`}>
              <span className="settings__summary-label">{item.label}</span>
              <span className="settings__summary-value">{item.value}</span>
            </button>
          </li>
        ))}
      </ul>
      {warnings.length > 0 && (
        <ul className="settings__warnings" aria-label="Atenção" data-testid="settings-warnings">
          {warnings.map((warning) => (
            <li key={warning.id} className="settings__warning" data-testid={`settings-warning-${warning.id}`}>
              <span className="settings__warning-text">{warning.text}</span>
              <button type="button" className="settings__link" onClick={() => onJump(warning.section)}>
                Ver
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
