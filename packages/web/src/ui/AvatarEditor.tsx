import { AVATAR_OPTIONS, SCENE_AVATAR_OPTIONS, type PaletteColorId, type SceneAccessory, type SceneHairStyle, type SceneTopStyle } from "@cyno/shared";
import { useId, useState } from "react";
import { AVATAR_DIRECTIONS, type AvatarDirection } from "./avatarDirections";
import { AvatarSprite } from "./AvatarSprite";
import {
  colorLabel,
  randomAvatar,
  SCENE_ACCESSORY_LABELS,
  SCENE_HAIR_LABELS,
  SCENE_TOP_LABELS,
  sceneAccessoryOf,
  sceneHairOf,
  sceneTopOf,
  SKIN_LABELS,
  skinColor,
  withSceneAccessory,
  withSceneHair,
  withSceneTop,
  type AvatarInput,
} from "./avatarOptions";

type SwatchGroupProps<T extends string> = {
  legend: string;
  name: string;
  options: readonly T[];
  value: T;
  color: (option: T) => PaletteColorId;
  label: (option: T) => string;
  onChange: (option: T) => void;
};

/** Grupo de rádios exibidos como amostras de cor (o nome da cor vai no rótulo acessível). */
function SwatchGroup<T extends string>({ legend, name, options, value, color, label, onChange }: SwatchGroupProps<T>) {
  const group = useId();
  return (
    <fieldset className="avatar-editor__group" data-testid={`avatar-${name}`}>
      <legend>
        {legend}: <span className="avatar-editor__current">{label(value)}</span>
      </legend>
      <div className="avatar-editor__swatches">
        {options.map((option) => (
          <label key={option} className="ui-swatch" title={label(option)}>
            <input
              type="radio"
              name={group}
              value={option}
              checked={option === value}
              onChange={() => onChange(option)}
              aria-label={label(option)}
            />
            <span className="ui-swatch__chip" style={{ background: `var(--p-${color(option)})` }} />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

type AvatarEditorProps = { value: AvatarInput; onChange: (avatar: AvatarInput) => void; previewScale?: number };

const DIRECTION_LABELS: Record<AvatarDirection, string> = { SE: "frente (direita)", SW: "frente (esquerda)", NE: "costas (direita)", NW: "costas (esquerda)" };

/** Editor de avatar com preview grande ao vivo: pele, cabelo, cores, roupas e acessório. */
export function AvatarEditor({ value, onChange, previewScale = 6 }: AvatarEditorProps) {
  const [direction, setDirection] = useState<AvatarDirection>("SE");
  const ids = { hair: useId(), accessory: useId(), top: useId() };
  const set = <K extends keyof AvatarInput>(key: K, next: AvatarInput[K]) => onChange({ ...value, [key]: next });
  const turn = () => setDirection((current) => AVATAR_DIRECTIONS[(AVATAR_DIRECTIONS.indexOf(current) + 1) % AVATAR_DIRECTIONS.length]!);

  return (
    <div className="avatar-editor" data-testid="avatar-editor">
      <div className="avatar-editor__preview">
        <div className="avatar-stage">
          <AvatarSprite avatar={value} scale={previewScale} direction={direction} animate testId="avatar-preview" />
        </div>
        <div className="avatar-editor__preview-actions">
          <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={turn} aria-label={`Girar avatar (agora: ${DIRECTION_LABELS[direction]})`}>
            Girar
          </button>
          <button type="button" className="ui-button ui-button--small" onClick={() => onChange(randomAvatar())} data-testid="avatar-random">
            Aleatório
          </button>
        </div>
      </div>

      <div className="avatar-editor__controls">
        <SwatchGroup legend="Pele" name="skin" options={AVATAR_OPTIONS.skin} value={value.skin} color={skinColor} label={(o) => SKIN_LABELS[o]} onChange={(o) => set("skin", o)} />

        <div className="avatar-editor__selects">
          <div className="ui-field">
            <label className="ui-field__label" htmlFor={ids.hair}>
              Cabelo
            </label>
            <select id={ids.hair} className="ui-input" value={sceneHairOf(value)} onChange={(e) => onChange(withSceneHair(value, e.currentTarget.value as SceneHairStyle))} data-testid="avatar-hair">
              {SCENE_AVATAR_OPTIONS.hairStyle.map((option) => (
                <option key={option} value={option}>
                  {SCENE_HAIR_LABELS[option]}
                </option>
              ))}
            </select>
          </div>
          <div className="ui-field">
            <label className="ui-field__label" htmlFor={ids.accessory}>
              Acessório
            </label>
            <select
              id={ids.accessory}
              className="ui-input"
              value={sceneAccessoryOf(value)}
              onChange={(e) => onChange(withSceneAccessory(value, e.currentTarget.value as SceneAccessory))}
              data-testid="avatar-accessory"
            >
              {SCENE_AVATAR_OPTIONS.accessory.map((option) => (
                <option key={option} value={option}>
                  {SCENE_ACCESSORY_LABELS[option]}
                </option>
              ))}
            </select>
          </div>
          <div className="ui-field">
            <label className="ui-field__label" htmlFor={ids.top}>
              Roupa
            </label>
            <select id={ids.top} className="ui-input" value={sceneTopOf(value)} onChange={(e) => onChange(withSceneTop(value, e.currentTarget.value as SceneTopStyle | ""))} data-testid="avatar-top">
              <option value="">Do agente</option>
              {SCENE_AVATAR_OPTIONS.topStyle.map((option) => (
                <option key={option} value={option}>
                  {SCENE_TOP_LABELS[option]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <SwatchGroup legend="Cor do cabelo" name="hairColor" options={AVATAR_OPTIONS.hairColor} value={value.hairColor} color={(o): PaletteColorId => o} label={colorLabel} onChange={(o) => set("hairColor", o)} />
        <SwatchGroup legend="Camisa" name="shirt" options={AVATAR_OPTIONS.shirt} value={value.shirt} color={(o): PaletteColorId => o} label={colorLabel} onChange={(o) => set("shirt", o)} />
        <SwatchGroup legend="Calça" name="pants" options={AVATAR_OPTIONS.pants} value={value.pants} color={(o): PaletteColorId => o} label={colorLabel} onChange={(o) => set("pants", o)} />
      </div>
    </div>
  );
}
