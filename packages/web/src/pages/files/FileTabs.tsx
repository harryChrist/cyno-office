import { useEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { useFilesStore } from "../../store/filesStore";
import { FilesIcon } from "./filesIcons";
import { tabKey, tabLabels } from "./filesView";
import { fileTone } from "./highlight";

/**
 * A faixa de abas, como num editor de código: uma por arquivo aberto, com ícone, nome e fechar. A aba provisória
 * (nome em itálico) é trocada pelo próximo clique simples; dois cliques (no arquivo ou na aba) fixam. Clique do meio
 * fecha. Com muitas abas a faixa rola na horizontal e a ativa fica sempre à vista.
 */
export function FileTabs({ onBack }: { onBack: () => void }) {
  const tabs = useFilesStore((state) => state.tabs);
  const active = useFilesStore((state) => state.active);
  const roots = useFilesStore((state) => state.roots);
  const edits = useFilesStore((state) => state.edits);
  const strip = useRef<HTMLDivElement>(null);
  const labels = useMemo(() => tabLabels(tabs, (id) => roots?.find((root) => root.id === id)?.name ?? id), [tabs, roots]);
  const store = useFilesStore.getState;

  // A aba ativa sempre fica visível na faixa.
  useEffect(() => {
    if (!active) return;
    const node = Array.from(strip.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []).find((tab) => tab.dataset.key === active);
    node?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, key: string) => {
    const index = tabs.findIndex((tab) => tabKey(tab) === key);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = Math.min(tabs.length - 1, index + 1);
    else if (event.key === "ArrowLeft") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      store().activate(key);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    const target = tabs[next];
    if (!target) return;
    store().activate(tabKey(target));
    window.requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(tabKey(target))}"]`)?.focus());
  };

  return (
    <div className="files-tabsrow">
      <button type="button" className="files-back" onClick={onBack} data-testid="files-back">
        ‹ Arquivos
      </button>
      <div className="files-tabs" role="tablist" aria-label="Arquivos abertos" ref={strip} data-testid="files-tabs">
        {tabs.map((tab, index) => {
          const key = tabKey(tab);
          const label = labels[index]!;
          const isActive = key === active;
          const dirty = edits[key]?.dirty === true;
          return (
            <div
              key={key}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              className={`files-tab${isActive ? " files-tab--active" : ""}${tab.preview ? " files-tab--preview" : ""}`}
              title={tab.path}
              data-key={key}
              onClick={() => store().activate(key)}
              onDoubleClick={() => store().pinTab(key)}
              onMouseDown={(event: MouseEvent) => {
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event: MouseEvent) => {
                if (event.button === 1) {
                  event.preventDefault();
                  store().requestCloseTab(key);
                }
              }}
              onKeyDown={(event) => onKeyDown(event, key)}
              data-testid="files-tab"
              data-path={tab.path}
              data-active={isActive ? "true" : "false"}
              data-preview={tab.preview ? "true" : "false"}
              data-dirty={dirty ? "true" : "false"}
            >
              <FilesIcon name="file" size={14} tone={fileTone(label.name)} />
              <span className="files-tab__name">{label.name}</span>
              {label.hint && <span className="files-tab__hint">{label.hint}</span>}
              <button
                type="button"
                className="files-tab__close"
                tabIndex={-1}
                aria-label={`Fechar ${label.name}`}
                title={dirty ? "Fechar (há alterações não salvas)" : "Fechar"}
                onClick={(event) => {
                  event.stopPropagation();
                  store().requestCloseTab(key);
                }}
                onDoubleClick={(event) => event.stopPropagation()}
                data-testid="files-tab-close"
              >
                {dirty && <span className="files-tab__dot" aria-hidden="true" />}
                <FilesIcon name="close" size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="files-tabsrow__more">
        <span className="files-tabsrow__count">{tabs.length === 1 ? "1 aberto" : `${tabs.length} abertos`}</span>
        <button type="button" className="files-close-all" onClick={() => store().requestCloseAll()} data-testid="files-close-all">
          Fechar todos
        </button>
      </div>
    </div>
  );
}
