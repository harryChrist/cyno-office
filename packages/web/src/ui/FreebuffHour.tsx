import { agentEngine, freebuffMinutesLeft, openFreebuffSessions, type Agent } from "@cyno/shared";
import { useMemo } from "react";
import { useNavStore } from "../store/navStore";
import { useUsageStore } from "../store/usageStore";
import { useNow } from "./ActivityFeed";

/** "37 min" / "1 h 5 min". */
export function hourLeftText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

export type FreebuffAgentHour = {
  /** O agente tem hora aberta: quanto falta. */
  minutesLeft?: number;
  /** "hora em uso: restam 37 min". */
  label?: string;
  /** O modelo da plataforma (todos os agentes de Freebuff usam o mesmo): "DeepSeek V4.1 Flash · high". */
  platformModel?: string;
  /** O processo está sem vida agora (o servidor reiniciou; reabre na próxima tarefa). */
  noProcess?: boolean;
};

/** A hora aberta de um agente em Freebuff e o modelo da plataforma (do uso da assinatura que o servidor publica). Vazio para outros motores. */
export function useFreebuffAgentHour(agent: Pick<Agent, "id" | "engine"> | undefined): FreebuffAgentHour {
  const detail = useUsageStore((state) => state.byProvider.freebuff?.freebuff);
  const workspaceId = useNavStore((state) => state.workspaceId) ?? undefined;
  const now = useNow().getTime();
  return useMemo(() => {
    if (!agent || agentEngine(agent) !== "freebuff" || !detail) return {};
    const ref = { agentId: agent.id, ...(workspaceId ? { workspaceId } : {}) };
    const minutesLeft = freebuffMinutesLeft(detail, ref, now);
    const session = openFreebuffSessions(detail, now).find((candidate) => candidate.agentId === agent.id && (!workspaceId || candidate.workspaceId === workspaceId));
    return {
      platformModel: `${detail.settings.model} · ${detail.settings.effort}`,
      ...(minutesLeft !== undefined ? { minutesLeft, label: `hora em uso: restam ${hourLeftText(minutesLeft)}` } : {}),
      ...(session && !session.hasProcess ? { noProcess: true } : {}),
    };
  }, [agent, detail, workspaceId, now]);
}

/** Selo "hora: 37 min" do agente que tem a hora aberta (a dica diz o resto). */
export function FreebuffHourChip({ agent }: { agent: Pick<Agent, "id" | "engine"> }) {
  const hour = useFreebuffAgentHour(agent);
  if (hour.minutesLeft === undefined) return null;
  return (
    <span className="agents-chip agents-chip--hour" title={`${hour.label}${hour.noProcess ? ". O processo está parado (o servidor reiniciou): reabre na mesma hora na próxima tarefa." : ""}`} data-testid="freebuff-hour-chip">
      {`hora: ${hourLeftText(hour.minutesLeft)}`}
    </span>
  );
}
