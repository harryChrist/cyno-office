import { isOneShotEngineId, isSupportedEngineId, type EngineInfo, type EngineStatus, type EngineTestResult, type ModelDefaults, type SupportedEngineId } from "@cyno/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError } from "../../api/client";
import { copyText } from "../../ui/clipboard";
import { loadEngines } from "../../ui/EngineFields";
import { ErrorText } from "../../ui/widgets";
import {
  canUseAsDefault,
  DEFAULT_TARGET_LABELS,
  defaultTargetsFor,
  defaultsWithEngine,
  engineDefaultFor,
  enginePathLine,
  engineStateBadge,
  engineTestLine,
  engineVersionLine,
  loginInstruction,
  type DefaultTarget,
} from "./enginesView";
import { engineSummary, engineToOpenFirst, type EngineSummary } from "./enginesSummary";
import { FreebuffSection, freebuffTestWarning } from "./FreebuffSection";
import { settingsLayout } from "./settingsLayout";
import { OneShotSection } from "./OneShotSection";
import { Seal } from "./SettingsOption";
import { modelShortName } from "./settingsView";
import "./enginesPanel.css";
import "./enginesLayout.css";

export type EngineCardProps = {
  engine: EngineStatus;
  defaults: ModelDefaults | null;
  now: number;
  /** Teste em andamento deste motor. */
  testing: boolean;
  /** Algum teste rodando (um por vez no servidor). */
  anyTesting: boolean;
  testError?: string | undefined;
  configOpen: boolean;
  onTest: () => void;
  onToggleConfig: () => void;
  onUseAsDefault: (target: DefaultTarget) => void;
  onOpenModels?: (() => void) | undefined;
  /** Conteúdo do "Configurar" (o formulário do caminho), já montado por quem usa. */
  config?: React.ReactNode;
  /** Conteúdo próprio do motor, sempre à vista (o Freebuff: modelo da plataforma, horas, confirmação do teste). */
  extra?: React.ReactNode;
  defaultsMessage?: string | undefined;
};

