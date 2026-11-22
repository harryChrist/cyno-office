import { isProjectOpen, PROJECT_PRIORITIES, PROJECT_PRIORITY_LABELS, type Pace, type Project, type ProjectPriority } from "@cyno/shared";
import { useId, useState } from "react";
import { api, ApiRequestError, describeError, type ProjectPatch } from "../../api/client";
import { ConfirmDialog, ErrorText } from "../../ui/widgets";
import { canCompleteProject, canReopenProject, COMPLETE_PROJECT_MESSAGE, COMPLETE_PROJECT_TITLE } from "./projectLifecycleView";
import { syncProjectResponse } from "./useTaskActions";
import { hoursLabel } from "./workView";
import { brasiliaNote, fromBrasiliaInput, toBrasiliaInput } from "./workTime";

/** Os campos de data valem no horário de Brasília (veja workTime.ts). */
export { fromBrasiliaInput as fromLocalInput, toBrasiliaInput as toLocalInput } from "./workTime";

/** "Disponível em breve" quando a rota de edição ainda não existe no servidor (404). */
export function patchErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError && (error.status === 404 || error.status === 405)) return "Disponível em breve.";
  return describeError(error);
}

/** Manda uma edição do projeto e aplica a resposta no store local na hora (o evento project:upserted mantém igual). */
function usePatch(project: Project) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runAction = async (call: () => Promise<{ project: Project }>): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      syncProjectResponse(await call());
      return true;
    } catch (caught) {
      setError(patchErrorMessage(caught));
      return false;
    } finally {
      setPending(false);
    }
  };
  const patch = (body: ProjectPatch): Promise<boolean> => runAction(() => api.updateProject(project.id, body));
  const reopen = (): Promise<boolean> => runAction(() => api.reopenProject(project.id));
  return { pending, error, patch, reopen };
}

function PaceForm({ project, onSave, onCancel, pending }: { project: Project; onSave: (pace: Pace | null) => void; onCancel: () => void; pending: boolean }) {
  const id = useId();
  const pace = project.pace;
  const [hours, setHours] = useState(pace?.hoursPerDay !== undefined ? String(pace.hoursPerDay) : "");
  const [from, setFrom] = useState(pace?.window?.from ?? "");
  const [to, setTo] = useState(pace?.window?.to ?? "");
  const [parallel, setParallel] = useState(pace?.maxParallel !== undefined ? String(pace.maxParallel) : "");
  const [problem, setProblem] = useState<string | null>(null);
  const save = () => {
    const next: Pace = {};
    if (hours.trim()) {
      const value = Number(hours.replace(",", "."));
      if (!Number.isFinite(value) || value <= 0 || value > 24) return setProblem("Horas por dia: um número entre 0,1 e 24.");
      next.hoursPerDay = value;
    }
    if (from || to) {
      if (!from || !to) return setProblem("Janela: preencha o começo e o fim.");
      next.window = { from, to };
    }
    if (parallel.trim()) {
      const value = Number(parallel);
      if (!Number.isInteger(value) || value < 1 || value > 10) return setProblem("Em paralelo: um número inteiro de 1 a 10.");
      next.maxParallel = value;
    }
    setProblem(null);
    onSave(Object.keys(next).length > 0 ? next : null);
  };
  return (
    <div className="w-pace" data-testid="work-pace-form">
      <label htmlFor={`${id}-h`}>
        Horas por dia
        <input id={`${id}-h`} className="ui-input ui-input--compact" inputMode="decimal" value={hours} placeholder="ex.: 1,5" onChange={(event) => setHours(event.currentTarget.value)} />
      </label>
      <label htmlFor={`${id}-f`}>
        Das{brasiliaNote()}
        <input id={`${id}-f`} className="ui-input ui-input--compact" type="time" value={from} onChange={(event) => setFrom(event.currentTarget.value)} />
      </label>
      <label htmlFor={`${id}-t`}>
        Às
        <input id={`${id}-t`} className="ui-input ui-input--compact" type="time" value={to} onChange={(event) => setTo(event.currentTarget.value)} />
      </label>
      <label htmlFor={`${id}-p`}>
        Em paralelo
        <input id={`${id}-p`} className="ui-input ui-input--compact" inputMode="numeric" value={parallel} placeholder="ex.: 2" onChange={(event) => setParallel(event.currentTarget.value)} />
      </label>
      <div className="w-pace__actions">
        <button type="button" className="ui-button ui-button--small" disabled={pending} onClick={save} data-testid="work-pace-save">
          Salvar ritmo
        </button>
        {pace && (
          <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={pending} onClick={() => onSave(null)}>
            Tirar o ritmo
          </button>
        )}
        <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={onCancel}>
          Fechar
        </button>
      </div>
      {problem && <ErrorText>{problem}</ErrorText>}
    </div>
  );
}

