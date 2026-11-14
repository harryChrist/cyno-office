import { useEffect, useRef, type ReactNode } from "react";
import "./pagetabs.css";

export type PageTab<T extends string> = {
  id: T;
  label: string;
  disabled?: boolean;
  /** Um contador ou rótulo curto depois do nome ("3", "em breve"). */
  badge?: ReactNode;
  /** Um ícone antes do nome (decorativo). */
  icon?: ReactNode;
  /** Dica ao passar o mouse. */
  title?: string;
};

/**
 * Abas de uma página (Gestão, Biblioteca, Projetos e tarefas, Atividade…): uma tira com a aba atual
 * sublinhada. É o visual único das abas de página do app; quem precisa de algo a mais usa as props
 * opcionais (`badge`/`icon` por aba, `trailing` à direita, `flush` sem o respiro lateral) em vez de
 * copiar o CSS. Cabendo ou não, a tira nunca quebra em duas linhas: rola por dentro e traz a aba atual à vista.
 */
export function PageTabs<T extends string>({
  label,
  tabs,
  active,
  onSelect,
  testIdPrefix,
  idPrefix,
  controls,
  trailing,
  flush,
  className,
}: {
  label: string;
  tabs: readonly PageTab<T>[];
  active: T;
  onSelect: (id: T) => void;
  testIdPrefix: string;
  /** Se dado, cada aba ganha `id="<idPrefix>-<aba>"` (para o painel apontar com `aria-labelledby`). */
  idPrefix?: string;
  /** O `id` do painel que as abas controlam (`aria-controls`). */
  controls?: string;
  /** Algo fixo à direita da tira (um seletor, uma visão), que não rola junto com as abas. */
  trailing?: ReactNode;
  /** Sem o respiro de cima e dos lados: a página que usa já dá a sua margem. */
  flush?: boolean;
  /** Classe extra na tira (posicionamento pela página, nunca o visual das abas). */
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // Celular: se as abas não cabem, a atual é trazida para dentro da área visível (só a tira rola, não a página).
  useEffect(() => {
    const list = listRef.current;
    const tab = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !tab || list.scrollWidth <= list.clientWidth) return;
    const left = tab.offsetLeft - list.offsetLeft;
    if (left < list.scrollLeft) list.scrollLeft = left - 16;
    else if (left + tab.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = left + tab.offsetWidth - list.clientWidth + 16;
  }, [active, tabs.length]);

  return (
    <div className={`pagetabs${flush ? " pagetabs--flush" : ""}${className ? ` ${className}` : ""}`}>
      <div className="pagetabs__list" role="tablist" aria-label={label} ref={listRef}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}-${tab.id}` : undefined}
            aria-selected={active === tab.id}
            aria-controls={controls}
            disabled={tab.disabled}
            title={tab.title}
            className="pagetabs__tab"
            onClick={() => onSelect(tab.id)}
            data-testid={`${testIdPrefix}-${tab.id}`}
          >
            {tab.icon && (
              <span className="pagetabs__icon" aria-hidden="true">
                {tab.icon}
              </span>
            )}
            {tab.label}
            {tab.badge != null && tab.badge !== false && <span className="pagetabs__badge">{tab.badge}</span>}
          </button>
        ))}
      </div>
      {trailing != null && <div className="pagetabs__trailing">{trailing}</div>}
    </div>
  );
}
