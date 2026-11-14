import { verEsseMomento } from "../../../cena/replay/replayStore";
import { DAY_STATE_LABELS, dayKeyOf, type DayState, type DayStats, type ForYouItem } from "@cyno/shared";
import { useMemo, useState } from "react";
import { useDayStats } from "../../../store/dayStatsStore";
import { useForYouFocus } from "../../../store/forYouFocus";
import { useNavStore } from "../../../store/navStore";
import { useOfficeStore } from "../../../store/officeStore";
import { useNow } from "../../../ui/ActivityFeed";
import { cardTitle, typeDisplay } from "../../foryou/forYouView";
import {
  ALL_STATES,
  STATE_TONES,
  agentRows,
  clampDay,
  coverageNote,
  dayNav,
  dayOptions,
  doneByAgent,
  emptyView,
  heroView,
  hourChart,
  hourTable,
  legendStates,
  projectRows,
  toggleState,
  usageView,
  waitRows,
  type TimeCells,
} from "./dayView";
import { WeekSection } from "./WeekSection";
import "./painel.css";

/**
 * A aba Painel da Gestão: a tela da manhã. A primeira parte, "Esta semana" (`WeekSection`), responde "o que precisa de
 * mim e estamos no ritmo?" com os números do `/metrics`; a segunda, "Meu dia", é a vista do dia (para onde foi o tempo
 * dos agentes e quanto eles esperaram por você). A contagem de quem espera o OK aparece uma vez só, na primeira parte.
 */
