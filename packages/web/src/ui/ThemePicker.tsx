import { THEMES, type RoomThemeId, type ThemeId } from "@cyno/shared";
import { useId } from "react";
import { indiceDoTema } from "../cena/adaptador/temas";
import { nomeDoTemaNoMotor, TEMAS_DO_MOTOR } from "../cena/adaptador/temasDoMotor";
import { useArteDoMotor, type ArteDoMotor } from "../cena/arteDoMotor";

/** Cores do tema do motor (parede, friso, carpete e detalhe) para o índice dado. */
function coresDoMotor(arte: ArteDoMotor | null, indice: number) {
  const tema = arte?.roomTheme(indice);
  return tema ? { parede: tema.wall.base, friso: tema.wall.trim, carpete: tema.carpet, carpete2: tema.carpet2, detalhe: tema.accent } : null;
}

/** Mini-amostra do tema: parede em cima e as duas cores do carpete embaixo (cores do motor; o lobby usa as do Cyno). */
export function ThemeChip({ theme }: { theme: ThemeId }) {
  const arte = useArteDoMotor();
  const motor = theme === "lobby" ? null : coresDoMotor(arte, indiceDoTema(theme));
  if (motor) {
    return (
      <span className="theme-chip" aria-hidden="true">
        <span style={{ background: motor.parede, borderBottom: `3px solid ${motor.friso}` }} />
        <span style={{ background: motor.carpete }} />
        <span style={{ background: motor.carpete2 }} />
      </span>
    );
  }
  const colors = THEMES[theme];
  return (
    <span className="theme-chip" aria-hidden="true">
      <span style={{ background: `var(--p-${colors.wall})` }} />
      <span style={{ background: `var(--p-${colors.floorA})` }} />
      <span style={{ background: `var(--p-${colors.floorB})` }} />
    </span>
  );
}

type ThemePickerProps = { value: string; onChange: (theme: RoomThemeId) => void; error?: string };

/**
 * Escolha do tema da sala: só os dez temas que o motor da cena tem, com a prévia nas cores dele (parede, friso,
 * carpete e a cor de detalhe). São rádios nativos: Tab entra no grupo e as setas trocam de tema. Uma sala com um id
 * antigo (`forest`, `night`...) aparece marcada no tema do motor que a representa.
 */
export function ThemePicker({ value, onChange, error }: ThemePickerProps) {
  const name = useId();
  const errorId = `${name}-error`;
  const arte = useArteDoMotor();
  const atual = indiceDoTema(value);
  return (
    <fieldset className="theme-picker" aria-describedby={error ? errorId : undefined} data-testid="theme-picker">
      <legend className="ui-field__label">Tema</legend>
      <div className="theme-picker__options">
        {TEMAS_DO_MOTOR.map((tema) => {
          const cores = coresDoMotor(arte, tema.indice);
          return (
            <label key={tema.id} className="theme-card" title={nomeDoTemaNoMotor(tema.indice)} data-theme={tema.id}>
              <input type="radio" name={name} value={tema.id} checked={atual === tema.indice} onChange={() => onChange(tema.id)} />
              <span className="theme-card__preview">
                {cores && (
                  <span className="theme-card__sala" aria-hidden="true">
                    <span className="theme-card__parede" style={{ background: cores.parede, borderBottomColor: cores.friso }} />
                    <span className="theme-card__carpete" style={{ background: `repeating-conic-gradient(${cores.carpete} 0% 25%, ${cores.carpete2} 0% 50%) 0 0 / 16px 16px` }} />
                  </span>
                )}
              </span>
              <span className="theme-card__label">
                <span className="theme-card__accent" style={{ background: cores?.detalhe ?? "var(--ui-border)" }} aria-hidden="true" />
                {tema.nome}
              </span>
            </label>
          );
        })}
      </div>
      {error && (
        <p id={errorId} className="ui-field__error">
          {error}
        </p>
      )}
    </fieldset>
  );
}
