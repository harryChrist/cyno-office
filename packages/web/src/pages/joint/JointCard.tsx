import type { JointPartView, JointView, Project } from "@cyno/shared";
import { useEffect, useState } from "react";
import { useCynoStore } from "../../store/cynoStore";
import { openRequestProject } from "../cyno/cynoRequests";
import { canRetry, isJointOpen, jointProgress, jointStatusLabel, partLabel, partTone, receivedLine, waitingLine } from "./jointView";
import "./joint.css";

/** Uma parte do projeto conjunto: o workspace, o título, o estado e o que mais importa agora. */
function PartRow({ joint, part, last, editable }: { joint: JointView; part: JointPartView; last: boolean; editable: boolean }) {
  const jointAction = useCynoStore((state) => state.jointAction);
  const tone = partTone(part.state);
  const waiting = waitingLine(joint, part);
  const received = receivedLine(joint, part);
  return (
    <li className={`jpart jpart--${tone}${last ? " jpart--last" : ""}`} data-testid="joint-part" data-ref={part.ref} data-state={part.state}>
      <span className="jpart__dot" aria-hidden="true">
        {part.state === "concluida" ? "✓" : part.ref}
      </span>
      <span className="jpart__body">
        <span className="jpart__line">
          <span className="jpart__ws">{part.workspaceName}</span>
          <span className="jpart__title">{part.title}</span>
        </span>
        <span className="jpart__meta">
          <span className={`jpart__state jpart__state--${tone}`} data-testid="joint-part-state">
            {partLabel(part)}
          </span>
          {waiting && <span className="jpart__wait">{waiting}</span>}
          {part.stage && part.state !== "concluida" && <span className="jpart__stage">{part.stage}</span>}
          {part.tasksTotal ? <span className="jpart__stage">{`${part.tasksDone}/${part.tasksTotal} tarefas`}</span> : null}
        </span>
        {received && (
          <span className="jpart__received" data-testid="joint-received">
            {received}
          </span>
        )}
        {part.blockedReason && part.state !== "esperando" && part.state !== "concluida" && <span className="jpart__reason">{part.blockedReason}</span>}
        {editable && canRetry(joint, part) && (
          <button type="button" className="ui-button ui-button--secondary jpart__retry" onClick={() => void jointAction(joint.id, "retry", part.ref)} data-testid="joint-retry">
            Refazer a parte {part.ref}
          </button>
        )}
      </span>
      {part.projectId && (
        <button type="button" className="jpart__open" onClick={() => openRequestProject(part.workspace, part.projectId!)} aria-label={`Abrir ${part.title} em Projetos e tarefas de ${part.workspaceName}`} data-testid="joint-open">
          Abrir ↗
        </button>
      )}
    </li>
  );
}

/**
 * O cartão do projeto conjunto, ao vivo (o estado vem da lista de projetos conjuntos, calculado por
 * código): as partes em sequência, por workspace, com o estado de cada uma e "esperando a parte X". O dono
 * pausa, retoma ou cancela o conjunto; numa parte que falhou, refaz.
 */
