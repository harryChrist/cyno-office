import type { Agent, ForYouItem, Project } from "@cyno/shared";
import { useCallback, useMemo, useState } from "react";
import { useNavStore } from "../../store/navStore";
import { ProgressBar } from "../../ui/widgets";
import { NewProjectDialog } from "./NewProjectDialog";
import { NewWorkDialog } from "./NewWorkDialog";
import { PROJECT_GROUP_TITLES, buildProjectGroups, onlyAtRisk, openText, readOpenGroups, waitingText, writeOpenGroups, type ProjectEntry, type ProjectGroupId } from "./projectsView";
import { AvatarStack, PriorityFlag } from "./treeParts";
import { WorkTabs } from "./WorkTabs";
import { workSub } from "./workRoute";
import { useOfficeStore } from "../../store/officeStore";

type HomeProps = {
  projects: readonly Project[];
  forYou: readonly ForYouItem[] | null;
  agents: ReadonlyMap<string, Agent>;
  now: number;
  /** "Prazo em risco" vindo da Gestão: abre a entrada já filtrada. */
  atRiskOnly: boolean;
  onClearAtRisk: () => void;
  assembling: number;
};

const open = (projectId: string) => useNavStore.getState().go("trabalho", workSub({ view: "project", projectId, tab: "tarefas" }));

/** A entrada de "Projetos e tarefas": só os projetos, em grupos que abrem e fecham, e o Avulsas como projeto fixo no fim. */
export function ProjectsHome({ projects, forYou, agents, now, atRiskOnly, onClearAtRisk, assembling }: HomeProps) {
  const [openGroups, setOpenGroups] = useState<Set<ProjectGroupId>>(() => readOpenGroups());
  const [creating, setCreating] = useState(false);
  const [asking, setAsking] = useState(false);
  const [sent, setSent] = useState(false);
  const status = useOfficeStore((state) => state.status);
  const loading = useOfficeStore((state) => state.office) === null;

  const all = useMemo(() => buildProjectGroups(projects, forYou, now), [projects, forYou, now]);
  const groups = atRiskOnly ? onlyAtRisk(all) : all;
  const toggle = useCallback((id: ProjectGroupId) => {
    setOpenGroups((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      writeOpenGroups(next);
      return next;
    });
  }, []);
  const none = all.progresso.length + all.fila.length + all.concluidos.length === 0 && all.avulsas === null;

  return (
    <>
      <header className="page__header page__header--row">
        <div className="page__heading">
          <h2 id="page-title-trabalho" className="page__title">
            Projetos e tarefas
          </h2>
          <p className="page__subtitle">Os projetos do time: o que anda, quem cuida e o que espera você. Clique num projeto para ver as tarefas.</p>
        </div>
        <div className="page__actions">
          <button type="button" className="ui-button ui-button--secondary" onClick={() => setAsking(true)} data-testid="work-new">
            Pedir ao Maestro
          </button>
          <button type="button" className="ui-button" onClick={() => setCreating(true)} data-testid="work-new-project">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M8 3v10M3 8h10" />
            </svg>
            Novo projeto
          </button>
        </div>
      </header>
      <WorkTabs active="projetos" />

      {sent && (
        <p className="w-notice" role="status" data-testid="work-sent">
          Pedido enviado ao Maestro. O projeto aparece aqui assim que ele montar o plano.
        </p>
      )}
      {!loading && assembling > 0 && !none && (
        <p className="w-notice" role="status" data-testid="work-assembling">
          Maestro montando o projeto… ({assembling === 1 ? "1 pedido" : `${assembling} pedidos`} em preparo)
        </p>
      )}
      {atRiskOnly && (
        <p className="w-notice w-notice--filter" role="status" data-testid="work-atrisk">
          Mostrando só os projetos com prazo em risco.
          <button type="button" className="ui-link" onClick={onClearAtRisk}>
            Ver todos
          </button>
        </p>
      )}

      {loading ? (
        <div className="page__body">
          <p className="page__empty">{status === "error" ? "Não deu para carregar o trabalho." : "Carregando o trabalho…"}</p>
        </div>
      ) : none ? (
        <div className="w-body">
          <div className="w-empty" data-testid="work-empty">
            <p className="w-empty__title">{assembling > 0 ? "Maestro montando o projeto…" : "Nenhum projeto ainda."}</p>
            <p className="w-empty__text">{assembling > 0 ? "Ele está organizando o pedido; o projeto aparece aqui assim que sair o plano." : "Peça ao Maestro ou crie um projeto à mão."}</p>
            <button type="button" className="ui-button" onClick={() => setCreating(true)}>
              Novo projeto
            </button>
          </div>
        </div>
      ) : (
        <div className="w-body ph" data-testid="projects-home">
          <div className="ph-head" aria-hidden="true">
            <span>Projeto</span>
            <span>Progresso</span>
            <span>Agentes</span>
            <span>Prazo</span>
            <span>Prioridade</span>
            <span>Espera você</span>
          </div>
          {(["progresso", "fila", "concluidos"] as const).map((id) => {
            const entries = groups[id];
            // Só o grupo Em progresso aparece vazio (é onde o dono procura); Na fila e Concluídos somem quando não há nada neles.
            if (entries.length === 0 && (id !== "progresso" || atRiskOnly)) return null;
            const isOpen = openGroups.has(id);
            return (
              <section key={id} className={`ph-group ph-group--${id}`} data-testid={`projects-group-${id}`}>
                <h3 className="ph-group__title">
                  <button type="button" className="ph-group__toggle" aria-expanded={isOpen} onClick={() => toggle(id)} data-testid={`projects-group-toggle-${id}`}>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" style={{ transform: isOpen ? "rotate(90deg)" : undefined }}>
                      <path d="M4 2l5 4-5 4z" />
                    </svg>
                    {PROJECT_GROUP_TITLES[id]}
                    <span className="ph-group__count">{entries.length}</span>
                  </button>
                </h3>
                {isOpen &&
                  (entries.length === 0 ? (
                    <p className="ph-none">Nenhum projeto aqui.</p>
                  ) : (
                    <ul className="ph-list">
                      {entries.map((entry) => (
                        <ProjectRow key={entry.project.id} entry={entry} agents={agents} />
                      ))}
                    </ul>
                  ))}
              </section>
            );
          })}
          {groups.avulsas && (
            <section className="ph-group ph-group--avulsas" data-testid="projects-group-avulsas">
              <ul className="ph-list">
                <ProjectRow entry={groups.avulsas} agents={agents} />
              </ul>
            </section>
          )}
        </div>
      )}
      {creating && <NewProjectDialog onClose={() => setCreating(false)} onCreated={open} />}
      {asking && <NewWorkDialog onClose={() => setAsking(false)} onSent={() => setSent(true)} />}
    </>
  );
}

