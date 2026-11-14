import type { Agent, Project, Sprint } from "@cyno/shared";
import { useEffect, useMemo } from "react";
import { useMediaStore } from "../../store/mediaStore";
import { MediaThumb } from "../media/MediaParts";
import { AgentTag } from "./Agent";
import "./delivery.css";
import { deliveryView, mediaOfEntry, shortLink, type DeliveryView } from "./deliveryView";

type Props = {
  project: Project;
  sprint: Sprint;
  agents: ReadonlyMap<string, Agent>;
  onOpenTask: (ref: string) => void;
  /** Marcar entregas (o cartão "Devolver"): refs marcados e como mudar. */
  pick?: { refs: ReadonlySet<string>; onToggle: (ref: string) => void };
  testId?: string;
};

/**
 * O resumo de entrega de uma sprint: o que foi feito (com quem fez, os links e a mídia de cada tarefa), o que
 * sobrou e para onde foi, o que falhou, foi cancelado ou foi refeito. É o mesmo corpo do cartão em Aprovações,
 * da aba Sprints (recolhido) e da aba Entregas.
 */
export function DeliverySummary({ project, sprint, agents, onOpenTask, pick, testId }: Props) {
  const media = useMediaStore((state) => state.items);
  const ensure = useMediaStore((state) => state.ensureLoaded);
  useEffect(() => ensure(), [ensure]);
  const view = useMemo(() => deliveryView(project, sprint), [project, sprint]);
  if (!view) return null;
  return (
    <div className="dv" data-testid={testId ?? `delivery-${sprint.id}`}>
      {view.done.length > 0 ? (
        <section aria-label="Entregues">
          <h4 className="dv__h">
            Entregue <span className="tp__count">{view.done.length}</span>
          </h4>
          <ul className="dv__list">
            {view.done.map((entry) => {
              const files = mediaOfEntry(media, entry);
              const checked = pick?.refs.has(entry.ref) ?? false;
              return (
                <li key={entry.ref} className={`dv__item${checked ? " is-picked" : ""}`} data-testid={`delivery-entry-${entry.ref}`}>
                  <div className="dv__row">
                    {pick && <input type="checkbox" className="dv__check" checked={checked} onChange={() => pick.onToggle(entry.ref)} aria-label={`Devolver ${entry.title}`} data-testid={`delivery-pick-${entry.ref}`} />}
                    <button type="button" className="ui-link dv__title" onClick={() => onOpenTask(entry.ref)} title="Abrir a tarefa">
                      {entry.title}
                    </button>
                    <span className="dv__who">
                      {entry.assignees.map((id) => (
                        <AgentTag key={id} agent={agents.get(id)} fallback={id} />
                      ))}
                    </span>
                  </div>
                  {(entry.links?.length ?? 0) > 0 && (
                    <ul className="dv__links">
                      {entry.links!.map((link) => (
                        <li key={link}>
                          <a href={link} target="_blank" rel="noreferrer noopener" className="ui-link" title={link}>
                            {shortLink(link)}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                  {files.length > 0 && (
                    <ul className="dv__media">
                      {files.slice(0, 6).map((item) => (
                        <li key={item.id}>
                          <button type="button" className="dv__thumb" onClick={() => useMediaStore.getState().open(item.id)} title={`${item.title || item.fileName} (abrir na Mídia)`}>
                            <MediaThumb item={item} className="dv__thumb-img" />
                          </button>
                        </li>
                      ))}
                      {files.length > 6 && <li className="dv__more">+{files.length - 6}</li>}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <p className="dv__none">Nenhuma tarefa foi entregue nesta sprint.</p>
      )}
      <Rest view={view} onOpenTask={onOpenTask} />
    </div>
  );
}

function RefButton({ entry, onOpenTask, note }: { entry: { ref: string; title: string }; onOpenTask: (ref: string) => void; note?: string }) {
  return (
    <li className="dv__line">
      <button type="button" className="ui-link dv__title" onClick={() => onOpenTask(entry.ref)}>
        {entry.title}
      </button>
      {note && <span className="dv__note">{note}</span>}
    </li>
  );
}

/** O que não entrou como entrega: sobra, falhas, canceladas, retrabalho e o que ainda está terminando. */
function Rest({ view, onOpenTask }: { view: DeliveryView; onOpenTask: (ref: string) => void }) {
  return (
    <>
      {view.carried.length > 0 && (
        <section aria-label="Sobraram" data-testid="delivery-carried">
          <h4 className="dv__h">
            Sobrou <span className="tp__count">{view.carried.length}</span>
          </h4>
          <ul className="dv__list dv__list--plain">
            {view.carried.map((entry) => (
              <RefButton key={entry.ref} entry={entry} onOpenTask={onOpenTask} note={entry.where} />
            ))}
          </ul>
        </section>
      )}
      {view.failed.length > 0 && (
        <section aria-label="Falharam" data-testid="delivery-failed">
          <h4 className="dv__h dv__h--bad">
            Falhou <span className="tp__count">{view.failed.length}</span>
          </h4>
          <ul className="dv__list dv__list--plain">
            {view.failed.map((entry) => (
              <RefButton key={entry.ref} entry={entry} onOpenTask={onOpenTask} {...(entry.reason ? { note: entry.reason } : {})} />
            ))}
          </ul>
        </section>
      )}
      {view.reworked.length > 0 && (
        <section aria-label="Refeitas">
          <h4 className="dv__h">
            Refeitas <span className="tp__count">{view.reworked.length}</span>
          </h4>
          <ul className="dv__list dv__list--plain">
            {view.reworked.map((entry) => (
              <RefButton key={entry.ref} entry={entry} onOpenTask={onOpenTask} note={`${entry.count === 1 ? "1 recusa" : `${entry.count} recusas`}${entry.reason ? `, a última: ${entry.reason}` : ""}`} />
            ))}
          </ul>
        </section>
      )}
      {view.cancelled.length > 0 && (
        <section aria-label="Canceladas">
          <h4 className="dv__h">
            Canceladas <span className="tp__count">{view.cancelled.length}</span>
          </h4>
          <ul className="dv__list dv__list--plain">
            {view.cancelled.map((entry) => (
              <RefButton key={entry.ref} entry={entry} onOpenTask={onOpenTask} />
            ))}
          </ul>
        </section>
      )}
      {view.finishing.length > 0 && (
        <section aria-label="Ainda terminando">
          <h4 className="dv__h">
            Ainda terminando <span className="tp__count">{view.finishing.length}</span>
          </h4>
          <ul className="dv__list dv__list--plain">
            {view.finishing.map((entry) => (
              <RefButton key={entry.ref} entry={entry} onOpenTask={onOpenTask} note="começou antes do fim e termina onde está" />
            ))}
          </ul>
        </section>
      )}
      <p className="dv__foot">
        {[view.range, view.closedLabel, view.skipped > 0 ? (view.skipped === 1 ? "1 pulada" : `${view.skipped} puladas`) : null, view.worked].filter(Boolean).join(" · ")}
      </p>
    </>
  );
}
