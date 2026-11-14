import type { Connector } from "@cyno/shared";
import { useState, type CSSProperties } from "react";
import { connectorIconUrl, libraryConnectorIconUrl } from "../api/client";
import { useConnectorsStore } from "../store/connectorsStore";
import { useNavStore } from "../store/navStore";
import { connectorsOfAgent, connectorStatus, iconLook } from "./connectorView";
import "./connectors.css";

type IconProps = {
  connector: Pick<Connector, "id" | "name" | "icon" | "color">;
  /** Lado em px (padrão 20). */
  size?: number;
  /** Nome acessível; sem ele o ícone é decorativo (o texto ao lado já diz). */
  label?: string;
  className?: string;
  /** Conector da Biblioteca (a imagem própria vem da rota da plataforma, não da de um workspace). */
  library?: boolean;
};

/**
 * Ícone de um conector: azulejo com a cor da marca e o símbolo do simple-icons (usado como
 * máscara, então a cor é a nossa), a imagem enviada pelo usuário ou um monograma.
 */
export function ConnectorIcon({ connector, size = 20, label, className, library = false }: IconProps) {
  const workspaceId = useNavStore((state) => state.workspaceId);
  const [broken, setBroken] = useState<number | null>(null);
  const look = iconLook(connector);
  const style = { "--cicon-size": `${size}px`, "--cicon-bg": look.background, "--cicon-fg": look.foreground } as CSSProperties;
  const a11y = label ? { role: "img", "aria-label": label, title: label } : { "aria-hidden": true };
  const custom = connector.icon.kind === "custom" ? connector.icon.version : null;
  if (custom !== null && (workspaceId || library) && broken !== custom) {
    return (
      <span className={`cicon cicon--image${className ? ` ${className}` : ""}`} style={style} {...a11y}>
        <img src={library || !workspaceId ? libraryConnectorIconUrl(connector.id, custom) : connectorIconUrl(workspaceId, connector.id, custom)} alt="" width={size} height={size} onError={() => setBroken(custom)} />
      </span>
    );
  }
  return (
    <span className={`cicon${look.outlined ? " cicon--outlined" : ""}${className ? ` ${className}` : ""}`} style={style} {...a11y}>
      {look.brand ? (
        <span className="cicon__glyph" style={{ ["--cicon-mask" as string]: `url("/conectores/${look.brand.slug}.svg")` }} />
      ) : (
        <span className="cicon__text">{look.text}</span>
      )}
    </span>
  );
}

/** Ícone com o ponto de estado no canto (verde conectado, âmbar precisa de login, vermelho erro, cinza desligado). */
export function ConnectorBadgeIcon({ connector, size = 22, library = false }: { connector: Pick<Connector, "id" | "name" | "icon" | "color" | "enabled" | "status">; size?: number; library?: boolean }) {
  const status = connectorStatus(connector);
  return (
    <span className="cicon-badge" data-status={status.dot}>
      <ConnectorIcon connector={connector} size={size} library={library} />
      <span className="cicon-badge__dot" aria-hidden="true" />
    </span>
  );
}

/**
 * Os ícones dos conectores de um agente, pequenos (lista de agentes, cabeçalho da tela de trabalho).
 * O que acabou de ser usado pulsa. Sem conectores: nada.
 */
export function AgentConnectorIcons({ agentId, size = 14, max = 4, testId }: { agentId: string; size?: number; max?: number; testId?: string }) {
  const list = useConnectorsStore((state) => state.list);
  const mark = useConnectorsStore((state) => state.byAgent[agentId]);
  const mine = connectorsOfAgent(list, agentId).filter((connector) => connector.enabled);
  if (mine.length === 0) return null;
  const names = mine.map((connector) => connector.name).join(", ");
  const active = mark?.connectorId;
  return (
    <span className="cicon-row" title={`Conectores: ${names}`} data-testid={testId}>
      <span className="sr-only">Conectores: {names}</span>
      {mine.slice(0, max).map((connector) => (
        <span key={active === connector.id ? `${connector.id}:${mark!.at}` : connector.id} className={`cicon-row__item${active === connector.id ? " cicon-row__item--active" : ""}`}>
          <ConnectorIcon connector={connector} size={size} />
        </span>
      ))}
      {mine.length > max && (
        <span className="cicon-row__more" aria-hidden="true">
          +{mine.length - max}
        </span>
      )}
    </span>
  );
}
