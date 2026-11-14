import { formatSpan } from "./metricsFormat";
import type { CycleLine as CycleLineView } from "./painelView";

const W = 272;
const H = 64;
const PAD_X = 8;
const PAD_Y = 8;

/**
 * A mini-linha do tempo até entregar: a mediana de cada semana, com a faixa até o 90% (o "quase sempre").
 * Pontos cheios têm 5 entregas ou mais; os vazados são poucos dados. Mostra a tendência, não cada valor.
 */
export function CycleLine({ view }: { view: CycleLineView }) {
  if (view.points.length === 0) return null;
  const x = (fraction: number) => PAD_X + (W - 2 * PAD_X) * fraction;
  const y = (fraction: number) => PAD_Y + (H - 2 * PAD_Y) * (1 - fraction);
  const line = view.points.map((point) => `${x(point.x).toFixed(1)},${y(point.y).toFixed(1)}`).join(" ");
  const upper = view.points.map((point) => `${x(point.x).toFixed(1)},${y(point.y90).toFixed(1)}`);
  const lower = [...view.points].reverse().map((point) => `${x(point.x).toFixed(1)},${y(point.y).toFixed(1)}`);
  const band = view.points.length > 1 ? [...upper, ...lower].join(" ") : "";
  return (
    <figure className="cyc" data-testid="cycle-line">
      <svg className="cyc__svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={view.ariaLabel}>
        {band && <polygon className="cyc__band" points={band} />}
        {view.points.length === 1 && <line className="cyc__band-line" x1={x(view.points[0]!.x)} x2={x(view.points[0]!.x)} y1={y(view.points[0]!.y)} y2={y(view.points[0]!.y90)} />}
        {view.points.length > 1 && <polyline className="cyc__line" points={line} />}
        {view.points.map((point) => (
          <circle key={point.key} className={`cyc__dot${point.solid ? "" : " cyc__dot--few"}`} cx={x(point.x)} cy={y(point.y)} r="3">
            <title>{`${point.label}: mediana ${formatSpan(point.median)}, até ${formatSpan(point.p90)} em 90% (${point.n} ${point.n === 1 ? "entrega" : "entregas"})`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="cyc__legend">mediana por semana, faixa até o 90% mais lento · ponto vazado: poucos dados</figcaption>
    </figure>
  );
}
