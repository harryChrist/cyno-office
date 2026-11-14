import { AGENT_EFFORTS, EFFORT_LABELS, ENGINE_LABELS, engineRoleNote, FENCE_ACTIVE_SHORT, FILE_REACH_WARNING, type OneShotEngineId, type AgentEffort, type AgentEngine, type EngineInfo, type EngineRole, type EnginesResponse } from "@cyno/shared";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { AccountModelPicker } from "./AccountModelPicker";
import { useEngineAccount } from "./useEngineAccount";
import { Field } from "./widgets";

/** Motores do server, pedidos uma vez por página (a detecção das CLIs é cara). */
let enginesRequest: Promise<EnginesResponse> | undefined;

function loadEnginesResponse(refresh = false): Promise<EnginesResponse> {
  if (refresh) enginesRequest = undefined;
  enginesRequest ??= api.listEngines(refresh).catch((error: unknown) => {
    enginesRequest = undefined;
    throw error;
  });
  return enginesRequest;
}

/** A lista guardada (ou a primeira busca); `refresh` pede ao server para detectar as CLIs de novo (e troca a guardada). */
export function loadEngines(refresh = false): Promise<EngineInfo[]> {
  return loadEnginesResponse(refresh).then((response) => response.engines);
}

/**
 * O servidor está com o modo simulado ligado (AGENT_RUNNER=mock, só testes)? Só então a UI mostra
 * o motor "Simulado" e as dicas dos marcadores [aprovar]/[falhar]/[plano]. Falso enquanto carrega.
 */
