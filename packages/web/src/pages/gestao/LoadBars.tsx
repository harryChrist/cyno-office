import type { LoadView } from "./pessoasView";

const ROW = 26;
const BAR_H = 12;

/** A carga de agora, uma barra empilhada por agente (fazendo, na fila, esperando); a mais longa fecha a escala. SVG puro. */
export function LoadBars({ view }: { view: LoadView }) {
  return (
    <div className="load" data-testid="load-bars">
      <ul className="load__legend" aria-label="Legenda">
        <li>
          <span className="load__key load__key--doing" aria-hidden="true" /> fazendo
        </li>
        <li>
          <span className="load__key load__key--queued" aria-hidden="true" /> na fila
        </li>
        <li>
          <span className="load__key load__key--waiting" aria-hidden="true" /> esperando
        </li>
      </ul>
      <ul className="load__rows">
        {view.rows.map((row) => (
          <li key={row.id} className="load__row" data-testid="load-row">
            <span className="load__name">{row.name}</span>
            <svg className="load__svg" height={ROW} width="100%" role="img" aria-label={`${row.name}: ${row.text}`} preserveAspectRatio="none">
              <rect className="load__track" x="0" y={(ROW - BAR_H) / 2} width="100%" height={BAR_H} rx="4" />
              <rect className="load__seg load__seg--doing" x="0%" y={(ROW - BAR_H) / 2} width={`${row.widths.doing * 100}%`} height={BAR_H} />
              <rect className="load__seg load__seg--queued" x={`${row.widths.doing * 100}%`} y={(ROW - BAR_H) / 2} width={`${row.widths.queued * 100}%`} height={BAR_H} />
              <rect className="load__seg load__seg--waiting" x={`${(row.widths.doing + row.widths.queued) * 100}%`} y={(ROW - BAR_H) / 2} width={`${row.widths.waiting * 100}%`} height={BAR_H} />
            </svg>
            <span className={`load__text${row.total === 0 ? " load__text--idle" : ""}`}>{row.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
