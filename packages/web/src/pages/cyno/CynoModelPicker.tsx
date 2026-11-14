import { describeModelChoice, type AgentEffort, type ModelChoice } from "@cyno/shared";
import { useCallback, useRef, useState } from "react";
import { usePopover } from "../../hud/usePopover";
import { useCynoStore } from "../../store/cynoStore";
import { EngineFields, type EngineValues } from "../../ui/EngineFields";

const toValues = (choice: ModelChoice): EngineValues => ({ engine: choice.engine, model: choice.model ?? "", effort: choice.effort ?? "" });
const toChoice = (values: EngineValues): ModelChoice => ({
  engine: values.engine,
  ...(values.model ? { model: values.model } : {}),
  ...(values.effort ? { effort: values.effort as AgentEffort } : {}),
});

/**
 * Seletor de motor e modelo do Cyno (o botão mostra o atual; abre um painel com Motor, Modelo e
 * Esforço). Vale na próxima vez que ele acordar; com ele no meio de um turno, reinicia quando livre.
 */
export function CynoModelPicker({ choice }: { choice: ModelChoice }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<EngineValues>(() => toValues(choice));
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  usePopover(open, close, rootRef, buttonRef);
  const setChoice = useCynoStore((state) => state.setChoice);

  const changed = JSON.stringify(toChoice(values)) !== JSON.stringify(choice);
  const apply = async () => {
    setSaving(true);
    const ok = await setChoice(toChoice(values));
    setSaving(false);
    if (ok) setOpen(false);
  };

  return (
    <div className="cyno-model" ref={rootRef}>
      <button ref={buttonRef} type="button" className="cyno-chip cyno-chip--button" aria-expanded={open} aria-haspopup="dialog" onClick={() => {
          // Ao abrir, parte do que está valendo agora.
          if (!open) setValues(toValues(choice));
          setOpen((value) => !value);
        }} title="Motor · modelo · esforço do Cyno" data-testid="cyno-model">
        <span className="cyno-chip__label">{describeModelChoice(choice)}</span>
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="cyno-model__pop" role="dialog" aria-label="Motor e modelo do Cyno" data-testid="cyno-model-pop">
          <EngineFields values={values} onChange={setValues} locked={false} testIdPrefix="cyno-model" />
          <p className="cyno-model__hint">Vale na próxima vez que o Cyno acordar. Trocar de motor começa uma conversa nova (cada CLI guarda a sua).</p>
          <div className="cyno-model__actions">
            <button type="button" className="ui-button ui-button--ghost" onClick={close}>
              Cancelar
            </button>
            <button type="button" className="ui-button cyno-solid" disabled={!changed || saving} onClick={() => void apply()} data-testid="cyno-model-apply">
              {saving ? "Aplicando…" : "Aplicar"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
