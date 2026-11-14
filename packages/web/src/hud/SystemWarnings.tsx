import { useSystemWarningStore } from "../store/systemWarningStore";
import "./systemWarnings.css";

/** Faixa de avisos do servidor (canto inferior): fica até a pessoa dispensar. */
export function SystemWarnings() {
  const warnings = useSystemWarningStore((state) => state.warnings);
  const dismiss = useSystemWarningStore((state) => state.dismiss);
  if (warnings.length === 0) return null;
  return (
    <div className="system-warnings" role="status" aria-live="polite">
      {warnings.map((warning) => (
        <div key={warning.id} className="system-warning">
          <span>{warning.message}</span>
          <button type="button" className="system-warning__close" onClick={() => dismiss(warning.id)} aria-label="Dispensar aviso">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
