import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Workspace } from "@cyno/shared";
import { api } from "../api/client";
import { useNavStore } from "../store/navStore";
import { currentWorkspaceName, pickWorkspace, useWorkspaceStore } from "../store/workspaceStore";
import { CreateWorkspaceDialog, RenameWorkspaceDialog } from "../ui/CreateDialogs";
import { ConfirmDialog } from "../ui/widgets";
import { workspaceColor } from "../ui/workspaceColor";
import { usePopover } from "./usePopover";

/** Inicial colorida do workspace (avatar redondo). */
function WorkspaceInitial({ name }: { name: string | null }) {
  const letter = name?.trim().charAt(0).toUpperCase() || "·";
  return (
    <span className="ws-picker__initial" aria-hidden="true" style={{ ["--ws-color" as string]: name ? workspaceColor(name) : "var(--ui-text-3)" }}>
      {letter}
    </span>
  );
}

/**
 * Seletor de workspace (à esquerda da barra): botão com o nome do atual e um menu com a lista
 * (cada um com "Renomear" e "Excluir") e "+ Novo workspace". Trocar de workspace reconecta e
 * recarrega tudo (veja App/workspaceSwitch).
 */
export function WorkspacePicker() {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const currentId = useNavStore((state) => state.workspaceId);
  const setWorkspace = useNavStore((state) => state.setWorkspace);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Workspace | null>(null);
  const [deleting, setDeleting] = useState<Workspace | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const name = currentWorkspaceName(workspaces, currentId);
  const empty = workspaces !== null && workspaces.length === 0;

  // Fecha ao clicar fora ou com Esc (o foco volta para o botão).
  const close = useCallback(() => setOpen(false), []);
  usePopover(open, close, rootRef, buttonRef);

  // Ao abrir, o foco vai para o workspace atual (ou o primeiro item).
  useEffect(() => {
    if (!open) return;
    const menu = rootRef.current?.querySelector<HTMLElement>('[role="menu"]');
    (menu?.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu?.querySelector<HTMLElement>('[role^="menuitem"]'))?.focus();
  }, [open]);

  /** Setas para cima/baixo andam pelos itens do menu. */
  const onMenuKey = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    next?.focus();
  };

  const choose = (id: string) => {
    setOpen(false);
    if (id !== currentId) setWorkspace(id);
  };

  /**
   * Exclui no server; se era o atual, vai para o primeiro que sobrou ou, se era o último, para o
   * estado vazio (a lista nova também chega pelo WebSocket).
   */
  const remove = async (target: Workspace) => {
    await api.deleteWorkspace(target.id);
    const nav = useNavStore.getState();
    if (nav.workspaceId !== target.id) return;
    const rest = (useWorkspaceStore.getState().workspaces ?? []).filter((ws) => ws.id !== target.id);
    const next = pickWorkspace(null, rest);
    if (next) nav.setWorkspace(next);
    else nav.clearWorkspace();
  };
  const deletingLast = deleting !== null && (workspaces ?? []).filter((ws) => ws.id !== deleting.id).length === 0;

  return (
    <div className="ws-picker" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="ws-picker__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={empty ? "Nenhum workspace. Criar workspace" : `Workspace: ${name ?? "carregando"}. Trocar de workspace`}
        disabled={!workspaces}
        onClick={() => setOpen((on) => !on)}
        data-testid="workspace-picker"
      >
        {empty ? (
          <span className="ws-picker__initial ws-picker__initial--empty" aria-hidden="true">
            +
          </span>
        ) : (
          <WorkspaceInitial name={name} />
        )}
        <span className={`ws-picker__name${empty ? " ws-picker__name--empty" : ""}`}>{empty ? "Nenhum workspace" : (name ?? "…")}</span>
        <span className="ws-picker__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && workspaces && (
        <ul id={menuId} className="ws-picker__menu" role="menu" aria-label="Workspaces" onKeyDown={onMenuKey} data-testid="workspace-menu">
          {empty && (
            <li role="none" className="ws-picker__empty" data-testid="workspace-menu-empty">
              Nenhum workspace ainda. Crie um para abrir o escritório.
            </li>
          )}
          {workspaces.map((ws) => (
            <li key={ws.id} role="none" className="ws-picker__row">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={ws.id === currentId}
                className="ws-picker__item"
                tabIndex={-1}
                onClick={() => choose(ws.id)}
                data-testid={`workspace-option-${ws.id}`}
              >
                <WorkspaceInitial name={ws.name} />
                <span className="ws-picker__item-name">{ws.name}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="ws-picker__action"
                tabIndex={-1}
                aria-label={`Renomear ${ws.name}`}
                title="Renomear"
                onClick={() => {
                  setOpen(false);
                  setRenaming(ws);
                }}
                data-testid={`workspace-rename-${ws.id}`}
              >
                ✎
              </button>
              <button
                type="button"
                role="menuitem"
                className="ws-picker__action ws-picker__action--danger"
                tabIndex={-1}
                aria-label={`Excluir ${ws.name}`}
                title="Excluir"
                onClick={() => {
                  setOpen(false);
                  setDeleting(ws);
                }}
                data-testid={`workspace-delete-${ws.id}`}
              >
                ×
              </button>
            </li>
          ))}
          {!empty && <li role="separator" className="ws-picker__divider" />}
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="ws-picker__item ws-picker__item--new"
              tabIndex={-1}
              onClick={() => {
                setOpen(false);
                setCreating(true);
              }}
              data-testid="workspace-new"
            >
              {empty ? "+ Criar workspace" : "+ Novo workspace"}
            </button>
          </li>
        </ul>
      )}
      {creating && <CreateWorkspaceDialog onClose={() => setCreating(false)} />}
      {renaming && <RenameWorkspaceDialog workspace={renaming} onClose={() => setRenaming(null)} />}
      {deleting && (
        <ConfirmDialog
          title="Excluir workspace"
          testId="confirm-delete-workspace"
          message={
            <>
              <p>
                Excluir <strong>{deleting.name}</strong>? Sai do app tudo o que é dele: o escritório, os agentes (os terminais deles param), as tarefas, os planos e os
                Cérebros. A pasta não é apagada: vai para <code>data/excluidos/</code>, de onde dá para recuperar.
              </p>
              {deletingLast && (
                <p className="ws-picker__last" data-testid="confirm-delete-workspace-last">
                  É o último workspace: o app fica sem nenhum até você criar outro.
                </p>
              )}
            </>
          }
          confirmLabel="Excluir workspace"
          onConfirm={() => remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
