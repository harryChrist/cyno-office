import { type MetricsReport } from "@cyno/shared";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../../api/client";
import { useForYouFocus } from "../../../store/forYouFocus";
import { useNavStore } from "../../../store/navStore";
import { useOfficeStore } from "../../../store/officeStore";
import { useRoutinesStore } from "../../../store/routinesStore";
import { useWorkStore } from "../../../store/workStore";
import { useNow } from "../../../ui/ActivityFeed";
import { cardTitle, typeDisplay } from "../../foryou/forYouView";
import { BudgetStrip } from "../../spend/BudgetPanel";
import { openSpend } from "../../../store/navTargets";
import { ActionNote, BatchApproveDialog, ProjectActions, ReassignPicker, useActionNote, type ReassignTarget } from "../ActionControls";
import { canReassign } from "../actionsView";
import { BarsWeekly } from "../BarsWeekly";
import { CycleLine } from "../CycleLine";
import { ForecastBars } from "../ForecastBars";
import { KpiTile } from "../KpiTile";
import { useMetrics } from "../metricsApi";
import { waitingRules } from "../relatorios/retroView";
import { blockedView, forecastView, goalFacts, painelView, pendingRows, ruleLine, weekFacts } from "../painelView";
import "../metrics.css";

/**
 * "Esta semana", a primeira tela do Painel: o que precisa de você e se o ritmo está bom. Os números vêm de
 * `GET /api/w/:ws/metrics` (um cálculo só, no servidor); aqui só se desenha. O "Meu dia" vem logo abaixo.
 */
export function WeekSection() {
  const workspaceId = useNavStore((state) => state.workspaceId);
  const { report, error, reload } = useMetrics(workspaceId);
  return (
    <section className="wk" aria-labelledby="wk-title" data-testid="painel-week">
      <header className="wk__head">
        <h2 className="painel__title" id="wk-title">
          Esta semana
        </h2>
        <p className="painel__sub">O que precisa de você e se o ritmo está bom.</p>
      </header>
      {error && !report && (
        <p className="ui-error" role="alert" data-testid="painel-week-error">
          Não deu para carregar os números da semana. {error}{" "}
          <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={reload}>
            Tentar de novo
          </button>
        </p>
      )}
      {!report && !error && <p className="page__empty">Carregando a semana…</p>}
      {report && <WeekBody report={report} />}
    </section>
  );
}

