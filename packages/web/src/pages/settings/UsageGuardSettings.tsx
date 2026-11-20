import { USAGE_GUARD_PATH, USAGE_GUARD_RELEASE_PATH, USAGE_GUARD_RULE_PATH, type UsageGuardResponse, type UsageGuardRuleBody, type UsageGuardRuleView } from "@cyno/shared";
import { useCallback, useEffect, useState } from "react";
import { describeError, requestJson } from "../../api/client";
import { ErrorText } from "../../ui/widgets";
import { OptionHead, StateBadge } from "./SettingsOption";
import { groupGuardRules, guardRowState, parseGuardPercent } from "./usageGuardView";
import "./usageGuardSettings.css";

const REFRESH_MS = 30_000;

/**
 * Pausa por limite de uso do plano: uma linha por motor e janela (chave, percentual, estado, "volta às HH:MM"
 * e "Liberar"). Componente autocontido: busca e grava sozinho pela API (`/api/usage-guard`). Ao bater o percentual
 * o motor pausa (a tarefa termina o passo, nada novo começa) e volta sozinho quando a janela reinicia.
 */
export function UsageGuardSettings({ now = Date.now, onPauses }: { now?: () => number; /** Quantas pausas estão valendo (o índice das Configurações mostra). */ onPauses?: (count: number) => void }) {
  const [view, setView] = useState<UsageGuardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await requestJson<UsageGuardResponse>(USAGE_GUARD_PATH));
      setError(null);
    } catch (failure) {
      setError(describeError(failure));
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  const send = async (key: string, path: string, init: { method: "PATCH" | "POST"; body: unknown }) => {
    setBusy(key);
    setError(null);
    try {
      setView(await requestJson<UsageGuardResponse>(path, init));
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(null);
    }
  };
  const patch = (body: UsageGuardRuleBody) => send(body.key, USAGE_GUARD_RULE_PATH, { method: "PATCH", body });
  const release = (key: string) => send(key, USAGE_GUARD_RELEASE_PATH, { method: "POST", body: { key } });

  const groups = view ? groupGuardRules(view) : [];
  const pausedCount = view?.rules.filter((rule) => rule.paused).length ?? 0;
  const loaded = view !== null;
  useEffect(() => {
    if (loaded) onPauses?.(pausedCount);
  }, [loaded, pausedCount, onPauses]);
  const nowMs = now();

  return (
    <section className="ugs" data-testid="usage-guard-settings" aria-label="Pausa por limite de uso do plano">
      <OptionHead
        title="Pausar ao chegar no limite do plano"
        line="Vem desligado. Ligue a janela que quiser: ao bater o percentual, os agentes do motor terminam o passo e nada novo começa, até a janela reiniciar."
        seal="plataforma"
        state={pausedCount > 0 ? <StateBadge tone="warn">{pausedCount === 1 ? "1 pausa" : `${pausedCount} pausas`}</StateBadge> : <StateBadge tone="off">Nenhuma pausa</StateBadge>}
      />
      <ErrorText>{error}</ErrorText>
      {!view && !error && <p className="ugs__hint">Carregando…</p>}
      {view && groups.length === 0 && <p className="ugs__hint">Nenhum motor informou o uso do plano ainda.</p>}
      {groups.map((group) => (
        <div key={group.engine} className="ugs__group" data-engine={group.engine}>
          <h5 className="ugs__engine">{group.engineLabel}</h5>
          <ul className="ugs__rows">
            {group.rules.map((rule) => (
              <Row key={rule.key} rule={rule} now={nowMs} busy={busy === rule.key} onPatch={patch} onRelease={release} />
            ))}
          </ul>
        </div>
      ))}
      {view?.freebuff && (
        <p className="ugs__hint" data-testid="usage-guard-wallet">
          {view.freebuff.usingWallet ? "A cota do dia do Freebuff acabou: ele está gastando da carteira" : "A cota do dia do Freebuff ainda não acabou"}
          {view.freebuff.wallet !== undefined ? ` · carteira: ${view.freebuff.wallet} h` : ""}
        </p>
      )}
      {view && view.unsupported.length > 0 && (
        <p className="ugs__hint" data-testid="usage-guard-unsupported">
          Fora da pausa por não terem dado confiável do plano: {view.unsupported.map((item) => `${item.engineLabel} (${item.reason})`).join("; ")}.
        </p>
      )}
    </section>
  );
}

function Row({ rule, now, busy, onPatch, onRelease }: { rule: UsageGuardRuleView; now: number; busy: boolean; onPatch: (body: UsageGuardRuleBody) => Promise<void>; onRelease: (key: string) => Promise<void> }) {
  // `null`: não está digitando, vale o percentual da regra.
  const [typed, setTyped] = useState<string | null>(null);
  const draft = typed ?? String(rule.percent);
  const state = guardRowState(rule, now);
  const commit = () => {
    const percent = parseGuardPercent(draft);
    setTyped(null);
    if (percent !== undefined && percent !== rule.percent) void onPatch({ key: rule.key, percent });
  };
  const wallet = rule.kind === "no_wallet";
  return (
    <li className="ugs__row" data-testid="usage-guard-row" data-key={rule.key} data-paused={rule.paused}>
      <label className="ui-switch ugs__switch">
        <input type="checkbox" role="switch" checked={rule.enabled} disabled={busy} onChange={(event) => void onPatch({ key: rule.key, enabled: event.target.checked })} aria-label={`${rule.engineLabel}: ${rule.label}`} />
        <span className="ui-switch__track" aria-hidden="true">
          <span className="ui-switch__knob" />
        </span>
        <span className="ugs__label">{wallet ? "Parar quando a cota do dia acabar (não gastar a carteira)" : rule.label}</span>
      </label>
      {wallet ? (
        <span className="ugs__percent ugs__percent--fixed">100%</span>
      ) : (
        <label className="ugs__percent">
          <input
            type="text"
            inputMode="numeric"
            value={draft}
            disabled={busy || !rule.enabled}
            aria-label={`Percentual de pausa: ${rule.engineLabel}, ${rule.label}`}
            onChange={(event) => setTyped(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
          />
          <span aria-hidden="true">%</span>
        </label>
      )}
      <span className={`ugs__state ugs__state--${state.tone}`} data-testid="usage-guard-state">
        {state.text}
      </span>
      {rule.paused ? (
        <button type="button" className="ugs__release" disabled={busy} onClick={() => void onRelease(rule.key)}>
          Liberar
        </button>
      ) : (
        <span />
      )}
    </li>
  );
}
