import type { ReactNode } from "react";
import type { KpiView } from "./painelView";

/** Um cartão de número do Painel: o rótulo, o valor grande (com a seta, se houver), as linhas de apoio e, embaixo, o que o cartão trouxer (gráfico, lista). */
export function KpiTile({ tile, children }: { tile: KpiView; children?: ReactNode }) {
  return (
    <article className={`kpi kpi--${tile.tone}`} aria-label={tile.label} data-testid={`kpi-${tile.id}`}>
      <h3 className="kpi__label">{tile.label}</h3>
      <p className="kpi__main">
        <span className="kpi__value ui-tabular" data-testid={`kpi-${tile.id}-value`}>
          {tile.value}
        </span>
        {tile.unit && <small className="kpi__unit">{tile.unit}</small>}
        {tile.arrow && (
          <span className={`kpi__arrow kpi__arrow--${tile.arrow.dir}`} title={tile.arrow.text} data-testid={`kpi-${tile.id}-arrow`}>
            <span aria-hidden="true">{tile.arrow.glyph}</span>
            {tile.delta && <span className="kpi__delta">{tile.delta}</span>}
            <span className="kpi__sr">{tile.arrow.text}</span>
          </span>
        )}
      </p>
      {tile.lines.map((line) => (
        <p key={line} className="kpi__line">
          {line}
        </p>
      ))}
      {children}
    </article>
  );
}
