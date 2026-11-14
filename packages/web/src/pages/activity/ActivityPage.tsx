import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_CATEGORY_LABELS,
  ACTIVITY_MAESTRO,
  ACTIVITY_SYSTEM,
  ACTIVITY_USER,
  findMaestroAgent,
  type ActivityCategory,
  type ActivityEntry,
  type ActivityServerInfo,
  type ActivitySummary,
} from "@cyno/shared";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import { escapeReturnsToMap } from "../../cena/escape";
import { useActivityLogStore } from "../../store/activityLogStore";
import { useForYouFocus } from "../../store/forYouFocus";
import { useMediaStore } from "../../store/mediaStore";
import { useNavStore } from "../../store/navStore";
import { useOfficeStore } from "../../store/officeStore";
import { useTaskFocus } from "../../store/taskFocus";
import { AvatarSprite } from "../../ui/AvatarSprite";
import { formatAgo } from "../../ui/format";
import {
  CATEGORY_ICONS,
  DEFAULT_FILTERS,
  RANGES,
  entryDelivery,
  entryFacts,
  entryTime,
  isRoutineAlert,
  formatMb,
  formatUsd,
  groupByDay,
  matchesFilters,
  mergeLive,
  rangeOf,
  refLinks,
  todayKey,
  toneOf,
  type ActivityFilters,
  type RefLink,
} from "./activityView";
import "./activity.css";

const PAGE_SIZE = 60;
type Tab = "atividade" | "sistema";

/** Esc (fora de campo e sem janela aberta) volta ao escritório, como nas Configurações. */
function useEscapeToOffice(): void {
  const go = useNavStore((state) => state.go);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const modalOpen = document.querySelector("dialog[open]") !== null;
      if (escapeReturnsToMap({ key: event.key, defaultPrevented: event.defaultPrevented, target, modalOpen })) go("office");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);
}

/** Roda `load` agora e de novo quando ele muda (filtro novo); quem chama decide o que ele mexe no estado. */
function useLoadEffect(load: () => void | (() => void)): void {
  useEffect(() => load(), [load]);
}

/** O texto digitado na busca só vira filtro depois de uma pausa. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * Página "Atividade": o que foi feito no escritório (tarefas, aprovações, publicações, rotinas,
 * mídia, planos, agentes), dia a dia, com os números do período no topo e as entradas novas ao vivo.
 * A aba "Sistema" mostra os eventos do servidor (subiu, parou, caiu, memória baixa) e a memória agora.
 */
export function ActivityPage() {
  useEscapeToOffice();
  const workspaceId = useNavStore((state) => state.workspaceId);
  const [tab, setTab] = useState<Tab>(workspaceId ? "atividade" : "sistema");
  const effectiveTab: Tab = workspaceId ? tab : "sistema";

  return (
    <section className="page page--activity" aria-labelledby="page-title-activity" data-testid="page-activity">
      <header className="page__header page__header--row">
        <div className="page__heading">
          <h2 id="page-title-activity" className="page__title">
            Atividade
          </h2>
          <p className="page__subtitle">O que foi feito no escritório, dia a dia: tarefas, aprovações, publicações, rotinas, mídia e planos.</p>
        </div>
        <div className="activity__tabs" role="tablist" aria-label="Seção">
          <button type="button" role="tab" aria-selected={effectiveTab === "atividade"} className="activity__tab" disabled={!workspaceId} onClick={() => setTab("atividade")} data-testid="activity-tab-atividade">
            Atividade
          </button>
          <button type="button" role="tab" aria-selected={effectiveTab === "sistema"} className="activity__tab" onClick={() => setTab("sistema")} data-testid="activity-tab-sistema">
            Sistema
          </button>
        </div>
      </header>
      {effectiveTab === "atividade" && workspaceId ? <WorkspaceActivity key={workspaceId} /> : <SystemActivity />}
    </section>
  );
}

// ---------- Atividade do workspace ----------

