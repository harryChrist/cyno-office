import type { SettingsSectionId, SettingsWarning } from "./settingsView";

/**
 * Avisos de estados incomuns (senha desligada, terminal ligado, rede local liberada), cada um levando à sua
 * seção. O aviso de uma seção que já está aberta (`open`) não aparece: a própria seção mostra o estado.
 */
export function SettingsWarnings({ warnings, open, onJump }: { warnings: SettingsWarning[]; open: readonly SettingsSectionId[]; onJump: (section: SettingsSectionId) => void }) {
  const shown = warnings.filter((warning) => !open.includes(warning.section));
  if (shown.length === 0) return null;
  return (
    <ul className="settings__warnings" aria-label="Atenção" data-testid="settings-warnings">
      {shown.map((warning) => (
        <li key={warning.id} className="settings__warning" data-testid={`settings-warning-${warning.id}`}>
          <span className="settings__warning-text">{warning.text}</span>
          <button type="button" className="settings__link" onClick={() => onJump(warning.section)}>
            Ver
          </button>
        </li>
      ))}
    </ul>
  );
}