export function JointCard({ jointId, fallbackTitle, compact = false }: { jointId: string; fallbackTitle?: string; compact?: boolean }) {
  const joint = useCynoStore((state) => state.joints.find((candidate) => candidate.id === jointId));
  const jointAction = useCynoStore((state) => state.jointAction);
  const [confirming, setConfirming] = useState(false);
  if (!joint) {
    return (
      <div className="jcard jcard--gone" data-testid="joint-card">
        <span className="jcard__title">Projeto conjunto{fallbackTitle ? ` · ${fallbackTitle}` : ""}</span>
      </div>
    );
  }
  const open = isJointOpen(joint);
  const tone = joint.status === "travado" ? "bad" : joint.status === "concluido" ? "ok" : joint.status === "cancelado" || joint.paused ? "idle" : "info";
  return (
    <section className={`jcard jcard--${tone}${compact ? " jcard--compact" : ""}`} aria-label={`Projeto conjunto ${joint.title}`} data-testid="joint-card" data-joint-id={joint.id} data-status={joint.status}>
      <header className="jcard__head">
        <span className="jcard__eyebrow">Projeto conjunto</span>
        <h4 className="jcard__title">{joint.title}</h4>
        <span className="jcard__summary">
          <span className={`jcard__status jcard__status--${tone}`} data-testid="joint-status">
            {jointStatusLabel(joint)}
          </span>
          <span className="jcard__progress">{jointProgress(joint)}</span>
        </span>
      </header>
      <ol className="jcard__parts">
        {joint.parts.map((part, index) => (
          <PartRow key={part.ref} joint={joint} part={part} last={index === joint.parts.length - 1} editable={open} />
        ))}
      </ol>
      {open && (
        <footer className="jcard__actions">
          {confirming ? (
            <>
              <span className="jcard__ask">Cancelar o projeto inteiro?</span>
              <button type="button" className="ui-button ui-button--ghost" onClick={() => setConfirming(false)}>
                Não
              </button>
              <button
                type="button"
                className="ui-button ui-button--danger"
                onClick={() => {
                  setConfirming(false);
                  void jointAction(joint.id, "cancel");
                }}
                data-testid="joint-cancel-confirm"
              >
                Sim, cancelar
              </button>
            </>
          ) : (
            <>
              {joint.status === "ativo" && (
                <button type="button" className="ui-button ui-button--ghost" onClick={() => void jointAction(joint.id, joint.paused ? "resume" : "pause")} data-testid="joint-pause">
                  {joint.paused ? "Retomar" : "Pausar"}
                </button>
              )}
              <button type="button" className="ui-button ui-button--ghost" onClick={() => setConfirming(true)} data-testid="joint-cancel">
                Cancelar projeto
              </button>
            </>
          )}
        </footer>
      )}
    </section>
  );
}

/**
 * Na tela Trabalho, um projeto que é parte de um conjunto mostra "Parte de um projeto conjunto" com o
 * conjunto inteiro (as outras partes, com link) e o que veio da parte anterior. Os dados vêm da lista de
 * projetos conjuntos da plataforma (buscada ao abrir e quando o projeto muda).
 */
export function JointPartPanel({ project }: { project: Pick<Project, "id" | "joint" | "updatedAt"> }) {
  const jointId = project.joint?.id;
  const known = useCynoStore((state) => state.joints.some((candidate) => candidate.id === jointId));
  useEffect(() => {
    if (jointId) void useCynoStore.getState().loadJoints();
  }, [jointId, project.updatedAt]);
  const joint = useCynoStore((state) => state.joints.find((candidate) => candidate.id === jointId));
  if (!project.joint) return null;
  const mine = joint?.parts.find((part) => part.ref === project.joint!.part);
  const received = joint && mine ? receivedLine(joint, mine) : "";
  const waiting = joint && mine ? waitingLine(joint, mine) : project.joint.dependsOn.length > 0 ? `esperando a parte ${project.joint.dependsOn.join(" e ")}` : "";
  return (
    <section className="w-joint" aria-label="Parte de um projeto conjunto" data-testid="work-joint">
      <h3 className="w-joint__title">Parte de um projeto conjunto</h3>
      <p className="w-joint__text">
        {joint ? <strong>{joint.title}</strong> : `Projeto ${project.joint.id}`} · esta é a parte {project.joint.part}
        {mine ? ` (${mine.workspaceName})` : ""}
        {waiting ? `, ${waiting}` : ""}. O Cyno juntou o trabalho de mais de um workspace; a próxima parte só começa quando esta termina.
      </p>
      {received && (
        <p className="w-joint__received" data-testid="work-joint-received">
          {received}
        </p>
      )}
      {known && joint ? <JointCard jointId={joint.id} compact /> : <p className="w-joint__text">Carregando o projeto conjunto…</p>}
    </section>
  );
}