function WeekBody({ report }: { report: MetricsReport }) {
  const go = useNavStore((state) => state.go);
  const now = useNow().getTime();
  const agents = useOfficeStore((state) => state.office?.agents);
  const forYou = useOfficeStore((state) => state.forYou);
  const types = useOfficeStore((state) => state.forYouTypes);
  const view = useMemo(() => painelView(report), [report]);
  const agentName = (id: string) => agents?.find((agent) => agent.id === id)?.name;
  const typeName = (type: string) => typeDisplay(types, type).name;
  const lookup = useMemo(() => new Map((forYou ?? []).map((item) => [item.id, item])), [forYou]);
  const pending = pendingRows(report, typeName).map((row) => {
    const item = lookup.get(row.id);
    return item ? { ...row, title: cardTitle(item, agentName(item.agentId), types) } : row;
  });
  const blocked = blockedView(report, agentName);
  const forecast = forecastView(report, now);
  const goals = goalFacts(report);
  const facts = weekFacts(report);
  const [waiting, throughput, cycle, spend] = view.kpis;
  // Regra proposta é decisão sua, mas não segura nenhum agente: fora do "Esperando seu OK" (e das esperas), com a linha própria abaixo.
  const rulesWaiting = waitingRules(forYou);
  const [batchOpen, setBatchOpen] = useState(false);
  const [reassign, setReassign] = useState<ReassignTarget | null>(null);
  const [flash, setFlash] = useState<{ where: "batch" | "blocked" | "plans"; text: string } | null>(null);
  const routines = useRoutinesStore((state) => state.overview?.routines);
  useEffect(() => {
    // Pausar e retomar uma meta pelo Painel precisa saber o estado dela (a Gestão carrega isso nas Rotinas e metas).
    if (!useRoutinesStore.getState().overview) void useRoutinesStore.getState().load();
  }, []);

  return (
    <div className="wk__body">
      {view.empty && (
        <p className="wk__empty" data-testid="painel-week-empty">
          <strong>{view.empty.title}.</strong> {view.empty.text}
        </p>
      )}

      <div className="wk__kpis">
        <KpiTile tile={waiting!}>
          {pending.length > 0 && (
            <ul className="kpi__list" aria-label="Os que esperam há mais tempo" data-testid="kpi-waiting-items">
              {pending.slice(0, 3).map((row) => (
                <li key={row.id}>
                  <button type="button" className="kpi__item" onClick={() => useForYouFocus.getState().open(row.id)} data-testid="kpi-waiting-item">
                    <span className="kpi__item-title">{row.title}</span>
                    <span className="kpi__item-meta">{row.age}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="mdlink kpi__link" onClick={() => go("para-voce")} data-testid="painel-go-approvals">
            Ir para Aprovações{report.approvalWait.pending.count > 0 ? ` (${report.approvalWait.pending.count})` : ""}
          </button>
          {rulesWaiting > 0 && (
            <button type="button" className="mdlink kpi__link" onClick={() => go("gestao", "relatorios/aprendemos")} data-testid="painel-go-rules">
              {ruleLine(rulesWaiting)}
            </button>
          )}
          {report.approvalWait.pending.count > 0 && (
            <span className="act__row">
              <button type="button" className="ui-button ui-button--secondary ui-button--small act__btn" onClick={() => setBatchOpen(true)} data-testid="painel-batch-open">
                Aprovar em lote
              </button>
              {flash?.where === "batch" && <ActionNote note={{ tone: "ok", text: flash.text }} testId="painel-batch-flash" />}
            </span>
          )}
        </KpiTile>
        <KpiTile tile={throughput!}><BarsWeekly view={view.bars} /></KpiTile>
        <KpiTile tile={cycle!}>
          <CycleLine view={view.cycle} />
        </KpiTile>
        <KpiTile tile={spend!}>
          {view.quota.length > 0 && (
            <ul className="kpi__quota" aria-label="Cota da assinatura" data-testid="kpi-quota">
              {view.quota.map((row) => (
                <li key={row.id} className={row.warn ? "is-warn" : undefined}>
                  {row.percent !== null && (
                    <span className="kpi__meter" aria-hidden="true">
                      <span style={{ width: `${Math.min(100, row.percent)}%` }} />
                    </span>
                  )}
                  <span className="kpi__quota-text">{row.text}</span>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="mdlink kpi__link" onClick={() => openSpend()} data-testid="painel-go-spend">
            Ver os gastos
          </button>
        </KpiTile>
      </div>

      <BudgetStrip />

      <div className="wk__pair">
        <section className="mdcard wk__card" aria-labelledby="wk-blocked" data-testid="painel-blocked">
          <h3 className="mdcard__title" id="wk-blocked">
            Travado <span className="mdcard__count">{blocked.count}</span>
          </h3>
          {blocked.count === 0 ? (
            <p className="mdcard__quiet">Nada travado.</p>
          ) : (
            <>
              <ul className="blk">
                {blocked.rows.map((row) => (
                  <li key={row.key} className="blk__row" data-testid="painel-blocked-row">
                    <button
                      type="button"
                      className="blk__btn"
                      onClick={() => {
                        useWorkStore.getState().open(row.projectId);
                        go("trabalho");
                      }}
                      data-testid="painel-blocked-item"
                    >
                      <span className={`blk__dot blk__dot--${row.tone}`} aria-hidden="true" />
                      <span className="blk__text">
                        <span className="blk__title">{row.title}</span>
                        <span className="blk__meta">
                          {row.typeLabel}
                          {row.agentName ? ` · ${row.agentName}` : ""} · {row.projectTitle}
                        </span>
                      </span>
                      <span className="blk__age">{row.age}</span>
                    </button>
                    <div className="blk__actions act__row">
                      <ProjectActions projectId={row.projectId} />
                      {canReassign(row.type) && (
                        <button
                          type="button"
                          className="ui-button ui-button--secondary ui-button--small act__btn"
                          onClick={() => setReassign({ projectId: row.projectId, ref: row.ref, title: row.title, typeLabel: row.typeLabel, ...(row.agentId ? { agentId: row.agentId } : {}) })}
                          data-testid="painel-reassign"
                        >
                          Reatribuir
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              {blocked.more > 0 && <p className="mdcard__quiet">e mais {blocked.more}: {blocked.summary}</p>}
              {flash?.where === "blocked" && <ActionNote note={{ tone: "ok", text: flash.text }} testId="painel-blocked-flash" />}
            </>
          )}
        </section>

        <section className="mdcard wk__card" aria-labelledby="wk-forecast" data-testid="painel-forecast">
          <h3 className="mdcard__title" id="wk-forecast">
            Prazos e previsão
          </h3>
          {flash?.where === "plans" && <ActionNote note={{ tone: "ok", text: flash.text }} testId="painel-plans-flash" />}
          <ForecastBars view={forecast} renderActions={(row) => <ProjectActions projectId={row.id} pause onDone={(text) => setFlash({ where: "plans", text })} />} />
          <PausedProjects onDone={(text) => setFlash({ where: "plans", text })} />
        </section>
      </div>

      {goals.length > 0 && (
        <p className="wk__facts wk__goals" data-testid="painel-goals">
          <strong>Metas da semana:</strong>{" "}
          {goals.map((goal, index) => (
            <span key={goal.id}>
              {index > 0 && " · "}
              <span className={`wk__goal wk__goal--${goal.tone}`} title={goal.detail} data-testid="painel-goal">
                {goal.text}
              </span>
              <RoutinePause routineId={goal.id} title={goal.title} status={routines?.find((item) => item.routine.id === goal.id)?.routine.status} />
            </span>
          ))}
        </p>
      )}

      <p className="wk__facts" data-testid="painel-week-facts">
        <strong>Nos últimos 7 dias:</strong> {facts.map((fact) => fact.text).join(" · ")}
      </p>

      {batchOpen && <BatchApproveDialog report={report} onClose={() => setBatchOpen(false)} onDone={(text) => setFlash({ where: "batch", text })} />}
      {reassign && <ReassignPicker target={reassign} report={report} onClose={() => setReassign(null)} onDone={(text) => setFlash({ where: "blocked", text })} />}
    </div>
  );
}

/** Pausar ou retomar uma meta pelo Painel (a mesma rota dos botões das Rotinas e metas). */
function RoutinePause({ routineId, title, status }: { routineId: string; title: string; status: string | undefined }) {
  const { busy, note, run } = useActionNote();
  if (status !== "ativa" && status !== "pausada") return null;
  const paused = status === "pausada";
  return (
    <>
      {" "}
      <button
        type="button"
        className="mdlink wk__pause"
        disabled={busy}
        onClick={() => void run(async () => {
          await api.updateRoutine(routineId, paused ? { status: "ativa", pausedUntil: null } : { status: "pausada" });
          await useRoutinesStore.getState().load();
        }, paused ? "Retomada" : "Pausada")}
        aria-label={`${paused ? "Retomar" : "Pausar"} a meta ${title}`}
        data-testid="painel-goal-pause"
      >
        {paused ? "retomar" : "pausar"}
      </button>
      <ActionNote note={note} />
    </>
  );
}

/** Os projetos pausados: saem da previsão enquanto parados, então é daqui que se retoma (e a pausa fica à vista). */
function PausedProjects({ onDone }: { onDone: (text: string) => void }) {
  const projects = useWorkStore((state) => state.projects);
  const paused = projects.filter((project) => project.status === "pausado" && project.kind === "projeto");
  if (paused.length === 0) return null;
  return (
    <div className="fc__paused" data-testid="painel-paused">
      <p className="fc__summary">Pausados ({paused.length}): a previsão só volta quando retomar.</p>
      <ul className="fc__paused-list">
        {paused.map((project) => (
          <li key={project.id} className="fc__paused-row" data-testid="painel-paused-row">
            <span className="fc__paused-title">{project.title}</span>
            <ProjectActions projectId={project.id} pause pin={false} onDone={onDone} />
          </li>
        ))}
      </ul>
    </div>
  );
}
