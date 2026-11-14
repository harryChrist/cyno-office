import type { Page } from "@playwright/test";

declare global {
  interface Window {
    __taskStatusHistory?: Record<string, string[]>;
  }
}

/**
 * Grava no navegador a sequência de `data-status` de cada elemento `[data-task-id]`.
 * Com o MockRunner rápido do e2e, "in_progress" dura ~100 ms e o polling do expect
 * poderia não ver; o MutationObserver (com attributeOldValue) não perde nenhum estado.
 */
export async function recordTaskStatusHistory(page: Page): Promise<void> {
  await page.evaluate(() => {
    const history: Record<string, string[]> = {};
    window.__taskStatusHistory = history;

    const push = (element: Element, status: string | null) => {
      const id = element.getAttribute("data-task-id");
      if (!id || !status) return;
      const list = (history[id] ??= []);
      if (list.at(-1) !== status) list.push(status);
    };
    const tasksIn = (node: Node): Element[] => {
      if (!(node instanceof Element)) return [];
      const found = Array.from(node.querySelectorAll("[data-task-id]"));
      return node.matches("[data-task-id]") ? [node, ...found] : found;
    };

    for (const element of tasksIn(document.body)) push(element, element.getAttribute("data-status"));

    new MutationObserver((records) => {
      const touched = new Set<Element>();
      for (const record of records) {
        if (record.type === "attributes" && record.target instanceof Element) {
          push(record.target, record.oldValue);
          touched.add(record.target);
        } else {
          for (const node of record.addedNodes) for (const element of tasksIn(node)) touched.add(element);
        }
      }
      for (const element of touched) push(element, element.getAttribute("data-status"));
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-status"],
      attributeOldValue: true,
    });
  });
}

/** Status pelos quais a tarefa passou na tela, em ordem e sem repetições seguidas. */
export function taskStatusHistory(page: Page, taskId: string): Promise<string[]> {
  return page.evaluate((id) => window.__taskStatusHistory?.[id] ?? [], taskId);
}
