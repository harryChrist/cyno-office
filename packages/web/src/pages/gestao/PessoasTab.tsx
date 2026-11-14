import { agentEngine, describeModelChoice, isMaestroAgent, type MetricsReport } from "@cyno/shared";
import { useMemo, useState } from "react";
import { useNavStore } from "../../store/navStore";
import { useOfficeStore } from "../../store/officeStore";
import { typeDisplay } from "../foryou/forYouView";
import { api } from "../../api/client";
import { ActionNote, ModelChangeDialog, useActionNote, type ModelTarget } from "./ActionControls";
import { dispatchChoices, dispatchSentence } from "./actionsView";
import { LoadBars } from "./LoadBars";
import { PEOPLE_WINDOW_DAYS, useMetrics } from "./metricsApi";
import { DEFAULT_SORT, PEOPLE_COLUMNS, PEOPLE_SORT_KEYS, loadBars, nextSort, peopleEmpty, personRows, refusalByType, sortPeople, type PeopleSortKey, type Person, type PersonRow, type SortDir } from "./pessoasView";
import "./painel/painel.css";
import "./actions.css";
import "./metrics.css";

/** A aba Pessoas da Gestão: uma linha por agente (o que entrega, o que é recusado, refeito, editado e falha), a carga de agora e quem mais é recusado por tipo. */
export function PessoasTab() {
  const workspaceId = useNavStore((state) => state.workspaceId);
  const { report, error, reload } = useMetrics(workspaceId, PEOPLE_WINDOW_DAYS);
  return (
    <section className="page pe" aria-labelledby="ps-title" data-testid="page-pessoas">
      <header className="pe__head">
        <div>
          <h2 className="painel__title" id="ps-title">
            Pessoas
          </h2>
          <p className="painel__sub">O que cada agente entrega e o que você precisa corrigir, nas últimas {PEOPLE_WINDOW_DAYS / 7} semanas.</p>
        </div>
      </header>
      {error && !report && (
        <p className="ui-error" role="alert" data-testid="pessoas-error">
          Não deu para carregar os números. {error}{" "}
          <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={reload}>
            Tentar de novo
          </button>
        </p>
      )}
      {!report && !error && <p className="page__empty">Carregando as pessoas…</p>}
      {report && <PessoasBody report={report} onChanged={reload} />}
    </section>
  );
}

