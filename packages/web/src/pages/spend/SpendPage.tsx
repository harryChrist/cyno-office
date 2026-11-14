import { SUSPECT_REASON_LABELS, type AgentProvider, type UsageHistoryGroup, type UsageHistoryResponse, type UsageTaskHistoryResponse, type UsageTotals } from "@cyno/shared";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useNavStore } from "../../store/navStore";
import { UsageMeter, useUsageViews } from "../../hud/UsageMeter";
import { BudgetPanel } from "./BudgetPanel";
import { spendApi } from "./spendApi";
import "./spend.css";
import "./budget.css";
import {
  barLabel,
  barSegments,
  chartRange,
  chartSeries,
  costShares,
  formatMoney,
  formatPercent,
  formatRate,
  formatTokens,
  inCurrency,
  niceMax,
  parseRate,
  periodKey,
  periodRange,
  periodTitle,
  shiftPeriod,
  spendInsights,
  todayKey,
  UNIT_LABELS,
  type Currency,
  type Series,
  type SpendUnit,
} from "./spendView";

const CURRENCY_KEY = "agent-office:gastos-moeda";
const PROVIDER_LABELS: Partial<Record<AgentProvider, string>> = { claude: "Claude Code", gemini: "Antigravity" };
const STATUS_LABELS: Record<string, string> = { queued: "na fila", in_progress: "em andamento", waiting_approval: "esperando aprovação", done: "concluída", failed: "falhou" };

function readCurrency(): Currency {
  try {
    return window.localStorage.getItem(CURRENCY_KEY) === "USD" ? "USD" : "BRL";
  } catch {
    return "BRL";
  }
}