export function PainelTab() {
  const workspaceId = useNavStore((state) => state.workspaceId);
  const now = useNow();
  const today = dayKeyOf(now.getTime());
  const [picked, setPicked] = useState<string | null>(null);
  const day = clampDay(picked ?? today, today);
  const isToday = day === today;
  const { stats, days, error, loading, reload } = useDayStats(day, isToday, workspaceId);
  const nav = dayNav(day, today);
  const options = dayOptions(days?.days ?? [], today, day);
  const go = (next: string | null) => next && setPicked(next === today ? null : next);

  return (
    <section className="page painel" aria-label="Painel" data-testid="page-painel">
      <WeekSection />
      <header className="painel__head painel__head--day">
        <div className="painel__heading">
          <h2 className="painel__title" id="painel-title">
            Meu dia
          </h2>
          <p className="painel__sub">Para onde foi o tempo dos agentes e quanto eles esperaram por você.</p>
        </div>
        <div className="painel__nav" role="group" aria-label="Escolher o dia">
          <button type="button" className="ui-button ui-button--secondary painel__navbtn" onClick={() => go(nav.prev)} disabled={!nav.prev} aria-label="Dia anterior" data-testid="painel-prev">
            ‹
          </button>
          <label className="painel__select">
            <span className="painel__sr">Dia</span>
            <select value={day} onChange={(event) => go(event.target.value)} data-testid="painel-day-select">
              {options.map((option) => (
                <option key={option.day} value={option.day}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="ui-button ui-button--secondary painel__navbtn" onClick={() => go(nav.next)} disabled={!nav.next} aria-label="Próximo dia" data-testid="painel-next">
            ›
          </button>
          <button type="button" className="ui-button ui-button--secondary" onClick={() => setPicked(null)} disabled={isToday} data-testid="painel-today">
            Hoje
          </button>
        </div>
      </header>

      {error && !stats && (
        <p className="ui-error" role="alert" data-testid="painel-error">
          Não deu para carregar o dia. {error}{" "}
          <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={reload}>
            Tentar de novo
          </button>
        </p>
      )}
      {!stats && !error && <p className="page__empty">Carregando o dia…</p>}
      {stats && <DayBody stats={stats} today={today} now={now.getTime()} loading={loading} workspaceIsNew={days !== null && days.days.length === 0} />}
    </section>
  );
}

function DayBody({ stats, today, now, loading, workspaceIsNew }: { stats: DayStats; today: string; now: number; loading: boolean; workspaceIsNew: boolean }) {
  const empty = emptyView(stats, today, workspaceIsNew);
  const note = coverageNote(stats.coverage);
  const forYou = useOfficeStore((state) => state.forYou);
  const types = useOfficeStore((state) => state.forYouTypes);
  const agents = useOfficeStore((state) => state.office?.agents);
  const tasks = useOfficeStore((state) => state.office?.tasks);
  const agentName = (id: string) => agents?.find((agent) => agent.id === id)?.name;
  const itemTitle = (item: ForYouItem) => cardTitle(item, agentName(item.agentId), types);
  const lookup = useMemo(() => new Map((forYou ?? []).map((item) => [item.id, item])), [forYou]);
  const done = useMemo(() => doneByAgent(tasks ?? [], stats), [tasks, stats]);

  return (
    <div className={`painel__body${loading ? " painel__body--loading" : ""}`} data-testid="painel-body" data-day={stats.day} aria-busy={loading}>
      {note && (
        <p className="painel__coverage" data-testid="painel-coverage">
          <span aria-hidden="true">◔</span> {note}. Nesse período só “Esperando você” e o gasto aparecem completos.
        </p>
      )}
      <Hero stats={stats} today={today} />
      {empty ? (
        <section className="painel__empty" data-testid="painel-empty">
          <h3>{empty.title}</h3>
          <p>{empty.text}</p>
        </section>
      ) : (
        <>
          <WaitsCard
            stats={stats}
            title={(id, type) => {
              const item = id ? lookup.get(id) : undefined;
              return item ? itemTitle(item) : typeDisplay(types, type).name;
            }}
          />
          <HoursCard stats={stats} now={now} />
          <div className="painel__grid">
            <AgentsCard stats={stats} done={done} />
            <ProjectsCard stats={stats} />
          </div>
          <UsageCard stats={stats} />
        </>
      )}
    </div>
  );
}

// ---------- O herói ----------

function Hero({ stats, today }: { stats: DayStats; today: string }) {
  const hero = heroView(stats, today);
  return (
    <section className="mdhero mdhero--solo" aria-label="Tempo esperando você" data-testid="painel-hero">
      <div className="mdhero__main">
        <p className="mdhero__label">Tempo que os agentes esperaram por você</p>
        <p className={`mdhero__value${hero.none ? " mdhero__value--none" : ""}`} data-testid="painel-hero-value">
          {hero.value}
        </p>
        {hero.details && <p className="mdhero__details">{hero.details}</p>}
        {hero.chips.length > 0 && (
          <ul className="mdhero__chips" aria-label="Comparação">
            {hero.chips.map((chip) => (
              <li key={chip.id} className={`mdchip mdchip--${chip.tone}`} data-testid={`painel-chip-${chip.id}`}>
                {chip.text}
              </li>
            ))}
          </ul>
        )}
        <p className="mdhero__sentence" data-testid="painel-sentence">
          {hero.sentence}
        </p>
      </div>
    </section>
  );
}

// ---------- As maiores esperas ----------

function WaitsCard({ stats, title }: { stats: DayStats; title: (forYouId: string | undefined, type: string) => string }) {
  const rows = waitRows(stats, title);
  if (rows.length === 0) return null;
  return (
    <section className="mdcard" aria-labelledby="md-waits" data-testid="painel-waits">
      <h3 className="mdcard__title" id="md-waits">
        As maiores esperas <span className="mdcard__count">{rows.length}</span>
      </h3>
      <ol className="mdwaits">
        {rows.map((row, index) => (
          <li key={row.key} className="mdwait">
            <button type="button" className="mdwait__btn" disabled={!row.forYouId} onClick={() => row.forYouId && useForYouFocus.getState().open(row.forYouId)} data-testid="painel-wait">
              <span className="mdwait__rank" aria-hidden="true">
                {index + 1}
              </span>
              <span className="mdwait__text">
                <span className="mdwait__title">{row.title}</span>
                <span className="mdwait__meta">
                  {row.agentName}
                  {row.where ? ` · ${row.where}` : ""} · {row.span}
                </span>
              </span>
              <span className="mdwait__bar" aria-hidden="true">
                <span style={{ width: `${Math.max(4, Math.round(row.ratio * 100))}%` }} className={row.open ? "is-open" : ""} />
              </span>
              <span className="mdwait__time">
                {row.duration}
                {row.open && <span className="mdwait__live"> · aberta</span>}
              </span>
            </button>
            <button type="button" className="mdlink mdwait__replay" onClick={() => verEsseMomento(row.start)} data-testid="painel-wait-replay" title="Abrir o Escritório no replay do começo desta espera">
              Ver esse momento
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------- O dia por hora ----------

function HoursCard({ stats, now }: { stats: DayStats; now: number }) {
  const [visible, setVisible] = useState<ReadonlySet<DayState>>(() => new Set(ALL_STATES));
  const [asTable, setAsTable] = useState(false);
  const legend = legendStates(stats.hours);
  const chart = hourChart(stats.hours, now, visible);
  const table = hourTable(stats.hours, legend);
  return (
    <section className="mdcard" aria-labelledby="md-hours" data-testid="painel-hours">
      <div className="mdcard__bar">
        <h3 className="mdcard__title" id="md-hours">
          O dia por hora
        </h3>
        <button type="button" className="mdlink" onClick={() => setAsTable((value) => !value)} aria-pressed={asTable} data-testid="painel-hours-table-toggle">
          {asTable ? "Ver o gráfico" : "Ver como tabela"}
        </button>
      </div>
      {legend.length === 0 ? (
        <p className="mdcard__quiet">Sem tempo registrado por estado neste dia.</p>
      ) : (
        <>
          <ul className="mdlegend" aria-label="Estados (clique para ligar ou desligar)">
            {legend.map((state) => (
              <li key={state}>
                <button type="button" className="mdlegend__btn" aria-pressed={visible.has(state)} onClick={() => setVisible((current) => toggleState(current, state))} data-testid={`painel-legend-${state}`}>
                  <span className={`mdswatch mdswatch--${STATE_TONES[state]}`} aria-hidden="true" />
                  {DAY_STATE_LABELS[state]}
                </button>
              </li>
            ))}
          </ul>
          {!asTable && (
            <div className="mdchart" data-testid="painel-chart">
              <div className="mdchart__scroll">
                <div className="mdchart__plot" role="img" aria-label="Tempo por hora, empilhado por estado. A tabela abaixo traz os mesmos números.">
                  <div className="mdchart__axis" aria-hidden="true">
                    {chart.ticks.map((tick) => (
                      <span key={tick.pct} style={{ bottom: `${tick.pct}%` }}>
                        {tick.label}
                      </span>
                    ))}
                  </div>
                  <div className="mdchart__bars">
                    {chart.bars.map((bar) => (
                      <div key={bar.t} className={`mdbar${bar.current ? " mdbar--now" : ""}${bar.future ? " mdbar--future" : ""}`} data-testid={`painel-bar-${bar.label}`} data-current={bar.current || undefined} title={`${bar.label}h`}>
                        <div className="mdbar__stack">
                          {bar.segments.map((segment) => (
                            <span key={segment.state} className={`mdseg mdseg--${STATE_TONES[segment.state]}`} style={{ height: `${segment.pct}%` }} />
                          ))}
                        </div>
                        {bar.totalMs > 0 ? (
                          <button type="button" className="mdbar__label mdbar__label--link" onClick={() => verEsseMomento(bar.t)} aria-label={`Ver esse momento: ${bar.label}h`} title={`Ver esse momento (${bar.label}h) no replay do Escritório`} data-testid={`painel-bar-replay-${bar.label}`}>
                            {bar.label}
                          </button>
                        ) : (
                          <span className="mdbar__label">{bar.label}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
          <details className="mdtable" open={asTable} data-testid="painel-hours-details">
            <summary>Tabela do dia por hora</summary>
            <div className="mdtable__scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Hora</th>
                    {legend.map((state) => (
                      <th key={state} scope="col">
                        {DAY_STATE_LABELS[state]}
                      </th>
                    ))}
                    <th scope="col">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {table.map((row) => (
                    <tr key={row.key}>
                      <th scope="row">{row.hour}</th>
                      {row.cells.map((cell) => (
                        <td key={cell.state}>{cell.text}</td>
                      ))}
                      <td>{row.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

// ---------- Por agente e por projeto ----------

function Cells({ cells }: { cells: TimeCells }) {
  return (
    <>
      <td>{cells.working}</td>
      <td>{cells.queued}</td>
      <td className="mdnum--owner">{cells.waitingOwner}</td>
      <td>{cells.stalled}</td>
    </>
  );
}

const TIME_HEAD = (
  <>
    <th scope="col">Trabalhando</th>
    <th scope="col">Na fila</th>
    <th scope="col">Esperando você</th>
    <th scope="col" title="Esperando outro agente, o Maestro ou sem cota">
      Parado
    </th>
  </>
);

function AgentsCard({ stats, done }: { stats: DayStats; done: ReadonlyMap<string, number> }) {
  const rows = agentRows(stats, done);
  return (
    <section className="mdcard" aria-labelledby="md-agents" data-testid="painel-agents">
      <h3 className="mdcard__title" id="md-agents">
        Por agente <span className="mdcard__count">{rows.length}</span>
      </h3>
      {rows.length === 0 ? (
        <p className="mdcard__quiet">Nenhum agente teve tempo registrado neste dia.</p>
      ) : (
        <div className="mdtable__scroll">
          <table className="mdgrid">
            <thead>
              <tr>
                <th scope="col">Agente</th>
                {TIME_HEAD}
                <th scope="col">Concluídas</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid="painel-agent-row">
                  <th scope="row">{row.name}</th>
                  <Cells cells={row.cells} />
                  <td>{row.done}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ProjectsCard({ stats }: { stats: DayStats }) {
  const rows = projectRows(stats);
  return (
    <section className="mdcard" aria-labelledby="md-projects" data-testid="painel-projects">
      <h3 className="mdcard__title" id="md-projects">
        Por projeto e sprint <span className="mdcard__count">{rows.length}</span>
      </h3>
      {rows.length === 0 ? (
        <p className="mdcard__quiet">Nenhum projeto teve tempo registrado neste dia.</p>
      ) : (
        <div className="mdtable__scroll">
          <table className="mdgrid">
            <thead>
              <tr>
                <th scope="col">Projeto</th>
                {TIME_HEAD}
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((row) => [
                <tr key={row.id} data-testid="painel-project-row">
                  <th scope="row">{row.name}</th>
                  <Cells cells={row.cells} />
                </tr>,
                ...row.sprints.map((sprint) => (
                  <tr key={`${row.id}:${sprint.id}`} className="mdgrid__sprint" data-testid="painel-sprint-row">
                    <th scope="row">{sprint.name}</th>
                    <Cells cells={sprint.cells} />
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------- O gasto do dia ----------

function UsageCard({ stats }: { stats: DayStats }) {
  const usage = usageView(stats);
  return (
    <section className="mdcard" aria-labelledby="md-usage" data-testid="painel-usage">
      <h3 className="mdcard__title" id="md-usage">
        O gasto do dia
      </h3>
      {!usage.hasUsage ? (
        <p className="mdcard__quiet">Nenhum turno de agente neste dia.</p>
      ) : (
        <>
          <dl className="mdstats">
            <div>
              <dt>Tokens</dt>
              <dd>{usage.tokens}</dd>
            </div>
            <div>
              <dt>Turnos</dt>
              <dd>{stats.totals.turns}</dd>
            </div>
            <div>
              <dt>Custo equivalente</dt>
              <dd>
                {usage.cost}
                <small>{usage.costUsd}</small>
              </dd>
            </div>
          </dl>
          {usage.unmeasured && <p className="mdcard__quiet">{usage.unmeasured}: o motor não informou os tokens desses turnos.</p>}
          {usage.providers.length > 0 && (
            <ul className="mdprov" aria-label="Por motor">
              {usage.providers.map((provider) => (
                <li key={provider.id} data-testid="painel-provider">
                  <span className="mdprov__name">{provider.label}</span>
                  <span className="mdprov__meta">
                    {provider.turns}
                    {provider.unmeasured ? ` (${provider.unmeasured})` : ""} · {provider.tokens} tokens
                  </span>
                  <span className="mdprov__cost">{provider.cost}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
