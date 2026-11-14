import { LAYOUT_SEED_MAX, ROOM_PURPOSE_SPECS, ROOM_PURPOSES, ROOM_SIZE_SPECS, ROOM_SIZES, type RoomPurpose, type RoomSize } from "@cyno/shared";
import { useId } from "react";

/** Semente nova para "Gerar outro layout" (diferente da atual). */
export function newLayoutSeed(current?: number): number {
  for (;;) {
    const seed = Math.floor(Math.random() * LAYOUT_SEED_MAX);
    if (seed !== current) return seed;
  }
}

/**
 * Tamanho da sala em cartões: nome, piso inicial e quantas mesas cabem (só informação: se os times
 * precisarem de mais espaço, a sala cresce sozinha). `desks` = agentes que a sala já tem.
 */
export function RoomSizePicker({ value, onChange, desks }: { value: RoomSize; onChange: (size: RoomSize) => void; desks?: number }) {
  const name = useId();
  return (
    <fieldset className="choice-picker" data-testid="room-size-picker">
      <legend className="ui-field__label">Tamanho</legend>
      <div className="choice-picker__options choice-picker__options--sizes">
        {ROOM_SIZES.map((size) => {
          const spec = ROOM_SIZE_SPECS[size];
          const grows = desks !== undefined && spec.maxDesks !== null && desks > spec.maxDesks;
          return (
            <label key={size} className="choice-card" data-size={size}>
              <input type="radio" name={name} value={size} checked={value === size} onChange={() => onChange(size)} />
              <span className="choice-card__title">{spec.label}</span>
              <span className="choice-card__meta">{spec.tiles ? `${spec.tiles.w}×${spec.tiles.h}` : "cresce sozinha"}</span>
              <span className="choice-card__meta">{spec.maxDesks === null ? "do tamanho dos times" : `cabem ~${spec.maxDesks} mesas`}</span>
              {grows && <span className="choice-card__note">vai crescer</span>}
            </label>
          );
        })}
      </div>
      <p className="ui-field__hint">
        O tamanho é o piso inicial: se faltar espaço, a sala cresce.
        {desks !== undefined ? ` Hoje: ${desks === 1 ? "1 mesa" : `${desks} mesas`}.` : ""}
      </p>
    </fieldset>
  );
}

/** Tipo da sala (decide os móveis): cartões com nome e descrição curta. */
export function RoomPurposePicker({ value, onChange }: { value: RoomPurpose; onChange: (purpose: RoomPurpose) => void }) {
  const name = useId();
  return (
    <fieldset className="choice-picker" data-testid="room-purpose-picker">
      <legend className="ui-field__label">Tipo</legend>
      <div className="choice-picker__options">
        {ROOM_PURPOSES.map((purpose) => {
          const spec = ROOM_PURPOSE_SPECS[purpose];
          return (
            <label key={purpose} className="choice-card choice-card--wide" data-purpose={purpose} title={spec.description}>
              <input type="radio" name={name} value={purpose} checked={value === purpose} onChange={() => onChange(purpose)} />
              <span className="choice-card__title">{spec.label}</span>
              <span className="choice-card__desc">{spec.description}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
