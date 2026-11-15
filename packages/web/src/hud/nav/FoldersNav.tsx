import { create } from "zustand";
import { useNavStore } from "../../store/navStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { FoldersSettings } from "../../pages/settings/FoldersSettings";
import { Modal } from "../../ui/widgets";
import { NavIcon } from "../navIcons";
import { foldersSummary } from "./navItems";

/** O painel de pastas fica num estado à parte: a gaveta do celular fecha ao abrir, mas o painel precisa continuar. */
const useFoldersPanelStore = create<{ open: boolean; setOpen: (open: boolean) => void }>()((set) => ({ open: false, setOpen: (open) => set({ open }) }));

/** O workspace aberto, da mesma fonte da lista que chega em `workspaces:list` (some quando a lista ainda não chegou). */
function useOpenWorkspace() {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const id = useNavStore((state) => state.workspaceId);
  return workspaces?.find((ws) => ws.id === id) ?? null;
}

/**
 * Indicador das pastas de trabalho, logo abaixo do seletor de workspace: ícone de pasta e um resumo
 * (nome da pasta, "Nome +N" ou "Sem pasta de trabalho"), com um ponto âmbar quando algum agente pode escrever.
 * Recolhida, só o ícone com a contagem. Clicar abre o painel para mexer nas pastas.
 */
export function FoldersItem({ onBeforeOpen }: { onBeforeOpen?: () => void }) {
  const workspace = useOpenWorkspace();
  const open = useFoldersPanelStore((state) => state.open);
  const setOpen = useFoldersPanelStore((state) => state.setOpen);
  if (!workspace) return null;
  const summary = foldersSummary(workspace.folders);
  return (
    <button
      type="button"
      className={`navitem navitem--folders${summary.count === 0 ? " navitem--folders-empty" : ""}`}
      aria-label={summary.aria}
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={() => {
        onBeforeOpen?.();
        setOpen(true);
      }}
      title={summary.tip}
      data-tip={summary.tip}
      data-testid="nav-folders"
    >
      <span className="navitem__icon-wrap">
        <NavIcon name="pasta" />
      </span>
      <span className="navitem__label navitem__label--folders" aria-hidden="true">
        {summary.label}
      </span>
      {summary.writable > 0 && <span className="navitem__write" aria-hidden="true" data-testid="nav-folders-write" />}
      {summary.count > 0 && (
        <span className="navitem__badge navitem__badge--folders" aria-hidden="true" data-testid="nav-folders-count">
          {summary.count}
        </span>
      )}
    </button>
  );
}

/** O painel de pastas (janela modal por cima de tudo); fica no AppNav, fora da barra e da gaveta. */
export function FoldersPanelHost() {
  const open = useFoldersPanelStore((state) => state.open);
  const setOpen = useFoldersPanelStore((state) => state.setOpen);
  const workspace = useOpenWorkspace();
  if (!open || !workspace) return null;
  return (
    <Modal title="Pastas de trabalho" onClose={() => setOpen(false)} testId="folders-panel" wide>
      <p className="folders-panel__ws" data-testid="folders-panel-ws">
        Workspace <strong>{workspace.name}</strong>
      </p>
      <FoldersSettings key={workspace.id} workspace={workspace} panel />
    </Modal>
  );
}
