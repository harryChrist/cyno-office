import type { DeliveryCard, DeliveryMedia } from "@cyno/shared";
import { Markdown } from "../ui/markdown/Markdown";
import { formatDateTime } from "../ui/format";
import { useMediaUrl } from "../pages/media/MediaParts";
import { deliveryFacts } from "./deliveriesView";
import "../pages/work/delivery.css";

const noWiki = () => null;
const KIND_LABEL: Record<DeliveryMedia["kind"], string> = { image: "Imagem", video: "Vídeo", audio: "Áudio", document: "Documento", other: "Arquivo" };

/** O arquivo ou a mídia da entrega, com link (abre o arquivo; o resto é na Biblioteca de mídia). */
function MediaLink({ media }: { media: DeliveryMedia }) {
  const href = useMediaUrl(media);
  const label = media.title || media.fileName;
  if (!href) return <span className="ad__file">{label}</span>;
  return (
    <a className="ad__file ui-link" href={href} target="_blank" rel="noreferrer noopener" title={`${KIND_LABEL[media.kind]}: ${media.fileName}`} data-testid="agent-delivery-media">
      {label}
    </a>
  );
}

type Props = {
  cards: readonly DeliveryCard[];
  agentName: string;
  onOpenTask: (taskId: string) => void;
};

/**
 * "Entregas" do agente: o fim de cada pedido que ele terminou, a mais nova primeiro. A manchete e o resumo
 * saem do resultado por código (sem IA); o texto inteiro fica a um clique; arquivos e mídias levam ao arquivo.
 */
export function AgentDeliveries({ cards, agentName, onOpenTask }: Props) {
  if (cards.length === 0) {
    return (
      <div className="work-empty" data-testid="agent-deliveries-empty">
        <p className="work-empty__title">{agentName} ainda não entregou nada.</p>
        <p className="work-empty__text">Quando ele terminar um pedido com resultado, a entrega aparece aqui: a manchete, o resumo, os arquivos e as mídias.</p>
      </div>
    );
  }
  return (
    <ul className="ad" data-testid="agent-deliveries">
      {cards.map((card) => (
        <li key={card.id} className="ad__item" data-testid="agent-delivery">
          <p className="ad__request" title={card.request}>
            Pedido: {card.request}
          </p>
          <p className="ad__headline" data-testid="agent-delivery-headline">
            {card.headline}
          </p>
          {card.summary && (
            <p className="ad__summary" data-testid="agent-delivery-summary">
              {card.summary}
            </p>
          )}
          {card.media.length > 0 && (
            <p className="ad__files">
              {card.media.map((item) => (
                <MediaLink key={item.id} media={item} />
              ))}
            </p>
          )}
          <p className="ad__meta">
            <time dateTime={card.finishedAt}>{formatDateTime(card.finishedAt)}</time>
            {deliveryFacts(card).map((fact) => (
              <span key={fact}> · {fact}</span>
            ))}
          </p>
          <details className="ad__full">
            <summary>Ver a resposta inteira</summary>
            <Markdown source={card.text} resolveWiki={noWiki} headingOffset={3} plainLinks className="md--compact" />
          </details>
          <button type="button" className="ui-link ad__open" onClick={() => onOpenTask(card.taskId)}>
            Abrir em Projetos e tarefas
          </button>
        </li>
      ))}
    </ul>
  );
}
