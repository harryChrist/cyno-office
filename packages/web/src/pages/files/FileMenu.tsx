import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { MENU_LABELS, type MenuAction } from "./filesView";

export type FileMenuProps = {
  actions: MenuAction[];
  /** Onde o menu nasce (clique direito: o cursor; botão: o canto do botão). */
  x: number;
  y: number;
  onSelect: (action: MenuAction) => void;
  /** `restoreFocus` = fechou por Esc ou Tab: o foco volta para a linha de onde o menu saiu. */
  onClose: (restoreFocus: boolean) => void;
};

const EDGE = 8;

/**
 * O menu de ações de um item da árvore: `role="menu"`, setas movem, Home e End vão às pontas, Esc fecha. No celular a
 * folha sobe da borda de baixo (o CSS troca a posição); no computador ele ancora no ponto e nunca passa da tela.
 */
export function FileMenu({ actions, x, y, onSelect, onClose }: FileMenuProps) {
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number }>({ left: x, top: y });

  // Mede o menu e o encosta dentro da tela (vira para cima ou para a esquerda se faltar lugar).
  useLayoutEffect(() => {
    const node = menu.current;
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(x, window.innerWidth - width - EDGE));
    const top = y + height + EDGE > window.innerHeight ? Math.max(EDGE, y - height) : y;
    setPlace({ left, top });
    node.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [x, y]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const index = items.indexOf(document.activeElement as HTMLElement);
    const go = (at: number) => {
      event.preventDefault();
      items[(at + items.length) % items.length]?.focus();
    };
    if (event.key === "ArrowDown") go(index + 1);
    else if (event.key === "ArrowUp") go(index < 0 ? items.length - 1 : index - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(items.length - 1);
    else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    }
  };

  return (
    <div className="files-menu-layer" onMouseDown={() => onClose(false)} onContextMenu={(event) => { event.preventDefault(); onClose(false); }} data-testid="files-menu-layer">
      <div
        ref={menu}
        role="menu"
        aria-label="Ações do item"
        className="files-menu"
        style={{ ["--menu-x" as string]: `${place.left}px`, ["--menu-y" as string]: `${place.top}px` }}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        data-testid="files-menu"
      >
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={`files-menu__item${action === "delete" ? " files-menu__item--danger" : ""}`}
            onClick={() => onSelect(action)}
            data-testid="files-menu-item"
            data-action={action}
          >
            {MENU_LABELS[action]}
          </button>
        ))}
      </div>
    </div>
  );
}
