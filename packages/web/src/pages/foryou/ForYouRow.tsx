import { FOR_YOU_STATUS_LABELS, forYouKind, type ForYouItem } from "@cyno/shared";
import type { Ref } from "react";
import { formatAgo } from "../../ui/format";
import { proposalMode as proposalModeOf, PROPOSAL_ROW_LABELS, PROPOSAL_TITLES } from "./routineProposal";
import { ageTone, cardTitle, KIND_FILTERS, typeDisplay, typeStyle, updateBadge, waitingAge, type TypeList } from "./forYouView";
import { RowThumb } from "../media/MediaStrip";
import { Icon, type IconName } from "./icons";

type ForYouRowProps = {
  item: ForYouItem;
  types: TypeList;
  agentName?: string;
  roomName?: string;
  /** Pedido de origem, como linha discreta (só quando o grupo tem um item e não mostra cabeçalho). */
  requestLabel?: string;
  /** Lote de aprovações: "3 de 10 decididos". */
  batchLabel?: string;
  selected: boolean;
  onSelect: (item: ForYouItem) => void;
  rowRef?: Ref<HTMLButtonElement>;
};

/** Uma linha só do texto: sem markdown, quebras ou espaços repetidos. */
export function snippetOf(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Rótulo e ícone da linha: plano e questionário não são "tipos" do workspace. */
function rowKind(item: ForYouItem, types: TypeList): { label: string; icon: IconName; style?: React.CSSProperties } {
  const kind = forYouKind(item);
  if (kind === "plano") return { label: "Plano", icon: "estrela" };
  if (kind === "questionario") return { label: "Perguntas", icon: "interrogacao" };
  if (kind === "sprint") return { label: "Entrega", icon: "maleta", style: typeStyle(KIND_FILTERS.sprint) };
  if (kind === "regra") return { label: "Regra", icon: "escudo", style: typeStyle(KIND_FILTERS.regra) };
  if (kind === "organizacao") return { label: "Organização", icon: "marcador", style: typeStyle(KIND_FILTERS.organizacao) };
  if (kind === "rotina") return { label: PROPOSAL_ROW_LABELS[proposalModeOf(item.routine)], icon: "bandeira", style: typeStyle(KIND_FILTERS.rotina) };
  const type = typeDisplay(types, item.type);
  return { label: type.name, icon: type.icon, style: typeStyle(type) };
}

/** Linha compacta da lista: tipo, título, quem pediu, idade, situação e uma linha do texto. */
export function ForYouRow({ item, types, agentName, roomName, requestLabel, batchLabel, selected, onSelect, rowRef }: ForYouRowProps) {
  const kind = rowKind(item, types);
  const kindOfItem = forYouKind(item);
  const title =
    kindOfItem === "plano"
      ? (item.title ?? "Plano")
      : kindOfItem === "questionario"
        ? (item.title ?? "Perguntas para você")
        : kindOfItem === "organizacao"
          ? (item.title ?? `Organizar o Cérebro de ${item.organize?.brainName ?? "uma sala"}`)
        : kindOfItem === "rotina" && item.routine
          ? (item.title ?? `${PROPOSAL_TITLES[proposalModeOf(item.routine)]} · ${item.routine.title}`)
          : cardTitle(item, agentName, types);
  const snippet = snippetOf(
    kindOfItem === "questionario" ? (item.questions ?? []).map((question) => question.text).join(" ") || item.text : kindOfItem === "organizacao" ? (item.organize?.summary ?? item.text) : item.text,
  );
  const updated = updateBadge(item, agentName);
  return (
    <button
      ref={rowRef}
      type="button"
      className={`fy-row${item.mediaIds?.length ? " fy-row--media" : ""}`}
      style={kind.style}
      aria-current={selected ? "true" : undefined}
      data-item-id={item.id}
      data-status={item.status}
      onClick={() => onSelect(item)}
      data-testid={`foryou-row-${item.id}`}
    >
      {item.mediaIds?.length ? <RowThumb ids={item.mediaIds} /> : null}
      <span className="fy-row__top">
        <span className="fy-row__kind">
          <Icon name={kind.icon} size={13} />
          {kind.label}
        </span>
        <span className="fy-row__id">{item.id}</span>
        {item.status === "pendente" ? (
          <span className={`fy-row__age fy-row__age--${ageTone(item.createdAt)}`} title="Há quanto tempo espera você">
            <Icon name="clock" size={11} />
            {waitingAge(item.createdAt)}
          </span>
        ) : (
          <span className={`fy-status fy-status--${item.status}`}>{FOR_YOU_STATUS_LABELS[item.status]}</span>
        )}
      </span>
      <span className="fy-row__title">{title}</span>
      {requestLabel && (
        <span className="fy-row__request" title={`Pedido: ${requestLabel}`}>
          Pedido · {requestLabel}
        </span>
      )}
      {snippet && <span className="fy-row__snippet">{snippet}</span>}
      <span className="fy-row__meta">
        {agentName && (
          <span className="fy-row__who">
            <Icon name="agent" size={12} />
            {agentName}
            {roomName ? ` · ${roomName}` : ""}
          </span>
        )}
        {batchLabel && (
          <span className="fy-row__batch" title="Aprovações abertas juntas pelo mesmo agente" data-testid="foryou-row-batch">
            Lote · {batchLabel}
          </span>
        )}
        {item.decidedBy === "automatico" && (
          <span className="fy-row__auto" data-testid="foryou-row-auto">
            Decidido sozinho
          </span>
        )}
        {updated && <span className="fy-row__upd">Atualizado</span>}
        {item.status !== "pendente" && <span className="fy-row__when">{formatAgo(item.decidedAt ?? item.createdAt)}</span>}
      </span>
    </button>
  );
}