export function useSimulated(): boolean {
  const [simulated, setSimulated] = useState(false);
  useEffect(() => {
    let alive = true;
    loadEnginesResponse().then(
      (response) => {
        if (alive) setSimulated(response.simulated === true);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  return simulated;
}

/** Só para os testes: esquece a lista guardada. */
export function resetEnginesCache(): void {
  enginesRequest = undefined;
}

/** Lista de motores (undefined enquanto carrega; [] se o server não respondeu). */
export function useEngines(): EngineInfo[] | undefined {
  const [engines, setEngines] = useState<EngineInfo[] | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    loadEngines().then(
      (list) => {
        if (alive) setEngines(list);
      },
      () => {
        if (alive) setEngines([]);
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  return engines;
}

/** A versão curta para o seletor; "0.0.0" é o que o programa diz quando não leu a versão: não mostra. */
export function shownVersion(version: string | undefined): string {
  const short = version?.trim().split(" ")[0] ?? "";
  return /^0(\.0)*$/.test(short) ? "" : short;
}

/**
 * Opções do seletor de motor: o simulado e as CLIs instaladas; o motor atual sempre aparece (com
 * "não instalado" se a CLI sumiu), para o seletor não mentir.
 */
export function engineOptions(engines: readonly EngineInfo[] | undefined, current: AgentEngine, simulated = true): { engine: AgentEngine; label: string; disabled: boolean }[] {
  const mock: EngineInfo = { engine: "mock", label: ENGINE_LABELS.mock, available: true, models: [], freeModel: false };
  const list = engines && engines.length > 0 ? engines : simulated ? [mock] : [];
  const options = list
    .filter((info) => info.available || info.engine === current)
    .map((info) => ({
      engine: info.engine,
      label: `${info.label}${shownVersion(info.version) ? ` · ${shownVersion(info.version)}` : ""}${info.available ? "" : " (não instalado)"}`,
      disabled: !info.available && info.engine !== current,
    }));
  // Agente antigo gravado com o motor simulado, com o modo simulado desligado: "Sem motor" (escolha outro).
  const currentLabel = current === "mock" && !simulated ? "Sem motor (escolha um)" : ENGINE_LABELS[current];
  if (!options.some((option) => option.engine === current)) options.push({ engine: current, label: currentLabel, disabled: false });
  return options;
}

export type EngineValues = { engine: AgentEngine; model: string; effort: AgentEffort | "" };

/** Rótulo de um esforço no seletor ("médio (medium)"). */
export const effortOptionLabel = (effort: AgentEffort) => `${EFFORT_LABELS[effort]} (${effort})`;

/**
 * "Motor" (Simulado / Claude Code / Antigravity, só as CLIs instaladas no server), "Modelo"
 * (Antigravity: a lista de `agy models`; Claude Code: texto livre com sugestões; vazio = o padrão
 * da CLI) e "Esforço" (vazio = o padrão). Trocar o motor limpa o modelo (cada CLI tem os seus).
 * `testIdPrefix`: prefixo dos data-testid (padrão "agent-edit"), para mais de um conjunto na tela.
 */
/** OpenClaw e Hermes: o modelo do agente sai do mesmo seletor de Configurações › Motores (a lista do OpenRouter com a chave do painel; com a configuração do programa, a lista dele e a digitação livre provedor/modelo). Vazio = o padrão de lá. */
function OneShotModelField({ engine, value, onChange, testId, inputProps }: { engine: "openclaw" | "hermes"; value: string; onChange: (model: string) => void; testId: string; inputProps: { id?: string; "aria-describedby"?: string } }) {
  const account = useEngineAccount(engine);
  return (
    <AccountModelPicker
      engine={engine}
      account={account}
      version={`${account?.mode}-${account?.location}`}
      testId={testId}
      value={value}
      onChoose={onChange}
      onClear={() => onChange("")}
      placeholder={value ? undefined : "Padrão de Motores — buscar para trocar, ou colar um id…"}
      {...(inputProps.id ? { inputId: inputProps.id } : {})}
      {...(inputProps["aria-describedby"] ? { describedBy: inputProps["aria-describedby"] } : {})}
    />
  );
}

export function EngineFields({
  values,
  onChange,
  locked,
  testIdPrefix = "agent-edit",
  showEffort = true,
  role = "agent",
}: {
  values: EngineValues;
  onChange: (values: EngineValues) => void;
  locked: boolean;
  testIdPrefix?: string;
  showEffort?: boolean;
  /** O papel que roda neste motor: o seletor mostra em uma linha o que muda nele (nada é proibido). */
  role?: EngineRole;
}) {
  const engines = useEngines();
  const info = engines?.find((candidate) => candidate.engine === values.engine);
  const simulated = useSimulated();
  const options = engineOptions(engines, values.engine, simulated);
  const roleNote = engineRoleNote(values.engine, role);
  const platformModel = values.engine === "freebuff";
  const isCli = values.engine !== "mock";
  const oneShot = values.engine === "openclaw" || values.engine === "hermes";
  // Com a cerca de arquivos valendo, a frase da cerca; sem ela, o aviso de que o agente alcança arquivos fora da pasta.
  const fenced = info?.fenced === true && (values.engine === "hermes" || values.engine === "openclaw");
  const reachWarning = fenced ? FENCE_ACTIVE_SHORT : FILE_REACH_WARNING[values.engine as OneShotEngineId];
  const models = info?.models ?? [];
  const freeModel = info ? info.freeModel || models.length === 0 : true;
  const listId = `engine-models-${values.engine}`;

  return (
    <>
      <Field
        label="Motor"
        hint={
          <>
            {locked ? (
            "Espere as tarefas ativas terminarem para trocar o motor."
          ) : isCli ? (
            roleNote ? (
              <span data-testid={`${testIdPrefix}-engine-note`}>
                {roleNote}
                {oneShot ? " A conta é a de Configurações › Motores (chave do OpenRouter ou a configuração do próprio programa)." : ""}
              </span>
            ) : (
              "Roda na CLI da sua assinatura, em segundo plano."
            )
          ) : simulated ? (
            "Agente simulado (não gasta nada)."
          ) : (
            "Este agente está sem motor: escolha um para ele trabalhar."
          )}
            {reachWarning && (
              <span className={`engine-fields__warning${fenced ? " engine-fields__warning--ok" : ""}`} role="note" data-testid={`${testIdPrefix}-file-reach-warning`}>
                {reachWarning}
              </span>
            )}
          </>
        }
      >
        {(props) => (
          <select
            {...props}
            className="ui-input"
            value={values.engine}
            disabled={locked || engines === undefined}
            onChange={(e) => onChange({ ...values, engine: e.currentTarget.value as AgentEngine, model: "" })}
            data-testid={`${testIdPrefix}-engine`}
          >
            {options.map((option) => (
              <option key={option.engine} value={option.engine} disabled={option.disabled}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      {platformModel && (
        <Field label="Modelo" hint="O Freebuff usa um modelo só para todos os agentes (e cobra por hora aberta): escolha em Configurações › Motores.">
          {(props) => <input {...props} className="ui-input" value="Modelo da plataforma" readOnly disabled data-testid={`${testIdPrefix}-model`} />}
        </Field>
      )}
      {isCli && !platformModel && (
        <Field label="Modelo" hint={oneShot ? "Busque na lista ou digite o modelo (provedor/modelo). Vazio = o modelo padrão escolhido em Configurações › Motores." : "Vazio = o padrão da CLI."}>
          {(props) =>
            oneShot ? (
              <OneShotModelField engine={values.engine as "openclaw" | "hermes"} value={values.model} onChange={(model) => onChange({ ...values, model })} testId={`${testIdPrefix}-model`} inputProps={props} />
            ) : freeModel ? (
              <>
                <input
                  {...props}
                  className="ui-input"
                  value={values.model}
                  placeholder={oneShot ? "Padrão de Motores" : "Padrão da CLI"}
                  maxLength={100}
                  list={models.length > 0 ? listId : undefined}
                  onChange={(e) => onChange({ ...values, model: e.currentTarget.value.trim() })}
                  data-testid={`${testIdPrefix}-model`}
                />
                {models.length > 0 && (
                  <datalist id={listId}>
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label ?? model.id}
                      </option>
                    ))}
                  </datalist>
                )}
              </>
            ) : (
              <select {...props} className="ui-input" value={values.model} onChange={(e) => onChange({ ...values, model: e.currentTarget.value })} data-testid={`${testIdPrefix}-model`}>
                <option value="">Padrão da CLI</option>
                {values.model && !models.some((model) => model.id === values.model) && <option value={values.model}>{values.model}</option>}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label ? `${model.label} (${model.id})` : model.id}
                  </option>
                ))}
              </select>
            )
          }
        </Field>
      )}
      {isCli && showEffort && !platformModel && (
        <Field label="Esforço" hint="Vazio = o padrão.">
          {(props) => (
            <select {...props} className="ui-input" value={values.effort} onChange={(e) => onChange({ ...values, effort: e.currentTarget.value as AgentEffort | "" })} data-testid={`${testIdPrefix}-effort`}>
              <option value="">Padrão</option>
              {AGENT_EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  {effortOptionLabel(effort)}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
    </>
  );
}