/** Resumo do ritmo configurado ("1,5 h/dia · 09:00–12:00 · 2 em paralelo"). */
export function paceSummary(pace: Pace | undefined): string {
  if (!pace) return "sem ritmo";
  const parts = [
    pace.hoursPerDay !== undefined ? `${hoursLabel(pace.hoursPerDay)} h/dia` : "",
    pace.window ? `${pace.window.from}–${pace.window.to}` : "",
    pace.maxParallel !== undefined ? `${pace.maxParallel} em paralelo` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "sem ritmo";
}

/**
 * Ações do projeto: Pausar/Retomar, Prioridade, Prazo, Começa em, Ritmo e Cancelar. A edição vai por
 * `PATCH /projects/:id` (Fatia 4; num servidor antigo, que responde 404, a tela diz "Disponível em breve").
 */
export function ProjectControls({ project, slim = false }: { project: Project; slim?: boolean }) {
  const { pending, error, patch, reopen } = usePatch(project);
  const [paceOpen, setPaceOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [completing, setCompleting] = useState(false);
  const id = useId();
  const open = isProjectOpen(project);
  const planPending = project.status === "proposto" || project.status === "ajustando";
  if (!open) {
    if (slim || !canReopenProject(project)) return null;
    return (
      <div className="w-controls" data-testid="work-controls">
        <div className="w-controls__row">
          <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={pending} onClick={() => void reopen()} data-testid="project-reopen">
            {pending ? "Reabrindo…" : "Reabrir projeto"}
          </button>
        </div>
        <ErrorText testId="work-controls-error">{error}</ErrorText>
      </div>
    );
  }
  return (
    <div className="w-controls" data-testid="work-controls">
      <div className="w-controls__row">
        {!planPending && !slim && (
          <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={pending} onClick={() => void patch({ status: project.status === "pausado" ? "ativo" : "pausado" })} data-testid="work-pause">
            {project.status === "pausado" ? "Retomar" : "Pausar"}
          </button>
        )}
        {!slim && canCompleteProject(project) && (
          <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={pending} onClick={() => setCompleting(true)} data-testid="project-complete">
            Concluir projeto
          </button>
        )}
        {!slim && (
        <label className="w-controls__field" htmlFor={`${id}-p`}>
          <span>Prioridade</span>
          <select id={`${id}-p`} className="ui-input ui-input--compact" value={project.priority} disabled={pending} onChange={(event) => void patch({ priority: event.currentTarget.value as ProjectPriority })} data-testid="work-priority">
            {PROJECT_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {PROJECT_PRIORITY_LABELS[priority]}
              </option>
            ))}
          </select>
        </label>
        )}
        {!slim && (
        <label className="w-controls__field" htmlFor={`${id}-d`}>
          <span>Prazo{brasiliaNote()}</span>
          <input id={`${id}-d`} className="ui-input ui-input--compact" type="datetime-local" value={toBrasiliaInput(project.dueAt)} disabled={pending} onChange={(event) => void patch({ dueAt: fromBrasiliaInput(event.currentTarget.value) })} data-testid="work-due" />
        </label>
        )}
        <label className="w-controls__field" htmlFor={`${id}-s`}>
          <span>Começa em{brasiliaNote()}</span>
          <input id={`${id}-s`} className="ui-input ui-input--compact" type="datetime-local" value={toBrasiliaInput(project.startAt)} disabled={pending} onChange={(event) => void patch({ startAt: fromBrasiliaInput(event.currentTarget.value) })} data-testid="work-start" />
        </label>
        <button type="button" className="ui-button ui-button--secondary ui-button--small" aria-expanded={paceOpen} onClick={() => setPaceOpen((current) => !current)} data-testid="work-pace">
          Ritmo · {paceSummary(project.pace)}
        </button>
        <span className="w-grow" />
        <button type="button" className="ui-button ui-button--danger ui-button--small" disabled={pending} onClick={() => setCancelling(true)} data-testid="work-cancel">
          Cancelar
        </button>
      </div>
      {paceOpen && (
        <PaceForm
          project={project}
          pending={pending}
          onCancel={() => setPaceOpen(false)}
          onSave={(pace) =>
            void patch({ pace }).then((ok) => {
              if (ok) setPaceOpen(false);
            })
          }
        />
      )}
      <ErrorText testId="work-controls-error">{error}</ErrorText>
      {completing && (
        <ConfirmDialog
          title={COMPLETE_PROJECT_TITLE}
          message={<p>{COMPLETE_PROJECT_MESSAGE}</p>}
          confirmLabel="Concluir projeto"
          pendingLabel="Concluindo…"
          tone="success"
          onConfirm={async () => {
            syncProjectResponse(await api.completeProject(project.id));
          }}
          onClose={() => setCompleting(false)}
          testId="project-complete-dialog"
        />
      )}
      {cancelling && (
        <ConfirmDialog
          title={project.kind === "tarefa" ? "Cancelar a tarefa?" : "Cancelar o projeto?"}
          message={<p>As etapas que ainda não terminaram param. O que já foi entregue fica no histórico.</p>}
          confirmLabel={project.kind === "tarefa" ? "Cancelar a tarefa" : "Cancelar o projeto"}
          pendingLabel="Cancelando…"
          onConfirm={() => (project.status === "proposto" ? api.cancelPlan(project.id) : api.closeRequest(project.id, "cancelar"))}
          onClose={() => setCancelling(false)}
          testId="work-cancel-dialog"
        />
      )}
    </div>
  );
}