function saveCurrency(currency: Currency): void {
  try {
    window.localStorage.setItem(CURRENCY_KEY, currency);
  } catch {
    // Sem armazenamento: só não lembra a moeda.
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : "Não foi possível carregar os gastos");

/** Página "Gastos": quanto o trabalho dos agentes custaria na API, por dia/semana/mês, agente, modelo e pedido. */
export function SpendPage() {
  // Trocar de workspace recomeça a página (período e tarefas abertas eram do anterior).
  const workspaceId = useNavStore((state) => state.workspaceId);
  return (
    <section className="page page--spend" aria-labelledby="page-title-gastos" data-testid="page-gastos">
      <header className="page__header page__header--row">
        <div className="page__heading">
          <h2 id="page-title-gastos" className="page__title">
            Gastos
          </h2>
          <p className="page__subtitle">Quanto o trabalho dos agentes custaria se fosse pago por uso na API.</p>
        </div>
      </header>
      <SpendView key={workspaceId ?? ""} />
    </section>
  );
}

type PeriodData = { chart: UsageHistoryResponse; agents: UsageHistoryResponse; models: UsageHistoryResponse; tasks: UsageHistoryResponse };

function SpendView() {
  const [unit, setUnit] = useState<SpendUnit>("day");
  const [anchor, setAnchor] = useState(() => todayKey());
  const [stackBy, setStackBy] = useState<"agent" | "model">("agent");
  const [currency, setCurrency] = useState<Currency>(readCurrency);
  const [usdBrl, setUsdBrl] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  // Resultado da última consulta: enquanto a chave atual não chega, a página mostra o anterior.
  const [result, setResult] = useState<{ key: string; data?: PeriodData; error?: string } | null>(null);
  const requestKey = `${anchor}|${unit}|${stackBy}|${tick}`;
  const loading = result?.key !== requestKey;
  const data = result?.data ?? null;
  const error = result?.key === requestKey ? (result.error ?? null) : null;
  const today = todayKey();

  useEffect(() => {
    let alive = true;
    void spendApi
      .settings()
      .then((settings) => alive && setUsdBrl(settings.usdBrl))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const key = `${anchor}|${unit}|${stackBy}|${tick}`;
    const period = periodRange(anchor, unit);
    const chart = chartRange(anchor, unit);
    Promise.all([
      spendApi.history({ ...chart, groupBy: unit, stackBy }),
      spendApi.history({ ...period, groupBy: "agent" }),
      spendApi.history({ ...period, groupBy: "model" }),
      spendApi.history({ ...period, groupBy: "task" }),
    ])
      .then(([chartData, agents, models, tasks]) => {
        if (alive) setResult({ key, data: { chart: chartData, agents, models, tasks } });
      })
      .catch((reason: unknown) => {
        if (alive) setResult((current) => ({ key, ...(current?.data ? { data: current.data } : {}), error: errorText(reason) }));
      });
    return () => {
      alive = false;
    };
  }, [anchor, unit, stackBy, tick]);

  const rate = usdBrl ?? data?.agents.usdBrl ?? 0;
  const money = useCallback((usd: number) => formatMoney(inCurrency(usd, currency, rate), currency), [currency, rate]);
  const other = currency === "BRL" ? "USD" : "BRL";
  const otherMoney = useCallback((usd: number) => formatMoney(inCurrency(usd, other, rate), other), [other, rate]);

  const changeCurrency = (next: Currency) => {
    setCurrency(next);
    saveCurrency(next);
  };
  const canGoForward = periodRange(anchor, unit).to < today;
  const totals = data?.agents.overall;

  return (
    <div className="spend" aria-busy={loading}>
      <SubscriptionNote prices={data?.agents.prices} />
      <SpendQuota />
      <BudgetPanel money={money} />

      <div className="spend-controls" role="group" aria-label="Período e moeda">
        <div className="spend-switch" role="radiogroup" aria-label="Período">
          {(Object.keys(UNIT_LABELS) as SpendUnit[]).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={unit === option}
              className="spend-switch__option"
              onClick={() => setUnit(option)}
              data-testid={`spend-unit-${option}`}
            >
              {UNIT_LABELS[option]}
            </button>
          ))}
        </div>
        <div className="spend-nav">
          <button type="button" className="ui-icon-button spend-nav__step" aria-label={`${UNIT_LABELS[unit]} anterior`} onClick={() => setAnchor(shiftPeriod(anchor, unit, -1))}>
            ‹
          </button>
          <span className="spend-nav__title" aria-live="polite" data-testid="spend-period">
            {periodTitle(anchor, unit)}
          </span>
          <button
            type="button"
            className="ui-icon-button spend-nav__step"
            aria-label={`Próximo ${UNIT_LABELS[unit].toLowerCase()}`}
            disabled={!canGoForward}
            onClick={() => setAnchor(shiftPeriod(anchor, unit, 1))}
          >
            ›
          </button>
          {periodKey(anchor, unit) !== periodKey(today, unit) && (
            <button type="button" className="ui-button ui-button--small ui-button--secondary" onClick={() => setAnchor(today)}>
              Hoje
            </button>
          )}
        </div>
        <div className="spend-controls__end">
          <div className="spend-switch spend-switch--small" role="radiogroup" aria-label="Moeda">
            {(["BRL", "USD"] as const).map((option) => (
              <button key={option} type="button" role="radio" aria-checked={currency === option} className="spend-switch__option" onClick={() => changeCurrency(option)}>
                {option === "BRL" ? "R$" : "US$"}
              </button>
            ))}
          </div>
          <RateEditor rate={usdBrl} onSaved={(value) => setUsdBrl(value)} />
          <button type="button" className="ui-button ui-button--small ui-button--secondary" onClick={() => setTick((n) => n + 1)} disabled={loading}>
            Atualizar
          </button>
        </div>
      </div>

      {error && (
        <p className="spend__error" role="alert">
          {error}
        </p>
      )}

      {data && <SpendFlags flags={data.agents.flags} money={money} />}

      {totals && (
        <div className="spend-tiles" data-testid="spend-tiles">
          <div className="spend-tile spend-tile--hero">
            <span className="spend-tile__label">Custo equivalente na API</span>
            <span className="spend-tile__value ui-tabular" data-testid="spend-total">
              {money(totals.costUsd)}
            </span>
            <span className="spend-tile__sub ui-tabular">
              {otherMoney(totals.costUsd)}
              {totals.unpricedTurns > 0 && ` · ${totals.unpricedTurns} sem preço`}
            </span>
          </div>
          <div className="spend-tile">
            <span className="spend-tile__label">Tokens</span>
            <span className="spend-tile__value ui-tabular">{formatTokens(totals.totalTokens)}</span>
            <span className="spend-tile__sub ui-tabular">
              {formatTokens(totals.inputTokens + totals.cacheReadTokens + totals.cacheCreationTokens)} entrada · {formatTokens(totals.outputTokens)} saída
            </span>
          </div>
          <div className="spend-tile">
            <span className="spend-tile__label">Turnos</span>
            <span className="spend-tile__value ui-tabular">{totals.turns.toLocaleString("pt-BR")}</span>
            <span className="spend-tile__sub ui-tabular">
              {totals.turns > 0 ? `${money(totals.costUsd / Math.max(1, totals.measuredTurns))} por turno` : "nenhum turno"}
              {totals.unmeasuredTurns > 0 && ` · ${totals.unmeasuredTurns} sem medição`}
            </span>
          </div>
          <div className="spend-tile">
            <span className="spend-tile__label">Cache lido</span>
            <span className="spend-tile__value ui-tabular">{formatPercent(totals.cacheHitRatio)}</span>
            <span className="spend-tile__sub">da entrada veio do cache</span>
          </div>
        </div>
      )}

      {data && (
        <SpendChart
          data={data.chart}
          unit={unit}
          selectedKey={periodKey(anchor, unit)}
          stackBy={stackBy}
          onStackBy={setStackBy}
          money={money}
          currency={currency}
          rate={rate}
          onSelect={(day) => setAnchor(day)}
        />
      )}

      {totals && data && <WhereItGoes totals={totals} agents={data.agents.groups} models={data.models.groups} money={money} />}

      {data && (
        <div className="spend-rankings">
          <Ranking title="Por agente" groups={data.agents.groups} money={money} total={data.agents.overall.costUsd} kind="agent" />
          <Ranking title="Por modelo" groups={data.models.groups} money={money} total={data.models.overall.costUsd} kind="model" />
          <TaskRanking groups={data.tasks.groups} money={money} total={data.tasks.overall.costUsd} />
        </div>
      )}
      {!data && loading && <p className="page__empty">Carregando…</p>}
    </div>
  );
}

