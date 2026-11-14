import { useMemo } from "react";
import { openAlert } from "../attention/openAlert";
import { useAwayStore } from "../attention/awayStore";
import { awayCardView, type AwayItem } from "../attention/awayView";
import { NavIcon } from "./navIcons";
import "./away.css";

/**
 * "Enquanto você estava fora": o cartão discreto que aparece ao voltar depois de 30 minutos ou mais,
 * em qualquer página, sem cobrir o trabalho (canto da tela no computador, topo no celular). O resumo é
 * montado por código no servidor, sem IA; cada linha leva à coisa, e "Ok, vi" vale para todos os navegadores.
 * Se não aconteceu nada, o cartão não aparece.
 */
export function AwayCard() {
  const summary = useAwayStore((state) => state.summary);
  const dismissed = useAwayStore((state) => state.dismissed);
  const confirm = useAwayStore((state) => state.confirm);
  // O "agora" do cartão é o da volta: a idade das aprovações é contada até ali, para o texto não mudar a cada minuto.
  const view = useMemo(() => (summary ? awayCardView(summary, Date.parse(summary.until)) : null), [summary]);
  if (!view || dismissed) return null;

  const go = (item: AwayItem) => {
    if (item.target) openAlert({ kind: item.kind, target: item.target });
  };

  return (
    <aside
      className="away-card"
      role="region"
      aria-label={view.title}
      data-testid="away-card"
      onKeyDown={(event) => {
        if (event.key === "Escape") void confirm();
      }}
    >
      <header className="away-card__head">
        <div className="away-card__heading">
          <h2 className="away-card__title">{view.title}</h2>
          <p className="away-card__since" data-testid="away-since">
            {view.since}
          </p>
        </div>
        <button type="button" className="away-card__close" aria-label="Fechar e marcar como visto" onClick={() => void confirm()}>
          <NavIcon name="close" className="nav-icon away-card__close-icon" />
        </button>
      </header>
      <div className="away-card__body">
        {view.sections.map((section, index) => (
          <section key={`${section.key}-${section.workspace ?? ""}-${index}`} className={`away-sec away-sec--${section.tone}`} data-testid={`away-${section.key}`}>
            <h3 className="away-sec__heading">
              <span className="away-sec__dot" aria-hidden="true" />
              <span>
                {section.workspace && <span className="away-sec__ws">{section.workspace}: </span>}
                {section.heading}
              </span>
            </h3>
            {section.items.length > 0 && (
              <ul className="away-sec__items">
                {section.items.map((item, itemIndex) => (
                  <li key={`${item.label}-${itemIndex}`}>
                    {item.target ? (
                      <button type="button" className="away-item away-item--link" onClick={() => go(item)}>
                        <span className="away-item__label">{item.label}</span>
                        {item.sub && <span className="away-item__sub">{item.sub}</span>}
                      </button>
                    ) : (
                      <span className="away-item">
                        <span className="away-item__label">{item.label}</span>
                        {item.sub && <span className="away-item__sub">{item.sub}</span>}
                      </span>
                    )}
                  </li>
                ))}
                {section.more && <li className="away-item__more">{section.more}</li>}
              </ul>
            )}
          </section>
        ))}
      </div>
      <footer className="away-card__foot">
        <button type="button" className="ui-button ui-button--small away-card__ok" onClick={() => void confirm()} data-testid="away-ok">
          Ok, vi
        </button>
      </footer>
    </aside>
  );
}
