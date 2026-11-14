import { useBrowserStore } from "../store/browserStore";
import { useConnectorsStore } from "../store/connectorsStore";
import { GlobeIcon } from "./GlobeIcon";

/**
 * Balão sobre o agente no mapa enquanto ele usa o navegador (e alguns segundos depois): o globo e o
 * que fez ("Abriu google.com"). Só visual. Com o balão de um conector no ar, o do conector vale.
 * Usa a classe do balão do conector (o rótulo abre espaço para ele do mesmo jeito).
 */
export function BrowserBubble({ agentId }: { agentId: string }) {
  const mark = useBrowserStore((state) => state.byAgent[agentId]);
  const connectorBusy = useConnectorsStore((state) => state.byAgent[agentId] !== undefined);
  if (!mark || connectorBusy) return null;
  return (
    <span key={mark.seq} className="agent-label__connector agent-label__browser" data-testid="agent-browser-bubble">
      <span className="agent-label__browser-icon">
        <GlobeIcon size={12} />
      </span>
      <span className="agent-label__connector-tool">{mark.label}</span>
    </span>
  );
}
