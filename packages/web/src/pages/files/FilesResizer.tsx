import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { clampTreeWidth, TREE_WIDTH_DEFAULT, TREE_WIDTH_MIN, treeWidthForKey } from "./filesView";

/**
 * A divisória entre a árvore e o arquivo (só no computador): arrastar muda a largura dos dois, duplo clique volta à
 * padrão, e com foco as setas, Home e End fazem o mesmo. O ponteiro fica "capturado" na divisória, então nada
 * (nem a imagem aberta) rouba o arraste. Um ajuste por quadro, no máximo.
 */
export function FilesResizer({ width, available, onChange, onCommit, onDragging }: { width: number; available: number; onChange: (width: number) => void; onCommit: (width: number) => void; onDragging: (dragging: boolean) => void }) {
  const drag = useRef<{ x: number; width: number; last: number; frame: number } | null>(null);
  const max = clampTreeWidth(Number.MAX_SAFE_INTEGER, available);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width, last: width, frame: 0 };
    onDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    current.last = clampTreeWidth(current.width + (event.clientX - current.x), available);
    if (current.frame) return;
    current.frame = requestAnimationFrame(() => {
      current.frame = 0;
      onChange(current.last);
    });
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (current.frame) cancelAnimationFrame(current.frame);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    onDragging(false);
    onCommit(current.last);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = treeWidthForKey(event.key, width, available);
    if (next === null) return;
    event.preventDefault();
    onCommit(next);
  };

  return (
    <div
      className="files-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Largura da árvore de arquivos: arraste ou use as setas"
      aria-valuenow={width}
      aria-valuemin={TREE_WIDTH_MIN}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onCommit(clampTreeWidth(TREE_WIDTH_DEFAULT, available))}
      data-testid="files-resizer"
    >
      <span className="files-resizer__line" aria-hidden="true" />
    </div>
  );
}
