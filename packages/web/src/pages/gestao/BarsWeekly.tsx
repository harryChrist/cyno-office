import type { WeeklyBars } from "./painelView";

const W = 272;
const H = 112;
const TOP = 16;
const BOTTOM = 18;
const PITCH = W / 8;
const BAR = 20;

/**
 * As entregas por semana (barras, uma por semana, porque semanas separadas pedem barra e não linha): a semana atual
 * tracejada (ainda em andamento) e a linha da média das 4 semanas. SVG puro, nas cores do tema.
 */
export function BarsWeekly({ view }: { view: WeeklyBars }) {
  const plot = H - TOP - BOTTOM;
  const y = (fraction: number) => TOP + plot * (1 - fraction);
  const x = (index: number) => index * PITCH + (PITCH - BAR) / 2;
  const avgPoints = view.bars
    .map((bar, index) => (bar.avg === null ? null : `${(x(index) + BAR / 2).toFixed(1)},${y(bar.avg).toFixed(1)}`))
    .filter((point): point is string => point !== null)
    .join(" ");
  return (
    <figure className="bars" data-testid="bars-weekly">
      <svg className="bars__svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={view.ariaLabel}>
        <line className="bars__base" x1="0" x2={W} y1={y(0)} y2={y(0)} />
        {view.bars.map((bar, index) => {
          const height = Math.max(bar.count > 0 ? 2 : 0, plot * bar.height);
          return (
            <g key={bar.key} data-testid={`bars-week-${bar.key}`} data-current={bar.current || undefined}>
              <title>{`Semana de ${bar.label}: ${bar.count} ${bar.count === 1 ? "entrega" : "entregas"}${bar.current ? " (em andamento)" : ""}`}</title>
              <rect className={`bars__bar${bar.current ? " bars__bar--current" : ""}`} x={x(index)} y={y(0) - height} width={BAR} height={height} rx="3" />
              {bar.count > 0 && (
                <text className="bars__count" x={x(index) + BAR / 2} y={y(0) - height - 4} textAnchor="middle">
                  {bar.count}
                </text>
              )}
              <text className="bars__label" x={x(index) + BAR / 2} y={H - 4} textAnchor="middle">
                {bar.label}
              </text>
            </g>
          );
        })}
        {avgPoints && <polyline className="bars__avg" points={avgPoints} />}
      </svg>
      <figcaption className="bars__legend">
        <span className="bars__key bars__key--bar" aria-hidden="true" /> por semana
        <span className="bars__key bars__key--current" aria-hidden="true" /> semana em andamento
        <span className="bars__key bars__key--avg" aria-hidden="true" /> média de 4 semanas
      </figcaption>
    </figure>
  );
}