function ProjectRow({ entry, agents }: { entry: ProjectEntry; agents: ReadonlyMap<string, Agent> }) {
  const { project } = entry;
  const fixed = entry.group === "avulsas";
  const ratio = entry.progress.total > 0 ? entry.progress.done / entry.progress.total : 0;
  return (
    <li>
      <button
        type="button"
        className={`ph-row${fixed ? " ph-row--avulsas" : ""}${entry.group === "concluidos" ? " ph-row--closed" : ""}`}
        onClick={() => open(project.id)}
        data-testid={`work-row-${project.id}`}
        data-project-id={project.id}
        data-status={project.status}
      >
        <span className="ph-name">
          <span className="ph-name__title">{project.title}</span>
          <span className="ph-name__tags">
            {fixed ? (
              <span className="ph-state ph-state--fixed">Projeto fixo</span>
            ) : (
              <span className={`ph-state ph-state--${entry.state.tone}`} data-testid="work-row-state">
                {entry.state.label}
              </span>
            )}
            {entry.unreleased && (
              <span className="ph-state ph-state--planned" data-testid={`work-row-planned-${project.id}`}>
                Planejado
              </span>
            )}
            {project.origin === "cyno" && <span className="w-kind w-kind--cyno">Pedido pelo Cyno</span>}
            {project.joint && <span className="w-kind w-kind--cyno">Projeto conjunto</span>}
            {project.mode.kind === "automatico" && !fixed && <span className="w-kind w-kind--auto">Automático</span>}
            {entry.sprint && (
              <span className="ph-sprint" title="A sprint em andamento" data-testid={`work-row-sprint-${project.id}`}>
                {entry.sprint}
              </span>
            )}
          </span>
        </span>
        <span className="ph-progress" data-testid="work-row-progress">
          {fixed ? (
            <span className="ph-open">{openText(entry.open)}</span>
          ) : entry.progress.total === 0 ? (
            <span className="ph-none">Sem tarefas</span>
          ) : (
            <>
              <ProgressBar value={ratio} label={entry.progress.unit === "modulos" ? "Módulos concluídos" : "Tarefas concluídas"} />
              <span className="ph-progress__text">{entry.progressText}</span>
            </>
          )}
        </span>
        <span className="ph-agents">
          <AvatarStack ids={entry.agents} more={entry.moreAgents} agents={agents} empty="Sem agentes ainda" />
        </span>
        <span className={`ph-due${entry.deadline ? ` ph-due--${entry.deadline.state}` : ""}`} data-testid="work-row-due">
          {entry.deadline ? entry.deadline.label : project.dueAt && entry.group === "concluidos" ? "" : <span className="tt-none">—</span>}
        </span>
        <span className="ph-prio">{fixed ? <span className="tt-none">—</span> : <PriorityFlag priority={entry.priority} />}</span>
        <span className="ph-wait">
          {entry.waiting > 0 ? (
            <span className="tt-badge tt-badge--wait" data-testid={`work-row-wait-${project.id}`}>
              {waitingText(entry.waiting)}
            </span>
          ) : (
            <span className="tt-none">—</span>
          )}
        </span>
      </button>
    </li>
  );
}
