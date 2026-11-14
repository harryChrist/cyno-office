import { platformReportPath, type Card } from "@cyno/shared";
import { useEffect, useState } from "react";
import { describeError } from "../../api/client";
import { useNavStore } from "../../store/navStore";
import { Modal } from "../../ui/widgets";
import { ReportFrame } from "../gestao/relatorios/ReportFrame";
import { fetchReportHtml } from "./platformReportApi";
import { gestaoRows, TREND_ARROW, type GestaoRow } from "./cynoGestao";
import "./cynoGestao.css";

/** Abre a Gestão do workspace (Painel). */
function openGestao(workspace: string): void {
  const nav = useNavStore.getState();
  nav.setWorkspace(workspace);
  nav.go("gestao");
}

const TREND_LABEL = { up: "subiu", down: "caiu", flat: "estável" } as const;

function Row({ row }: { row: GestaoRow }) {
  return (
    <li>
      <button type="button" className="gblock__row" onClick={() => openGestao(row.workspace)} aria-label={`Abrir a Gestão de ${row.name}`} data-testid="gestao-row" data-workspace={row.workspace}>
        <span className="gblock__top">
          <span className="gblock__name">{row.name}</span>
          {!row.pending && <span className={`gblock__waiting${row.waitingLate ? " gblock__waiting--late" : ""}`}>{row.waiting}</span>}
        </span>
        {row.pending ? (
          <span className="gblock__stats gblock__stats--soft">{row.deliveries}</span>
        ) : (
          <span className="gblock__stats">
            <span className="gblock__cell">
              {row.deliveries}
              {row.trend && (
                <span className={`gblock__trend gblock__trend--${row.trend}`} aria-label={TREND_LABEL[row.trend]}>
                  {" "}
                  {TREND_ARROW[row.trend]}
                </span>
              )}
            </span>
            <span className="gblock__cell">{row.blocked}</span>
            <span className="gblock__cell">{row.atRisk}</span>
            <span className="gblock__cell">{row.cost}</span>
            {row.quota && <span className="gblock__cell">{row.quota}</span>}
          </span>
        )}
      </button>
    </li>
  );
}

/** "Semana da plataforma": a página do relatório da plataforma (a soma dos workspaces), na mesma moldura isolada dos relatórios. */
function PlatformWeek({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<{ html: string } | { error: string } | null>(null);
  useEffect(() => {
    let stale = false;
    fetchReportHtml(platformReportPath("latest"))
      .then((html) => {
        if (!stale) setState({ html });
      })
      .catch((failure: unknown) => {
        if (!stale) setState({ error: describeError(failure) });
      });
    return () => {
      stale = true;
    };
  }, []);
  return (
    <Modal title="Semana da plataforma" onClose={onClose} testId="platform-week" wide>
      {state === null && <p className="page__empty">Abrindo a semana…</p>}
      {state && "error" in state && (
        <p className="ui-error" role="alert" data-testid="platform-week-error">
          {state.error.includes("404") || /ainda não/i.test(state.error) ? "A semana da plataforma sai quando todos os workspaces fecham a revisão da semana (na segunda de manhã). Ainda não há uma fechada." : `Não deu para abrir a semana da plataforma. ${state.error}`}
        </p>
      )}
      {state && "html" in state && <ReportFrame html={state.html} title="Semana da plataforma" />}
    </Modal>
  );
}

/**
 * O bloco "Gestão" do Resumo do Cyno: uma linha compacta por workspace (entregas dos últimos 7 dias, o que espera você, travados,
 * prazos em risco, gasto da semana e cota), cada uma levando à Gestão daquele workspace. No topo, "Semana da plataforma".
 */
export function GestaoBlock({ cards, loaded, now }: { cards: readonly Card[]; loaded: boolean; now: Date }) {
  const [open, setOpen] = useState(false);
  const rows = gestaoRows(cards, now);
  return (
    <section className="sblock gblock" aria-label="Gestão" data-testid="summary-gestao">
      <header className="sblock__head">
        <h3 className="sblock__title">Gestão</h3>
        <button type="button" className="sblock__action" onClick={() => setOpen(true)} data-testid="gestao-platform-week">
          Semana da plataforma
        </button>
      </header>
      {!loaded ? (
        <p className="sblock__empty">Carregando…</p>
      ) : rows.length === 0 ? (
        <p className="sblock__empty">Nenhum workspace ainda</p>
      ) : (
        <ul className="gblock__list">
          {rows.map((row) => (
            <Row key={row.workspace} row={row} />
          ))}
        </ul>
      )}
      {loaded && rows.length > 0 && <p className="sblock__note">Gasto em dólar é equivalente à API (a conta é assinatura); leia junto da cota. Setas só com 5 ou mais entregas nas duas semanas.</p>}
      {open && <PlatformWeek onClose={() => setOpen(false)} />}
    </section>
  );
}
