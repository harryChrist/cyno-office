import { isTodayEmpty } from "@cyno/shared";
import { useOfficeStore } from "../../store/officeStore";
import { useWorkspaceToday } from "../../store/todayStore";
import { useNow } from "../../ui/ActivityFeed";
import { WaitedLine } from "../../pages/gestao/painel/WaitedLine";
import { TodayBody, WaitingLine } from "./TodayBody";
import { runningCount, todayHeading } from "./todayView";
import "./today.css";

/** Quantas tarefas estão fazendo agora (acende o indicador "ao vivo" do item Hoje na barra). */
export function useRunningCount(): number {
  const office = useOfficeStore((state) => state.office);
  return runningCount(office);
}

/** Painel "Hoje" ao lado da barra: todo o trabalho e o fluxo do dia do workspace, calculado pelo servidor (sem IA). */
export function TodayPanel({ onClose, titleId }: { onClose: () => void; titleId?: string }) {
  const now = useNow();
  const running = useRunningCount();
  const { view, error } = useWorkspaceToday();
  return (
    <div className="hoje" data-testid="hoje-panel-body">
      <header className="bell__head actp__head">
        <div className="actp__titles">
          <h2 className="bell__title" id={titleId}>
            {todayHeading(now)}
          </h2>
          <p className="actp__sub">
            {running > 0 && <span className="actp__live" aria-hidden="true" />}
            {running > 0 ? `${running} fazendo agora` : "Nada rodando agora"}
          </p>
        </div>
        <button type="button" className="actp__close" aria-label="Fechar" onClick={onClose}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <div className="hoje__scroll">
        {view === null ? (
          <p className="ui-muted ui-empty" role={error ? "alert" : "status"}>
            {error ? `Não deu para carregar o dia agora. ${error}` : "Carregando o dia…"}
          </p>
        ) : (
          <>
            {isTodayEmpty(view) && <p className="hj-quiet" data-testid="hoje-empty">Dia tranquilo: nada rodando, nada marcado e nada esperando você. Quando alguém começar, aparece aqui.</p>}
            <TodayBody view={view} now={now} />
          </>
        )}
      </div>
      {view && (
        <footer className="hoje__foot">
          <WaitedLine scope="workspace" />
          <WaitingLine view={view} />
        </footer>
      )}
    </div>
  );
}