/**
 * Os avisos discretos do período: turnos de valor impossível (ficam fora dos totais, gravados à parte) e turnos
 * cortados (cancelados, terminal caído, limite), cujo gasto parcial entra nos totais como estimado.
 */
function SpendFlags({ flags, money }: { flags: UsageHistoryResponse["flags"]; money: (usd: number) => string }) {
  const { suspect, partial } = flags;
  if (suspect.records === 0 && partial.records === 0) return null;
  return (
    <div className="spend-flags" data-testid="spend-flags">
      {suspect.records > 0 && (
        <details className="spend-flag spend-flag--suspect" data-testid="spend-suspect">
          <summary>
            {suspect.records === 1 ? "1 turno ignorado" : `${suspect.records} turnos ignorados`} por valor impossível (fora dos totais)
          </summary>
          <p>
            {formatTokens(suspect.tokens)} tokens no total. Motivo:{" "}
            {Object.entries(suspect.reasons)
              .map(([reason, count]) => `${SUSPECT_REASON_LABELS[reason as keyof typeof SUSPECT_REASON_LABELS] ?? reason}${count > 1 ? ` (${count} turnos)` : ""}`)
              .join("; ")}
            . Ficam gravados no histórico, mas não entram nas somas nem no orçamento.
          </p>
        </details>
      )}
      {partial.records > 0 && (
        <p className="spend-flag spend-flag--partial" data-testid="spend-partial">
          Inclui {partial.records === 1 ? "1 turno cortado" : `${partial.records} turnos cortados`} no meio (cancelado, terminal parado ou queda): {formatTokens(partial.tokens)} tokens, {money(partial.costUsd)}{" "}
          <em>estimado</em>, só o que a CLI já tinha informado.
        </p>
      )}
    </div>
  );
}

/** A cota da assinatura (5 h e semana) com as mesmas regras de leitura do anel: idade à vista, leitura antiga esmaecida, janela renovada sem número. */
function SpendQuota() {
  const views = useUsageViews();
  if (views.length === 0) return null;
  return (
    <section className="spend-quota" aria-label="Cota da assinatura" data-testid="spend-quota">
      <h3 className="spend-quota__title">Cota da assinatura</h3>
      <UsageMeter views={views} />
    </section>
  );
}

