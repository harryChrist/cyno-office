import { isMaestroAgent } from "@cyno/shared";
import { useOfficeStore } from "../store/officeStore";
import { AgentWorkPanel } from "./AgentWorkPanel";
import { useWorkPanelStore } from "./workPanelStore";

/**
 * Desenha a tela de trabalho de agente aberta (uma por vez). O Maestro não: o painel dele é
 * acoplado à caixa do rodapé (TaskBox), e a store já desvia o pedido para lá.
 */
export function WorkPanelHost() {
  const target = useWorkPanelStore((state) => state.target);
  const close = useWorkPanelStore((state) => state.close);
  const office = useOfficeStore((state) => state.office);
  if (!target) return null;
  const agent = office?.agents.find((candidate) => candidate.id === target.agentId);
  if (office && agent && isMaestroAgent(office, agent)) return null;
  return <AgentWorkPanel key={target.agentId} agentId={target.agentId} onClose={close} />;
}
