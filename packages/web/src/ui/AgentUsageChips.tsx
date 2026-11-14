import type { Task } from "@cyno/shared";
import { useMemo } from "react";
import { useOfficeStore } from "../store/officeStore";
import { useSpendChips } from "../store/spendChipsStore";
import { agentUsageChips, taskCostText } from "./spendChips";
import "./spendChips.css";

/**
 * Os chips de gasto de um agente: "Esta tarefa" e "Hoje" (tokens e custo equivalente), da mesma fonte da página
 * Gastos. Pequeno e autossuficiente: monta-se com uma linha onde o agente aparece (painel do agente, tela de trabalho).
 */
export function AgentUsageChips({ agentId }: { agentId: string }) {
  const data = useSpendChips();
  const tasks = useOfficeStore((state) => state.office?.tasks);
  // A tarefa em andamento do agente (a mais antiga ainda ativa).
  const current = useMemo(() => tasks?.filter((task: Task) => task.agentId === agentId && task.role !== "request" && (task.status === "in_progress" || task.status === "waiting_approval")).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0], [tasks, agentId]);
  const chips = agentUsageChips({ ...(data?.agents[agentId] ? { today: data.agents[agentId] } : {}), ...(current && data?.tasks[current.id] ? { task: data.tasks[current.id] } : {}) });
  if (chips.length === 0) return null;
  return (
    <ul className="spend-chips" aria-label="Gasto do agente" data-testid="agent-usage-chips">
      {chips.map((chip) => (
        <li key={chip.key} className="spend-chip" title={chip.title} data-testid={`agent-chip-${chip.key}`}>
          <span className="spend-chip__label">{chip.label}</span>
          <span className="spend-chip__value ui-tabular">{chip.tokens}</span>
          <span className="spend-chip__value spend-chip__value--cost ui-tabular">{chip.cost}</span>
        </li>
      ))}
    </ul>
  );
}

/** O que a tarefa custou, em letra pequena no cartão dela. Sem gasto, não aparece. */
export function TaskCostChip({ taskId }: { taskId: string }) {
  const data = useSpendChips();
  const text = taskCostText(data?.tasks[taskId]);
  if (!text) return null;
  return (
    <p className="spend-chip spend-chip--task ui-tabular" title="O que esta tarefa custou, em custo equivalente na API (mesma conta da página Gastos)" data-testid="task-cost-chip">
      <span className="spend-chip__label">Custou</span>
      <span className="spend-chip__value">{text}</span>
    </p>
  );
}
