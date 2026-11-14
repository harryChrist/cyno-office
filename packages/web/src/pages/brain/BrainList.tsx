import type { BrainSummary, OfficeState } from "@cyno/shared";
import { countLabel } from "../../ui/format";
import { BRAIN_KIND_ICONS, BrainIcon } from "./brainIcons";
import { BRAIN_KIND_LABELS, brainAudience, brainHash } from "./brainView";

/** Coluna da esquerda: os Cérebros do workspace, com a contagem de notas e quem trabalha em cada quarto. */
export function BrainList({
  workspaceId,
  brains,
  activeId,
  selected,
  office,
}: {
  workspaceId: string;
  brains: BrainSummary[];
  activeId: string;
  /** Algum Cérebro escolhido no endereço? (no celular, a lista de Cérebros não marca nenhum até tocar). */
  selected: boolean;
  office: OfficeState | null;
}) {
  return (
    <nav className="brain-col brain-col--brains" aria-label="Cérebros do workspace" data-selected={selected}>
      <header className="brain-col__head">
        <h3 className="brain-col__title">Cérebros</h3>
      </header>
      <div className="brain-col__scroll">
        <ul className="brain-list" data-testid="brain-list">
          {brains.map((brain) => {
            const audience = brainAudience(brain, office);
            const active = brain.id === activeId;
            return (
              <li key={brain.id}>
                <a
                  className={`brain-list__item brain-list__item--${brain.kind}`}
                  href={brainHash(workspaceId, brain.id)}
                  aria-current={active ? "page" : undefined}
                  data-testid={`brain-item-${brain.id}`}
                >
                  <span className="brain-kind-tile" aria-hidden="true">
                    <BrainIcon name={BRAIN_KIND_ICONS[brain.kind]} size={17} />
                  </span>
                  <span className="brain-list__text">
                    <span className="brain-list__head">
                      <span className="brain-list__name">{brain.name}</span>
                      <span className="brain-list__count" aria-label={countLabel(brain.notes.length, "nota", "notas")}>
                        {brain.notes.length}
                      </span>
                    </span>
                    <span className="brain-list__kind">{BRAIN_KIND_LABELS[brain.kind]}</span>
                    <span className="brain-list__crew" title={audience}>
                      {audience}
                    </span>
                  </span>
                  <BrainIcon name="seta" size={16} className="brain-list__chevron" />
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
