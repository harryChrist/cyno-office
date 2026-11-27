import { useEffect, type ReactNode } from "react";
import { useAgendaStore } from "../../store/agendaStore";
import { useCynoStore } from "../../store/cynoStore";
import { useMuralStore } from "../../store/muralStore";
import { useNavStore } from "../../store/navStore";
import { compactDayLabel, dayKeyOf, eventTimeLabel, todayKey, upcomingEvents, workspaceColor } from "../agenda/agendaTime";
import { MuralPanel } from "../mural/MuralPanel";
import { ageLabel } from "./cynoHome";
import { RequestRow, SentRequestsSection } from "./RequestsPanel";
import { AgendaNext, openWaiting, useAgendaLoad } from "./HomeStrip";
import { WorkspaceCards, enterWorkspace } from "./WorkspaceCards";
import { GestaoBlock } from "./GestaoBlock";
import { agendaTodayCount, openRequests, oldestWaiting, SIDE_TABS, sideCounts, workspaceLine, type SideCounts, type SideTabId } from "./cynoSideLogic";
import { isOpenRequest } from "./cynoRequests";
import { WaitedLine } from "../gestao/painel/WaitedLine";
import "./cynoSide.css";

/** Os números das abas (e dos chips do celular), todos ao vivo das lojas que o websocket do Cyno mantém. */
export function useSideCounts(now: Date): SideCounts {
  const waiting = useCynoStore((state) => state.waiting.length);
  const open = useCynoStore((state) => state.requests.filter(isOpenRequest).length);
  const events = useAgendaStore((state) => state.events);
  const news = useMuralStore((state) => Object.values(state.news).reduce((sum, count) => sum + count, 0));
  useAgendaLoad(now);
  useEffect(() => {
    void useMuralStore.getState().load();
  }, []);
  return sideCounts({ waiting, openRequests: open, agendaToday: agendaTodayCount(events, now), muralNews: news });
}

const ICONS: Record<SideTabId, ReactNode> = {
  resumo: <path d="M4 13l3-8h10l3 8v6H4v-6zm0 0h5l1 2h4l1-2h5" />,
  workspaces: <path d="M4 5h7v7H4zM13 5h7v7h-7zM4 14h7v5H4zM13 14h7v5h-7z" />,
  agenda: <path d="M5 6h14v13H5zM5 10h14M9 4v4M15 4v4" />,
  mural: <path d="M5 5h14v14H5zM9 9h6M9 13h4" />,
};

function TabIcon({ id }: { id: SideTabId }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round">
      {ICONS[id]}
    </svg>
  );
}

/** Uma seção do Resumo: título pequeno, o total e um atalho. */
function Block({ title, count, action, children, testId }: { title: string; count?: string; action?: { label: string; onClick: () => void; testId?: string }; children: ReactNode; testId: string }) {
  return (
    <section className="sblock" aria-label={title} data-testid={testId}>
      <header className="sblock__head">
        <h3 className="sblock__title">{title}</h3>
        {count && <span className="sblock__count">{count}</span>}
        {action && (
          <button type="button" className="sblock__action" onClick={action.onClick} data-testid={action.testId}>
            {action.label}
          </button>
        )}
      </header>
      {children}
    </section>
  );
}

