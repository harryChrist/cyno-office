import type { BrainSummary, OfficeState } from "@cyno/shared";
import { countLabel } from "../../ui/format";
import { BRAIN_KIND_ICONS, BrainIcon, NOTE_KIND_ICONS } from "./brainIcons";
import { BRAIN_KIND_LABELS, brainAudience, brainHash, fixedName, groupNotes, latestDate, noteKind } from "./brainView";
import { RelativeTime } from "./NoteList";

/**
 * Leitor sem nota aberta (só em tela larga): um resumo do Cérebro escolhido, com atalhos para as
 * notas fixas, em vez de uma caixa vazia.
 */
export function BrainOverview({ workspaceId, brain, office, now }: { workspaceId: string; brain: BrainSummary; office: OfficeState | null; now: number }) {
  const groups = groupNotes(brain.notes);
  const latest = latestDate(brain.notes);
  const stats = [
    countLabel(groups.notes.length, "nota", "notas"),
    groups.history.length > 0 ? countLabel(groups.history.length, "resultado de tarefa", "resultados de tarefa") : "",
  ].filter(Boolean);

  return (
    <section className={`brain-col brain-col--reader brain-overview brain-overview--${brain.kind}`} aria-label={`Resumo do Cérebro ${brain.name}`} data-testid="brain-overview">
      <div className="brain-overview__inner">
        <span className="brain-overview__mark" aria-hidden="true">
          <BrainIcon name="brain" size={34} />
        </span>
        <p className="brain-overview__kind">
          <BrainIcon name={BRAIN_KIND_ICONS[brain.kind]} size={13} />
          {BRAIN_KIND_LABELS[brain.kind]}
        </p>
        <h3 className="brain-overview__name">{brain.name}</h3>
        <p className="brain-overview__audience">{brainAudience(brain, office)}</p>
        <p className="brain-overview__stats">
          {stats.join(" · ")}
          {latest && (
            <>
              {" · atualizado "}
              <RelativeTime iso={latest} now={now} />
            </>
          )}
        </p>
        {groups.fixed.length > 0 && (
          <ul className="brain-overview__fixed" aria-label="Sempre no contexto">
            {groups.fixed.map((note) => {
              const kind = noteKind(note);
              return (
                <li key={note.file}>
                  <a className={`brain-overview__card brain-note--${kind}`} href={brainHash(workspaceId, brain.id, note.file)}>
                    <span className="brain-note__icon" aria-hidden="true">
                      <BrainIcon name={NOTE_KIND_ICONS[kind]} size={16} />
                    </span>
                    <span className="brain-overview__card-name">{fixedName(note)}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
        <p className="brain-overview__hint">
          Escolha uma nota na lista para ler. As fixas entram em toda tarefa dos agentes deste Cérebro; as outras eles acham pela busca.
        </p>
      </div>
    </section>
  );
}
