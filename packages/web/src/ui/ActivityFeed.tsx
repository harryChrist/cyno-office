import { isMaestroAgent } from "@cyno/shared";
import { useEffect, useState } from "react";
import { useOfficeStore } from "../store/officeStore";
import { useViewStore } from "../store/viewStore";
import { ACTIVITY_LABELS, MAESTRO_ACTIVITY_LABELS, type ActivityEntry, type ActivityKind } from "./activity";
import { formatAgo, truncate } from "./format";

const KIND_TONE: Record<ActivityKind, string> = {
  created: "neutral",
  started: "busy",
  delegated: "busy",
  waiting_approval: "attention",
  done: "success",
  failed: "danger",
};

/** Relógio que avança a cada 30 s (para "há 2 min" não ficar parado). */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** Uma linha do feed. `idPrefix` muda os data-testid (o sino da barra repete as linhas com "bell"). */
export function FeedItem({ entry, now, idPrefix = "feed" }: { entry: ActivityEntry; now: Date; idPrefix?: string }) {
  const agent = useOfficeStore((state) => (entry.agentId ? state.office?.agents.find((a) => a.id === entry.agentId) : undefined));
  const roomName = useOfficeStore((state) => state.office?.rooms.find((w) => w.id === entry.roomId)?.name);
  const teamName = useOfficeStore((state) => state.office?.teams.find((t) => t.id === entry.teamId)?.name);
  const maestro = useOfficeStore((state) => Boolean(agent && state.office && isMaestroAgent(state.office, agent)));
  const select = useViewStore((state) => state.select);
  const label = (maestro ? MAESTRO_ACTIVITY_LABELS : ACTIVITY_LABELS)[entry.kind];
  return (
    <li className={`feed-item feed-item--${KIND_TONE[entry.kind]}`} data-testid={`${idPrefix}-${entry.taskId}-${entry.kind}`} data-kind={entry.kind}>
      <span className="feed-item__dot" aria-hidden="true" />
      <div className="feed-item__body">
        <p className="feed-item__line">
          {agent ? (
            <button type="button" className="ui-link" onClick={() => select({ kind: "agent", id: agent.id })}>
              {agent.name}
            </button>
          ) : (
            <span className="ui-muted">agente removido</span>
          )}{" "}
          {label}
          {entry.kind === "delegated" && ` ${teamName ?? "removido"}`} <span className="feed-item__prompt">“{truncate(entry.prompt, 60)}”</span>
        </p>
        {entry.detail && (
          <p className="feed-item__meta" data-testid={`${idPrefix}-reason`}>
            {truncate(entry.detail, 90)}
          </p>
        )}
        <p className="feed-item__meta">
          {roomName ?? "sala removida"} · <time dateTime={entry.at}>{formatAgo(entry.at, now)}</time>
        </p>
      </div>
    </li>
  );
}
