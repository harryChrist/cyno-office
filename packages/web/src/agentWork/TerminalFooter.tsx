import type { AgentLogEntry } from "@cyno/shared";
import { useEffect, useMemo, useState } from "react";
import { sinceLabel, terminalFooter } from "./terminalFooterLogic";

/** Rodapé de estado do terminal: o que o agente está fazendo agora e há quanto tempo (relógio da própria tela). */
export function TerminalFooter({ entries, live }: { entries: readonly AgentLogEntry[]; live: boolean }) {
  const footer = useMemo(() => terminalFooter(entries, live), [entries, live]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!footer.since) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [footer.since, footer.kind]);
  const since = footer.since ? sinceLabel(now - Date.parse(footer.since)) : undefined;
  return (
    <div className="aterm__footer" data-kind={footer.kind} data-testid="agent-terminal-footer">
      <span className="aterm__footer-mark" aria-hidden="true">
        {footer.icon ?? (footer.kind === "working" ? "●" : "○")}
      </span>
      <span className="aterm__footer-text">{footer.text}</span>
      {since && <span className="aterm__footer-since">{since}</span>}
    </div>
  );
}