/** Um motor: nome, estado, versão e caminho, último teste, entrar na conta e os botões. */
export function EngineCard({ engine, defaults, now, testing, anyTesting, testError, configOpen, onTest, onToggleConfig, onUseAsDefault, onOpenModels, config, extra, defaultsMessage }: EngineCardProps) {
  const badge = engineStateBadge(engine, now);
  const pathLine = enginePathLine(engine);
  const lastTest = engine.lastTest ? engineTestLine(engine.lastTest, now) : null;
  const login = loginInstruction(engine);
  const asDefault = canUseAsDefault(engine);
  const oneShot = isOneShotEngineId(engine.id);
  const current = engine.supported && (isSupportedEngineId(engine.id) || engine.id === "freebuff" || oneShot) ? engineDefaultFor(defaults, engine.id as SupportedEngineId | "freebuff" | "openclaw" | "hermes") : [];
  const targets = defaultTargetsFor(engine);
  return (
    <div className="settings__card engine-card" data-testid={`settings-engine-${engine.id}`} data-state={engine.state} data-supported={engine.supported}>
      <header className="engine-card__head">
        <h4 className="settings__card-title">{engine.label}</h4>
        <span className={`ui-badge ui-badge--${badge.tone}`} data-testid="settings-state">
          {badge.label}
        </span>
        <Seal kind="plataforma" />
      </header>
      <p className="engine-card__blurb">{engine.blurb}</p>
      <p className={`engine-card__version${engine.state === "not_installed" ? " engine-card__version--off" : ""}`} data-testid="engine-version">
        {engineVersionLine(engine)}
      </p>
      {pathLine && (
        <p className="engine-card__path" data-testid="engine-path">
          {pathLine}
        </p>
      )}
      {engine.notice && !engine.supported && (
        <p className="engine-card__soon" data-testid="engine-notice">
          {engine.notice}
        </p>
      )}
      {engine.state === "no_login" && login && (
        <p className="engine-card__warn" data-testid="engine-login-needed">
          Sem login. Rode <code>{login}</code> no seu terminal.
        </p>
      )}
      {lastTest && (
        <p className={`engine-card__test engine-card__test--${lastTest.ok ? "ok" : "bad"}`} data-testid="engine-last-test">
          {lastTest.text}
        </p>
      )}
      {testError && (
        <p className="engine-card__test engine-card__test--bad" role="alert" data-testid="engine-test-error">
          {testError}
        </p>
      )}
      {extra}
      {engine.supported && current.length > 0 && (
        <p className="engine-card__defaults" data-testid="engine-defaults">
          Padrão para: {current.map((target) => DEFAULT_TARGET_LABELS[target]).join(", ")}
        </p>
      )}
      {engine.supported && (
        <div className="engine-card__actions">
          {!oneShot && (
          <button
            type="button"
            className="ui-button ui-button--secondary ui-button--small"
            onClick={onTest}
            disabled={testing || anyTesting || engine.state === "not_installed"}
            aria-busy={testing}
            title={
              engine.state === "not_installed"
                ? "Instale o motor primeiro."
                : engine.freebuff
                  ? `${freebuffTestWarning(engine.freebuff)} Pede a sua confirmação antes.`
                  : "Um pedido mínimo ao motor (gasta poucos mil tokens da assinatura)."
            }
            data-testid="engine-test"
          >
            {testing ? "Testando…" : "Testar"}
          </button>
          )}
          <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={onToggleConfig} aria-expanded={configOpen} data-testid="engine-configure">
            Configurar
          </button>
        </div>
      )}
      {engine.supported && (
        <div className="engine-card__default-row" role="group" aria-label={`Usar ${engine.label} como padrão`}>
          <span className="engine-card__default-label">{engine.id === "freebuff" || oneShot ? "Usar como padrão (sem subagentes) para" : "Usar como padrão para"}</span>
          {targets.map((target) => (
            <button
              key={target}
              type="button"
              className="ui-button ui-button--secondary ui-button--small"
              onClick={() => onUseAsDefault(target)}
              disabled={!asDefault.ok || !defaults || current.includes(target)}
              title={asDefault.reason ?? (current.includes(target) ? "Já é o padrão." : undefined)}
              data-testid={`engine-default-${target}`}
            >
              {DEFAULT_TARGET_LABELS[target]}
            </button>
          ))}
        </div>
      )}
      {defaultsMessage && (
        <p className="engine-card__saved" role="status" data-testid="engine-defaults-saved">
          {defaultsMessage}
        </p>
      )}
      {configOpen && engine.supported && (
        <div className="engine-config" data-testid="engine-config">
          {config}
          <p className="engine-config__row" data-testid="engine-config-models">
            <span className="engine-config__label">Modelo e esforço padrão</span>
            <span>
              {defaults ? `Agentes: ${modelShortName(defaults.agentes)} · Maestro: ${modelShortName(defaults.maestro)}` : "…"}
              {onOpenModels && (
                <>
                  {" "}
                  <button type="button" className="ui-link" onClick={onOpenModels} data-testid="engine-open-models">
                    Editar em Modelos padrão
                  </button>
                </>
              )}
            </span>
          </p>
          {login && (
            <p className="engine-config__row" data-testid="engine-config-login">
              <span className="engine-config__label">Como entrar</span>
              <span>
                Rode <code>{login}</code> no seu terminal. O Cyno nunca toca na sua senha.{" "}
                <button type="button" className="ui-link" onClick={() => void copyText(login)} data-testid="engine-copy-login">
                  Copiar comando
                </button>
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const ICON_LABEL: Record<EngineSummary["icon"], string> = { "✓": "funcionando", "!": "precisa de atenção", "✕": "com problema", "●": "instalado", "○": "não instalado" };

/**
 * Uma linha do resumo dos motores: nome, estado (cor e símbolo), conta, modelo, padrão de quem e gasto ou horas.
 * É um botão: clicar abre (ou fecha) o detalhe do motor, que fica logo abaixo ou, em tela larga, ao lado da lista.
 */
function EngineSummaryRow({ summary, open, onToggle }: { summary: EngineSummary; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={`engine-row engine-row--${summary.tone}`} aria-expanded={open} aria-controls={`engine-detail-${summary.id}`} onClick={onToggle} data-testid={`engine-row-${summary.id}`}>
      <span className="engine-row__head">
        <span className="engine-row__icon" aria-hidden="true">
          {summary.icon}
        </span>
        <span className="engine-row__name">{summary.label}</span>
        <span className={`ui-badge ui-badge--${summary.tone} engine-row__state`}>
          <span className="sr-only">{ICON_LABEL[summary.icon]}: </span>
          {summary.stateLabel}
        </span>
        <span className="engine-row__chevron" aria-hidden="true" />
      </span>
      <span className="engine-row__facts">
        <span className="engine-row__fact">
          <span className="engine-row__key">Conta</span> {summary.account}
        </span>
        <span className="engine-row__fact">
          <span className="engine-row__key">Modelo</span> {summary.model}
        </span>
        <span className="engine-row__fact">
          <span className="engine-row__key">Padrão</span> {summary.usedFor.length > 0 ? summary.usedFor.map((target) => DEFAULT_TARGET_LABELS[target]).join(", ") : "nenhum papel"}
        </span>
        {summary.extra && <span className="engine-row__fact engine-row__fact--extra">{summary.extra}</span>}
      </span>
    </button>
  );
}

/** O formulário do caminho do executável: o valor em uso, de onde vem, o campo e Salvar / Voltar ao padrão. */
function PathForm({ engine, onSaved }: { engine: EngineStatus; onSaved: (engines: EngineStatus[]) => void }) {
  const [value, setValue] = useState(engine.configuredPath ?? "");
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const save = async (next: string | null) => {
    setState({ busy: true, error: null });
    try {
      const response = await api.setEnginePath(engine.id, next);
      onSaved(response.engines);
      if (next === null) setValue("");
      setState({ busy: false, error: null });
    } catch (error) {
      setState({ busy: false, error: describeError(error) });
    }
  };
  return (
    <form
      className="engine-config__row engine-config__path"
      onSubmit={(event) => {
        event.preventDefault();
        void save(value.trim() || null);
      }}
    >
      <label className="engine-config__label" htmlFor={`engine-path-${engine.id}`}>
        Caminho do executável
      </label>
      <span className="engine-config__field">
        <input
          id={`engine-path-${engine.id}`}
          className="ui-input"
          value={value}
          placeholder={engine.path ?? (engine.id === "claude" ? "claude" : engine.id === "gemini" ? "agy" : engine.id)}
          maxLength={500}
          onChange={(event) => setValue(event.currentTarget.value)}
          data-testid="engine-path-input"
        />
        <button type="submit" className="ui-button ui-button--secondary ui-button--small" disabled={state.busy} data-testid="engine-path-save">
          {state.busy ? "Salvando…" : "Salvar"}
        </button>
        {engine.configuredPath !== undefined && (
          <button type="button" className="ui-button ui-button--ghost ui-button--small" disabled={state.busy} onClick={() => void save(null)} data-testid="engine-path-reset">
            Voltar ao padrão
          </button>
        )}
      </span>
      <span className="engine-config__hint">
        Em uso: {engine.path ?? "nenhum"}
        {engine.pathSource ? ` (${engine.pathSource === "config" ? "escolhido aqui" : engine.pathSource === "env" ? "variável de ambiente" : "PATH"})` : ""}. Vale a partir da próxima subida dos agentes.
      </span>
      <ErrorText testId="engine-path-error">{state.error}</ErrorText>
    </form>
  );
}

/**
 * Seção "Motores": todos os motores que o Cyno conhece, com o estado detectado por código. Claude Code e
 * Antigravity têm Testar (um pedido mínimo), Configurar (caminho do executável; o modelo e o esforço
 * padrão são os de Modelos padrão) e Usar como padrão; Freebuff, OpenClaw e Hermes têm o passo a passo próprio (horas, conta, modelo, Verificar).
 */
export function EnginesPanel({ onLoaded, onOpenModels }: { onLoaded?: (engines: EngineInfo[]) => void; onOpenModels?: () => void }) {
  const [engines, setEngines] = useState<EngineStatus[] | null>(null);
  const [defaults, setDefaults] = useState<ModelDefaults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [testing, setTesting] = useState<string | null>(null);
  const [confirmingFreebuff, setConfirmingFreebuff] = useState(false);
  const [testErrors, setTestErrors] = useState<Partial<Record<string, string>>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [messages, setMessages] = useState<Partial<Record<string, string>>>({});
  const [now, setNow] = useState(() => Date.now());
  // Qual motor está com o detalhe aberto (um por vez). Em tela larga abre sozinho o que pede atenção; no celular, nenhum.
  const [selected, setSelected] = useState<string | null>(null);
  const autoOpened = useRef(false);
  const alive = useRef(true);

  const fetchAll = useCallback((refresh: boolean) => {
    // O resumo do topo das Configurações usa a detecção antiga (EngineInfo): ela também é atualizada.
    void loadEngines(refresh).then(
      (list) => alive.current && onLoaded?.(list),
      () => undefined,
    );
    api.getEngineStatus().then(
      (response) => {
        if (!alive.current) return;
        setEngines(response.engines);
        setNow(Date.now());
        setError(null);
        setBusy(false);
      },
      (failure: unknown) => {
        if (!alive.current) return;
        setError(describeError(failure));
        setBusy(false);
      },
    );
    // O aviso ao resumo do topo não deve refazer a detecção.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    alive.current = true;
    fetchAll(false);
    api.getModelDefaults().then(
      (response) => alive.current && setDefaults(response.defaults),
      () => undefined,
    );
    return () => {
      alive.current = false;
    };
  }, [fetchAll]);

  useEffect(() => {
    if (autoOpened.current || engines === null || defaults === null) return;
    autoOpened.current = true;
    if (settingsLayout(window.innerWidth).split) setSelected(engineToOpenFirst(engines, defaults, Date.now()));
  }, [engines, defaults]);

  const refresh = () => {
    setBusy(true);
    setError(null);
    fetchAll(true);
  };

  const test = async (id: string) => {
    setTesting(id);
    setTestErrors((current) => ({ ...current, [id]: undefined }));
    try {
      // O Freebuff só testa depois da confirmação (o teste abre uma hora e gasta horas do dia).
      const { result } = id === "freebuff" ? await api.testFreebuff() : await api.testEngine(id);
      applyTest(id, result);
      if (id === "freebuff") void api.getEngineStatus().then((response) => alive.current && setEngines(response.engines), () => undefined);
    } catch (failure) {
      setTestErrors((current) => ({ ...current, [id]: describeError(failure) }));
    } finally {
      setTesting(null);
      setConfirmingFreebuff(false);
    }
  };
  const applyTest = (id: string, result: EngineTestResult) => {
    setNow(Date.now());
    setEngines((current) => current?.map((engine) => (engine.id === id ? { ...engine, lastTest: result, state: result.ok && engine.state === "installed" ? "working" : engine.state } : engine)) ?? current);
  };

  const applyAsDefault = async (engine: EngineStatus, target: DefaultTarget) => {
    if (!defaults || !(isSupportedEngineId(engine.id) || engine.id === "freebuff" || isOneShotEngineId(engine.id))) return;
    try {
      const saved = await api.updateModelDefaults(defaultsWithEngine(defaults, engine.id as SupportedEngineId | "freebuff" | "openclaw" | "hermes", target, engine.choices));
      setDefaults(saved.defaults);
      setMessages((current) => ({ ...current, [engine.id]: `${engine.label} agora é o padrão para ${DEFAULT_TARGET_LABELS[target]} (vale para o que nascer depois).` }));
    } catch (failure) {
      setMessages((current) => ({ ...current, [engine.id]: describeError(failure) }));
    }
  };

  return (
    <div className="settings__groups">
      <div className="settings__toolbar">
        <p className="settings__card-hint">Veja o que está instalado, teste e escolha o padrão. Os agentes rodam nas CLIs da sua assinatura.</p>
        <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={refresh} disabled={busy} aria-busy={busy} data-testid="settings-engines-refresh">
          {busy ? "Detectando…" : "Detectar de novo"}
        </button>
      </div>
      <ErrorText testId="settings-engines-error">{error}</ErrorText>
      {engines === null ? (
        !error && (
          <p className="settings__card-hint" role="status">
            Procurando os motores instalados…
          </p>
        )
      ) : (
        <ul className="engine-list" aria-label="Motores" aria-busy={busy} data-testid="settings-engines">
          {engines.map((engine) => (
            <li key={engine.id} className="engine-item" data-open={selected === engine.id} data-state={engine.state}>
              <EngineSummaryRow summary={engineSummary(engine, defaults, now)} open={selected === engine.id} onToggle={() => setSelected((current) => (current === engine.id ? null : engine.id))} />
              {selected === engine.id && (
                <div id={`engine-detail-${engine.id}`} className="engine-item__detail" role="region" aria-label={`Detalhes de ${engine.label}`}>
            <EngineCard
              engine={engine}
              defaults={defaults}
              now={now}
              testing={testing === engine.id}
              anyTesting={testing !== null}
              testError={testErrors[engine.id]}
              configOpen={open === engine.id}
              onTest={() => (engine.id === "freebuff" ? setConfirmingFreebuff(true) : isSupportedEngineId(engine.id) && void test(engine.id))}
              onToggleConfig={() => setOpen((current) => (current === engine.id ? null : engine.id))}
              onUseAsDefault={(target) => void applyAsDefault(engine, target)}
              onOpenModels={onOpenModels}
              defaultsMessage={messages[engine.id]}
              config={isSupportedEngineId(engine.id) || isOneShotEngineId(engine.id) ? <PathForm engine={engine} onSaved={setEngines} /> : undefined}
              extra={
                isOneShotEngineId(engine.id) ? (
                  <OneShotSection engine={engine} now={now} onStatus={setEngines} />
                ) : engine.id === "freebuff" ? (
                  <FreebuffSection
                    engine={engine}
                    now={now}
                    onStatus={setEngines}
                    confirming={confirmingFreebuff}
                    testing={testing === "freebuff"}
                    onConfirmTest={() => void test("freebuff")}
                    onCancelTest={() => setConfirmingFreebuff(false)}
                  />
                ) : undefined
              }
            />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
