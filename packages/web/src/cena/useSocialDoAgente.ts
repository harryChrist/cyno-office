// A vida social do agente na cena (moedinhas e "fazendo agora") para o painel do agente: lê do mundo da cena, só
// leitura, de tempos em tempos (o saldo muda sem avisar a interface).
import type { AgentSocial } from "@cyno/cena";
import { useEffect, useState } from "react";
import { mundoAtual } from "./mundoAtual";

export const ATUALIZA_SOCIAL_MS = 2_000;

/** `null` quando a cena nova não está aberta ou o agente não está no prédio (terminal desligado, p.ex.). */
export function useSocialDoAgente(agentId: string): Pick<AgentSocial, "coins" | "doing"> | null {
  const [social, setSocial] = useState<Pick<AgentSocial, "coins" | "doing"> | null>(null);
  useEffect(() => {
    const ler = (): void => {
      const s = mundoAtual()?.social?.(agentId) ?? null;
      setSocial((antes) => (s === null ? (antes === null ? antes : null) : antes && antes.coins === s.coins && antes.doing === s.doing ? antes : { coins: s.coins, doing: s.doing }));
    };
    ler();
    const id = setInterval(ler, ATUALIZA_SOCIAL_MS);
    return () => clearInterval(id);
  }, [agentId]);
  return social;
}