function WorkspaceActivity() {
  const [filters, setFilters] = useState<ActivityFilters>(DEFAULT_FILTERS);
  const [search, setSearch] = useState("");
  const q = useDebounced(search, 350);
  const effective = useMemo(() => ({ ...filters, q }), [filters, q]);
  const range = useMemo(() => rangeOf(effective.range), [effective.range]);
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const version = useActivityLogStore((state) => state.version);
  const seenVersion = useRef(version);

  const query = useCallback(
    (cursor?: string) => ({
      from: range.from,
      to: range.to,
      ...(effective.categories.length > 0 ? { category: effective.categories } : {}),
      ...(effective.actor ? { actor: effective.actor } : {}),
      ...(effective.q.trim() ? { q: effective.q.trim() } : {}),
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    }),
    [range, effective],
  );

  const loadSummary = useCallback(() => {
    api.activitySummary(range).then(setSummary, () => undefined);
  }, [range]);

  // Filtro novo (ou outro período): recomeça do topo.
  const reload = useCallback(() => {
    const id = ++request.current;
    setLoading(true);
    Promise.all([api.activity(query()), api.activitySummary(range)])
      .then(([page, nextSummary]) => {
        if (id !== request.current) return;
        setEntries(page.entries);
        setNextCursor(page.nextCursor);
        setSummary(nextSummary);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (id === request.current) setError(reason instanceof Error ? reason.message : "Não deu para carregar a atividade.");
      })
      .finally(() => {
        if (id === request.current) setLoading(false);
      });
  }, [query, range]);
  useLoadEffect(reload);

  // Ao vivo: o que chega pelo WebSocket entra no topo (se passa nos filtros) e os números se atualizam.
  useEffect(() => {
    if (version === seenVersion.current) return;
    seenVersion.current = version;
    const live = useActivityLogStore.getState().live;
    const workspaceId = useNavStore.getState().workspaceId;
    setEntries((current) => (current ? mergeLive(current, live.filter((entry) => entry.workspaceId === workspaceId), (entry) => matchesFilters(entry, effective, range)) : current));
    const timer = window.setTimeout(loadSummary, 1200);
    return () => window.clearTimeout(timer);
  }, [version, effective, range, loadSummary]);

  const more = () => {
    if (!nextCursor) return;
    setLoading(true);
    api
      .activity(query(nextCursor))
      .then((page) => {
        setEntries((current) => [...(current ?? []), ...page.entries.filter((entry) => !(current ?? []).some((item) => item.id === entry.id))]);
        setNextCursor(page.nextCursor);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Não deu para carregar mais."))
      .finally(() => setLoading(false));
  };

  const active = filters.categories.length > 0 || filters.actor !== "" || search.trim() !== "";
  const clear = () => {
    setSearch("");
    setFilters((current) => ({ ...current, categories: [], actor: "" }));
  };

  return (
    <>
      <SummaryTiles summary={summary} rangeId={effective.range} />
      <FilterBar filters={filters} onFilters={(change) => setFilters((current) => ({ ...current, ...change }))} search={search} onSearch={setSearch} entries={entries} active={active} onClear={clear} />
      {error && (
        <p className="activity__error" role="alert" data-testid="activity-error">
          {error}
        </p>
      )}
      {entries === null && !error && <p className="page__empty">Carregando a atividade…</p>}
      {entries !== null && entries.length === 0 && <EmptyState filtered={active || effective.range !== "30d"} onClear={clear} active={active} />}
      {entries !== null && entries.length > 0 && <Timeline entries={entries} />}
      {nextCursor && (
        <div className="activity__more">
          <button type="button" className="ui-button ui-button--secondary" onClick={more} disabled={loading} data-testid="activity-more">
            {loading ? "Carregando…" : "Mostrar mais"}
          </button>
        </div>
      )}
    </>
  );
}

function EmptyState({ filtered, active, onClear }: { filtered: boolean; active: boolean; onClear: () => void }) {
  return (
    <div className="activity__empty" data-testid="activity-empty">
      <svg viewBox="0 0 24 24" aria-hidden="true" className="activity__empty-icon">
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </svg>
      <p className="activity__empty-title">{active ? "Nada com esses filtros" : "Nada aconteceu neste período"}</p>
      <p className="activity__empty-text">
        {active ? "Tire um filtro ou amplie o período para ver mais." : filtered ? "Tente um período maior. Tarefas, aprovações, publicações e o resto aparecem aqui conforme acontecem." : "Quando houver tarefas, aprovações, publicações e o resto, elas aparecem aqui."}
      </p>
      {active && (
        <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={onClear}>
          Limpar filtros
        </button>
      )}
    </div>
  );
}

// ---------- Números do período ----------

function SummaryTiles({ summary, rangeId }: { summary: ActivitySummary | null; rangeId: ActivityFilters["range"] }) {
  const label = RANGES.find((item) => item.id === rangeId)?.label.toLowerCase() ?? "";
  const decided = summary ? summary.approvals.approved + summary.approvals.rejected + summary.approvals.answered : 0;
  const tiles: { id: string; label: string; value: string; hint: string; tone: "ok" | "danger" | "info" | "neutral" }[] = [
    { id: "done", label: "Tarefas concluídas", value: String(summary?.tasksDone ?? "–"), hint: label === "hoje" ? "hoje" : `em ${label}`, tone: "ok" },
    { id: "failed", label: "Falhas", value: String(summary?.tasksFailed ?? "–"), hint: summary && summary.tasksFailed > 0 ? "tarefas que não terminaram" : "nenhuma falha", tone: summary && summary.tasksFailed > 0 ? "danger" : "neutral" },
    { id: "approvals", label: "Aprovações", value: String(decided || (summary ? 0 : "–")), hint: summary ? `${summary.approvals.requested} pedidas` : "", tone: "info" },
    { id: "publications", label: "Publicações", value: String(summary?.publications ?? "–"), hint: "ações feitas em sites", tone: "info" },
    { id: "media", label: "Mídia criada", value: String(summary?.media ?? "–"), hint: "imagens e arquivos", tone: "neutral" },
    { id: "cost", label: "Gasto", value: summary ? formatUsd(summary.costUsd) : "–", hint: summary && summary.tokens > 0 ? `${Math.round(summary.tokens / 1000).toLocaleString("pt-BR")} mil tokens` : "custo equivalente na API", tone: "neutral" },
  ];
  return (
    <section className="activity__tiles" aria-label={`Resumo (${label})`} data-testid="activity-summary">
      {tiles.map((tile) => (
        <div key={tile.id} className={`activity__tile activity__tile--${tile.tone}`} data-testid={`activity-tile-${tile.id}`}>
          <span className="activity__tile-label">{tile.label}</span>
          <span className="activity__tile-value">{tile.value}</span>
          <span className="activity__tile-hint">{tile.hint}</span>
        </div>
      ))}
    </section>
  );
}

// ---------- Filtros ----------

function FilterBar({
  filters,
  onFilters,
  search,
  onSearch,
  entries,
  active,
  onClear,
}: {
  filters: ActivityFilters;
  onFilters: (change: Partial<ActivityFilters>) => void;
  search: string;
  onSearch: (value: string) => void;
  entries: ActivityEntry[] | null;
  active: boolean;
  onClear: () => void;
}) {
  const id = useId();
  const office = useOfficeStore((state) => state.office);
  // Quem aparece nos filtros: os agentes do workspace e quem fez algo nas entradas carregadas.
  const actors = useMemo(() => {
    const ids = new Set<string>([ACTIVITY_USER]);
    for (const agent of office?.agents ?? []) ids.add(agent.id);
    for (const entry of entries ?? []) ids.add(entry.actor);
    if (filters.actor) ids.add(filters.actor);
    ids.delete(ACTIVITY_SYSTEM);
    return [...ids];
  }, [office, entries, filters.actor]);
  const nameOf = (actor: string) => (actor === ACTIVITY_USER ? "Você" : actor === ACTIVITY_MAESTRO ? "Maestro" : (office?.agents.find((agent) => agent.id === actor)?.name ?? actor));
  const toggleCategory = (category: ActivityCategory) =>
    onFilters({ categories: filters.categories.includes(category) ? filters.categories.filter((item) => item !== category) : [...filters.categories, category] });

  return (
    <form className="activity__filters" role="search" aria-label="Filtrar a atividade" onSubmit={(event) => event.preventDefault()}>
      <div className="activity__filters-top">
        <div className="activity__segmented" role="group" aria-label="Período">
          {RANGES.map((range) => (
            <button key={range.id} type="button" className="activity__seg" aria-pressed={filters.range === range.id} onClick={() => onFilters({ range: range.id })} data-testid={`activity-range-${range.id}`}>
              {range.label}
            </button>
          ))}
        </div>
        <div className="activity__search">
          <label htmlFor={`${id}-q`} className="activity__sr">
            Buscar
          </label>
          <input id={`${id}-q`} className="ui-input" type="search" placeholder="Buscar na atividade…" value={search} onChange={(event) => onSearch(event.currentTarget.value)} data-testid="activity-search" />
        </div>
        {active && (
          <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={onClear} data-testid="activity-clear">
            Limpar
          </button>
        )}
      </div>
      <div className="activity__chips" role="group" aria-label="Categoria">
        {ACTIVITY_CATEGORIES.filter((category) => category !== "sistema" && category !== "gasto").map((category) => (
          <button key={category} type="button" className="activity__chip" aria-pressed={filters.categories.includes(category)} onClick={() => toggleCategory(category)} data-testid={`activity-cat-${category}`}>
            <CategoryIcon category={category} />
            {ACTIVITY_CATEGORY_LABELS[category]}
          </button>
        ))}
      </div>
      <div className="activity__chips" role="group" aria-label="Quem fez">
        {actors.map((actor) => (
          <button key={actor} type="button" className="activity__chip activity__chip--actor" aria-pressed={filters.actor === actor} onClick={() => onFilters({ actor: filters.actor === actor ? "" : actor })} data-testid={`activity-actor-${actor}`}>
            <Actor actor={actor} showName={false} size="small" />
            {nameOf(actor)}
          </button>
        ))}
      </div>
    </form>
  );
}

function CategoryIcon({ category }: { category: ActivityCategory }) {
  return (
    <svg className="activity__cat-icon" viewBox="0 0 24 24" aria-hidden="true">
      {CATEGORY_ICONS[category].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

// ---------- Linha do tempo ----------

function Timeline({ entries }: { entries: ActivityEntry[] }) {
  const groups = useMemo(() => groupByDay(entries, todayKey()), [entries]);
  return (
    <div className="activity__timeline" data-testid="activity-list">
      {groups.map((group) => (
        <section key={group.day} className="activity__day" aria-label={group.label}>
          <h3 className="activity__day-title">
            {group.label}
            <span className="activity__day-count">{group.entries.length}</span>
          </h3>
          <ol className="activity__list">
            {group.entries.map((entry) => (
              <EntryRow key={entry.id} entry={entry} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function EntryRow({ entry }: { entry: ActivityEntry }) {
  const facts = entryFacts(entry);
  const links = refLinks(entry.refs);
  const delivery = entryDelivery(entry);
  return (
    <li className={`activity__entry activity__entry--${toneOf(entry)}${isRoutineAlert(entry) ? " activity__entry--routine-alert" : ""}${entry.actor === ACTIVITY_SYSTEM ? " activity__entry--no-actor" : ""}`} data-testid="activity-entry" data-category={entry.category} data-action={entry.action}>
      <time className="activity__time" dateTime={entry.at}>
        {entryTime(entry)}
      </time>
      <span className="activity__dot" title={ACTIVITY_CATEGORY_LABELS[entry.category]}>
        <CategoryIcon category={entry.category} />
      </span>
      {entry.actor !== ACTIVITY_SYSTEM && <Actor actor={entry.actor} showName={false} />}
      <div className="activity__body">
        <p className="activity__summary">{entry.summary}</p>
        {delivery && (
          <p className="activity__delivery" data-testid="activity-delivery" title={delivery.summary}>
            <span className="activity__delivery-tag">Entrega</span> {delivery.headline}
          </p>
        )}
        {(facts.length > 0 || links.length > 0) && (
          <p className="activity__meta">
            {facts.map((fact) => (
              <span key={fact} className="activity__fact">
                {fact}
              </span>
            ))}
            {links.map((link) => (
              <RefButton key={`${link.kind}:${link.id}`} link={link} />
            ))}
          </p>
        )}
      </div>
    </li>
  );
}

function RefButton({ link }: { link: RefLink }) {
  const go = useNavStore((state) => state.go);
  if (link.kind === "url") {
    return (
      <a className="activity__ref" href={link.id} target="_blank" rel="noopener noreferrer" title={link.id}>
        {link.label}
        <span aria-hidden="true"> ↗</span>
      </a>
    );
  }
  const open = () => {
    if (link.kind === "task") useTaskFocus.getState().open(link.id);
    else if (link.kind === "foryou") useForYouFocus.getState().open(link.id);
    else if (link.kind === "media") useMediaStore.getState().open(link.id);
    else if (link.kind === "routine") go("gestao", "rotinas");
  };
  return (
    <button type="button" className="activity__ref" onClick={open} title={`Abrir ${link.label.toLowerCase()} ${link.id}`}>
      {link.label}
      {link.kind !== "task" && <span className="activity__ref-id"> {link.id}</span>}
    </button>
  );
}

/** Quem fez: avatar do agente (cabeça), "Você", o Maestro ou o sistema. */
function Actor({ actor, showName, size = "normal" }: { actor: string; showName: boolean; size?: "normal" | "small" }) {
  const office = useOfficeStore((state) => state.office);
  const agent = actor === ACTIVITY_MAESTRO ? (office ? findMaestroAgent(office) : undefined) : office?.agents.find((item) => item.id === actor);
  const name = actor === ACTIVITY_USER ? "Você" : actor === ACTIVITY_SYSTEM ? "Sistema" : (agent?.name ?? (actor === ACTIVITY_MAESTRO ? "Maestro" : actor));
  return (
    <span className={`activity__actor activity__actor--${size}`} title={name}>
      <span className="activity__avatar" aria-hidden={showName ? "true" : undefined}>
        {agent ? (
          <AvatarSprite avatar={agent.avatar} seedId={agent.id} size={size === "small" ? 20 : 26} framing="head" />
        ) : actor === ACTIVITY_USER ? (
          <span className="activity__avatar-glyph">V</span>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true" className="activity__avatar-svg">
            {CATEGORY_ICONS.sistema.map((d) => (
              <path key={d} d={d} />
            ))}
          </svg>
        )}
      </span>
      {showName && <span className="activity__actor-name">{name}</span>}
      {!showName && <span className="activity__sr">{name}</span>}
    </span>
  );
}

// ---------- Sistema ----------

function SystemActivity() {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [server, setServer] = useState<ActivityServerInfo | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const version = useActivityLogStore((state) => state.version);

  const load = useCallback(() => {
    setLoading(true);
    api
      .activitySystem({ limit: PAGE_SIZE })
      .then((page) => {
        setEntries(page.entries);
        setNextCursor(page.nextCursor);
        setServer(page.server);
        setError(null);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Não deu para carregar os eventos do servidor."))
      .finally(() => setLoading(false));
  }, []);

  // Carrega ao abrir, a cada minuto (a memória vem do batimento) e quando chega um evento do servidor.
  const refresh = useCallback(() => {
    void version;
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [load, version]);
  useLoadEffect(refresh);

  const more = () => {
    if (!nextCursor) return;
    setLoading(true);
    api
      .activitySystem({ limit: PAGE_SIZE, cursor: nextCursor })
      .then((page) => {
        setEntries((current) => [...(current ?? []), ...page.entries]);
        setNextCursor(page.nextCursor);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  };

  return (
    <>
      <ServerCard server={server} />
      {error && (
        <p className="activity__error" role="alert">
          {error}
        </p>
      )}
      {entries === null && !error && <p className="page__empty">Carregando os eventos do servidor…</p>}
      {entries !== null && entries.length === 0 && (
        <div className="activity__empty" data-testid="activity-system-empty">
          <p className="activity__empty-title">Nenhum evento do servidor ainda</p>
          <p className="activity__empty-text">Aqui aparecem as subidas e paradas do servidor, quedas e avisos de pouca memória.</p>
        </div>
      )}
      {entries !== null && entries.length > 0 && <Timeline entries={entries} />}
      {nextCursor && (
        <div className="activity__more">
          <button type="button" className="ui-button ui-button--secondary" onClick={more} disabled={loading}>
            {loading ? "Carregando…" : "Mostrar mais"}
          </button>
        </div>
      )}
    </>
  );
}

function ServerCard({ server }: { server: ActivityServerInfo | undefined }) {
  if (!server) return null;
  const low = server.memAvailablePct !== undefined && server.memAvailablePct < 15;
  const facts: { label: string; value: string; tone?: "warn" }[] = [
    { label: "Servidor subiu", value: formatAgo(server.startedAt) },
    ...(server.memAvailableMb !== undefined ? [{ label: "Memória livre", value: `${formatMb(server.memAvailableMb)} (${server.memAvailablePct}%)`, ...(low ? { tone: "warn" as const } : {}) }] : []),
    ...(server.swapUsedMb !== undefined ? [{ label: "Swap em uso", value: formatMb(server.swapUsedMb) }] : []),
    ...(server.serverRssMb !== undefined ? [{ label: "Servidor", value: formatMb(server.serverRssMb) }] : []),
    ...(server.terminalsRssMb !== undefined ? [{ label: "Terminais dos agentes", value: formatMb(server.terminalsRssMb) }] : []),
    ...(server.browserRssMb !== undefined ? [{ label: "Navegador", value: formatMb(server.browserRssMb) }] : []),
  ];
  return (
    <section className="activity__server" aria-label="O servidor agora" data-testid="activity-server">
      <header className="activity__server-head">
        <h3 className="activity__server-title">O servidor agora</h3>
        {server.heartbeatAt && <span className="activity__server-meta">batimento {formatAgo(server.heartbeatAt)}</span>}
      </header>
      <dl className="activity__server-facts">
        {facts.map((fact) => (
          <div key={fact.label} className={fact.tone ? `activity__server-fact activity__server-fact--${fact.tone}` : "activity__server-fact"}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
