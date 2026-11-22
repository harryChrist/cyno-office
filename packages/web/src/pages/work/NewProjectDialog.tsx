import { PROJECT_PRIORITIES, PROJECT_PRIORITY_LABELS, type ProjectPriority } from "@cyno/shared";
import { useId, useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText, Modal } from "../../ui/widgets";
import { brasiliaNote, fromBrasiliaInput } from "./workTime";

/**
 * Novo projeto à mão: nome, objetivo, prioridade e prazo. O projeto nasce em andamento (sem plano para aprovar)
 * e vazio; as tarefas o dono cria na árvore. Quem quer que o Maestro monte o plano usa "Pedir ao Maestro".
 */
export function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (projectId: string) => void }) {
  const id = useId();
  const { pending, error, run } = useAsyncAction();
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [priority, setPriority] = useState<ProjectPriority>("normal");
  const [due, setDue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) {
      setProblem("Dê um nome ao projeto.");
      return;
    }
    const dueAt = fromBrasiliaInput(due) ?? undefined;
    const created = await run(() => api.createProject({ title: title.trim(), ...(summary.trim() ? { summary: summary.trim() } : {}), priority, ...(dueAt ? { dueAt } : {}) }));
    if (!created) return;
    onClose();
    onCreated(created.project.id);
  };

  return (
    <Modal title="Novo projeto" onClose={onClose} testId="work-new-project-dialog">
      <form className="w-new" onSubmit={(event) => void submit(event)}>
        <div className="w-new__field">
          <label htmlFor={`${id}-t`}>Nome do projeto</label>
          <input
            id={`${id}-t`}
            className="ui-input"
            value={title}
            maxLength={120}
            placeholder="Ex.: Campanha de lançamento"
            aria-invalid={problem ? true : undefined}
            onChange={(event) => {
              setTitle(event.currentTarget.value);
              setProblem(null);
            }}
            autoFocus
            data-testid="work-new-project-title"
          />
          <ErrorText testId="work-new-project-problem">{problem}</ErrorText>
        </div>
        <div className="w-new__field">
          <label htmlFor={`${id}-s`}>Objetivo (opcional)</label>
          <textarea id={`${id}-s`} className="ui-input" rows={3} value={summary} placeholder="O que este projeto precisa entregar" onChange={(event) => setSummary(event.currentTarget.value)} data-testid="work-new-project-summary" />
        </div>
        <div className="w-new__row">
          <div className="w-new__field">
            <label htmlFor={`${id}-d`}>Prazo (opcional){brasiliaNote()}</label>
            <input id={`${id}-d`} className="ui-input" type="datetime-local" value={due} onChange={(event) => setDue(event.currentTarget.value)} data-testid="work-new-project-due" />
          </div>
          <div className="w-new__field">
            <label htmlFor={`${id}-p`}>Prioridade</label>
            <select id={`${id}-p`} className="ui-input" value={priority} onChange={(event) => setPriority(event.currentTarget.value as ProjectPriority)} data-testid="work-new-project-priority">
              {PROJECT_PRIORITIES.map((value) => (
                <option key={value} value={value}>
                  {PROJECT_PRIORITY_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="w-new__hint">O projeto começa vazio e em andamento. Crie os módulos e as tarefas na árvore e escolha quem faz cada uma.</p>
        <ErrorText testId="work-new-project-error">{error}</ErrorText>
        <div className="ui-actions">
          <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="ui-button" disabled={pending} data-testid="work-new-project-create">
            {pending ? "Criando…" : "Criar projeto"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