/** O aviso de que é assinatura: o valor é o que custaria na API (com a fonte dos preços). */
function SubscriptionNote({ prices }: { prices?: UsageHistoryResponse["prices"] }) {
  const verified = prices ? `${prices.verifiedAt.slice(8, 10)}/${prices.verifiedAt.slice(5, 7)}/${prices.verifiedAt.slice(0, 4)}` : null;
  return (
    <aside className="spend-note" data-testid="spend-note">
      <strong className="spend-note__title">Você usa assinatura: nada disto é cobrado por token.</strong>
      <span>
        Os valores são o <em>custo equivalente na API</em>: quanto o mesmo trabalho custaria pago por uso, pelos preços oficiais de cada modelo (Anthropic e Google)
        {verified ? `, conferidos em ${verified}` : ""}. Serve para comparar e achar onde economizar, não é uma conta.
      </span>
      {prices && prices.sources.length > 0 && (
        <span className="spend-note__sources">
          Fontes:{" "}
          {prices.sources.map((source, index) => {
            const url = source.split(" ")[0]!;
            return (
              <span key={url}>
                {index > 0 && " · "}
                <a className="ui-link" href={url} target="_blank" rel="noreferrer">
                  {new URL(url).hostname}
                </a>
              </span>
            );
          })}
        </span>
      )}
    </aside>
  );
}

/** "US$ 1 = R$ [5,51]": a cotação da instalação (salva ao sair do campo ou com Enter). */
function RateEditor({ rate, onSaved }: { rate: number | null; onSaved: (rate: number) => void }) {
  const inputId = useId();
  // O que o usuário está digitando (null = mostra a cotação salva).
  const [draft, setDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  const text = draft ?? (rate !== null ? formatRate(rate) : "");

  const save = async () => {
    const value = parseRate(text);
    if (value === null) {
      setStatus({ tone: "error", text: "Cotação inválida" });
      return;
    }
    if (rate !== null && Math.abs(value - rate) < 1e-9) {
      setDraft(null);
      return;
    }
    try {
      const saved = await spendApi.setRate(value);
      onSaved(saved.usdBrl);
      setDraft(null);
      setStatus({ tone: "ok", text: "Cotação salva" });
    } catch (error) {
      setStatus({ tone: "error", text: errorText(error) });
    }
  };

  return (
    <div className="spend-rate">
      <label htmlFor={inputId} className="spend-rate__label">
        US$ 1 = R$
      </label>
      <input
        id={inputId}
        className="ui-input ui-input--compact spend-rate__input ui-tabular"
        inputMode="decimal"
        value={text}
        disabled={rate === null}
        onChange={(event) => {
          setDraft(event.target.value);
          setStatus(null);
        }}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.key === "Enter") void save();
        }}
        title="Cotação usada para converter o custo em dólar (editável; vale para toda a instalação)"
        data-testid="spend-rate"
      />
      {status && (
        <span className={`spend-rate__status spend-rate__status--${status.tone}`} role={status.tone === "error" ? "alert" : "status"}>
          {status.text}
        </span>
      )}
    </div>
  );
}

type ChartProps = {
  data: UsageHistoryResponse;
  unit: SpendUnit;
  selectedKey: string;
  stackBy: "agent" | "model";
  onStackBy: (by: "agent" | "model") => void;
  money: (usd: number) => string;
  currency: Currency;
  rate: number;
  onSelect: (day: string) => void;
};

