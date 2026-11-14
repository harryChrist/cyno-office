import type { AgendaPostItem } from "@cyno/shared";
import { useNavStore } from "../../store/navStore";
import { Modal } from "../../ui/widgets";
import { shortDay, workspaceColor } from "./agendaTime";

/** Uma postagem do calendário de um workspace: só leitura aqui (quem muda é o Maestro do workspace, pela ferramenta do calendário). */
export function PostDialog({ post, onClose }: { post: AgendaPostItem; onClose: () => void }) {
  const open = () => {
    useNavStore.getState().setWorkspace(post.workspace);
    useNavStore.getState().go("office");
  };
  return (
    <Modal title="Postagem" onClose={onClose} testId="agenda-post-dialog">
      <div className="ag-detail">
        <p className="ag-detail__title">{post.title}</p>
        <dl className="ag-detail__grid">
          <dt>Quando</dt>
          <dd>
            {shortDay(post.date)} · {post.time ? `${post.time}${post.endTime ? `–${post.endTime}` : ""}` : "dia todo"}
          </dd>
          <dt>Workspace</dt>
          <dd>
            <span className="ag-chip__dot" style={{ background: workspaceColor(post.workspace) }} /> {post.workspaceName}
          </dd>
          <dt>Estado</dt>
          <dd>{post.done ? "Feito" : "A fazer"}</dd>
        </dl>
        <p className="ag-detail__hint">Postagens não tomam o seu tempo e não são conferidas contra os seus compromissos. Aqui elas só aparecem, para você ver o conjunto; o Maestro do workspace é quem as muda.</p>
        <div className="ui-actions">
          <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
            Fechar
          </button>
          <button type="button" className="ui-button" onClick={open}>
            Abrir o workspace
          </button>
        </div>
      </div>
    </Modal>
  );
}
