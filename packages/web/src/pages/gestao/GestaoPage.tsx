import type { RoutineOverviewItem } from "@cyno/shared";
import { useEffect, useMemo, useState } from "react";
import { useWorkPanelStore } from "../../agentWork/workPanelStore";
import { useNavStore } from "../../store/navStore";
import { useOfficeStore } from "../../store/officeStore";
import { useGestaoFocus } from "../../store/gestaoFocus";
import { useRoutinesStore } from "../../store/routinesStore";
import { GIcon } from "./GIcon";
import { GoalCard } from "./GoalCard";
import { RoutineDetailPanel } from "./RoutineDetail";
import { RoutineDialog } from "./RoutineDialog";
import { SummaryStrip } from "./SummaryStrip";
import { ownerLabel, pendingChangeProposals } from "./gestaoView";
import { ROUTINE_FILTERS, ROUTINE_FILTER_LABELS, emptyFilterText, filterCounts, filterRoutines, sectionTitle, type RoutineFilter } from "./routineView";
import type { RoutineFormValues } from "./routineForm";
import "./gestao.css";
import "./routines.css";

/** A frase que "Montar com o Maestro" coloca na caixa (o usuário revisa e envia). */
export const MAESTRO_ROUTINES_PROMPT = "Quero montar as rotinas deste workspace. Por onde começamos?";

/** Atualiza a Gestão a cada minuto (o resumo muda com tarefas e itens de Aprovações, que não são eventos de rotina). */
const REFRESH_MS = 60_000;

type DialogState = { kind: "new"; initial?: RoutineFormValues } | { kind: "edit"; routineId: string } | null;

/** Página "Gestão": o único lugar do gestor. Resumo no topo e as rotinas (metas e acompanhamentos) embaixo. */
export function GestaoPage() {
  // Trocar de workspace recomeça a página (painel e diálogos eram do anterior).
  const workspaceId = useNavStore((state) => state.workspaceId);
  return (
    <section className="page page--fill page--gestao" aria-labelledby="page-title-gestao" data-testid="page-gestao">
      <GestaoView key={workspaceId ?? ""} />
    </section>
  );
}