/** Barras empilhadas (por agente ou por modelo) dos últimos períodos; o escolhido fica em destaque. */
function SpendChart({ data, unit, selectedKey, stackBy, onStackBy, money, currency, rate, onSelect }: ChartProps) {
  const series = useMemo(() => chartSeries(data.groups), [data.groups]);
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const top = niceMax(Math.max(0, ...data.groups.map((group) => inCurrency(group.totals.costUsd, currency, rate))));
  const hovered = hover !== null ? data.groups[hover] : undefined;
  const firstDay = (group: UsageHistoryGroup) => (unit === "month" ? `${group.key}-01` : group.key);

  return (
    <section className="spend-card spend-chart" aria-label="Custo ao longo do tempo" data-testid="spend-chart">
      <header className="spend-card__head">
        <h3 className="spend-card__title">Custo por {UNIT_LABELS[unit].toLowerCase()}</h3>
        <div className="spend-switch spend-switch--small" role="radiogroup" aria-label="Empilhar por">
          {(["agent", "model"] as const).map((option) => (
            <button key={option} type="button" role="radio" aria-checked={stackBy === option} className="spend-switch__option" onClick={() => onStackBy(option)}>
              por {option === "agent" ? "agente" : "modelo"}
            </button>
          ))}
        </div>
      </header>
      {series.length > 0 && (
        <ul className="spend-legend" aria-label="Legenda">
          {series.map((item) => (
            <li key={item.key} className="spend-legend__item">
              <span className={`spend-swatch spend-c${item.slot}`} aria-hidden="true" />
              {item.label}
            </li>
          ))}
        </ul>
      )}
      <div className="spend-plot" onMouseLeave={() => setHover(null)}>
        <div className="spend-plot__axis" aria-hidden="true">
          {[1, 0.5, 0].map((fraction) => (
            <span key={fraction} className="spend-plot__tick ui-tabular" style={{ bottom: `${fraction * 100}%` }}>
              {formatMoney(top * fraction, currency)}
            </span>
          ))}
        </div>
        <div className="spend-plot__area">
          <div className="spend-plot__lines" aria-hidden="true">
            {[1, 0.5].map((fraction) => (
              <span key={fraction} className="spend-plot__grid" style={{ bottom: `${fraction * 100}%` }} />
            ))}
          </div>
          <div className="spend-plot__bars">
            {data.groups.map((group, index) => {
              const segments = barSegments(group, series);
              const value = inCurrency(group.totals.costUsd, currency, rate);
              const selected = group.key === selectedKey;
              return (
                <button
                  key={group.key}
                  type="button"
                  className={`spend-bar${selected ? " spend-bar--selected" : ""}`}
                  aria-pressed={selected}
                  aria-label={`${group.label}: ${money(group.totals.costUsd)}, ${group.totals.turns} turnos`}
                  onClick={() => onSelect(firstDay(group))}
                  onMouseEnter={() => setHover(index)}
                  onFocus={() => setHover(index)}
                  onBlur={() => setHover(null)}
                >
                  <span className="spend-bar__track">
                    <span className="spend-bar__stack" style={{ height: `${top > 0 ? (value / top) * 100 : 0}%` }}>
                      {segments.map((segment) => (
                        <span
                          key={segment.key}
                          className={`spend-bar__segment spend-c${segment.slot}`}
                          style={{ flexGrow: segment.value, flexBasis: 0 }}
                        />
                      ))}
                    </span>
                  </span>
                  <span className="spend-bar__label ui-tabular">{barLabel(group.key, unit)}</span>
                </button>
              );
            })}
          </div>
          {hovered && hover !== null && (
            <div
              className="spend-tooltip"
              role="presentation"
              style={{ left: `${((hover + 0.5) / data.groups.length) * 100}%` }}
              data-flip={hover > data.groups.length / 2 ? "left" : "right"}
            >
              <strong className="spend-tooltip__title">{hovered.label}</strong>
              <span className="spend-tooltip__total ui-tabular">{money(hovered.totals.costUsd)}</span>
              {barSegments(hovered, series).map((segment) => (
                <span key={segment.key} className="spend-tooltip__row">
                  <span className={`spend-swatch spend-c${segment.slot}`} aria-hidden="true" />
                  <span className="spend-tooltip__name">{segment.label}</span>
                  <span className="ui-tabular">{money(segment.value)}</span>
                </span>
              ))}
              <span className="spend-tooltip__meta ui-tabular">
                {formatTokens(hovered.totals.totalTokens)} tokens · {hovered.totals.turns} turnos
              </span>
            </div>
          )}
        </div>
      </div>
      <button type="button" className="ui-link spend-chart__table-toggle" aria-expanded={table} onClick={() => setTable((on) => !on)}>
        {table ? "Esconder tabela" : "Ver como tabela"}
      </button>
      {table && <ChartTable groups={data.groups} series={series} money={money} />}
    </section>
  );
}

