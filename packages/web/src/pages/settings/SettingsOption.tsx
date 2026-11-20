import type { ReactNode } from "react";
import { AsyncSwitch } from "../../ui/widgets";
import { SEAL_LABELS, type SettingsSeal } from "./settingsView";

/** Selo do que a opção vale: "Toda a plataforma", "Só este workspace" ou "Só neste navegador" (`label` troca o texto, ex.: o nome do workspace). */
export function Seal({ kind, label }: { kind: SettingsSeal; label?: string }) {
  return (
    <span className={`opt-seal opt-seal--${kind}`} data-testid="settings-seal" data-seal={kind}>
      {label ?? SEAL_LABELS[kind]}
    </span>
  );
}

export type StateTone = "on" | "off" | "value" | "warn";

/** Estado atual da opção, sempre em texto (Ligado, Desligado ou o valor). */
export function StateBadge({ tone, children, testId }: { tone: StateTone; children: ReactNode; testId?: string }) {
  return (
    <span className={`opt-state opt-state--${tone}`} data-testid={testId ?? "settings-state"} data-tone={tone}>
      {children}
    </span>
  );
}

/** Marca "vem do padrão": o campo nunca foi mexido neste workspace, vale o padrão da plataforma. */
export function DefaultTag() {
  return (
    <span className="opt-default" data-testid="settings-default-tag">
      Usando o padrão da plataforma
    </span>
  );
}

/** Cabeçalho de uma opção: título, o que ela faz, o selo e o estado (à direita). */
export function OptionHead({ title, line, seal, state, inherited, level = 4 }: { title: string; line?: ReactNode; seal: SettingsSeal; state?: ReactNode; inherited?: boolean; level?: 4 | 5 }) {
  const Heading = level === 4 ? "h4" : "h5";
  return (
    <header className="opt-head">
      <div className="opt-head__row">
        <Heading className="opt-head__title">{title}</Heading>
        <Seal kind={seal} />
        {inherited && <DefaultTag />}
        {state && <span className="opt-head__state">{state}</span>}
      </div>
      {line && <p className="opt-head__line">{line}</p>}
    </header>
  );
}

/**
 * Chave de uma opção (salva na hora): título e selo na linha do rótulo e a frase do que ela faz logo abaixo. A
 * própria chave diz se está ligada; só um estado que diz algo a mais (`stateText`) aparece escrito. `inherited`: o campo nunca foi mexido neste workspace.
 */
export function SettingSwitch({
  title,
  line,
  checked,
  disabled,
  onToggle,
  seal,
  inherited,
  testId,
  stateText,
}: {
  title: string;
  line: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onToggle: (next: boolean) => Promise<unknown>;
  seal: SettingsSeal;
  inherited?: boolean;
  testId: string;
  /** Estado que a chave sozinha não diz (ex.: "Desligado · precisa da internet"). */
  stateText?: string;
}) {
  return (
    <AsyncSwitch
      label={
        <span className="opt-label">
          <span className="opt-label__title">{title}</span>
          <Seal kind={seal} />
          {inherited && <DefaultTag />}
          {stateText && <StateBadge tone={checked ? "on" : "off"}>{stateText}</StateBadge>}
        </span>
      }
      description={line}
      checked={checked}
      disabled={disabled}
      onToggle={onToggle}
      testId={testId}
    />
  );
}
