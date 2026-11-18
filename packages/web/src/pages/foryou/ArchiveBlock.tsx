import type { ForYouItem } from "@cyno/shared";
import { ErrorText } from "../../ui/widgets";
import {
  archiveHint,
  archiveTotal,
  itemsLabel,
  monthLabel,
} from "./archiveView";
import { ForYouRow } from "./ForYouRow";
import type { TypeList } from "./forYouView";
import { Icon } from "./icons";
import type { useForYouArchive } from "./useForYouArchive";

type ArchiveBlockProps = {
  archive: ReturnType<typeof useForYouArchive>;
  types: TypeList;
  agentNames: ReadonlyMap<string, string>;
  roomNames: ReadonlyMap<string, string>;
  open: boolean;
  onToggle: () => void;
  /** Mês aberto (null = nenhum). */
  month: string | null;
  onMonth: (month: string | null) => void;
  selectedId: string | null;
  onSelect: (item: ForYouItem) => void;
};

/** O bloco só aparece com arquivo (ou para mostrar que o resumo falhou). */
export function hasArchive(
  archive: ReturnType<typeof useForYouArchive>,
): boolean {
  return (archive.summary?.months.length ?? 0) > 0 || archive.error !== null;
}

/**
 * "Mais antigos": as aprovações decididas que saíram da lista viva. Mostra os meses; ao abrir um, busca os itens e os
 * lista com a mesma linha da lista (só leitura: o detalhe abre o cartão sem decidir, reabrir, editar nem cancelar).
 */
export function ArchiveBlock({
  archive,
  types,
  agentNames,
  roomNames,
  open,
  onToggle,
  month,
  onMonth,
  selectedId,
  onSelect,
}: ArchiveBlockProps) {
  const { summary, error } = archive;
  if (!summary && !error) return null;
  const months = summary?.months ?? [];
  const hint = summary ? archiveHint(summary.liveDays) : "";
  return (
    <section
      className="fy-arch"
      aria-label="Aprovações mais antigas"
      data-testid="foryou-archive"
    >
      <header className="fy-sec__head fy-sec__head--decided">
        <button
          type="button"
          className="fy-sec__toggle"
          aria-expanded={open}
          onClick={onToggle}
          data-testid="foryou-archive-toggle"
        >
          <Icon name="back" size={12} />
          <span className="fy-sec__title">Mais antigos</span>
          {summary && (
            <span className="fy-sec__count">{archiveTotal(months)}</span>
          )}
        </button>
      </header>
      {hint && <p className="fy-arch__hint">{hint}</p>}
      {error && (
        <div className="fy-arch__error" data-testid="foryou-archive-error">
          <ErrorText>{`Não deu para carregar o arquivo: ${error}`}</ErrorText>
          <button type="button" className="fy-link" onClick={archive.reload}>
            Tentar de novo
          </button>
        </div>
      )}
      {open && (
        <ul className="fy-arch__months" data-testid="foryou-archive-months">
          {months.map((entry) => {
            const expanded = month === entry.month;
            const state = archive.months[entry.month];
            return (
              <li key={entry.month} className="fy-arch__month">
                <button
                  type="button"
                  className="fy-arch__month-btn"
                  aria-expanded={expanded}
                  onClick={() => {
                    onMonth(expanded ? null : entry.month);
                    if (!expanded) archive.loadMonth(entry.month);
                  }}
                  data-testid={`foryou-archive-month-${entry.month}`}
                >
                  <span>{monthLabel(entry.month)}</span>
                  <span className="fy-sec__count">
                    {itemsLabel(entry.count)}
                  </span>
                </button>
                {expanded && state?.status === "loading" && (
                  <p className="fy-sec__empty">Carregando…</p>
                )}
                {expanded && state?.status === "error" && (
                  <div className="fy-arch__error">
                    <ErrorText>{`Não deu para abrir ${monthLabel(entry.month)}: ${state.error}`}</ErrorText>
                    <button
                      type="button"
                      className="fy-link"
                      onClick={() => archive.loadMonth(entry.month)}
                    >
                      Tentar de novo
                    </button>
                  </div>
                )}
                {expanded && state?.status === "ready" && (
                  <ol className="fy-list">
                    {state.items.length === 0 && (
                      <p className="fy-sec__empty">Nenhum item neste mês.</p>
                    )}
                    {state.items.map((item) => (
                      <li key={item.id}>
                        <ForYouRow
                          item={item}
                          types={types}
                          agentName={agentNames.get(item.agentId)}
                          roomName={roomNames.get(item.roomId)}
                          selected={item.id === selectedId}
                          onSelect={onSelect}
                        />
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
