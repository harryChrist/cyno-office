import type { Agent, Project, ProjectTask } from "@cyno/shared";
import { useId, useMemo, useState } from "react";
import { Markdown } from "../../ui/markdown/Markdown";
import { Modal, ErrorText } from "../../ui/widgets";
import { AgentAvatar } from "./Agent";
import { dependsChoices, flowItems } from "./flowView";
import { StatusIcon } from "./treeParts";
import type { TaskActions } from "./useTaskActions";

const noWiki = () => null;

/**
 * "Fluxo" no painel da tarefa-mãe: as subtarefas em ordem, cada uma com o responsável, o estado e as setas de
 * quem ela espera. Clicar numa subtarefa mostra o que ela entregou. Lista simples, sem biblioteca de grafo.
 */
export function FlowBlock({ project, mother, agents, onSelect }: { project: Project; mother: ProjectTask; agents: ReadonlyMap<string, Agent>; onSelect: (ref: string) => void }) {
  const items = useMemo(() => flowItems(project, mother.ref, (id) => agents.get(id)?.name ?? id), [project, mother.ref, agents]);
  const [open, setOpen] = useState<string | null>(null);
  if (items.length === 0) return null;
  const finals = items.filter((item) => item.final);
  return (
    <section className="tp__section" aria-label="Fluxo" data-testid="task-panel-flow">
      <h3 className="tp__h">
        Fluxo <span className="tp__count">{items.length} subtarefas</span>
      </h3>
      <ol className="fl-list">
        {items.map((item, index) => {
          const shown = open === item.ref;
          return (
            <li key={item.ref} className={`fl-item fl-item--${item.status}`} data-testid={`flow-item-${item.ref}`} data-status={item.status}>
              <span className="fl-num" aria-hidden="true">
                {index + 1}
              </span>
              <div className="fl-main">
                <button type="button" className="fl-head" onClick={() => setOpen(shown ? null : item.ref)} aria-expanded={shown} title={item.result ? "Ver o que entregou" : item.title}>
                  <StatusIcon status={item.status} />
                  <AgentAvatar agent={agents.get(item.ownerId)} size={20} />
                  <span className="fl-who">{item.ownerName}</span>
                  <span className="fl-title">{item.title}</span>
                  {item.final && <span className="fl-final" title="A entrega desta tarefa vem daqui">entrega</span>}
                </button>
                <p className="fl-line">
                  {item.after.length > 0 && (
                    <span className="fl-after">
                      ← {item.after.map((dep, position) => (
                        <span key={dep.ref} className={dep.done ? "fl-dep fl-dep--done" : "fl-dep"}>
                          {position > 0 ? " e " : ""}
                          {dep.label}
                        </span>
                      ))}
                    </span>
                  )}
                  {item.text && <span className="fl-text">{item.text}</span>}
                </p>
                {shown && (
                  <div className="fl-result" data-testid={`flow-result-${item.ref}`}>
                    {item.result ? (
                      <Markdown source={item.result} resolveWiki={noWiki} headingOffset={4} className="md--compact" />
                    ) : (
                      <p className="tp__text">Ainda não entregou.</p>
                    )}
                    <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={() => onSelect(item.ref)}>
                      Abrir a subtarefa
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {finals.length > 0 && <p className="tp__hint">A tarefa conclui quando todas terminam; a entrega dela é {finals.length === 1 ? `a de ${finals[0]!.ownerName}` : `o conjunto (${finals.map((item) => item.ownerName).join(", ")})`}.</p>}
    </section>
  );
}

/** "Depois de": as irmãs que esta tarefa espera (marcar acrescenta, desmarcar tira). Só antes de a tarefa começar. */
export function DependsField({ project, task, agents, actions, locked }: { project: Project; task: ProjectTask; agents: ReadonlyMap<string, Agent>; actions: TaskActions; locked: boolean }) {
  const choices = useMemo(() => dependsChoices(project, task), [project, task]);
  const legend = useId();
  if (choices.length === 0 && task.dependsOn.length === 0) return null;
  const toggle = (ref: string, on: boolean) => void actions.update(task.ref, { dependsOn: on ? [...task.dependsOn, ref] : task.dependsOn.filter((dep) => dep !== ref) });
  return (
    <fieldset className="tp__field tp__field--wide fl-depends" aria-labelledby={legend} data-testid="task-panel-depends" disabled={locked || actions.busy}>
      <legend id={legend}>Depois de</legend>
      {choices.map((choice) => (
        <label key={choice.ref} className="fl-check">
          <input type="checkbox" checked={choice.checked} onChange={(event) => toggle(choice.ref, event.currentTarget.checked)} data-testid={`task-panel-depends-${choice.ref}`} />
          <AgentAvatar agent={agents.get(choice.ownerId)} size={18} />
          <span>
            {choice.ownerId ? <b>{agents.get(choice.ownerId)?.name ?? choice.ownerId} · </b> : null}{choice.title}
          </span>
        </label>
      ))}
      <small className="tp__hint">{locked ? "A tarefa já começou: de quem ela espera não muda." : "Ela só começa quando todas as marcadas terminarem, e recebe a entrega delas."}</small>
    </fieldset>
  );
}

/** Janela "Nova subtarefa": título, o que fazer, responsável e "depois de" (uma ou mais irmãs). */
export function AddSubtaskDialog({ project, parentRef, workers, actions, onClose, onCreated }: { project: Project; parentRef: string; workers: readonly Agent[]; actions: TaskActions; onClose: () => void; onCreated: (ref: string) => void }) {
  const parent = project.tasks.find((task) => task.ref === parentRef);
  const siblings = useMemo(() => dependsChoices(project, { ref: "", parent: parentRef, dependsOn: [] }), [project, parentRef]);
  const [title, setTitle] = useState("");
  const [briefing, setBriefing] = useState("");
  const [assignee, setAssignee] = useState("");
  const [after, setAfter] = useState<string[]>([]);
  const ready = title.trim().length > 0 && !actions.busy;
  const submit = async () => {
    if (!ready) return;
    const ref = await actions.create({
      title: title.trim(),
      parent: parentRef,
      ...(briefing.trim() ? { briefing: briefing.trim() } : {}),
      ...(assignee ? { assignee } : {}),
      ...(after.length > 0 ? { dependsOn: after } : {}),
    });
    if (ref) {
      onCreated(ref);
      onClose();
    }
  };
  return (
    <Modal title={`Nova subtarefa em “${parent?.title ?? parentRef}”`} onClose={onClose} testId="add-subtask-dialog">
      <form
        className="fl-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="tp__field">
          <span>Título</span>
          <input className="ui-input" value={title} maxLength={120} autoFocus onChange={(event) => setTitle(event.currentTarget.value)} placeholder="Ex.: Criar os textos" data-testid="add-subtask-title" />
        </label>
        <label className="tp__field">
          <span>O que fazer</span>
          <textarea className="ui-input" rows={3} value={briefing} onChange={(event) => setBriefing(event.currentTarget.value)} placeholder="O que essa pessoa faz e o que ela recebe de quem veio antes" data-testid="add-subtask-briefing" />
        </label>
        <label className="tp__field">
          <span>Responsável</span>
          <select className="ui-input" value={assignee} onChange={(event) => setAssignee(event.currentTarget.value)} data-testid="add-subtask-assignee">
            <option value="">Sem responsável (fica no backlog)</option>
            {workers.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name} · {agent.role}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="tp__field fl-depends" data-testid="add-subtask-after">
          <legend>Depois de</legend>
          {siblings.length === 0 ? (
            <small className="tp__hint">Esta é a primeira subtarefa: não há outra para esperar.</small>
          ) : (
            <>
              {siblings.map((choice) => (
                <label key={choice.ref} className="fl-check">
                  <input type="checkbox" checked={after.includes(choice.ref)} onChange={(event) => setAfter(event.currentTarget.checked ? [...after, choice.ref] : after.filter((ref) => ref !== choice.ref))} data-testid={`add-subtask-after-${choice.ref}`} />
                  <AgentAvatar agent={workers.find((agent) => agent.id === choice.ownerId)} size={18} />
                  <span>
                    {choice.ownerId ? <b>{workers.find((agent) => agent.id === choice.ownerId)?.name ?? choice.ownerId} · </b> : null}{choice.title}
                  </span>
                </label>
              ))}
              <small className="tp__hint">Sem marcar nenhuma, ela começa junto com as outras. Marcando, espera as escolhidas e recebe a entrega delas.</small>
            </>
          )}
        </fieldset>
        <ErrorText>{actions.error}</ErrorText>
        <div className="ui-actions">
          <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="ui-button" disabled={!ready} data-testid="add-subtask-confirm">
            {actions.busy ? "Criando…" : "Criar subtarefa"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
