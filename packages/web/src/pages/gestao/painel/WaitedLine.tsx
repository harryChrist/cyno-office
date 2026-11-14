import { dayKeyOf, type PlatformDayStats } from "@cyno/shared";
import { useNavStore } from "../../../store/navStore";
import { useWaitedToday } from "../../../store/dayStatsStore";
import { useNow } from "../../../ui/ActivityFeed";
import { waitedLine } from "./dayView";
import "./painel.css";

/**
 * "Esperando você · 2 h 10 min hoje · maior 48 min": uma linha do Hoje (um workspace) e do Resumo do Cyno (todos
 * os workspaces somados). Leva à aba Painel da Gestão (no Cyno, do workspace em que mais gente esperou).
 */
export function WaitedLine({ scope }: { scope: "workspace" | "platform" }) {
  const now = useNow();
  const { stats } = useWaitedToday(scope, dayKeyOf(now.getTime()));
  const line = waitedLine(stats);
  const go = useNavStore((state) => state.go);
  if (!line) return null;
  const open = () => {
    if (scope === "platform") {
      const first = (stats as PlatformDayStats).workspaces[0]?.workspace;
      if (first) useNavStore.getState().setWorkspace(first);
      else return;
    }
    go("gestao");
  };
  return (
    <button type="button" className={`mdline${line.quiet ? " mdline--quiet" : ""}`} onClick={open} data-testid={`waited-line-${scope}`} aria-label={`${line.text}${line.detail ? `, ${line.detail}` : ""}. Abrir o Meu dia`}>
      <span className="mdline__text">{line.text}</span>
      {line.detail && <span className="mdline__detail">{line.detail}</span>}
    </button>
  );
}