function PessoasBody({ report, onChanged }: { report: MetricsReport; onChanged: () => void }) {
  const [modelFor, setModelFor] = useState<ModelTarget | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const office = useOfficeStore((state) => state.office);
  const types = useOfficeStore((state) => state.forYouTypes);
  const [sort, setSort] = useState<{ key: PeopleSortKey; dir: SortDir }>(DEFAULT_SORT);
  const people: Person[] = useMemo(
    () => (office ? office.agents.filter((agent) => !isMaestroAgent(office, agent)).map((agent) => ({ id: agent.id, name: agent.name, engine: describeModelChoice({ engine: agentEngine(agent), model: agent.model, effort: agent.effort }) })) : []),
    [office],
  );
  const rows = useMemo(() => sortPeople(personRows(report, people), sort.key, sort.dir), [report, people, sort]);
  const load = useMemo(() => loadBars(report, people), [report, people]);
  const refusals = useMemo(() => refusalByType(report, (type) => typeDisplay(types, type).name), [report, types]);
  const empty = peopleEmpty(report, people);

  return (
    <div className="pe__body">
      <ParallelControl report={report} onChanged={onChanged} />
      {flash && (
        <p className="act__note act__note--ok" role="status" data-testid="pessoas-flash">
          {flash}
        </p>
      )}

      {empty && (
        <p className="wk__empty" data-testid="pessoas-empty">
          <strong>{empty.title}.</strong> {empty.text}
        </p>
      )}

      {people.length > 0 && (
        <>
          <section className="mdcard pe__card pe__tablecard" aria-label="Agentes" data-testid="pessoas-table">
            <div className="pe__scroll">
              <table className="pe__grid">
                <thead>
                  <tr>
                    {PEOPLE_SORT_KEYS.map((key) => {
                      const active = sort.key === key;
                      return (
                        <th key={key} scope="col" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={key === "name" ? "pe__th-name" : undefined}>
                          <button type="button" className={`pe__sort${active ? " is-active" : ""}`} onClick={() => setSort((current) => nextSort(current, key))} title={PEOPLE_COLUMNS[key].hint} data-testid={`pessoas-sort-${key}`}>
                            {PEOPLE_COLUMNS[key].label}
                            <span aria-hidden="true" className="pe__sort-mark">
                              {active ? (sort.dir === "asc" ? "↑" : "↓") : ""}
                            </span>
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} data-testid="pessoas-row">
                      <th scope="row" className="pe__who">
                        <span className="pe__name">{row.name}</span>
                        <span className="pe__engine">{row.engine}</span>
                        <button type="button" className="ui-button ui-button--secondary ui-button--small pe__model" onClick={() => setModelFor({ id: row.id, name: row.name })} data-testid="pessoas-model-button">
                          Trocar modelo
                        </button>
                      </th>
                      <td>
                        <NowCell row={row} />
                      </td>
                      <td>
                        <Deliveries row={row} />
                      </td>
                      <td>
                        <Cell cell={row.cycle} />
                      </td>
                      <td>
                        <Cell cell={row.rejected} />
                      </td>
                      <td>
                        <Cell cell={row.rework} />
                      </td>
                      <td>
                        <Cell cell={row.edited} extra={row.edited.intensity} />
                      </td>
                      <td>
                        <Cell cell={row.failed} />
                      </td>
                      <td>
                        <Cell cell={row.cost} extra={row.cost.known ? "equivalente, rateado" : undefined} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="pe__cards" aria-label="Agentes">
              {rows.map((row) => (
                <PersonCard key={row.id} row={row} onModel={() => setModelFor({ id: row.id, name: row.name })} />
              ))}
            </ul>
          </section>

          <div className="pe__pair">
            <section className="mdcard pe__card" aria-labelledby="ps-load" data-testid="pessoas-load">
              <h3 className="mdcard__title" id="ps-load">
                Carga agora
              </h3>
              {load.anyLoad ? <LoadBars view={load} /> : <p className="mdcard__quiet">Ninguém com trabalho agora: todos livres.</p>}
            </section>
            <section className="mdcard pe__card" aria-labelledby="ps-refusals" data-testid="pessoas-refusals">
              <h3 className="mdcard__title" id="ps-refusals">
                O que mais é recusado, por tipo
              </h3>
              {refusals.length === 0 ? (
                <p className="mdcard__quiet">Você ainda não decidiu itens neste período. As recusas aparecem aqui por tipo.</p>
              ) : (
                <ul className="ref">
                  {refusals.map((row) => (
                    <li key={row.type} className="ref__row" data-testid="pessoas-refusal">
                      <span className="ref__label">{row.label}</span>
                      <span className="ref__value ui-tabular">{row.cell.text}</span>
                      <span className="ref__note">{row.cell.note ?? `${row.n} ${row.n === 1 ? "decisão" : "decisões"}`}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}

      {modelFor && (
        <ModelChangeDialog
          target={modelFor}
          onClose={() => setModelFor(null)}
          onDone={(text) => {
            setFlash(text);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/** O limite de trabalho em paralelo, editável aqui mesmo: no total e por agente (os mesmos limites das Configurações). */
function ParallelControl({ report, onChanged }: { report: MetricsReport; onChanged: () => void }) {
  const go = useNavStore((state) => state.go);
  const workspaceId = useNavStore((state) => state.workspaceId);
  const { busy, note, run } = useActionNote();
  const save = (patch: { maxRunning?: number; perAgent?: number }) => {
    if (!workspaceId) return;
    void run(async () => {
      await api.updateWorkspaceDispatch(workspaceId, patch);
      onChanged();
    }, "Limite salvo");
  };
  return (
    <div className="pe__parallel" data-testid="pessoas-parallel">
      <span className="pe__parallel-label">Trabalho em paralelo</span>
      <label className="act__stepper">
        no total
        <select value={report.load.maxRunning} disabled={busy} onChange={(event) => save({ maxRunning: Number(event.target.value) })} aria-label="Quantas tarefas rodam ao mesmo tempo no workspace" data-testid="pessoas-max-running">
          {dispatchChoices("maxRunning", report.load.maxRunning).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label className="act__stepper">
        por agente
        <select value={report.load.perAgentLimit} disabled={busy} onChange={(event) => save({ perAgent: Number(event.target.value) })} aria-label="Quantas tarefas cada agente faz ao mesmo tempo" data-testid="pessoas-per-agent">
          {dispatchChoices("perAgent", report.load.perAgentLimit).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <span className="pe__parallel-sentence" data-testid="pessoas-parallel-sentence">
        {dispatchSentence(report)}
      </span>
      <ActionNote note={note} />
      <button type="button" className="mdlink" onClick={() => go("configuracoes")} data-testid="pessoas-parallel-config">
        Mais em Configurações
      </button>
    </div>
  );
}

function Cell({ cell, extra }: { cell: { text: string; note?: string; known: boolean; arrow: { dir: "up" | "down"; glyph: string; text: string } | null }; extra?: string }) {
  return (
    <span className={`pe__cell${cell.known ? "" : " pe__cell--none"}`}>
      <span className="pe__num ui-tabular">
        {cell.text}
        {cell.arrow && (
          <span className={`pe__arrow pe__arrow--${cell.arrow.dir}`} title={cell.arrow.text}>
            <span aria-hidden="true">{cell.arrow.glyph}</span>
            <span className="kpi__sr">{cell.arrow.text}</span>
          </span>
        )}
      </span>
      {(cell.note || extra) && <span className="pe__sub">{cell.note ?? extra}</span>}
    </span>
  );
}

function NowCell({ row }: { row: PersonRow }) {
  return (
    <span className="pe__cell">
      <span className={`pe__num pe__now${row.now.busy ? " is-busy" : ""}`}>{row.now.text}</span>
      {row.now.blocked && <span className="pe__sub pe__sub--warn">{row.now.blocked}</span>}
    </span>
  );
}

/** Quatro mini-barras (as últimas 4 semanas) e o total. */
function Deliveries({ row }: { row: PersonRow }) {
  const { total, weeks, max } = row.deliveries;
  return (
    <span className="pe__cell">
      <span className="pe__deliv">
        <span className="pe__num ui-tabular" data-testid="pessoas-deliveries">
          {total}
        </span>
        <svg className="pe__mini" viewBox="0 0 40 18" width="40" height="18" role="img" aria-label={`Entregas por semana nas últimas 4 semanas: ${weeks.join(", ")}`}>
          {weeks.map((count, index) => {
            const height = count === 0 ? 1.5 : Math.max(3, (count / max) * 16);
            return <rect key={index} className={count === 0 ? "pe__mini-bar pe__mini-bar--zero" : "pe__mini-bar"} x={index * 10 + 1} y={17 - height} width="8" height={height} rx="1.5" />;
          })}
        </svg>
      </span>
    </span>
  );
}

/** O cartão do celular: o nome e o agora, três números e "mais" para o resto. */
function PersonCard({ row, onModel }: { row: PersonRow; onModel: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="pcard" data-testid="pessoas-card">
      <div className="pcard__head">
        <span className="pe__name">{row.name}</span>
        <span className={`pe__now${row.now.busy ? " is-busy" : ""}`}>{row.now.text}</span>
      </div>
      <p className="pe__engine">{row.engine}</p>
      <button type="button" className="ui-button ui-button--secondary ui-button--small pe__model" onClick={onModel} data-testid="pessoas-card-model-button">
        Trocar modelo
      </button>
      <dl className="pcard__nums">
        <div>
          <dt>Entregas</dt>
          <dd>
            <Deliveries row={row} />
          </dd>
        </div>
        <div>
          <dt>Recusado</dt>
          <dd>
            <Cell cell={row.rejected} />
          </dd>
        </div>
        <div>
          <dt>Refeito</dt>
          <dd>
            <Cell cell={row.rework} />
          </dd>
        </div>
      </dl>
      <button type="button" className="mdlink pcard__more" aria-expanded={open} onClick={() => setOpen((value) => !value)} data-testid="pessoas-card-more">
        {open ? "menos" : "mais"}
      </button>
      {open && (
        <dl className="pcard__nums pcard__nums--more">
          <div>
            <dt>Tempo até entregar</dt>
            <dd>
              <Cell cell={row.cycle} />
            </dd>
          </div>
          <div>
            <dt>Você editou</dt>
            <dd>
              <Cell cell={row.edited} extra={row.edited.intensity} />
            </dd>
          </div>
          <div>
            <dt>Falhou</dt>
            <dd>
              <Cell cell={row.failed} />
            </dd>
          </div>
          <div>
            <dt>Custo por entrega (rateado)</dt>
            <dd>
              <Cell cell={row.cost} extra={row.cost.known ? "equivalente, rateado" : undefined} />
            </dd>
          </div>
        </dl>
      )}
    </li>
  );
}
