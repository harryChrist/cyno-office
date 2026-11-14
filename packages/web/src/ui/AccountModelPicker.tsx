import { normalizeOpenRouterModelId, type OneShotAccount, type OneShotEngineId } from "@cyno/shared";
import { useMemo, useState } from "react";
import { ModelPicker } from "./ModelPicker";
import { programModelToPicker } from "./modelSearch";
import { useOpenRouterModels } from "./useOpenRouterModels";
import { useProgramModels } from "./useProgramModels";

type Props = {
  engine: OneShotEngineId;
  /** A forma de conta do motor (ausente = a chave do painel, a lista do OpenRouter). */
  account: OneShotAccount | undefined;
  value: string;
  unlisted?: boolean | undefined;
  onChoose: (id: string) => void;
  onClear?: () => void;
  testId: string;
  inputId?: string;
  describedBy?: string;
  placeholder?: string;
  disabled?: boolean;
  now?: number;
  /** Muda quando a conta muda (o seletor lê a lista do programa de novo). */
  version?: string;
};

/**
 * O seletor de modelo de um motor de um processo por turno. Com a chave do painel: a lista do OpenRouter. Com a configuração
 * do próprio programa: a origem "Modelos do programa" (a lista que ele dá; no Hermes não há, só a digitação livre
 * `provedor/modelo`) e a origem "OpenRouter" (quando o provedor escolhido é o OpenRouter: o id vai como `openrouter/<id>`).
 */
export function AccountModelPicker({ engine, account, value, unlisted, onChoose, onClear, testId, inputId, describedBy, placeholder, disabled, now, version }: Props) {
  const program = account?.mode === "program";
  const catalog = useOpenRouterModels();
  const own = useProgramModels(engine, program, version);
  const [origin, setOrigin] = useState<"program" | "openrouter">("program");
  const ownModels = useMemo(() => own.models.map(programModelToPicker), [own.models]);
  const common = {
    testId,
    ...(onClear ? { onClear } : {}),
    ...(now !== undefined ? { now } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
    ...(inputId ? { inputId } : {}),
    ...(describedBy ? { describedBy } : {}),
  };

  if (!program) {
    return (
      <ModelPicker
        {...common}
        models={catalog.models}
        value={value}
        unlisted={unlisted}
        onChoose={onChoose}
        readAt={catalog.readAt}
        onRefresh={() => void catalog.refresh()}
        refreshing={catalog.refreshing}
        loading={catalog.loading}
        loadError={catalog.error}
        {...(placeholder ? { placeholder } : {})}
      />
    );
  }

  const viaOpenRouter = origin === "openrouter";
  const shown = value.startsWith("openrouter/") ? value.slice("openrouter/".length) : "";
  return (
    <div className="mpick-source" data-testid={`${testId}-origin`}>
      <div className="mpick__filters" role="group" aria-label="De onde vem a lista de modelos">
        <button type="button" className="mpick__chip" aria-pressed={!viaOpenRouter} onClick={() => setOrigin("program")} data-testid={`${testId}-origin-program`}>
          Modelos do programa
        </button>
        <button type="button" className="mpick__chip" aria-pressed={viaOpenRouter} onClick={() => setOrigin("openrouter")} data-testid={`${testId}-origin-openrouter`}>
          OpenRouter
        </button>
      </div>
      {viaOpenRouter ? (
        <ModelPicker
          {...common}
          models={catalog.models}
          value={shown}
          onChoose={(id) => onChoose(`openrouter/${normalizeOpenRouterModelId(id) ?? id}`)}
          readAt={catalog.readAt}
          onRefresh={() => void catalog.refresh()}
          refreshing={catalog.refreshing}
          loading={catalog.loading}
          loadError={catalog.error}
          placeholder="Modelo do OpenRouter: buscar ou colar um id…"
        />
      ) : (
        <>
          <ModelPicker
            {...common}
            source="program"
            models={ownModels}
            value={value}
            unlisted={unlisted}
            onChoose={onChoose}
            readAt={own.readAt}
            onRefresh={() => void own.refresh()}
            refreshing={own.loading}
            loading={own.loading && ownModels.length === 0}
            loadError={own.error}
            placeholder={placeholder ?? "Buscar na lista do programa, ou digitar provedor/modelo…"}
          />
          {own.note && ownModels.length === 0 && (
            <p className="oneshot__hint" data-testid={`${testId}-program-note`}>
              {own.note}
            </p>
          )}
        </>
      )}
    </div>
  );
}
