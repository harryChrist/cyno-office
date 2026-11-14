import type { ReactNode } from "react";
import { useWorkStore } from "../../store/workStore";
import { useNavStore } from "../../store/navStore";
import type { ForecastRow, ForecastView } from "./painelView";

const TONE_VAR: Record<string, string> = { ok: "var(--ui-ok)", warn: "var(--ui-warn)", danger: "var(--ui-danger)", neutral: "var(--m-bar)" };

/** A régua de uma previsão: a faixa (rápido a lento), o ponto do fim provável, hoje e o prazo. SVG puro; posições em %. */
function Bar({ row }: { row: ForecastRow }) {
  const bar = row.bar;
  if (!bar) return null;
  const color = TONE_VAR[row.verdict?.tone ?? "neutral"]!;
  const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;
  return (
    <svg className="fc__svg" width="100%" height="22" role="img" aria-label={bar.ariaLabel} data-testid="forecast-bar">
      <rect x="0" y="10" width="100%" height="2" rx="1" fill="var(--ui-border)" />
      <line x1={pct(bar.now)} x2={pct(bar.now)} y1="5" y2="17" stroke="var(--ui-text-3)" strokeWidth="1" />
      <rect x={pct(bar.low)} y="6" width={pct(Math.max(bar.high - bar.low, 0.006))} height="10" rx="3" fill={color} opacity="0.28" data-testid="forecast-band" />
      <circle cx={pct(bar.at)} cy="11" r="5" fill={color} data-testid="forecast-at" />
      {bar.due !== null && (
        <g data-testid="forecast-due">
          <line x1={pct(bar.due)} x2={pct(bar.due)} y1="1" y2="21" stroke="var(--ui-text)" strokeWidth="2" strokeDasharray="3 2" />
        </g>
      )}
    </svg>
  );
}

/** "Prazos e previsão": uma linha por projeto aberto, legível no celular (nada de rolagem para o lado). */
export function ForecastBars({ view, renderActions }: { view: ForecastView; /** Botões por projeto (Isso primeiro, Pausar). */ renderActions?: (row: ForecastRow) => ReactNode }) {
  const go = useNavStore((state) => state.go);
  if (view.empty) return <p className="mdcard__quiet" data-testid="forecast-empty">{view.empty}</p>;
  const open = (id: string) => {
    useWorkStore.getState().open(id);
    go("trabalho");
  };
  return (
    <>
      {view.summary && <p className="fc__summary" data-testid="forecast-summary">{view.summary}</p>}
      <p className="fc__legend">Faixa: do fim mais rápido ao mais lento · ponto: fim provável · tracejado: prazo · traço fino: hoje</p>
      <ul className="fc" data-testid="forecast-list">
        {view.rows.map((row) => (
          <li key={row.id} className="fc__row" data-testid="forecast-row" data-verdict={row.verdict ? row.verdict.label : "sem"}>
            <div className="fc__head">
              <button type="button" className="fc__title" onClick={() => open(row.id)} data-testid="forecast-open">
                {row.title}
              </button>
              {row.verdict && (
                <span className={`fc__verdict fc__verdict--${row.verdict.tone}`} data-testid="forecast-verdict">
                  {row.verdict.label}
                </span>
              )}
              <span className="fc__remaining">{row.remaining}</span>
            </div>
            <Bar row={row} />
            {row.bar && (
              <div className="fc__axis" aria-hidden="true">
                <span>{row.bar.startLabel}</span>
                <span>{row.bar.endLabel}</span>
              </div>
            )}
            <p className="fc__sentence" data-testid="forecast-sentence">{row.sentence}</p>
            {(row.dueNote || row.confidence) && (
              <p className="fc__notes">
                {row.dueNote && <span className={row.verdict?.tone === "danger" ? "is-danger" : undefined}>{row.dueNote}</span>}
                {row.confidence && <span>{row.confidence}</span>}
              </p>
            )}
            {renderActions && <div className="fc__actions">{renderActions(row)}</div>}
          </li>
        ))}
      </ul>
      {view.more > 0 && <p className="mdcard__quiet">e mais {view.more} projeto(s) com previsão.</p>}
    </>
  );
}
