/**
 * Janela de rolagem (virtualização simples) compartilhada entre "Todas as tarefas" (`AllTasks`)
 * e a árvore de tarefas (`TaskTree`): calcula o intervalo visível mais a folga (`overscan`).
 */
export function visibleWindow<T>(items: readonly T[], sizeOf: (item: T) => number, top: number, height: number, overscan = 6): { start: number; end: number; total: number; offset: number } {
  let total = 0;
  let start = -1;
  let end = items.length;
  let offset = 0;
  for (let i = 0; i < items.length; i += 1) {
    const h = sizeOf(items[i]!);
    if (start < 0 && total + h > top) {
      start = i;
      offset = total;
    }
    if (start >= 0 && total >= top + height) {
      end = i;
      break;
    }
    total += h;
  }
  if (end < items.length) {
    // `total` parou no começo do item `end`; soma o resto para o espaço de baixo.
    for (let i = end; i < items.length; i += 1) total += sizeOf(items[i]!);
  }
  if (start < 0) return { start: items.length, end: items.length, total, offset: total };
  const from = Math.max(0, start - overscan);
  for (let i = from; i < start; i += 1) offset -= sizeOf(items[i]!);
  return { start: from, end: Math.min(items.length, end + overscan), total, offset };
}