function ChartTable({ groups, series, money }: { groups: UsageHistoryGroup[]; series: Series[]; money: (usd: number) => string }) {
  return (
    <div className="spend-table-wrap">
      <table className="spend-table">
        <thead>
          <tr>
            <th scope="col">Período</th>
            {series.map((item) => (
              <th key={item.key} scope="col">
                {item.label}
              </th>
            ))}
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const values = new Map(barSegments(group, series).map((segment) => [segment.key, segment.value]));
            return (
              <tr key={group.key}>
                <th scope="row">{group.label}</th>
                {series.map((item) => (
                  <td key={item.key} className="ui-tabular">
                    {values.has(item.key) ? money(values.get(item.key)!) : "—"}
                  </td>
                ))}
                <td className="ui-tabular">{money(group.totals.costUsd)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** "O que mais pesa": o custo por tipo de token e as dicas de onde economizar. */
function WhereItGoes({ totals, agents, models, money }: { totals: UsageTotals; agents: UsageHistoryGroup[]; models: UsageHistoryGroup[]; money: (usd: number) => string }) {
  const shares = costShares(totals);
  const tips = spendInsights(totals, agents, models);
  if (shares.length === 0 && tips.length === 0) return null;
  return (
    <section className="spend-card spend-weight" aria-label="O que mais pesa" data-testid="spend-weight">
      <header className="spend-card__head">
        <h3 className="spend-card__title">O que mais pesa</h3>
      </header>
      {shares.length > 0 && (
        <ul className="spend-weight__list">
          {shares.map((share) => (
            <li key={share.key} className="spend-weight__row">
              <span className="spend-weight__name">{share.label}</span>
              <span className="spend-meter" aria-hidden="true">
                <span className="spend-meter__fill" style={{ width: `${Math.max(1, share.share * 100)}%` }} />
              </span>
              <span className="spend-weight__value ui-tabular">
                {money(share.usd)} <span className="spend-weight__pct">{formatPercent(share.share)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {tips.length > 0 && (
        <ul className="spend-tips">
          {tips.map((tip) => (
            <li key={tip} className="spend-tips__item">
              {tip}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RowMeta({ group }: { group: UsageHistoryGroup }) {
  return (
    <span className="spend-row__meta ui-tabular">
      {formatTokens(group.totals.totalTokens)} tokens · {group.totals.turns} {group.totals.turns === 1 ? "turno" : "turnos"}
      {group.totals.cacheHitRatio !== null && ` · cache ${formatPercent(group.totals.cacheHitRatio)}`}
    </span>
  );
}

function RowCost({ group, money }: { group: UsageHistoryGroup; money: (usd: number) => string }) {
  const unpriced = group.totals.unpricedTurns > 0 && group.totals.costUsd === 0;
  return <span className="spend-row__cost ui-tabular">{unpriced ? "sem preço" : money(group.totals.costUsd)}</span>;
}

/** Ranking de um período (agentes ou modelos): maior custo primeiro, com a fatia do total. */
function Ranking({ title, groups, money, total, kind }: { title: string; groups: UsageHistoryGroup[]; money: (usd: number) => string; total: number; kind: "agent" | "model" }) {
  return (
    <section className="spend-card spend-ranking" aria-label={title} data-testid={`spend-ranking-${kind}`}>
      <header className="spend-card__head">
        <h3 className="spend-card__title">{title}</h3>
      </header>
      {groups.length === 0 ? (
        <p className="spend-ranking__empty">Nenhum turno neste período.</p>
      ) : (
        <ol className="spend-ranking__list">
          {groups.map((group) => (
            <li key={group.key} className="spend-row">
              <span className="spend-row__head">
                <span className="spend-row__name">{group.label}</span>
                {group.provider && <span className={`spend-chip spend-chip--${group.provider}`}>{PROVIDER_LABELS[group.provider] ?? group.provider}</span>}
                <RowCost group={group} money={money} />
              </span>
              <span className="spend-meter" aria-hidden="true">
                <span className="spend-meter__fill" style={{ width: `${total > 0 ? Math.max(1, (group.totals.costUsd / total) * 100) : 0}%` }} />
              </span>
              <RowMeta group={group} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Pedidos mais caros do período; abrir um mostra as subtarefas, os agentes e os modelos dele. */
function TaskRanking({ groups, money, total }: { groups: UsageHistoryGroup[]; money: (usd: number) => string; total: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, UsageTaskHistoryResponse | { error: string }>>({});
  const shown = groups.slice(0, 15);

  const toggle = (key: string) => {
    const next = open === key ? null : key;
    setOpen(next);
    if (next && !details[next]) {
      spendApi
        .task(next)
        .then((detail) => setDetails((current) => ({ ...current, [next]: detail })))
        .catch((error: unknown) => setDetails((current) => ({ ...current, [next]: { error: errorText(error) } })));
    }
  };

  return (
    <section className="spend-card spend-ranking spend-ranking--tasks" aria-label="Pedidos mais caros" data-testid="spend-ranking-task">
      <header className="spend-card__head">
        <h3 className="spend-card__title">Pedidos mais caros</h3>
      </header>
      {shown.length === 0 ? (
        <p className="spend-ranking__empty">Nenhum pedido neste período.</p>
      ) : (
        <ol className="spend-ranking__list">
          {shown.map((group) => {
            const expandable = group.key !== "_sem-tarefa";
            const detail = details[group.key];
            const isOpen = open === group.key;
            return (
              <li key={group.key} className="spend-row spend-row--task">
                <button
                  type="button"
                  className="spend-row__toggle"
                  aria-expanded={expandable ? isOpen : undefined}
                  disabled={!expandable}
                  onClick={() => toggle(group.key)}
                >
                  <span className="spend-row__head">
                    {expandable && <span className={`spend-row__caret${isOpen ? " spend-row__caret--open" : ""}`} aria-hidden="true" />}
                    <span className="spend-row__name" title={group.label}>
                      {group.label}
                    </span>
                    {group.taskStatus && <span className="spend-chip">{STATUS_LABELS[group.taskStatus] ?? group.taskStatus}</span>}
                    <RowCost group={group} money={money} />
                  </span>
                  <span className="spend-meter" aria-hidden="true">
                    <span className="spend-meter__fill" style={{ width: `${total > 0 ? Math.max(1, (group.totals.costUsd / total) * 100) : 0}%` }} />
                  </span>
                  <span className="spend-row__meta ui-tabular">
                    {group.subtasks ? `${group.subtasks} ${group.subtasks === 1 ? "subtarefa" : "subtarefas"} · ` : ""}
                    {formatTokens(group.totals.totalTokens)} tokens · {group.totals.turns} {group.totals.turns === 1 ? "turno" : "turnos"}
                  </span>
                </button>
                {isOpen && (
                  <div className="spend-task-detail">
                    {!detail && <p className="spend-ranking__empty">Carregando…</p>}
                    {detail && "error" in detail && (
                      <p className="spend__error" role="alert">
                        {detail.error}
                      </p>
                    )}
                    {detail && !("error" in detail) && <TaskDetail detail={detail} money={money} />}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {groups.length > shown.length && <p className="spend-ranking__more">+ {groups.length - shown.length} pedidos menores</p>}
    </section>
  );
}

function TaskDetail({ detail, money }: { detail: UsageTaskHistoryResponse; money: (usd: number) => string }) {
  const block = (title: string, groups: UsageHistoryGroup[], self?: string) => (
    <div className="spend-task-detail__block">
      <h4 className="spend-task-detail__title">{title}</h4>
      <ul className="spend-task-detail__list">
        {groups.map((group) => (
          <li key={group.key} className="spend-task-detail__row">
            <span className="spend-task-detail__name" title={group.label}>
              {group.key === self ? "Coordenação do pedido" : group.label}
            </span>
            <span className="spend-task-detail__meta ui-tabular">
              {formatTokens(group.totals.totalTokens)} · {group.totals.turns}t
            </span>
            <RowCost group={group} money={money} />
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <>
      {detail.tasks.length > 1 && block("Tarefas", detail.tasks, detail.taskId)}
      {block("Agentes", detail.agents)}
      {block("Modelos", detail.models)}
    </>
  );
}
