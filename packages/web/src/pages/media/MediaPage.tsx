import type { AppRun, Avatar, MediaItem } from "@cyno/shared";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { describeError } from "../../api/client";
import { useLibraryAppsStore } from "../../store/libraryAppsStore";
import { useMediaStore } from "../../store/mediaStore";
import { useNavStore } from "../../store/navStore";
import { useOfficeStore } from "../../store/officeStore";
import { useWorkStore } from "../../store/workStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { Drawer } from "../../ui/Drawer";
import { ConfirmDialog } from "../../ui/widgets";
import { MediaCard } from "./MediaCards";
import { Breadcrumb, FolderBlock, FolderNameDialog, MoveDialog, SelectionBar, SizeLabel } from "./FolderParts";
import { childFolders, folderOf, folderStats, parentOf, remapAfterDelete, remapAfterRename, ROOT_LABEL } from "./mediaFolders";
import { MediaDetail, type BringAction } from "./MediaDetail";
import { buildEntries, entryItems, entryKey, entryMatches, loadDensity, loadScope, saveDensity, saveScope, scopeKey, timeSections, type Density, type GalleryEntry, type Located, type Scope } from "./mediaGroups";
import { ActiveFilters, FilterBar } from "./FilterBar";
import { drawerLimits, drawerWidth, loadDrawerWidth, saveDrawerWidth } from "./mediaDrawer";
import { useMediaParam, useScopeScroll } from "./mediaHooks";
import { hashWithMedia, neighbors } from "./mediaNav";
import { MIcon } from "./MediaParts";
import { MediaViewer, type ViewerMode } from "./MediaViewer";
import { agentOptions, cameFrom, isFiltering, kindOptions, NO_FILTERS, statusOptions, type MediaFilters } from "./mediaView";
import { prefetchRemoteMedia, useRemoteMedia } from "./useMediaScope";

/** Página "Mídia": a biblioteca do workspace (o que os agentes fizeram e o que você enviou), mais a de outros workspaces só para ver e trazer. */
export function MediaPage() {
  // Trocar de workspace recomeça a página (seleção e filtros eram do anterior).
  const workspaceId = useNavStore((state) => state.workspaceId);
  return (
    <section className="page page--fill page--media" aria-labelledby="page-title-midia" data-testid="page-midia">
      <MediaView key={workspaceId ?? ""} />
    </section>
  );
}

/** Faixa fina: só existe com render em andamento ou na fila neste workspace. */
function RenderStrip({ runs }: { runs: AppRun[] }) {
  const running = runs.find((run) => run.state === "rodando");
  const queued = runs.filter((run) => run.state === "na-fila");
  if (!running && queued.length === 0) return null;
  return (
    <div className="md-renders" role="status" data-testid="media-renders">
      <span className="md-renders__dot" aria-hidden="true" />
      <span className="md-renders__text">
        {running ? (
          <>
            Renderizando{running.agentName ? ` para ${running.agentName}` : ""}: {running.tool}
            {running.progress !== undefined ? ` · ${running.progress}%` : ""}
          </>
        ) : (
          "Na fila de renders"
        )}
        {queued.length > 0 && <span className="md-renders__queue"> · {queued.length} na fila</span>}
      </span>
      {running && running.progress !== undefined && (
        <span className="md-renders__bar" aria-hidden="true">
          <span style={{ width: `${Math.max(4, running.progress)}%` }} />
        </span>
      )}
    </div>
  );
}

/** Espaço reservado da grade enquanto o primeiro carregamento não chega (mesma forma dos cartões: nada pula depois). */
function GridSkeleton() {
  return (
    <ul className="md-grid md-grid--skeleton" aria-hidden="true" data-testid="media-skeleton">
      {Array.from({ length: 12 }, (_, index) => (
        <li key={index} className="md-card md-card--skeleton">
          <span className="md-card__stage" />
          <span className="md-skel__line" />
          <span className="md-skel__line md-skel__line--short" />
        </li>
      ))}
    </ul>
  );
}

/** O que a tela mostra de um escopo: as mídias, com o workspace de cada uma, e quem são os agentes dos outros workspaces. */
type View = { key: string; scope: Scope; located: Located[]; agents: Record<string, Record<string, string>>; avatars: Record<string, Record<string, Avatar>> };

const SCOPE_OPTIONS = [
  { id: "este", long: "Este workspace", short: "Este" },
  { id: "outro", long: "Outro workspace", short: "Outro" },
  { id: "todos", long: "Todos", short: "Todos" },
] as const;

