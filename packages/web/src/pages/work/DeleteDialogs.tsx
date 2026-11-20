import type { Project } from "@cyno/shared";
import { api } from "../../api/client";
import { ConfirmDialog } from "../../ui/widgets";
import { DELETE_TASK_NOTE } from "./avulsasCleanupView";
import { projectTasksText, runningNote } from "./projectDeleteView";

/**
 * Confirmação curta para apagar de vez uma tarefa avulsa terminada. O 409 do servidor (tarefa que não está
 * terminada, por exemplo) aparece no próprio diálogo, com a mensagem dele.
 */
export function DeleteAvulsaTaskDialog({ projectId, taskRef, title, onClose, onDeleted }: { projectId: string; taskRef: string; title: string; onClose: () => void; onDeleted?: () => void }) {
  return (
    <ConfirmDialog
      title="Apagar a tarefa?"
      message={
        <div className="w-del">
          <p>
            <strong>{title}</strong> será apagada de vez.
          </p>
          <p>{DELETE_TASK_NOTE}</p>
        </div>
      }
      confirmLabel="Apagar tarefa"
      pendingLabel="Apagando…"
      onConfirm={async () => {
        await api.deleteAvulsaTask(projectId, taskRef);
        onDeleted?.();
      }}
      onClose={onClose}
      testId="avulsas-delete-dialog"
    />
  );
}

/**
 * Apagar um projeto comum: diz o nome, quantas tarefas ele tem e que as tarefas e os logs delas vão junto.
 * O botão vermelho é o segundo passo (o primeiro foi abrir este diálogo). O 409 do servidor (tarefa rodando)
 * aparece aqui mesmo.
 */
export function DeleteProjectDialog({ project, onClose, onDeleted }: { project: Project; onClose: () => void; onDeleted: () => void }) {
  const note = runningNote(project);
  return (
    <ConfirmDialog
      title="Apagar o projeto?"
      message={
        <div className="w-del">
          <p>
            <strong>{project.title}</strong> tem {projectTasksText(project)}.
          </p>
          <p>Apagar o projeto apaga as tarefas e os logs delas. Não dá para desfazer. O histórico da Atividade continua.</p>
          {note && <p data-testid="project-delete-running">{note}</p>}
        </div>
      }
      confirmLabel="Apagar projeto"
      pendingLabel="Apagando…"
      onConfirm={async () => {
        await api.deleteProject(project.id);
        onDeleted();
      }}
      onClose={onClose}
      testId="project-delete-dialog"
    />
  );
}
