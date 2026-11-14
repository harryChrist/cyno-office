import { PROJECT_PRIORITIES, PROJECT_PRIORITY_LABELS, type ProjectPriority } from "@cyno/shared";
import { useId, useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { validateMessage } from "../../ui/validation";
import { ErrorText, Modal } from "../../ui/widgets";
import { brasiliaNote, fromBrasiliaInput } from "./workTime";
import { newWorkMessage } from "./workView";

/**
 * Botão Novo: um formulário curto que manda o pedido ao Maestro (o mesmo caminho da conversa, `POST /maestro/messages`),
 * em texto estruturado. É o Maestro que monta o plano: esta tela nunca cria Projeto sozinha.
 */
export function NewWorkDialog({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const id = useId();
  const { pending, error, run } = useAsyncAction();
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"projeto" | "tarefa">("tarefa");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState<ProjectPriority>("normal");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const invalid = validateMessage(text);
    setProblem(invalid ?? null);
    if (invalid) return;
    const dueAt = fromBrasiliaInput(due) ?? undefined;
    const message = newWorkMessage({ text, kind, priority, ...(dueAt ? { dueAt } : {}) });
    const sent = await run(() => api.talkToMaestro(message));
    if (!sent) return;
    onSent();
    onClose();
  };

  return (
    <Modal title="Novo" onClose={onClose} testId="work-new-dialog">
      <form className="w-new" onSubmit={(event) => void submit(event)}>
        <div className="w-new__field">
          <label htmlFor={`${id}-t`}>O que fazer</label>
          <textarea
            id={`${id}-t`}
            className="ui-input"
            rows={4}
            value={text}
            placeholder="Ex.: preparar os 5 posts da semana sobre o lançamento"
            aria-invalid={problem ? true : undefined}
            onChange={(event) => {
              setText(event.currentTarget.value);
              setProblem(null);
            }}
            autoFocus
            data-testid="work-new-text"
          />
          <ErrorText testId="work-new-problem">{problem}</ErrorText>
        </div>
        <fieldset className="w-new__field w-new__kind">
          <legend>Tipo</legend>
          <label className={`w-radio${kind === "tarefa" ? " w-radio--on" : ""}`}>
            <input type="radio" name={`${id}-k`} checked={kind === "tarefa"} onChange={() => setKind("tarefa")} data-testid="work-new-tarefa" />
            <span>
              <strong>Tarefa</strong>
              <small>Uma coisa só, com um agente.</small>
            </span>
          </label>
          <label className={`w-radio${kind === "projeto" ? " w-radio--on" : ""}`}>
            <input type="radio" name={`${id}-k`} checked={kind === "projeto"} onChange={() => setKind("projeto")} data-testid="work-new-projeto" />
            <span>
              <strong>Projeto</strong>
              <small>Várias tarefas; o Maestro monta o plano e você aprova.</small>
            </span>
          </label>
        </fieldset>
        <div className="w-new__row">
          <div className="w-new__field">
            <label htmlFor={`${id}-d`}>Prazo (opcional){brasiliaNote()}</label>
            <input id={`${id}-d`} className="ui-input" type="datetime-local" value={due} onChange={(event) => setDue(event.currentTarget.value)} data-testid="work-new-due" />
          </div>
          <div className="w-new__field">
            <label htmlFor={`${id}-p`}>Prioridade</label>
            <select id={`${id}-p`} className="ui-input" value={priority} onChange={(event) => setPriority(event.currentTarget.value as ProjectPriority)} data-testid="work-new-priority">
              {PROJECT_PRIORITIES.map((value) => (
                <option key={value} value={value}>
                  {PROJECT_PRIORITY_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="w-new__hint">O pedido vai para o Maestro, que cria o {kind === "projeto" ? "plano (você aprova antes de começar)" : "trabalho e escolhe o agente"}.</p>
        <ErrorText testId="work-new-error">{error}</ErrorText>
        <div className="ui-actions">
          <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="ui-button" disabled={pending} data-testid="work-new-send">
            {pending ? "Enviando…" : "Enviar ao Maestro"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