function MediaView() {
  const items = useMediaStore((state) => state.items);
  const folders = useMediaStore((state) => state.folders);
  const error = useMediaStore((state) => state.error);
  const uploads = useMediaStore((state) => state.uploads);
  const focusId = useMediaStore((state) => state.focusId);
  const office = useOfficeStore((state) => state.office);
  const currentId = useNavStore((state) => state.workspaceId) ?? "";
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const runs = useLibraryAppsStore((state) => state.listing?.runs);
  const projects = useWorkStore((state) => state.projects);

  const names = useMemo(() => new Map(workspaces?.map((workspace) => [workspace.id, workspace.name]) ?? []), [workspaces]);
  const workspaceName = (id: string) => names.get(id) ?? id;
  const currentName = workspaceName(currentId);
  const others = useMemo(() => (workspaces ?? []).filter((workspace) => workspace.id !== currentId), [workspaces, currentId]);

  const [saved] = useState(loadScope);
  const [scopeRaw, setScopeRaw] = useState<Scope>(saved.scope);
  const [otherRaw, setOtherRaw] = useState<string | null>(saved.other);
  // Sem outro workspace, só existe "Este workspace"; o "outro" salvo que sumiu cai no primeiro que existe.
  const scope: Scope = others.length === 0 ? "este" : scopeRaw;
  const otherId = (otherRaw && others.some((workspace) => workspace.id === otherRaw) ? otherRaw : others[0]?.id) ?? null;
  // O escopo responde na hora ao clique (a escolha é guardada já); a lista só troca quando a nova chegou.
  const setScope = (next: Scope, other: string | null = otherId) => {
    setScopeRaw(next);
    setOtherRaw(other);
    saveScope(next, other);
    setNotice(null);
  };

  const [filters, setFilters] = useState<MediaFilters>(NO_FILTERS);
  const [showDiscarded, setShowDiscarded] = useState(false);
  const [density, setDensityRaw] = useState<Density>(loadDensity);
  const [selectedKey, selectMedia] = useMediaParam();
  const [notice, setNotice] = useState<{ text: string; ws: string; mediaId: string } | null>(null);
  const [bringError, setBringError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ items: Located[]; index: number; mode: ViewerMode } | null>(null);
  const [busy, setBusy] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  // Pastas: a aberta ("" = raiz), a seleção para mover e os diálogos.
  const [folderRaw, setFolder] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [folderDialog, setFolderDialog] = useState<{ mode: "create" } | { mode: "rename"; path: string } | null>(null);
  const [deleteFolder, setDeleteFolder] = useState<string | null>(null);
  const [moveIds, setMoveIds] = useState<string[] | null>(null);
  const [folderNotice, setFolderNotice] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void useMediaStore.getState().load();
    if (!useLibraryAppsStore.getState().listing) void useLibraryAppsStore.getState().load();
  }, []);

  const remoteIds = useMemo(() => (scope === "outro" && otherId ? [otherId] : scope === "todos" ? others.map((workspace) => workspace.id) : []), [scope, otherId, others]);
  const remote = useRemoteMedia(remoteIds);

  // Esquenta os outros workspaces (poucos e leves: só a lista de metadados) para "Outro" e "Todos" abrirem na hora.
  const othersKey = others.map((workspace) => workspace.id).join("\n");
  useEffect(() => {
    if (!othersKey) return;
    const ids = othersKey.split("\n");
    if (ids.length > 6) return;
    const timer = window.setTimeout(() => prefetchRemoteMedia(ids), 400);
    return () => window.clearTimeout(timer);
  }, [othersKey]);

  // O que a tela mostra: o escopo pedido quando já está pronto; senão, o último que ficou pronto (esmaecido) até o novo chegar.
  const ownLoading = scope !== "outro" && items === null && error === null;
  const ready = !remote.pending && !ownLoading;
  const current = useMemo<View>(() => {
    const own = scope === "outro" ? [] : (items ?? []).map((item) => ({ ws: currentId, item }));
    const other = Object.entries(remote.items).flatMap(([ws, list]) => list.map((item) => ({ ws, item })));
    return { key: scopeKey(scope, otherId), scope, located: [...own, ...other], agents: remote.agents, avatars: remote.avatars };
  }, [scope, otherId, items, currentId, remote.items, remote.agents, remote.avatars]);
  const [held, setHeld] = useState<View | null>(null);
  if (ready && held !== current) setHeld(current);
  const view = ready ? current : (held ?? current);
  const switching = !ready && held !== null;
  const firstLoad = !ready && held === null;
  useScopeScroll(root, view.key);

  const ownAgents = useMemo(() => new Map(office?.agents.map((agent) => [agent.id, agent.name]) ?? []), [office]);
  const tasks = useMemo(() => new Map(office?.tasks.map((task) => [task.id, task]) ?? []), [office]);
  const agentName = useCallback((ws: string, id: string) => (id === "usuario" ? "Você" : ((ws === currentId ? ownAgents.get(id) : view.agents[ws]?.[id]) ?? id)), [currentId, ownAgents, view.agents]);
  const agentAvatar = useCallback((ws: string, id: string): Avatar | undefined => (ws === currentId ? office?.agents.find((agent) => agent.id === id)?.avatar : view.avatars[ws]?.[id]), [currentId, office, view.avatars]);
  const projectTitle = useCallback((id: string | undefined) => (id ? projects.find((project) => project.id === id)?.title : undefined), [projects]);

  const located = view.located;
  const entries = useMemo(() => buildEntries(located, showDiscarded), [located, showDiscarded]);
  const nameLookup = useMemo(() => new Map(located.map(({ ws, item }) => [item.createdBy, agentName(ws, item.createdBy)])), [located, agentName]);
  const matched = useMemo(() => entries.filter((entry) => entryMatches(entry, filters, showDiscarded, agentName)), [entries, filters, showDiscarded, agentName]);
  // Pastas só neste workspace. Buscando ou filtrando, a lista olha TODAS as pastas (e cada cartão diz em qual está).
  const foldersOn = scope === "este";
  const browsing = foldersOn && !isFiltering(filters);
  const folder = folders === null || folderRaw === "" || folders.includes(folderRaw) ? folderRaw : "";
  const shown = useMemo(() => (browsing ? matched.filter((entry) => folderOf(entry.main.item) === folder) : matched), [matched, browsing, folder]);
  const subfolders = useMemo(() => (browsing && folders ? childFolders(folders, folder) : []), [browsing, folders, folder]);
  const ownItems = useMemo(() => items ?? [], [items]);
  // Rótulo de tamanho do cabeçalho: tudo o que há nesta pasta (com as subpastas); buscando, o que a lista mostra.
  const headerBytes = useMemo(() => (browsing ? folderStats(ownItems, folders ?? [], folder).bytes : shown.reduce((total, entry) => total + entry.main.item.size, 0)), [browsing, ownItems, folders, folder, shown]);
  // As contagens dos menus seguem os cartões (um carrossel conta 1; descartados só com o interruptor).
  const allItems = useMemo(() => entries.filter((entry) => showDiscarded || entry.type === "carousel" || entry.main.item.status !== "descartado").map((entry) => entry.main.item), [entries, showDiscarded]);
  const filterOptions = useMemo(() => ({ kind: kindOptions(allItems, filters.kind), status: statusOptions(allItems, filters.status), agent: agentOptions(allItems, nameLookup, filters.agent) }), [allItems, filters.kind, filters.status, filters.agent, nameLookup]);
  const hasDiscarded = useMemo(() => located.some((entry) => entry.item.status === "descartado"), [located]);

  // "Ver na Mídia" e o envio: abrem o item pedido no escopo "Este workspace", sem filtro (ajuste durante o render).
  const [handledFocus, setHandledFocus] = useState<string | null>(null);
  const requested = focusId && items?.some((item) => item.id === focusId) ? focusId : null;
  if (requested && requested !== handledFocus) {
    setHandledFocus(requested);
    setFilters(NO_FILTERS);
    setShowDiscarded(true);
    setScopeRaw("este");
    setNotice(null);
  } else if (!focusId && handledFocus !== null) {
    setHandledFocus(null);
  }
  useEffect(() => {
    if (!focusId || !items) return;
    if (requested) selectMedia(`${currentId}:${requested}`, "push");
    useMediaStore.getState().clearFocus();
  }, [focusId, items, requested, currentId, selectMedia]);

  // Um link com a mídia de outro workspace (`?midia=<ws>:<código>`) abre no escopo "Outro" dele (ajuste durante o render).
  const [handledUrl, setHandledUrl] = useState<string | null>(null);
  if (selectedKey && selectedKey !== handledUrl && others.length > 0) {
    setHandledUrl(selectedKey);
    const ws = selectedKey.split(":")[0] ?? "";
    if (ws !== currentId && others.some((workspace) => workspace.id === ws)) {
      setScopeRaw("outro");
      setOtherRaw(ws);
    }
  }

  const selected = useMemo(() => {
    if (!selectedKey) return undefined;
    return entries.find((entry) => entry.key === selectedKey) ?? entries.find((entry) => entryItems(entry).some((part) => entryKey(part) === selectedKey));
  }, [entries, selectedKey]);

  // A mídia aberta e a lista que a grade mostra: dão a posição ("3 de 42") e as vizinhas.
  const shownKeys = useMemo(() => shown.map((entry) => entry.key), [shown]);
  const nav = neighbors(shownKeys, selected?.key ?? null);
  const goTo = useCallback(
    (key: string | null) => {
      const entry = key ? shown.find((candidate) => candidate.key === key) : undefined;
      if (entry) selectMedia(entryKey(entry.main), "replace");
    },
    [shown, selectMedia],
  );

  // O cartão da mídia aberta fica visível atrás da gaveta (e marcado), mesmo depois de ←/→.
  const selectedCard = selected?.key;
  useEffect(() => {
    if (!selectedCard) return;
    const id = selected?.main.item.id;
    if (!id) return;
    const card = root.current?.querySelector<HTMLElement>(`[data-testid="media-card-${CSS.escape(id)}"]`);
    card?.scrollIntoView?.({ block: "nearest" });
  }, [selectedCard]); // eslint-disable-line react-hooks/exhaustive-deps

  // Já está neste workspace? (as cópias guardam "Veio de <workspace> · <código>")
  const broughtSet = useMemo(() => new Set((items ?? []).flatMap((item) => (cameFrom(item)?.mediaId ? [`${cameFrom(item)!.workspace}|${cameFrom(item)!.mediaId}`] : []))), [items]);
  const isBrought = (part: Located) => part.ws !== currentId && broughtSet.has(`${workspaceName(part.ws)}|${part.item.id}`);
  const bringOf = (entry: GalleryEntry): BringAction | undefined => {
    if (entry.main.ws === currentId) return undefined;
    const parts = entry.type === "carousel" ? entry.slides : [entry.main];
    const pending = parts.filter((part) => !isBrought(part));
    return {
      label: `Trazer para ${currentName}${entry.type === "carousel" ? ` (${parts.length} slides)` : ""}`,
      done: pending.length === 0,
      busy: busy.includes(entry.key),
      onBring: () => void bringEntry(entry, pending),
    };
  };

  const bringEntry = async (entry: GalleryEntry, pending: Located[]) => {
    setBusy((currentBusy) => [...currentBusy, entry.key]);
    setBringError(null);
    try {
      let last: MediaItem | undefined;
      for (const part of pending) last = await useMediaStore.getState().bring(part.ws, part.item.id);
      if (last) setNotice({ text: pending.length > 1 ? `${pending.length} slides trazidos para ${currentName}.` : `Trazida para ${currentName}: ${entry.main.item.title}.`, ws: currentId, mediaId: last.id });
    } catch (failure) {
      setBringError(`Não deu para trazer: ${describeError(failure)}`);
    } finally {
      setBusy((currentBusy) => currentBusy.filter((key) => key !== entry.key));
    }
  };

  // Visualizador em tela cheia: slides do carrossel, versões da peça ou os itens da lista filtrada.
  const openViewer = (entry: GalleryEntry, activeId?: string) => {
    if (entry.type === "carousel") {
      setViewer({ items: entry.slides, index: Math.max(0, entry.slides.findIndex((slide) => slide.item.id === activeId)), mode: "slides" });
    } else if (entry.versions.length > 0) {
      const parts = [entry.main, ...entry.versions];
      setViewer({ items: parts, index: Math.max(0, parts.findIndex((part) => part.item.id === activeId)), mode: "versions" });
    } else {
      const list = shown.map((candidate) => candidate.main);
      setViewer({ items: list, index: Math.max(0, list.findIndex((part) => part === entry.main)), mode: "list" });
    }
  };

  const ownEmpty = items !== null && items.length === 0 && (folders?.length ?? 0) === 0;
  const folderEmpty = browsing && shown.length === 0 && subfolders.length === 0;

  // O envio cai na pasta aberta (o escopo e os filtros voltam ao normal depois, mas a pasta fica).
  const uploadFolder = browsing ? folder : "";
  const send = (files: FileList | File[] | null) => {
    const list = files ? Array.from(files) : [];
    if (list.length === 0) return;
    const target = uploadFolder;
    void useMediaStore.getState().upload(list, target).then((created) => {
      if (created.length > 0) setFolder(target);
      if (created.length > 0) {
        setFilters(NO_FILTERS);
        setScope("este");
        selectMedia(`${currentId}:${created[0]!.id}`, "push");
      }
    });
  };

  // ---------- Pastas: abrir, mover, apagar ----------
  const openFolder = (path: string) => {
    setFolder(path);
    setFolderNotice(null);
  };
  const idsOf = (entry: GalleryEntry) => entryItems(entry).map((part) => part.item.id);
  const togglePicked = (entry: GalleryEntry) =>
    setPicked((current) => {
      const next = new Set(current);
      const ids = idsOf(entry);
      if (ids.every((id) => next.has(id))) for (const id of ids) next.delete(id);
      else for (const id of ids) next.add(id);
      return next;
    });
  const stopSelecting = () => {
    setSelecting(false);
    setPicked(new Set());
  };
  // Mover (pelo diálogo ou arrastando): avisa onde foi parar e sai do modo de seleção.
  const moveTo = async (ids: readonly string[], target: string) => {
    await useMediaStore.getState().moveItems(ids, target);
    setFolderNotice(`${ids.length === 1 ? "1 item movido" : `${ids.length} itens movidos`} para ${target ? target.split("/").pop() : ROOT_LABEL}.`);
    stopSelecting();
  };
  const dropOnFolder = (target: string, ids: string[]) => {
    if (ids.length === 0) return;
    void moveTo(ids, target).catch((failure) => setFolderNotice(`Não deu para mover: ${describeError(failure)}`));
  };
  // Arrastar um cartão selecionado leva toda a seleção; senão, só ele.
  const dragIdsOf = (entry: GalleryEntry) => () => {
    const own = idsOf(entry);
    return selecting && own.every((id) => picked.has(id)) ? [...picked] : own;
  };
  const pickedIds = [...picked];
  const moveFrom = (() => {
    const places = new Set(pickedIds.map((id) => folderOf(ownItems.find((item) => item.id === id) ?? {})));
    return places.size === 1 ? [...places][0]! : null;
  })();

  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes("Files");
  const onDragEnter = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragLeave = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    send(event.dataTransfer.files);
  };

  // Só os renders deste workspace, em andamento ou na fila.
  const myRuns = useMemo(() => (runs ?? []).filter((run) => run.workspaceId === currentId && (run.state === "rodando" || run.state === "na-fila")), [runs, currentId]);

  // ---------- Gaveta: largura (guardada por navegador) e teclas ----------
  const [viewport, setViewport] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const [storedWidth, setStoredWidth] = useState<number | null>(loadDrawerWidth);
  const limits = drawerLimits(viewport);
  const width = limits.full ? null : drawerWidth(storedWidth, viewport);
  // ← e → trocam de mídia com a gaveta aberta, esteja o foco onde estiver (até no corpo da página, quando o botão em foco ficou desligado).
  const prevKey = nav.prev;
  const nextKey = nav.next;
  const drawerOpen = !!selected;
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      // Campos de texto, a barra de arrastar e os controles de vídeo/áudio usam as setas para si.
      if (target && (/^(INPUT|TEXTAREA|SELECT|AUDIO|VIDEO)$/.test(target.tagName) || target.getAttribute("role") === "separator" || target.isContentEditable)) return;
      // Um diálogo aberto por cima da gaveta (confirmar exclusão, tela cheia) fica com as teclas.
      const dialog = target?.closest("dialog");
      if (dialog && !dialog.classList.contains("ui-drawer")) return;
      const to = event.key === "ArrowLeft" ? prevKey : nextKey;
      if (to) {
        event.preventDefault();
        goTo(to);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen, prevKey, nextKey, goTo]);
  // Fechou: tira a mídia do endereço e, quando a gaveta sair da tela, devolve o foco ao cartão da mídia em que ela parou.
  const returnFocus = useRef<string | null>(null);
  const closeDrawer = () => {
    returnFocus.current = selected?.main.item.id ?? null;
    selectMedia(null);
  };
  useEffect(() => {
    if (selected || !returnFocus.current) return;
    const id = returnFocus.current;
    returnFocus.current = null;
    root.current?.querySelector<HTMLElement>(`[data-testid="media-card-${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  }, [selected]);

  // ---------- Cabeçalho e conteúdo ----------
  const visible = shown.length;
  const showToolbar = !(scope === "este" && ownEmpty);
  const heading = scope === "este" ? currentName : scope === "outro" ? (otherId ? workspaceName(otherId) : "Outro workspace") : "Todos";

  const onScopeKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    for (let i = 1; i <= SCOPE_OPTIONS.length; i++) {
      const option = SCOPE_OPTIONS[(index + step * i + SCOPE_OPTIONS.length * 2) % SCOPE_OPTIONS.length]!;
      if (option.id !== "este" && others.length === 0) continue;
      chooseScope(option.id);
      root.current?.querySelector<HTMLElement>(`[data-testid="media-scope-${option.id === "este" ? "este" : option.id}"]`)?.focus();
      return;
    }
  };
  const chooseScope = (id: Scope) => setScope(id);

  const otherSelect = (
    <label className="md-menu md-menu--other">
      <span className="md-menu__label sr-only">Escolher o workspace</span>
      <select className="ui-input ui-input--compact" value={otherId ?? ""} onChange={(event) => setScope("outro", event.currentTarget.value || null)} data-testid="media-scope-other" aria-label="Escolher o workspace">
        {others.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name}
          </option>
        ))}
      </select>
    </label>
  );

  const groups = useMemo(() => {
    if (view.scope !== "todos") return [];
    const order = [currentId, ...others.map((workspace) => workspace.id)];
    return order.map((ws) => ({ ws, entries: shown.filter((entry) => entry.main.ws === ws) })).filter((group) => group.entries.length > 0);
  }, [view.scope, shown, currentId, others]);

  const renderGrid = (list: GalleryEntry[]) => (
    <ul className="md-grid" data-testid="media-grid">
      {list.map((entry) => (
        <MediaCard
          key={entry.key}
          entry={entry}
          selected={entry.key === selected?.key}
          agentName={agentName}
          onOpen={() => selectMedia(entryKey(entry.main), "push")}
          onView={() => openViewer(entry)}
          {...(bringOf(entry) ? { bring: bringOf(entry)! } : {})}
          {...(foldersOn && !browsing ? { folderLabel: folderOf(entry.main.item) } : {})}
          {...(foldersOn ? { selecting, checked: idsOf(entry).every((id) => picked.has(id)), onToggle: () => togglePicked(entry), dragIds: dragIdsOf(entry) } : {})}
        />
      ))}
    </ul>
  );

  const body = () => {
    if (error && items === null && scope !== "outro") {
      return (
        <p className="page__empty" role="alert">
          Não deu para carregar a Mídia: {error}
        </p>
      );
    }
    if (remote.error && firstLoad) {
      return (
        <p className="page__empty" role="alert">
          Não deu para carregar a mídia dos outros workspaces: {remote.error}{" "}
          <button type="button" className="fy-link" onClick={remote.reload}>
            Tentar de novo
          </button>
        </p>
      );
    }
    if (firstLoad) return <GridSkeleton />;
    if (view.scope === "este" && ownEmpty) return <EmptyState onPick={() => input.current?.click()} />;
    if (located.length === 0) {
      return (
        <div className="md-empty" data-testid="media-empty-remote">
          <MIcon name="image" size={30} />
          <h3>{view.scope === "outro" ? `${workspaceName(otherId ?? "")} ainda não tem mídia` : "Ainda não há mídia nos outros workspaces"}</h3>
          <p>Quando os agentes de lá guardarem imagens e vídeos, eles aparecem aqui para você ver e trazer.</p>
        </div>
      );
    }
    if (shown.length === 0 && folderEmpty && folder !== "") {
      return (
        <div className="md-empty md-empty--folder" data-testid="media-folder-empty">
          <MIcon name="folder" size={30} />
          <h3>Esta pasta está vazia</h3>
          <p>Arraste arquivos para cá, use “Enviar arquivo” (o envio cai nesta pasta) ou mova itens de outra pasta.</p>
        </div>
      );
    }
    if (shown.length === 0 && subfolders.length === 0) {
      return (
        <div className="md-nomatch" data-testid="media-nomatch">
          <p>
            <strong>Nenhuma mídia com esses filtros.</strong>
          </p>
          {(isFiltering(filters) || !showDiscarded) && (
            <button type="button" className="fy-link" onClick={() => setFilters(NO_FILTERS)}>
              Limpar filtros
            </button>
          )}
        </div>
      );
    }
    if (view.scope === "todos") {
      return (
        <div className="md-groups">
          {groups.map((group) => (
            <section key={group.ws} className="md-section" aria-label={workspaceName(group.ws)} data-testid={`media-group-${group.ws}`}>
              <h3 className="md-section__title md-section__title--ws">
                {group.ws === currentId ? `${workspaceName(group.ws)} (este workspace)` : workspaceName(group.ws)}
                <span className="md-section__count">{group.entries.length}</span>
              </h3>
              {renderGrid(group.entries)}
            </section>
          ))}
        </div>
      );
    }
    return (
      <div className="md-groups">
        {subfolders.length > 0 && (
          <ul className="md-folders" aria-label="Pastas" data-testid="media-folders">
            {subfolders.map((path) => (
              <FolderBlock
                key={path}
                path={path}
                stat={folderStats(ownItems, folders ?? [], path)}
                onOpen={() => openFolder(path)}
                onRename={() => setFolderDialog({ mode: "rename", path })}
                onDelete={() => setDeleteFolder(path)}
                onDropIds={(ids) => dropOnFolder(path, ids)}
              />
            ))}
          </ul>
        )}
        {timeSections(shown).map((section) => (
          <section key={section.id} className="md-section" aria-label={section.title ?? "Mídia"}>
            {section.title && (
              <h3 className="md-section__title">
                {section.title}
                <span className="md-section__count">{section.entries.length}</span>
              </h3>
            )}
            {renderGrid(section.entries)}
          </section>
        ))}
      </div>
    );
  };

  const setDensity = (next: Density) => {
    setDensityRaw(next);
    saveDensity(next);
  };

  return (
    <div ref={root} className="md-page" data-density={density} data-scope={scope} onDragEnter={onDragEnter} onDragOver={(event) => hasFiles(event) && event.preventDefault()} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="md-bar" data-testid="media-bar">
        <div className="md-bar__row">
          <h2 id="page-title-midia" className="md-bar__title" data-testid="media-scope-label">
            <span className={scope === "outro" ? "sr-only" : "md-bar__name"}>{heading}</span>
            {showToolbar && (
              <span className="md-bar__count" aria-live="polite" title={scope === "este" ? undefined : `Só para ver. “Trazer para ${currentName}” copia; o original fica onde está.`}>
                {visible} {visible === 1 ? "item" : "itens"}
                {scope === "este" && !browsing && <span className="md-bar__ro"> · todas as pastas</span>}
                {scope !== "este" && <span className="md-bar__ro"> · só para ver</span>}
                {scope === "este" && <SizeLabel bytes={headerBytes} testId="media-size" className="md-size--head" title="Peso dos arquivos da Mídia deste workspace" />}
                {switching && <span className="md-spinner" role="status" aria-label="Carregando" data-testid="media-switching" />}
              </span>
            )}
          </h2>

          <div className="md-scope" role="radiogroup" aria-label="De onde mostrar a mídia" data-testid="media-scope">
            {SCOPE_OPTIONS.map((option, index) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={scope === option.id}
                tabIndex={scope === option.id ? 0 : -1}
                className="md-scope__opt"
                disabled={option.id !== "este" && others.length === 0}
                onClick={() => chooseScope(option.id)}
                onKeyDown={(event) => onScopeKey(event, index)}
                data-testid={`media-scope-${option.id}`}
                title={option.id === "este" ? currentName : others.length === 0 ? "Só existe este workspace" : undefined}
              >
                <span className="md-scope__long">{option.long}</span>
                <span className="md-scope__short">{option.short}</span>
              </button>
            ))}
          </div>
          {scope === "outro" && otherSelect}
          {showToolbar && (
            <label className="md-search">
              <MIcon name="search" size={15} />
              <input className="ui-input" type="search" value={filters.q} onChange={(event) => setFilters({ ...filters, q: event.target.value })} placeholder="Buscar mídia" aria-label="Buscar mídia" data-testid="media-search" />
            </label>
          )}
          {showToolbar && <FilterBar filters={filters} onChange={setFilters} options={filterOptions} showDiscarded={showDiscarded} onShowDiscarded={setShowDiscarded} hasDiscarded={hasDiscarded} />}
          {showToolbar && (
            <div className="md-density" role="radiogroup" aria-label="Tamanho dos cartões" data-testid="media-density">
              <button type="button" role="radio" aria-checked={density === "confortavel"} className="md-density__opt" onClick={() => setDensity("confortavel")} title="Cartões confortáveis" aria-label="Cartões confortáveis" data-testid="media-density-comfortable">
                <MIcon name="grid" size={15} />
              </button>
              <button type="button" role="radio" aria-checked={density === "compacta"} className="md-density__opt" onClick={() => setDensity("compacta")} title="Cartões compactos" aria-label="Cartões compactos" data-testid="media-density-compact">
                <MIcon name="dense" size={15} />
              </button>
            </div>
          )}
          {showToolbar && foldersOn && (
            <button type="button" className="ui-button ui-button--secondary md-folder-btn" onClick={() => setFolderDialog({ mode: "create" })} data-testid="media-new-folder" aria-label="Nova pasta">
              <MIcon name="folderPlus" size={14} />
              <span className="md-folder-btn__label">Nova pasta</span>
            </button>
          )}
          {showToolbar && foldersOn && shown.length > 0 && (
            <button type="button" className={`ui-button ui-button--secondary md-folder-btn${selecting ? " md-folder-btn--on" : ""}`} aria-pressed={selecting} onClick={() => (selecting ? stopSelecting() : setSelecting(true))} data-testid="media-select" aria-label="Selecionar itens">
              <MIcon name="task" size={14} />
              <span className="md-folder-btn__label">Selecionar</span>
            </button>
          )}
          <input ref={input} type="file" multiple hidden onChange={(event) => { send(event.target.files); event.target.value = ""; }} data-testid="media-file-input" />
          <button type="button" className="ui-button md-upload-btn" onClick={() => input.current?.click()} data-testid="media-upload" aria-label="Enviar arquivo">
            <MIcon name="upload" size={14} />
            <span className="md-upload-btn__label">Enviar arquivo</span>
          </button>
        </div>
        {showToolbar && <ActiveFilters filters={filters} onChange={setFilters} options={filterOptions} />}
        {showToolbar && browsing && <Breadcrumb folder={folder} onOpen={openFolder} onDropIds={dropOnFolder} />}
      </div>

      {folderNotice && (
        <p className="md-notice" role="status" data-testid="media-folder-notice">
          <MIcon name="check" size={14} />
          <span>{folderNotice}</span>
          <button type="button" className="ui-icon-button" onClick={() => setFolderNotice(null)} aria-label="Dispensar aviso">
            <MIcon name="close" size={14} />
          </button>
        </p>
      )}

      {scope === "este" && <RenderStrip runs={myRuns} />}

      {notice && (
        <p className="md-notice" role="status" data-testid="media-notice">
          <MIcon name="check" size={14} />
          <span>{notice.text}</span>
          <button
            type="button"
            className="fy-link"
            onClick={() => {
              setScope("este");
              setFilters(NO_FILTERS);
              selectMedia(`${notice.ws}:${notice.mediaId}`, "push");
            }}
          >
            Ver em Este workspace
          </button>
          <button type="button" className="ui-icon-button" onClick={() => setNotice(null)} aria-label="Dispensar aviso">
            <MIcon name="close" size={14} />
          </button>
        </p>
      )}
      {bringError && (
        <p className="md-notice md-notice--error" role="alert">
          {bringError}
        </p>
      )}

      {uploads.length > 0 && (
        <ul className="md-uploads" aria-label="Envios" data-testid="media-uploads">
          {uploads.map((upload) => (
            <li key={upload.key} className={`md-upload${upload.error ? " md-upload--error" : ""}`} role={upload.error ? "alert" : undefined}>
              <span className="md-upload__name">{upload.name}</span>
              {upload.error ? (
                <>
                  <span className="md-upload__msg">{upload.error}</span>
                  <button type="button" className="ui-icon-button" onClick={() => useMediaStore.getState().dismissUpload(upload.key)} aria-label="Dispensar">
                    <MIcon name="close" size={14} />
                  </button>
                </>
              ) : (
                <>
                  <span className="md-upload__bar" role="progressbar" aria-label={`Enviando ${upload.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(upload.progress * 100)}>
                    <span style={{ width: `${Math.round(upload.progress * 100)}%` }} />
                  </span>
                  <span className="md-upload__pct">{Math.round(upload.progress * 100)}%</span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="md__main" data-switching={switching ? "true" : undefined} aria-busy={!ready}>
        {switching && <span className="md-loadbar" aria-hidden="true" />}
        {body()}
      </div>

      {selected && (
        <Drawer
          label={`Detalhe de ${selected.type === "carousel" ? "carrossel" : selected.main.item.title}`}
          width={width}
          min={limits.min}
          max={limits.max}
          onWidthChange={(next) => {
            setStoredWidth(next);
            saveDrawerWidth(next);
          }}
          onClose={closeDrawer}
          testId="media-drawer"
        >
          {({ close }) => (
            <MediaDetail
              key={selected.key}
              entry={selected}
              currentWs={currentId}
              agentName={agentName}
              agentAvatar={agentAvatar}
              workspaceName={workspaceName}
              tasks={tasks}
              projectTitle={projectTitle}
              onView={openViewer}
              {...(bringOf(selected) ? { bring: bringOf(selected)! } : {})}
              onClose={close}
              nav={{ index: nav.index, total: nav.total, onPrev: nav.prev ? () => goTo(nav.prev) : null, onNext: nav.next ? () => goTo(nav.next) : null }}
              linkTo={(entry) => hashWithMedia(window.location.hash, entryKey(entry.main))}
            />
          )}
        </Drawer>
      )}

      {viewer && <MediaViewer items={viewer.items} index={viewer.index} mode={viewer.mode} agentName={agentName} onIndex={(index) => setViewer({ ...viewer, index })} onClose={() => setViewer(null)} />}

      {selecting && foldersOn && <SelectionBar count={pickedIds.length} total={shown.reduce((total, entry) => total + idsOf(entry).length, 0)} onAll={() => setPicked(new Set(shown.flatMap(idsOf)))} onMove={() => setMoveIds(pickedIds)} onCancel={stopSelecting} />}

      {folderDialog && (
        <FolderNameDialog
          title={folderDialog.mode === "create" ? (folder ? `Nova pasta em ${folder.split("/").pop()}` : "Nova pasta") : "Renomear a pasta"}
          confirmLabel={folderDialog.mode === "create" ? "Criar pasta" : "Renomear"}
          {...(folderDialog.mode === "rename" ? { initial: folderDialog.path.split("/").pop() ?? "" } : {})}
          hint={folderDialog.mode === "create" ? "Pastas só organizam: os arquivos não saem do lugar." : undefined}
          onClose={() => setFolderDialog(null)}
          onSubmit={async (name) => {
            if (folderDialog.mode === "create") {
              const created = await useMediaStore.getState().createFolder(name, folder);
              openFolder(created);
              return;
            }
            const renamed = await useMediaStore.getState().renameFolder(folderDialog.path, name);
            setFolder(remapAfterRename(folder, folderDialog.path, renamed));
          }}
        />
      )}

      {deleteFolder !== null && (
        <ConfirmDialog
          title={`Apagar a pasta “${deleteFolder.split("/").pop()}”?`}
          message={
            <p>
              Nenhum arquivo é apagado. Os {folderStats(ownItems, folders ?? [], deleteFolder).count} itens e as subpastas dela sobem para {parentOf(deleteFolder) ? `“${parentOf(deleteFolder).split("/").pop()}”` : `a raiz (${ROOT_LABEL})`}.
            </p>
          }
          confirmLabel="Apagar pasta"
          pendingLabel="Apagando…"
          testId="media-folder-delete-dialog"
          onClose={() => setDeleteFolder(null)}
          onConfirm={async () => {
            const removed = deleteFolder;
            await useMediaStore.getState().deleteFolder(removed);
            setFolder(remapAfterDelete(folder, removed));
          }}
        />
      )}

      {moveIds && <MoveDialog folders={folders ?? []} count={moveIds.length} from={moveFrom} onClose={() => setMoveIds(null)} onMove={(target) => moveTo(moveIds, target)} />}

      {dragging && (
        <div className="md-drop" aria-hidden="true" data-testid="media-drop">
          <MIcon name="upload" size={34} />
          <p>{uploadFolder ? `Solte para enviar à pasta ${uploadFolder.split("/").pop()}` : "Solte para enviar a este workspace"}</p>
        </div>
      )}
    </div>
  );
}

function EmptyState({ onPick }: { onPick: () => void }) {
  return (
    <div className="md-empty" data-testid="media-empty">
      <svg className="md-empty__art" viewBox="0 0 140 100" width="140" height="100" fill="none" aria-hidden="true">
        <rect x="14" y="22" width="72" height="56" rx="8" fill="currentColor" opacity="0.07" stroke="currentColor" strokeWidth="2.5" />
        <rect x="46" y="12" width="80" height="62" rx="8" fill="var(--ui-surface-solid)" stroke="currentColor" strokeWidth="2.5" opacity="0.9" />
        <circle cx="68" cy="32" r="6" fill="var(--ui-accent-bg)" stroke="var(--ui-accent)" strokeWidth="2.5" />
        <path d="m50 68 22-22 16 16 10-10 24 24" stroke="var(--ui-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <h3>Nenhuma mídia neste workspace ainda</h3>
      <p>Os agentes guardam aqui o que fazem; você também pode enviar qualquer arquivo e organizar tudo em pastas.</p>
      <button type="button" className="ui-button" onClick={onPick}>
        <MIcon name="upload" size={14} />
        Enviar arquivo
      </button>
      <p className="md-empty__hint">Arraste para esta tela ou use o botão. Aceita qualquer arquivo, de qualquer tamanho. Para usar algo de outro workspace, escolha “Outro workspace” acima.</p>
    </div>
  );
}