function GestaoView() {
  const overview = useRoutinesStore((state) => state.overview);
  const summary = useRoutinesStore((state) => state.summary);
  const error = useRoutinesStore((state) => state.error);
  const go = useNavStore((state) => state.go);
  // O painel "Hoje" abre a rotina direto (useGestaoFocus); o pedido vale uma vez.
  const [openId, setOpenId] = useState<string | null>(() => useGestaoFocus.getState().routineId);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [filter, setFilter] = useState<RoutineFilter>("todas");

  useEffect(() => {
    useGestaoFocus.getState().clear();
  }, []);

  useEffect(() => {
    void useRoutinesStore.getState().load();
    const timer = window.setInterval(() => void useRoutinesStore.getState().load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const { goals, proposals } = useMemo(() => {
    const all = overview?.routines ?? [];
    return { goals: all.filter((item) => item.routine.status !== "proposta"), proposals: all.filter((item) => item.routine.status === "proposta") };
  }, [overview]);
  const forYou = useOfficeStore((state) => state.forYou);
  const changes = useMemo(() => pendingChangeProposals(forYou), [forYou]);
  const shown = useMemo(() => filterRoutines(goals, filter), [goals, filter]);
  const counts = useMemo(() => filterCounts(goals), [goals]);
  const ended = overview?.ended ?? [];
  const open: RoutineOverviewItem | undefined = goals.find((item) => item.routine.id === openId) ?? ended.find((item) => item.routine.id === openId);
  const editing = dialog?.kind === "edit" ? goals.find((item) => item.routine.id === dialog.routineId)?.routine : undefined;
  const loading = overview === null && error === null;
  const empty = overview !== null && goals.length === 0 && proposals.length === 0;

  return (
    <>
      <header className="page__header page__header--row">
        <div className="page__heading">
          <h2 id="page-title-gestao" className="page__title">
            Rotinas e metas
          </h2>
          <p className="page__subtitle">Como o time está indo: o que espera você, o que deu errado, o ritmo das metas e os acompanhamentos.</p>
        </div>
        <div className="page__actions">
          <button type="button" className="ui-button ui-button--secondary" onClick={() => useWorkPanelStore.getState().openMaestroWith(MAESTRO_ROUTINES_PROMPT)} data-testid="gestao-maestro">
            <GIcon name="sparkles" size={14} />
            Montar com o Maestro
          </button>
          <button type="button" className="ui-button" onClick={() => setDialog({ kind: "new" })} data-testid="gestao-new">
            <GIcon name="plus" size={14} />
            Nova rotina
          </button>
        </div>
      </header>

      <div className={`gestao${open ? " gestao--detail" : ""}${open?.routine.type === "acompanhamento" ? " gestao--wide" : ""}`}>
        <div className="gestao__main">
          {summary && <SummaryStrip summary={summary} trackings={goals.filter((item) => item.routine.type === "acompanhamento" && item.routine.status === "ativa").length} />}
          {error && !overview && (
            <p className="ui-error" role="alert">
              {error}
            </p>
          )}
          {loading && <p className="page__empty">Carregando…</p>}

          {(proposals.length > 0 || changes.length > 0) && (
            <section className="gprop" aria-label="Propostas" data-testid="gestao-proposals">
              <h3 className="gsection__title">
                Propostas <span className="gsection__count">{proposals.length + changes.length}</span>
              </h3>
              <ul className="gprop__list">
                {changes.map((change) => (
                  <li key={change.itemId} className="gprop__item">
                    <GIcon name="flag" size={14} />
                    <span className="gprop__text">
                      <strong>{change.text}</strong> · {change.title} ({change.routineId})
                    </span>
                    <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => go("para-voce")} data-testid={`proposal-change-${change.itemId}`}>
                      Ir para Aprovações
                    </button>
                  </li>
                ))}
                {proposals.map((item) => (
                  <li key={item.routine.id} className="gprop__item">
                    <GIcon name="flag" size={14} />
                    <span className="gprop__text">
                      <strong>{item.routine.title}</strong> · {item.routine.type === "meta" ? `${item.routine.target} por ${item.period === "month" ? "mês" : "semana"}` : "acompanhamento"} · {ownerLabel(item)}
                    </span>
                    <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => go("para-voce")} data-testid={`proposal-${item.routine.id}`}>
                      Ir para Aprovações
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {goals.length > 0 && (
            <section className="gsection" aria-label={sectionTitle(filter)} data-testid="gestao-routines">
              <div className="gsection__bar">
                <h3 className="gsection__title">
                  {sectionTitle(filter)} <span className="gsection__count">{shown.length}</span>
                </h3>
                <div className="rfilter" role="group" aria-label="Filtrar rotinas">
                  {ROUTINE_FILTERS.map((id) => (
                    <button key={id} type="button" className="rfilter__chip" aria-pressed={filter === id} onClick={() => setFilter(id)} data-testid={`routine-filter-${id}`}>
                      {ROUTINE_FILTER_LABELS[id]} <span className="rfilter__count">{counts[id]}</span>
                    </button>
                  ))}
                </div>
              </div>
              {shown.length === 0 ? (
                <p className="page__empty" data-testid="gestao-filter-empty">
                  {emptyFilterText(filter)}
                </p>
              ) : (
                <div className="ggrid" data-testid="gestao-goals">
                  {shown.map((item) => (
                    <GoalCard key={item.routine.id} item={item} selected={item.routine.id === openId} onOpen={() => setOpenId(item.routine.id)} onEdit={() => setDialog({ kind: "edit", routineId: item.routine.id })} />
                  ))}
                </div>
              )}
            </section>
          )}

          {ended.length > 0 && (
            <details className="gended" data-testid="gestao-ended">
              <summary className="gsection__title">
                Encerradas <span className="gsection__count">{ended.length}</span>
              </summary>
              <ul className="gprop__list">
                {ended.map((item) => (
                  <li key={item.routine.id} className="gprop__item">
                    <GIcon name="flag" size={14} />
                    <span className="gprop__text">
                      <strong>{item.routine.title}</strong> · {item.routine.id} · {ownerLabel(item)}
                    </span>
                    <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => setOpenId(item.routine.id)} data-testid={`ended-open-${item.routine.id}`}>
                      Abrir
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {empty && (
            <section className="gempty" data-testid="gestao-empty">
              <span className="gempty__icon" aria-hidden="true">
                <GIcon name="target" size={28} />
              </span>
              <h3 className="gempty__title">Nenhuma rotina ainda</h3>
              <p className="gempty__text">Uma rotina é um combinado que o servidor vigia sem gastar token. Uma Meta é um alvo por período, por exemplo “2 posts por semana”: cobra o agente quando estiver atrasado e só conta o que foi entregue, com o link. Um Acompanhamento confere uma lista de itens (inscrições, pedidos…) em horários fixos e avisa quando algo muda. Você decide em cada rotina se o agente pede o seu OK ou age sozinho.</p>
              <div className="gempty__actions">
                <button type="button" className="ui-button" onClick={() => useWorkPanelStore.getState().openMaestroWith(MAESTRO_ROUTINES_PROMPT)} data-testid="gestao-empty-maestro">
                  <GIcon name="sparkles" size={14} />
                  Montar com o Maestro
                </button>
                <button type="button" className="ui-button ui-button--secondary" onClick={() => setDialog({ kind: "new" })} data-testid="gestao-empty-new">
                  <GIcon name="plus" size={14} />
                  Criar pelo formulário
                </button>
              </div>
            </section>
          )}
        </div>

        {open && <RoutineDetailPanel key={open.routine.id} item={open} onClose={() => setOpenId(null)} onEdit={() => setDialog({ kind: "edit", routineId: open.routine.id })} />}
      </div>

      {dialog?.kind === "new" && <RoutineDialog initial={dialog.initial} onClose={() => setDialog(null)} onSaved={(saved) => setOpenId(saved.id)} />}
      {dialog?.kind === "edit" && editing && <RoutineDialog routine={editing} onClose={() => setDialog(null)} />}
    </>
  );
}
