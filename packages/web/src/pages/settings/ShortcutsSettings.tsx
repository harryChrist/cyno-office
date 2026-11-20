import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { bindingFromEvent, bindingKeys, bindingText, DEFAULT_SHORTCUTS, IS_MAC, resetShortcut, sameBinding, setShortcut, useShortcuts, type KeyBinding } from "../../hud/shortcuts";
import { ErrorText } from "../../ui/widgets";
import { OptionHead, StateBadge } from "./SettingsOption";

/** As teclas de uma combinação, uma `<kbd>` por tecla. */
function Keys({ binding }: { binding: KeyBinding }) {
  return (
    <span className="shortcut-keys" data-testid="shortcut-keys">
      {bindingKeys(binding, IS_MAC).map((key, index) => (
        <Fragment key={key}>
          {index > 0 && <span aria-hidden="true">+</span>}
          <kbd>{key}</kbd>
        </Fragment>
      ))}
    </span>
  );
}

/**
 * Seção "Atalhos do teclado": preferência só deste navegador (localStorage, sem server). Hoje um atalho: abrir o chat
 * do Maestro de qualquer tela. "Trocar atalho" espera a próxima combinação apertada (Esc cancela; Tab sai sem trocar);
 * uma combinação que não serve é recusada com o motivo e nada muda.
 */
export function ShortcutsSettings() {
  const { maestro } = useShortcuts();
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string>();
  const captureRef = useRef<HTMLButtonElement>(null);
  const isDefault = sameBinding(maestro, DEFAULT_SHORTCUTS.maestro);

  useEffect(() => {
    if (capturing) captureRef.current?.focus();
  }, [capturing]);

  const stop = () => {
    setCapturing(false);
    setError(undefined);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!capturing || event.key === "Tab") return;
    // A tecla é da captura: não chega aos atalhos da página (o próprio atalho do Maestro, recolher a barra).
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") return stop();
    const binding = bindingFromEvent(event.nativeEvent);
    if (!binding) return;
    const issue = setShortcut("maestro", binding);
    if (issue) setError(issue);
    else stop();
  };

  return (
    <div className="settings__groups">
      <section className="settings__card" data-testid="settings-atalho-maestro">
        <OptionHead
          title="Abrir o chat do Maestro"
          seal="navegador"
          state={<StateBadge tone="value">{bindingText(maestro, IS_MAC)}</StateBadge>}
          line="De qualquer tela, abre o chat do Maestro com o cursor no campo de mensagem."
        />
        <div className="shortcut-row">
          <Keys binding={maestro} />
          <div className="ui-actions">
            <button
              ref={captureRef}
              type="button"
              className={`ui-button ui-button--small${capturing ? "" : " ui-button--secondary"}`}
              aria-pressed={capturing}
              onClick={() => (capturing ? stop() : setCapturing(true))}
              onKeyDown={onKeyDown}
              onBlur={stop}
              data-testid="settings-atalho-trocar"
            >
              {capturing ? "Aperte a nova combinação (Esc cancela)" : "Trocar atalho"}
            </button>
            {!isDefault && !capturing && (
              <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => resetShortcut("maestro")} data-testid="settings-atalho-padrao">
                Voltar ao padrão ({bindingText(DEFAULT_SHORTCUTS.maestro, IS_MAC)})
              </button>
            )}
          </div>
        </div>
        <p className="settings__fine" role="status" data-testid="settings-atalho-ajuda">
          {capturing ? "Segure Ctrl (ou ⌘) ou Alt e aperte uma tecla. Vale também uma tecla de função, como F2." : "Dentro do terminal do Maestro o atalho não vale."}
        </p>
        <ErrorText testId="settings-atalho-erro">{error}</ErrorText>
      </section>
    </div>
  );
}
