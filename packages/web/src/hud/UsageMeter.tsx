import { useMemo, useState, type ReactNode } from "react";
import { api, describeError } from "../api/client";
import { useUsageStore } from "../store/usageStore";
import { useNow } from "../ui/ActivityFeed";
import { usageViews, type UsageView, type UsageWindowView } from "./usage";

/** Usos conhecidos da assinatura, prontos para a interface (vazio = nenhum dado ainda). */
export function useUsageViews(): UsageView[] {
  const byProvider = useUsageStore((state) => state.byProvider);
  const now = useNow();
  return useMemo(() => usageViews(byProvider, now.getTime()), [byProvider, now]);
}

/** Botão "atualizar agora": pede ao server uma nova consulta do uso da conta daquele motor. */
export function RefreshButton({ provider, label }: { provider: "claude" | "gemini"; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api.refreshUsage(provider);
      if (result.usage) useUsageStore.getState().apply({ type: "usage:updated", usage: result.usage });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className={`usage__refresh${busy ? " usage__refresh--busy" : ""}`}
        onClick={() => void refresh()}
        disabled={busy}
        aria-label={`Atualizar o uso da conta ${label} agora`}
        title={error || "Atualizar agora"}
        data-testid="usage-refresh"
        data-provider={provider}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {error && (
        <span className="usage__error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

function WindowRow({ view, window }: { view: UsageView; window: UsageWindowView }) {
  const aria = `${view.providerLabel} · ${window.group ? `${window.group} · ` : ""}${window.label}`;
  return (
    <li
      className={`usage__window usage__window--${window.tone}${window.old ? " usage__window--old" : ""}${window.renewed ? " usage__window--renewed" : ""}`}
      data-window={window.id}
      data-old={window.old || undefined}
      data-renewed={window.renewed || undefined}
    >
      <span className="usage__label">{window.label}</span>
      {window.percent === null ? (
        <span className="usage__bar usage__bar--empty" role="img" aria-label={`${aria}: ${window.text}`} />
      ) : (
        <span className="usage__bar" role="meter" aria-label={aria} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.percent}>
          <span className="usage__fill" style={{ width: `${window.percent}%` }} />
        </span>
      )}
      <span className="usage__pct ui-tabular" data-testid="usage-pct">
        {window.percent === null ? (window.renewed ? "↻ renovada" : "–") : `${window.percent}%`}
      </span>
      {window.renewed && <span className="usage__reset">a janela renovou depois da última leitura; o uso de agora é desconhecido</span>}
      {!window.renewed && window.resetLabel && <span className="usage__reset">{window.resetLabel}</span>}
    </li>
  );
}

/**
 * Uma seção por motor: nome com o selo da cor dele (Claude laranja, Antigravity azul), "atualizado
 * há…", recarregar e as janelas — agrupadas por grupo de modelos quando a fonte separa (o
 * Antigravity divide a cota entre Modelos Gemini, Claude e GPT e Gemini 4 Argon).
 */
function ProviderUsage({ view }: { view: UsageView }) {
  const grouped = view.groups.length > 1 || view.groups.some((group) => group.group !== "");
  return (
    <div className={`usage__block usage__block--${view.tone} usage__block--${view.provider}`} data-provider={view.provider} data-testid="usage-provider">
      <div className="usage__head">
        <span className="usage__provider">
          <span className="usage__badge" aria-hidden="true" />
          {view.providerLabel}
        </span>
        {view.updatedLabel && (
          <span className={`usage__updated${view.old ? " usage__updated--old" : ""}`} data-testid="usage-updated">
            {view.updatedLabel}
          </span>
        )}
        {view.account && (view.provider === "claude" || view.provider === "gemini") && <RefreshButton provider={view.provider} label={view.providerLabel} />}
      </div>
      {view.old && (
        <p className="usage__stale usage__stale--old" data-testid="usage-old">
          <span aria-hidden="true">⏱</span> Leitura antiga ({view.updatedLabel.replace("atualizado ", "")}): os números podem não refletir o uso de agora.
        </p>
      )}
      {view.stale && (
        <p className="usage__stale" data-testid="usage-stale">
          <span aria-hidden="true">⚠</span> {view.stale}
          {view.windows.length > 0 && <span className="usage__stale-note"> · mostrando o último valor</span>}
        </p>
      )}
      {view.windows.length > 0 &&
        (grouped ? (
          view.groups.map((group) => (
            <div key={group.group} className="usage__group" data-group={group.group}>
              {group.group && <h4 className="usage__group-name">{group.group}</h4>}
              <ul className="usage__windows">
                {group.windows.map((window) => (
                  <WindowRow key={window.id} view={view} window={window} />
                ))}
              </ul>
            </div>
          ))
        ) : (
          <ul className="usage__windows">
            {view.windows.map((window) => (
              <WindowRow key={window.id} view={view} window={window} />
            ))}
          </ul>
        ))}
    </div>
  );
}

/** Seção de um motor sem dado de cota (ex.: Antigravity com a consulta desligada): só o aviso. */
export function ProviderUsagePlaceholder({ provider, label, note }: { provider: string; label: string; note: string }) {
  return (
    <div className={`usage__block usage__block--${provider}`} data-provider={provider} data-testid="usage-provider">
      <div className="usage__head">
        <span className="usage__provider">
          <span className="usage__badge" aria-hidden="true" />
          {label}
        </span>
      </div>
      <p className="usage__note">{note}</p>
    </div>
  );
}

/**
 * Limites da assinatura, no detalhe do anel de uso: por provedor, cada janela (Sessão 5h, Semana,
 * Semana · Opus…) com barra, porcentagem, quando renova e cor pela gravidade; "atualizado há X min",
 * botão de atualizar (uso da conta Claude) e aviso discreto quando a consulta está falhando.
 */
export function UsageMeter({ views, children }: { views: UsageView[]; children?: ReactNode }) {
  if (views.length === 0 && !children) return null;
  return (
    <section className="usage" aria-label="Limites da assinatura" data-testid="usage-meter">
      {views.map((view) => (
        <ProviderUsage key={view.provider} view={view} />
      ))}
      {children}
    </section>
  );
}