/** O Resumo: só o que pede atenção, em poucas linhas, cada uma levando ao lugar certo. */
function Summary({ now, goTab }: { now: Date; goTab: (tab: SideTabId) => void }) {
  const waiting = useCynoStore((state) => state.waiting);
  const requests = useCynoStore((state) => state.requests);
  const cards = useCynoStore((state) => state.cards);
  const cardsLoaded = useCynoStore((state) => state.cardsLoaded);
  const events = useAgendaStore((state) => state.events);
  const workspaces = useAgendaStore((state) => state.workspaces);
  const setWorkspace = useNavStore((state) => state.setWorkspace);
  const go = useNavStore((state) => state.go);
  const oldest = oldestWaiting(waiting, 3);
  const open = openRequests(requests);
  const closed = requests.length - open.length;
  const next = upcomingEvents(events, now, 2);
  const today = todayKey(now);
  const nameOf = (id: string | undefined) => workspaces.find((workspace) => workspace.id === id)?.name ?? id ?? "";
  // Com algo esperando, a linha leva às Aprovações daquele workspace; senão, ao escritório dele.
  const openWorkspaceCard = (workspace: string, waitingForYou: number) => {
    if (waitingForYou === 0) return enterWorkspace(workspace);
    setWorkspace(workspace);
    go("para-voce");
  };
  const seeAll = () => {
    if (oldest[0]) setWorkspace(oldest[0].workspace);
    go("para-voce");
  };
  return (
    <div className="side-summary" data-testid="cyno-summary">
      <WaitedLine scope="platform" />
      <Block title="Esperando você" count={waiting.length > 0 ? String(waiting.length) : undefined} action={waiting.length > 0 ? { label: "Ver todos", onClick: seeAll, testId: "summary-see-all" } : undefined} testId="summary-waiting">
        {!cardsLoaded ? (
          <p className="sblock__empty">Carregando…</p>
        ) : oldest.length === 0 ? (
          <p className="sblock__empty" data-testid="waiting-empty">
            Nada esperando você
          </p>
        ) : (
          <ul className="srows">
            {oldest.map((item) => (
              <li key={item.id}>
                <button type="button" className="srow" onClick={() => (item.type === "conjunto" ? undefined : openWaiting(item))} disabled={item.type === "conjunto"} aria-label={`Abrir ${item.title} em Aprovações de ${item.workspaceName}`} data-testid="waiting-open">
                  <span className="srow__main">
                    <span className="srow__title">{item.title}</span>
                    <span className="srow__meta">
                      {item.agent ? `${item.agent} · ` : ""}
                      {item.workspaceName} · {ageLabel(item.at, now)}
                    </span>
                  </span>
                  <span className="srow__go">{item.type === "conjunto" ? "no chat" : "Abrir"}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Block>

      {requests.length > 0 && (
        <Block title="Pedidos enviados" count={open.length > 0 ? `${open.length} ${open.length === 1 ? "aberto" : "abertos"}` : undefined} action={{ label: "Histórico", onClick: () => goTab("workspaces") }} testId="summary-requests">
          {open.length === 0 ? (
            <p className="sblock__empty">Nenhum pedido em aberto</p>
          ) : (
            <ul className="srows">
              {open.slice(0, 3).map((view) => (
                <li key={view.projectId}>
                  <RequestRow view={view} />
                </li>
              ))}
            </ul>
          )}
          {(closed > 0 || open.length > 3) && (
            <p className="sblock__note">
              {open.length > 3 ? `e mais ${open.length - 3} em aberto` : ""}
              {open.length > 3 && closed > 0 ? " · " : ""}
              {closed > 0 ? `${closed} ${closed === 1 ? "concluído ou fechado" : "concluídos ou fechados"}` : ""}
            </p>
          )}
        </Block>
      )}

      {next.length > 0 && (
        <Block title={next.length === 1 ? "Próximo compromisso" : "Próximos compromissos"} action={{ label: "Agenda", onClick: () => goTab("agenda") }} testId="summary-agenda">
          <ul className="srows">
            {next.map((event) => (
              <li key={event.id}>
                <button type="button" className="srow srow--event" style={{ ["--ws" as string]: workspaceColor(event.workspace) }} onClick={() => goTab("agenda")} data-testid="summary-event">
                  <span className="srow__when">
                    <span>{compactDayLabel(dayKeyOf(event.start), today)}</span>
                    <span>{eventTimeLabel(event)}</span>
                  </span>
                  <span className="srow__main">
                    <span className="srow__title">{event.title}</span>
                    <span className="srow__meta">{event.workspace ? nameOf(event.workspace) : "Marcado por você"}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Block>
      )}

      {cards.length > 0 && <GestaoBlock cards={cards} loaded={cardsLoaded} now={now} />}

      <Block title="Workspaces" action={{ label: "Fichas", onClick: () => goTab("workspaces") }} testId="summary-workspaces">
        {!cardsLoaded ? (
          <p className="sblock__empty">Carregando…</p>
        ) : cards.length === 0 ? (
          <div className="sblock__first" data-testid="summary-no-workspace">
            <p className="sblock__empty">Nenhum workspace ainda</p>
            <button type="button" className="ui-button cyno-solid" onClick={() => goTab("workspaces")}>
              Criar o primeiro
            </button>
          </div>
        ) : (
          <ul className="srows">
            {[...cards].sort((a, b) => b.waitingForYou - a.waitingForYou || b.projects.active.length - a.projects.active.length || a.name.localeCompare(b.name, "pt-BR")).map((card) => {
              const line = workspaceLine(card, now);
              return (
                <li key={card.workspace}>
                  <button type="button" className={`srow srow--ws srow--${line.tone}`} onClick={() => openWorkspaceCard(card.workspace, card.waitingForYou)} data-testid="summary-workspace" data-workspace={card.workspace}>
                    <span className="srow__dot" aria-hidden="true" />
                    <span className="srow__main">
                      <span className="srow__title">{line.name}</span>
                      <span className="srow__meta">{line.text}</span>
                      {line.meta && <span className="srow__meta srow__meta--soft">{line.meta}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Block>
    </div>
  );
}

function Count({ value, tone }: { value: number; tone?: "alert" }) {
  if (value <= 0) return null;
  return <span className={`sbadge${tone === "alert" ? " sbadge--alert" : ""}`}>{value > 99 ? "99+" : value}</span>;
}

/**
 * O painel lateral da página do Cyno: uma aba por vez (Resumo, Workspaces, Agenda, Mural), só o corpo rola.
 * No celular ele é a folha que sobe de baixo (`sheet`), com as mesmas abas.
 */
export function CynoSide({ now, tab, onTab, counts, onCollapse, sheet, onClose }: { now: Date; tab: SideTabId; onTab: (tab: SideTabId) => void; counts: SideCounts; onCollapse: () => void; sheet: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!sheet) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, onClose]);
  return (
    <>
      {sheet && <div className="cyno-sheet-backdrop" onClick={onClose} data-testid="cyno-sheet-backdrop" />}
      <aside className="cyno-side" data-sheet={sheet ? "open" : "closed"} aria-label="Painel do Cyno" data-testid="cyno-side">
        <div className="cyno-side__grab" aria-hidden="true" />
        <div className="cyno-side__top">
          <div className="cyno-side__tabs" role="tablist" aria-label="Painel do Cyno" data-testid="cyno-tabs">
            {SIDE_TABS.map((item) => (
              <button key={item.id} type="button" role="tab" id={`cyno-tab-${item.id}`} aria-selected={tab === item.id} aria-controls="cyno-side-panel" className="cyno-side__tab" onClick={() => onTab(item.id)} data-testid={`cyno-tab-${item.id}`}>
                {item.label}
                <Count value={counts[item.id]} tone={item.id === "resumo" ? "alert" : undefined} />
              </button>
            ))}
          </div>
          <button type="button" className="cyno-side__collapse" onClick={onCollapse} aria-label="Recolher o painel" title="Recolher o painel" data-testid="cyno-side-collapse">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
          <button type="button" className="cyno-side__close" onClick={onClose} aria-label="Fechar o painel" data-testid="cyno-side-close">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="cyno-side__body" role="tabpanel" id="cyno-side-panel" aria-labelledby={`cyno-tab-${tab}`} data-panel={tab} tabIndex={0}>
          {tab === "resumo" && <Summary now={now} goTab={onTab} />}
          {tab === "workspaces" && (
            <div className="side-stack">
              <WorkspaceCards now={now} />
              <SentRequestsSection />
            </div>
          )}
          {tab === "agenda" && <AgendaNext now={now} />}
          {tab === "mural" && <MuralPanel />}
        </div>
      </aside>
    </>
  );
}

/** Painel recolhido (computador): uma faixa fina com os contadores; cada botão reabre o painel naquela aba. */
export function CynoRail({ counts, onOpen }: { counts: SideCounts; onOpen: (tab: SideTabId) => void }) {
  return (
    <nav className="cyno-rail" aria-label="Painel do Cyno recolhido" data-testid="cyno-rail">
      <button type="button" className="cyno-rail__btn cyno-rail__btn--open" onClick={() => onOpen("resumo")} aria-label="Abrir o painel" title="Abrir o painel" data-testid="cyno-side-expand">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 6l-6 6 6 6" />
        </svg>
      </button>
      {SIDE_TABS.map((item) => (
        <button key={item.id} type="button" className="cyno-rail__btn" onClick={() => onOpen(item.id)} aria-label={`${item.label}${counts[item.id] > 0 ? `: ${counts[item.id]}` : ""}`} title={item.label} data-testid={`cyno-rail-${item.id}`}>
          <TabIcon id={item.id} />
          <Count value={counts[item.id]} tone={item.id === "resumo" ? "alert" : undefined} />
        </button>
      ))}
    </nav>
  );
}

/** Celular: uma fileira de chips com os contadores; cada um abre a folha do painel na aba certa. */
export function CynoChips({ counts, noWorkspaces, onOpen }: { counts: SideCounts; noWorkspaces: boolean; onOpen: (tab: SideTabId) => void }) {
  const first = noWorkspaces ? "Criar o primeiro workspace" : counts.resumo > 0 ? `${counts.resumo} esperando você` : "Resumo";
  return (
    <div className="cyno-chips" role="group" aria-label="Atalhos do painel" data-testid="cyno-chips">
      <button type="button" className={`cyno-chip-btn${counts.resumo > 0 ? " cyno-chip-btn--alert" : ""}`} onClick={() => onOpen(noWorkspaces ? "workspaces" : "resumo")} data-testid="cyno-chip-resumo">
        {first}
      </button>
      {counts.workspaces > 0 && (
        <button type="button" className="cyno-chip-btn" onClick={() => onOpen("workspaces")} data-testid="cyno-chip-workspaces">
          {counts.workspaces} {counts.workspaces === 1 ? "pedido" : "pedidos"}
        </button>
      )}
      <button type="button" className="cyno-chip-btn" onClick={() => onOpen("agenda")} data-testid="cyno-chip-agenda">
        Agenda{counts.agenda > 0 ? ` · ${counts.agenda} hoje` : ""}
      </button>
      <button type="button" className="cyno-chip-btn" onClick={() => onOpen("mural")} data-testid="cyno-chip-mural">
        Mural{counts.mural > 0 ? ` · ${counts.mural}` : ""}
      </button>
    </div>
  );
}
