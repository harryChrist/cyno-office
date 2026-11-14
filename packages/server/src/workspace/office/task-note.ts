import type { Agent, Task, Team } from "@cyno/shared";
import type { NewNote } from "../brain/brain";
import { shorten } from "../../util/text";

/** Nota datada com o resultado de uma tarefa concluída (gravada no Cérebro do quarto). */
export function buildResultNote(input: {
  task: Task;
  agent: Agent | undefined;
  team: Team | undefined;
  result: string;
  date: Date;
}): NewNote {
  const { task, agent, team, result, date } = input;
  const agentLine = agent ? `${agent.name} (${agent.role})` : (task.agentId ?? "—");
  return {
    title: shorten(task.prompt, 80),
    body: [
      `- **Agente:** ${agentLine}`,
      `- **Time:** ${team?.name ?? task.teamId}`,
      `- **Pedido:** ${task.prompt}`,
      "",
      result,
    ].join("\n"),
    frontmatter: {
      task: task.id,
      agent: task.agentId ?? "",
      team: task.teamId,
      data: date.toISOString(),
      tags: ["agent-office", "tarefa"],
    },
  };
}
