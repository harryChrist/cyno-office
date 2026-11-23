import { isProjectTaskFinished, PROJECT_PRIORITIES, PROJECT_PRIORITY_LABELS, type Agent, type Label, type Project, type ProjectPriority, type Sprint } from "@cyno/shared";
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { ConfirmDialog, ErrorText, Modal } from "../../ui/widgets";
import { AgentAvatar } from "./Agent";
import { canDeleteTaskNode } from "./projectDeleteView";
import { buildProjectIndex, type ProjectIndex } from "./projectIndex";
import {
  impliedSelection,
  normalizeSelection,
  plannedWaitButton,
  plannedWaitText,
  RELEASE_FILTER_LABELS,
  RELEASE_FILTERS,
  releaseFilterRefs,
  releaseMenu,
  selectionCan,
  selectionSummary,
  type PlannedWait,
  type ReleaseFilter,
} from "./releaseView";
import {
  buildTreeRows,
  hasSprintColumn,
  indentLevel,
  MOBILE_INDENT_LEVELS,
  moveTargets,
  normalizeText,
  pathText,
  readOpenRefs,
  resolveDue,
  searchTree,
  TREE_PAGE,
  TREE_VIRTUALIZE_FROM,
  treeOpenKey,
  treeRowHeight,
  treeVisibleRange,
  writeOpenRefs,
  type DueInfo,
  type FlowInfo,
  type TreeAddRow,
  type TreeMoreRow,
  type TreeNodeRow,
  type TreeStepRow,
} from "./taskTreeView";
import { openSprints, shortSprintName, sprintRange } from "./sprintsView";
import { AvatarStack, Popover, PriorityFlag, StateChip, StatusIcon } from "./treeParts";
import { treeDrop, zoneAt, type TreeVerdict } from "./dragRules";
import { DragGhost, usePointerDrag } from "./usePointerDrag";
import { AddSubtaskDialog } from "./FlowBlock";
import { useIsMobile } from "./useIsMobile";
import type { TaskActions } from "./useTaskActions";
import { brasiliaNote, fromBrasiliaInput, toBrasiliaInput } from "./workTime";

type TreeProps = {
  project: Project;
  /** Índice já montado pelo `ProjectBody` (evita reindexar na mesma versão do projeto). */
  index?: ProjectIndex;
  agents: ReadonlyMap<string, Agent>;
  /** Quem pode receber tarefa (todos menos o Maestro), em ordem de nome. */
  workers: readonly Agent[];
  workspaceId: string | null;
  now: number;
  selectedRef: string | undefined;
  onSelect: (ref: string) => void;
  /** O projeto aceita mudanças (não terminou nem está sendo refeito pelo Maestro). */
  editable: boolean;
  /** Dá para criar à mão (o Avulsas não). */
  canCreate: boolean;
  actions: TaskActions;
  /** Tarefa do Avulsas: ganha "Transformar em projeto" no menu. */
  onConvert?: (ref: string) => void;
  /** Pede para apagar o item (quem chama abre a confirmação apropriada). */
  onDelete?: (ref: string) => void;
};

const EMPTY_CLOSED: ReadonlySet<string> = new Set();

/** O ancestral mais próximo que rola verticalmente (mesma regra do `usePointerDrag`). */
function findScrollParent(node: HTMLElement | null): HTMLElement | null {
  for (let current = node?.parentElement ?? null; current; current = current.parentElement) {
    const overflow = getComputedStyle(current).overflowY;
    if (overflow === "auto" || overflow === "scroll") return current;
  }
  return null;
}

/**
 * O título tem prioridade: enquanto ele aparece cortado, a linha solta o que é secundário, um nível por vez
 * (1: os selos de sprint; 2: só uma etiqueta; 3: nenhuma, só o "+N"). Mede de novo quando a coluna muda de largura.
 * No celular o nome quebra em duas linhas e nada precisa sair.
 */
function useNameFit(deps: readonly unknown[], enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const signature = deps.join("\u0001");
  // O nível vale só para o conteúdo medido (a assinatura): mudou título, etiquetas ou selos, começa do 0.
  const [state, setState] = useState({ signature, level: 0 });
  const level = state.signature === signature ? state.level : 0;
  useLayoutEffect(() => {
    const title = ref.current?.querySelector<HTMLElement>(".tt-title");
    if (!enabled || !title || level >= 3) return;
    if (title.scrollWidth > title.clientWidth + 1) setState({ signature, level: level + 1 });
  }, [state, signature, level, enabled]);
  useEffect(() => {
    const node = ref.current;
    if (!node || !enabled || typeof ResizeObserver === "undefined") return;
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (Math.abs(node.clientWidth - width) < 1) return;
      width = node.clientWidth;
      setState((current) => ({ signature: current.signature, level: 0 }));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled]);
  return [ref, enabled ? level : 0] as const;
}

/** O mínimo que as células editáveis (responsável, data, prioridade, sprint) leem da linha: a lista "Todas as tarefas" reaproveita as mesmas. */
export type CellRow = Pick<TreeNodeRow, "ref" | "node" | "assignees" | "moreAssignees" | "due" | "carried" | "status">;
export type CellActions = Pick<TaskActions, "update" | "move">;

/** A folha já começou (não dá para trocar o responsável nem dividir)? */
const started = (row: Pick<TreeNodeRow, "node">): boolean => (row.node.status !== "backlog" && row.node.status !== "a_fazer") || row.node.steps.some((step) => step.status !== "pendente" || step.taskId !== undefined);

/**
 * A árvore do projeto (a lista em árvore do print): módulos, tarefas e subtarefas com seta de abrir e fechar,
 * contador, etiquetas e as colunas Responsáveis, Data e Prioridade (e Sprint, quando o projeto tiver sprints).
 * Clicar na linha abre o painel da tarefa; as colunas editam ali mesmo (no celular, a edição fica no painel).
 */
export function TaskTree({ project, index: externalIndex, agents, workers, workspaceId, now, selectedRef, onSelect, editable, canCreate, actions, onConvert, onDelete }: TreeProps) {
  const storageKey = treeOpenKey(workspaceId, project.id);
  const projectIndex = useMemo(() => externalIndex ?? buildProjectIndex(project.tasks), [externalIndex, project.tasks]);
  /** O que o dono abriu (a árvore nasce toda fechada). */
  const [openRefs, setOpenRefs] = useState<Set<string>>(() => readOpenRefs(storageKey) ?? new Set());
  const [adding, setAdding] = useState<{ parentRef?: string; group?: boolean } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [movingSprint, setMovingSprint] = useState<string | null>(null);
  /** Pai de quem ganha uma subtarefa pela janela (responsável e "depois de"). */
  const [subDialog, setSubDialog] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const mobile = useIsMobile();
  const [notice, setNotice] = useState<string | null>(null);
  /** Busca no topo da árvore; a lista usa o valor "atrasado" para a digitação não travar com centenas de linhas. */
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query);
  /** Filtro "Mostrar: Tudo | Liberadas | Planejadas". */
  const [releaseFilter, setReleaseFilter] = useState<ReleaseFilter>("tudo");
  /** Seleção em lote (refs marcados pelo usuário; selecionar um módulo vale por ele inteiro). */
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  /** No celular, liga/desliga o modo de seleção em lote. */
  const [selectMode, setSelectMode] = useState(false);
  /** Quantos filhos cada pai mostra ("ver mais" soma 30; chave "" é o projeto). */
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(new Map());
  const listRef = useRef<HTMLUListElement>(null);
  const [scrollView, setScrollView] = useState({ top: 0, height: 800 });

  // O que o dono abre é lembrado por projeto (localStorage, com try/catch em writeOpenRefs); o resto nasce fechado.
  const toggle = useCallback(
    (ref: string) => {
      setOpenRefs((current) => {
        const next = new Set(current);
        if (!next.delete(ref)) next.add(ref);
        writeOpenRefs(storageKey, next);
        return next;
      });
    },
    [storageKey],
  );
  const openRef = useCallback(
    (ref: string) => {
      setOpenRefs((current) => {
        if (current.has(ref)) return current;
        const next = new Set(current);
        next.add(ref);
        writeOpenRefs(storageKey, next);
        return next;
      });
    },
    [storageKey],
  );

  /** Mostra todos os filhos de um pai (depois de criar ou mover para ele: o item novo vai para o fim e não pode ficar escondido). */
  const revealAll = useCallback((parentRef: string | null | undefined) => setShown((current) => new Map(current).set(parentRef ?? "", Number.MAX_SAFE_INTEGER)), []);
  const showMore = useCallback((parentRef: string | undefined) => setShown((current) => new Map(current).set(parentRef ?? "", Math.min(Number.MAX_SAFE_INTEGER, (current.get(parentRef ?? "") ?? TREE_PAGE) + TREE_PAGE))), []);

  const canRelease = editable && canCreate;
  const addingParent = adding?.parentRef;
  const searching = search.trim() !== "";
  const filtering = releaseFilter !== "tudo";
  const filterRefs = useMemo(() => releaseFilterRefs(project, releaseFilter, projectIndex), [project, releaseFilter, projectIndex]);
  const selectedRefs = useMemo(() => (canRelease ? normalizeSelection(project, picked, projectIndex) : []), [canRelease, project, picked, projectIndex]);
  const selectedSet = useMemo(() => new Set(selectedRefs), [selectedRefs]);
  const impliedSet = useMemo(() => impliedSelection(project, selectedSet, projectIndex), [project, selectedSet, projectIndex]);
  const hasPicked = selectedRefs.length > 0;
  const canBatch = useMemo(() => selectionCan(project, selectedRefs, projectIndex), [project, selectedRefs, projectIndex]);
  const clearPicked = useCallback(() => {
    setPicked(new Set());
    setSelectMode(false);
  }, []);

  const latestRef = useRef({ project, projectIndex, canRelease, impliedSet, actions });
  useEffect(() => {
    latestRef.current = { project, projectIndex, canRelease, impliedSet, actions };
  }, [project, projectIndex, canRelease, impliedSet, actions]);

  const togglePick = useCallback((ref: string) => {
    const { canRelease: allowed, impliedSet: implied, project: currentProject, projectIndex: currentIndex } = latestRef.current;
    if (!allowed || implied.has(ref)) return;
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(ref)) next.add(ref);
      return new Set(normalizeSelection(currentProject, next, currentIndex));
    });
  }, []);
  useEffect(() => {
    if (!hasPicked && !selectMode) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector("dialog[open]") || document.querySelector(".tt-pop")) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return;
      event.preventDefault();
      clearPicked();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hasPicked, selectMode, clearPicked]);

  const agentName = useCallback((id: string) => agents.get(id)?.name ?? id, [agents]);

  // Sem `now` nas dependências: o relógio de 30 s não reconstrói a árvore (só resolve o prazo das linhas visíveis).
  const rows = useMemo(
    () =>
      buildTreeRows(project, EMPTY_CLOSED, {
        index: projectIndex,
        openRefs,
        addRows: editable && canCreate,
        shown,
        ...(search.trim() ? { query: search } : {}),
        ...(filterRefs ? { filter: filterRefs } : {}),
        agentName,
        ...(addingParent ? { forceAdd: addingParent } : {}),
      }),
    [project, projectIndex, openRefs, editable, canCreate, addingParent, agentName, shown, search, filterRefs],
  );
  const found = useMemo(() => {
    if (!searching) return 0;
    const matches = searchTree(project, search, projectIndex)?.matches;
    if (!matches) return 0;
    return filterRefs ? [...matches].filter((ref) => filterRefs.has(ref)).length : matches.size;
  }, [project, projectIndex, search, searching, filterRefs]);
  const liveCount = projectIndex.liveTasks.length;
  const sprintColumn = hasSprintColumn(project);
  const virtualized = rows.length > TREE_VIRTUALIZE_FROM;

  // Janela de rolagem ativa só quando há muitas linhas abertas (> 200): acompanha o ancestral que rola (`.ps`).
  useEffect(() => {
    if (!virtualized) return;
    const list = listRef.current;
    const scroller = findScrollParent(list);
    if (!list || !scroller) return;
    const measure = () => {
      const listRect = list.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const listTopInScroller = listRect.top - scrollerRect.top + scroller.scrollTop;
      const top = Math.max(0, scroller.scrollTop - listTopInScroller);
      const height = scroller.clientHeight || 800;
      setScrollView((current) => (Math.abs(current.top - top) < 4 && Math.abs(current.height - height) < 4 ? current : { top, height }));
    };
    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [virtualized]);

  const windowRange = useMemo(
    () => (virtualized ? treeVisibleRange(rows, mobile, scrollView.top, scrollView.height) : null),
    [virtualized, rows, mobile, scrollView.top, scrollView.height],
  );
  const visibleRows = useMemo(() => (windowRange ? rows.slice(windowRange.start, windowRange.end) : rows), [windowRange, rows]);

  // Ao selecionar uma tarefa (ex.: link direto ou painel) com a árvore virtualizada, rola até ela se estiver fora da janela.
  useEffect(() => {
    if (!virtualized || !selectedRef) return;
    const idx = rows.findIndex((row) => row.kind === "node" && row.ref === selectedRef);
    if (idx < 0) return;
    const list = listRef.current;
    const scroller = findScrollParent(list);
    if (!list || !scroller) return;
    let offset = 0;
    for (let i = 0; i < idx; i += 1) offset += treeRowHeight(rows[i]!, mobile);
    const listRect = list.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const listTopInScroller = listRect.top - scrollerRect.top + scroller.scrollTop;
    const rowTop = listTopInScroller + offset;
    const rowBottom = rowTop + treeRowHeight(rows[idx]!, mobile);
    if (rowTop < scroller.scrollTop || rowBottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = Math.max(0, rowTop - scroller.clientHeight / 3);
    }
  }, [virtualized, selectedRef, rows, mobile]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Arrastar uma linha: reordena entre irmãs ou muda de pai; a linha-guia mostra onde vai cair (regras em dragRules).
  const drag = usePointerDrag<TreeVerdict>({
    enabled: editable && canCreate && !mobile && !searching && !filtering,
    hit: (point, id) => {
      const over = document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>("li.tt-row[data-ref]");
      const overRef = over?.dataset.ref;
      if (!over || !overRef) return null;
      const rect = over.getBoundingClientRect();
      return treeDrop(project, id, overRef, zoneAt(point.y, rect.top, rect.height, true), projectIndex.tree);
    },
    accepts: (verdict) => verdict.ok,
    onDrop: (id, verdict) => {
      if (!verdict.ok) {
        if (verdict.reason) setNotice(verdict.reason);
        return;
      }
      void actions.move(id, verdict.move).then((ok) => {
        if (!ok) return;
        if (verdict.move.parent) openRef(verdict.move.parent);
        revealAll(verdict.move.parent);
      });
    },
  });

  const dragStartRef = useRef(drag.start);
  useEffect(() => {
    dragStartRef.current = drag.start;
  }, [drag.start]);

  const handleDragStart = useCallback((ref: string, title: string, event: PointerEvent<HTMLLIElement>) => {
    dragStartRef.current(ref, title, event);
  }, []);
  const handleRename = useCallback((ref: string, on: boolean) => setRenaming(on ? ref : null), []);
  const handleAddChild = useCallback(
    (ref: string, isGroup: boolean, group?: boolean) => {
      openRef(ref);
      if (!isGroup) setSubDialog(ref);
      else setAdding({ parentRef: ref, ...(group ? { group: true } : {}) });
    },
    [openRef],
  );
  const handleMove = useCallback((ref: string) => setMoving(ref), []);
  const handleMoveSprint = useCallback((ref: string) => setMovingSprint(ref), []);
  const handleCancel = useCallback((ref: string) => setCancelling(ref), []);
  const handleStartAdd = useCallback((parentRef: string | undefined, group: boolean) => {
    const parentNode = parentRef ? latestRef.current.projectIndex.tree.byRef.get(parentRef) : undefined;
    if (parentRef && parentNode && !parentNode.group) setSubDialog(parentRef);
    else setAdding({ ...(parentRef ? { parentRef } : {}), ...(group ? { group: true } : {}) });
  }, []);
  const handleStopAdd = useCallback(() => setAdding(null), []);
  const handleCreateAdd = useCallback(
    async (parentRef: string | undefined, title: string, group: boolean) => {
      const ref = await latestRef.current.actions.create({ title, ...(parentRef ? { parent: parentRef } : {}), ...(group ? { group: true } : {}) });
      if (ref) {
        if (parentRef) openRef(parentRef);
        revealAll(parentRef);
      }
      return ref !== undefined;
    },
    [openRef, revealAll],
  );

  const movingRow = moving ? rows.find((row): row is TreeNodeRow => row.kind === "node" && row.ref === moving) : undefined;
  const sprintRow = movingSprint ? rows.find((row): row is TreeNodeRow => row.kind === "node" && row.ref === movingSprint) : undefined;
  const cancelRow = cancelling ? rows.find((row): row is TreeNodeRow => row.kind === "node" && row.ref === cancelling) : undefined;

  const runBatch = async (action: () => Promise<boolean>) => {
    const ok = await action();
    if (ok) clearPicked();
  };

  const listStyle = windowRange ? ({ paddingTop: windowRange.offset, paddingBottom: windowRange.bottom } satisfies CSSProperties) : undefined;

  return (
    <div className={`tt${sprintColumn ? " tt--sprints" : ""}${hasPicked || selectMode ? " tt--picking" : ""}`} data-testid="task-tree">
      <ErrorText testId="task-tree-error">{actions.error}</ErrorText>
      {notice && (
        <p className="tt-notice" role="status" data-testid="tree-drop-notice">
          {notice}
        </p>
      )}
      {liveCount > 0 && (
        <div className="tt-toolbar">
          {liveCount >= SEARCH_FROM && (
            <div className="tt-search" role="search">
              <input
                className="ui-input ui-input--compact tt-search__input"
                type="search"
                value={query}
                placeholder="Buscar por nome ou código"
                aria-label="Buscar na árvore por nome ou código"
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setQuery("");
                }}
                data-testid="tree-search"
              />
              {searching && (
                <span className="tt-search__count" role="status" data-testid="tree-search-count">
                  {found === 0 ? "Nada encontrado" : found === 1 ? "1 item" : `${found} itens`}
                </span>
              )}
            </div>
          )}
          <div className="tt-filter" role="group" aria-label="Mostrar">
            <span className="tt-filter__label">Mostrar:</span>
            <div className="w-seg tt-filter__seg">
              {RELEASE_FILTERS.map((id) => (
                <button key={id} type="button" aria-pressed={releaseFilter === id} onClick={() => setReleaseFilter(id)} data-testid={`tree-filter-${id}`}>
                  {RELEASE_FILTER_LABELS[id]}
                </button>
              ))}
            </div>
          </div>
          {canRelease && mobile && (
            <button
              type="button"
              className="ui-button ui-button--secondary ui-button--small tt-selectbtn"
              onClick={() => (selectMode || hasPicked ? clearPicked() : setSelectMode(true))}
              data-testid="tree-select-toggle"
            >
              {selectMode || hasPicked ? "Cancelar seleção" : "Selecionar"}
            </button>
          )}
        </div>
      )}
      {canRelease && hasPicked && (
        <div className="tt-batch" role="region" aria-label="Ações da seleção" data-testid="tree-batch-bar">
          <span className="tt-batch__count" data-testid="tree-batch-count">
            {selectionSummary(project, selectedRefs, projectIndex)}
          </span>
          <div className="tt-batch__actions">
            <button
              type="button"
              className="ui-button ui-button--small"
              disabled={!canBatch.release || actions.busy}
              onClick={() => void runBatch(() => actions.release({ refs: selectedRefs }))}
              data-testid="tree-batch-release"
            >
              Liberar
            </button>
            <button
              type="button"
              className="ui-button ui-button--secondary ui-button--small"
              disabled={!canBatch.releaseWith || actions.busy}
              title={canBatch.releaseWith ? "Libera a seleção e os pré-requisitos Planejados" : "Nenhum pré-requisito Planejado fora da seleção"}
              onClick={() => void runBatch(() => actions.release({ refs: selectedRefs, withPrerequisites: true }))}
              data-testid="tree-batch-release-with"
            >
              Liberar com o que precisam
            </button>
            <button
              type="button"
              className="ui-button ui-button--secondary ui-button--small"
              disabled={!canBatch.hold || actions.busy}
              onClick={() => void runBatch(() => actions.hold(selectedRefs))}
              data-testid="tree-batch-hold"
            >
              Segurar
            </button>
            <button type="button" className="ui-button ui-button--ghost ui-button--small" disabled={actions.busy} onClick={clearPicked} data-testid="tree-batch-clear">
              Limpar
            </button>
          </div>
        </div>
      )}
      <div className="tt-head" aria-hidden="true">
        <span className="tt-head__name">Nome</span>
        <span>Responsáveis</span>
        <span>Data</span>
        <span>Prioridade</span>
        <span>{sprintColumn ? "Sprint" : "Estado"}</span>
      </div>
      <ul
        ref={listRef}
        className="tt-body"
        style={listStyle}
        role="tree"
        aria-label="Tarefas do projeto"
        data-virtualized={virtualized ? "true" : undefined}
        data-total-rows={rows.length}
      >
        {visibleRows.map((row) =>
          row.kind === "step" ? (
            <StepRow key={row.key} row={row} agents={agents} mobile={mobile} />
          ) : row.kind === "more" ? (
            <MoreRow key={row.key} row={row} mobile={mobile} onMore={showMore} />
          ) : row.kind === "add" ? (
            <AddRow
              key={row.key}
              row={row}
              mobile={mobile}
              active={adding !== null && adding.parentRef === row.parentRef && (row.both || !adding.group)}
              group={adding?.group ?? false}
              onStart={handleStartAdd}
              onStop={handleStopAdd}
              onCreate={handleCreateAdd}
            />
          ) : (
            <NodeRow
              key={row.key}
              row={row}
              due={row.due ?? resolveDue(row.dueMeta, row.status, now)}
              project={project}
              index={projectIndex}
              agents={agents}
              workers={workers}
              selected={selectedRef === row.ref}
              picked={selectedSet.has(row.ref)}
              implied={impliedSet.has(row.ref)}
              showCheck={canRelease && (!mobile || selectMode || hasPicked)}
              onPick={togglePick}
              dragging={drag.session?.id === row.ref}
              dropVerdict={drag.session?.verdict && drag.session.verdict.overRef === row.ref ? drag.session.verdict : null}
              onDragStart={handleDragStart}
              editable={editable}
              canCreate={canCreate}
              mobile={mobile}
              sprintColumn={sprintColumn}
              renaming={renaming === row.ref}
              actions={actions}
              onSelect={onSelect}
              onToggle={toggle}
              onRename={handleRename}
              onAddChild={handleAddChild}
              onMove={handleMove}
              onMoveSprint={handleMoveSprint}
              onCancel={handleCancel}
              {...(onConvert ? { onConvert } : {})}
              {...(onDelete ? { onDelete } : {})}
            />
          ),
        )}
      </ul>
      <DragGhost session={drag.session} reason={drag.session?.verdict && !drag.session.verdict.ok ? drag.session.verdict.reason || null : null} />
      {searching && found === 0 && <p className="tt-empty">Nada encontrado para “{search.trim()}”. Busque pelo nome ou pelo código (T12).</p>}
      {!searching && filtering && rows.length === 0 && (
        <p className="tt-empty" data-testid="tree-filter-empty">
          {releaseFilter === "planejadas" ? "Nenhuma tarefa Planejada neste projeto." : "Nenhuma tarefa liberada ainda."}
        </p>
      )}
      {!searching && !filtering && rows.every((row) => row.kind === "add") && (
        <p className="tt-empty" data-testid="tree-empty-hint">
          {canCreate ? "Tudo que você cria aqui nasce Planejado. Libere quando quiser que as IAs comecem." : "Este projeto ainda não tem tarefas."}
        </p>
      )}
      {subDialog && <AddSubtaskDialog project={project} parentRef={subDialog} workers={workers} actions={actions} onClose={() => setSubDialog(null)} onCreated={(ref) => { openRef(subDialog); revealAll(subDialog); onSelect(ref); }} />}
      {movingRow && <MoveDialog project={project} index={projectIndex} row={movingRow} actions={actions} onClose={() => setMoving(null)} onMoved={(parent) => { if (parent) openRef(parent); revealAll(parent); }} />}
      {sprintRow && <MoveSprintDialog project={project} row={sprintRow} actions={actions} onClose={() => setMovingSprint(null)} />}
      {cancelRow && (
        <ConfirmDialog
          title={cancelRow.hasChildren || cancelRow.isGroup ? "Cancelar tudo que está dentro?" : "Cancelar a tarefa?"}
          message={<p>A etapa que já está rodando para. O que já foi entregue fica no histórico.</p>}
          confirmLabel="Cancelar"
          pendingLabel="Cancelando…"
          onConfirm={async () => {
            const ok = await actions.cancel(cancelRow.ref);
            if (!ok) throw new Error("Não deu para cancelar.");
          }}
          onClose={() => setCancelling(null)}
          testId="tree-cancel-dialog"
        />
      )}
    </div>
  );
}

/** A busca só aparece quando a árvore tem itens que justifiquem. */
const SEARCH_FROM = 8;

/** O recuo da linha: um nível por ancestral (no celular pára no 4º; o caminho "A > B > C" diz onde ela está). */
const levelStyle = (depth: number, mobile: boolean): CSSProperties => ({ "--tt-level": indentLevel(depth, mobile) }) as CSSProperties;

/** "ver mais 70": mostra mais 30 filhos do nível. */
const MoreRow = memo(function MoreRow({ row, mobile, onMore }: { row: TreeMoreRow; mobile: boolean; onMore: (parentRef: string | undefined) => void }) {
  const next = Math.min(TREE_PAGE, row.remaining);
  return (
    <li className="tt-row tt-row--more" role="none" style={levelStyle(row.depth, mobile)} data-testid={`tree-${row.key}`}>
      <div className="tt-name">
        <span className="tt-arrow tt-arrow--none" aria-hidden="true" />
        <button type="button" className="tt-addbtn tt-morebtn" title={`Mostra mais ${next}`} onClick={() => onMore(row.parentRef)} data-testid={`tree-more-${row.parentRef ?? "root"}`}>
          ver mais {row.remaining}
        </button>
      </div>
    </li>
  );
});

type NodeRowProps = {
  row: TreeNodeRow;
  /** Prazo resolvido com `now` apenas para as linhas visíveis. */
  due: DueInfo | null;
  project: Project;
  index: ProjectIndex;
  agents: ReadonlyMap<string, Agent>;
  workers: readonly Agent[];
  selected: boolean;
  picked: boolean;
  implied: boolean;
  showCheck: boolean;
  onPick: (ref: string) => void;
  dragging: boolean;
  dropVerdict: TreeVerdict | null;
  onDragStart: (ref: string, title: string, event: PointerEvent<HTMLLIElement>) => void;
  editable: boolean;
  canCreate: boolean;
  mobile: boolean;
  sprintColumn: boolean;
  renaming: boolean;
  actions: TaskActions;
  onSelect: (ref: string) => void;
  onToggle: (ref: string) => void;
  onRename: (ref: string, on: boolean) => void;
  /** `group`: o novo é um módulo (só dentro de módulo); sem ele, tarefa ou subtarefa. */
  onAddChild: (ref: string, isGroup: boolean, group?: boolean) => void;
  onMove: (ref: string) => void;
  onMoveSprint: (ref: string) => void;
  onCancel: (ref: string) => void;
  onConvert?: (ref: string) => void;
  /** Pede para apagar o item (quem chama abre a confirmação apropriada). */
  onDelete?: (ref: string) => void;
};

const sameStrings = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
};

const sameLabels = (a: readonly Label[] | undefined, b: readonly Label[] | undefined): boolean => {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.id !== b[i]!.id || a[i]!.name !== b[i]!.name || a[i]!.color !== b[i]!.color) return false;
  }
  return true;
};

const sameSprints = (a: readonly Sprint[] | undefined, b: readonly Sprint[] | undefined): boolean => {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.id !== b[i]!.id || a[i]!.name !== b[i]!.name || a[i]!.status !== b[i]!.status || a[i]!.startAt !== b[i]!.startAt || a[i]!.endAt !== b[i]!.endAt) return false;
  }
  return true;
};

const sameDue = (a: DueInfo | null, b: DueInfo | null): boolean =>
  a === b || (a !== null && b !== null && a.label === b.label && a.tone === b.tone && a.at === b.at && a.title === b.title);

const sameFlow = (a: FlowInfo | undefined, b: FlowInfo | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.kind === b.kind &&
    a.ownerId === b.ownerId &&
    a.ownerName === b.ownerName &&
    a.text === b.text &&
    a.summary === b.summary &&
    a.done === b.done &&
    a.total === b.total &&
    sameStrings(a.everyone, b.everyone));

const samePlannedWaits = (a: readonly PlannedWait[], b: readonly PlannedWait[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.ref !== b[i]!.ref || a[i]!.title !== b[i]!.title || a[i]!.container !== b[i]!.container || a[i]!.state !== b[i]!.state) return false;
  }
  return true;
};

const sameVerdict = (a: TreeVerdict | null, b: TreeVerdict | null): boolean => {
  if (a === b) return true;
  if (!a || !b || a.ok !== b.ok || a.zone !== b.zone || a.overRef !== b.overRef) return false;
  if (!a.ok && !b.ok) return a.reason === b.reason;
  return true;
};

/** Comparação por valor visível: uma atualização numa tarefa redesenha só as linhas afetadas, mesmo quando `project:upserted` recria os objetos. */
function areNodeRowPropsEqual(prev: NodeRowProps, next: NodeRowProps): boolean {
  if (
    prev.selected !== next.selected ||
    prev.picked !== next.picked ||
    prev.implied !== next.implied ||
    prev.showCheck !== next.showCheck ||
    prev.dragging !== next.dragging ||
    prev.editable !== next.editable ||
    prev.canCreate !== next.canCreate ||
    prev.mobile !== next.mobile ||
    prev.sprintColumn !== next.sprintColumn ||
    prev.renaming !== next.renaming ||
    prev.agents !== next.agents ||
    prev.workers !== next.workers ||
    prev.onSelect !== next.onSelect ||
    prev.onToggle !== next.onToggle ||
    prev.onPick !== next.onPick ||
    prev.onDragStart !== next.onDragStart ||
    prev.onRename !== next.onRename ||
    prev.onAddChild !== next.onAddChild ||
    prev.onMove !== next.onMove ||
    prev.onMoveSprint !== next.onMoveSprint ||
    prev.onCancel !== next.onCancel ||
    prev.onConvert !== next.onConvert ||
    prev.onDelete !== next.onDelete ||
    !sameDue(prev.due, next.due) ||
    !sameVerdict(prev.dropVerdict, next.dropVerdict)
  ) {
    return false;
  }
  const a = prev.row;
  const b = next.row;
  if (
    a.ref !== b.ref ||
    a.depth !== b.depth ||
    a.isGroup !== b.isGroup ||
    a.isContainer !== b.isContainer ||
    a.hasChildren !== b.hasChildren ||
    a.childCount !== b.childCount ||
    a.open !== b.open ||
    a.status !== b.status ||
    a.waits !== b.waits ||
    a.moreAssignees !== b.moreAssignees ||
    a.priority !== b.priority ||
    a.blocked !== b.blocked ||
    a.waiting !== b.waiting ||
    a.startsIn !== b.startsIn ||
    a.carried !== b.carried ||
    a.canAddChild !== b.canAddChild ||
    a.stepCount !== b.stepCount ||
    a.state.label !== b.state.label ||
    a.state.tone !== b.state.tone ||
    a.state.planned !== b.state.planned ||
    a.progress?.done !== b.progress?.done ||
    a.progress?.total !== b.progress?.total ||
    a.node.title !== b.node.title ||
    a.node.status !== b.node.status ||
    a.node.priority !== b.node.priority ||
    a.node.ownerId !== b.node.ownerId ||
    a.node.dueAt !== b.node.dueAt ||
    a.node.sprintId !== b.node.sprintId ||
    a.node.released !== b.node.released ||
    a.node.steps.length !== b.node.steps.length ||
    !sameStrings(a.assignees, b.assignees) ||
    !sameStrings(a.sprints, b.sprints) ||
    !sameStrings(a.trail, b.trail) ||
    !sameStrings(a.node.labels, b.node.labels) ||
    !sameLabels(a.labels, b.labels) ||
    !sameFlow(a.flow, b.flow) ||
    !samePlannedWaits(a.plannedWaits, b.plannedWaits)
  ) {
    return false;
  }
  if ((a.plannedWaits.length > 0 || b.plannedWaits.length > 0) && prev.actions.busy !== next.actions.busy) return false;
  if (prev.project.status !== next.project.status || prev.project.system !== next.project.system) return false;
  if (!sameLabels(prev.project.labels, next.project.labels)) return false;
  if (next.sprintColumn && !sameSprints(prev.project.sprints, next.project.sprints)) return false;
  return true;
}

const NodeRow = memo(function NodeRow({ row, due, project, index, agents, workers, selected, picked, implied, showCheck, onPick, dragging, dropVerdict, onDragStart, editable, canCreate, mobile, sprintColumn, renaming, actions, onSelect, onToggle, onRename, onAddChild, onMove, onMoveSprint, onCancel, onConvert, onDelete }: NodeRowProps) {
  const { node } = row;
  const cellRow: CellRow = useMemo(() => (row.due === due ? row : { ...row, due }), [row, due]);
  const leaf = !row.isGroup && !row.hasChildren;
  const editableCells = editable && leaf && !mobile;
  const parentLike = row.isContainer;
  const foldable = row.hasChildren || (row.stepCount ?? 0) > 0;
  const finished = isProjectTaskFinished(node) && leaf;
  const stop = (event: MouseEvent) => event.stopPropagation();
  const hasSub = Boolean(row.flow) || row.plannedWaits.length > 0 || (row.isContainer && Boolean(row.waits));
  const [nameRef, fitLevel] = useNameFit([node.title, row.labels.length, row.startsIn, row.carried, row.waiting, row.blocked, renaming], !mobile);

  const onKey = (event: KeyboardEvent<HTMLLIElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(row.ref);
    } else if (event.key === "ArrowRight" && foldable && !row.open) onToggle(row.ref);
    else if (event.key === "ArrowLeft" && foldable && row.open) onToggle(row.ref);
  };

  return (
    <li
      className={`tt-row${row.isGroup ? " tt-row--group" : parentLike ? " tt-row--parent" : ""}${row.flow ? " tt-row--flow" : hasSub ? " tt-row--waits" : ""}${selected ? " is-selected" : ""}${picked || implied ? " is-picked" : ""}${finished || row.status === "concluida" ? " is-done" : ""}${dragging ? " is-dragging" : ""}${dropVerdict ? ` tt-drop tt-drop--${dropVerdict.zone}${dropVerdict.ok ? "" : dropVerdict.reason ? " tt-drop--no" : " tt-drop--same"}` : ""}`}
      role="treeitem"
      style={levelStyle(row.depth, mobile)}
      aria-level={row.depth}
      aria-expanded={foldable ? row.open : undefined}
      aria-selected={selected}
      tabIndex={0}
      data-testid={`tree-row-${row.ref}`}
      data-ref={row.ref}
      data-status={row.status}
      data-state={row.state.tone}
      data-depth={row.depth}
      onClick={() => onSelect(row.ref)}
      onKeyDown={onKey}
      onPointerDown={(event) => onDragStart(row.ref, node.title, event)}
    >
      <div className="tt-name" ref={nameRef} data-fit={fitLevel}>
        {mobile && row.depth > MOBILE_INDENT_LEVELS && row.trail.length > 0 && (
          <span className="tt-path" title={pathText(row.trail)} data-testid={`tree-path-${row.ref}`}>
            {pathText(row.trail)}
          </span>
        )}
        {showCheck && (
          <label className="tt-check" onClick={stop} onPointerDown={(event) => event.stopPropagation()} title={implied ? "Incluída no módulo selecionado" : `Selecionar ${node.title}`}>
            <input
              type="checkbox"
              checked={picked || implied}
              disabled={implied}
              aria-label={`Selecionar ${node.title}`}
              onChange={() => onPick(row.ref)}
              data-testid={`tree-pick-${row.ref}`}
            />
          </label>
        )}
        {foldable ? (
          <button
            type="button"
            className="tt-arrow"
            aria-label={`${row.open ? "Fechar" : "Abrir"} ${node.title}`}
            aria-expanded={row.open}
            onClick={(event) => {
              stop(event);
              onToggle(row.ref);
            }}
            data-testid={`tree-toggle-${row.ref}`}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" style={{ transform: row.open ? "rotate(90deg)" : undefined }}>
              <path d="M4 2l5 4-5 4z" />
            </svg>
          </button>
        ) : (
          <span className="tt-arrow tt-arrow--none" aria-hidden="true" />
        )}
        <StatusIcon status={row.status} planned={row.state.planned} label={row.state.label} />
        {sprintColumn && (row.state.planned || row.state.label === "Misto") && <StateChip state={row.state} compact testId={`tree-release-chip-${row.ref}`} />}
        {renaming ? (
          <RenameInput
            value={node.title}
            onDone={(title) => {
              onRename(row.ref, false);
              if (title && title !== node.title) void actions.update(row.ref, { title });
            }}
          />
        ) : (
          <span className="tt-title" onDoubleClick={editable && !mobile ? (event) => (stop(event), onRename(row.ref, true)) : undefined} title={node.title} data-testid={`tree-title-${row.ref}`}>
            {node.title}
          </span>
        )}
        {parentLike && row.childCount > 0 && (
          <span className={`tt-count${row.progress && row.progress.total > 0 && row.progress.done >= row.progress.total ? " tt-count--done" : ""}`} title={row.progress && row.progress.total > 0 ? `${row.progress.done} de ${row.progress.total} ${row.progress.total === 1 ? "atividade concluída" : "atividades concluídas"}` : `${row.childCount} dentro`} data-testid={`tree-count-${row.ref}`}>
            {row.progress && row.progress.total > 0 ? `${row.progress.done}/${row.progress.total}` : row.childCount}
          </span>
        )}
        {row.startsIn && fitLevel < 1 && (
          <span className="tt-tag tt-tag--soon" title="A sprint dela ainda não começou: o agente só começa quando ela abrir" data-testid={`tree-startsin-${row.ref}`}>
            {row.startsIn}
          </span>
        )}
        {row.carried && fitLevel < 1 && (
          <span className="tt-tag tt-tag--carried" title="Não ficou pronta na sprint anterior e passou para esta" data-testid={`tree-carried-${row.ref}`}>
            ↩ {row.carried}
          </span>
        )}
        <LabelsCell row={row} project={project} actions={actions} interactive={editable && !mobile && !row.isGroup} level={fitLevel} />
        {editable && canCreate && !mobile && !row.isGroup && row.canAddChild && (
          <button
            type="button"
            className="tt-subbtn"
            onClick={(event) => {
              event.stopPropagation();
              onAddChild(row.ref, row.isGroup);
            }}
            aria-label={`Adicionar subtarefa em ${row.node.title}`}
            data-testid={`tree-quick-sub-${row.ref}`}
          >
            + subtarefa
          </button>
        )}
        {row.waiting > 0 && (
          <span className="tt-badge tt-badge--wait" title={`${row.waiting} esperando você`}>
            Espera você
          </span>
        )}
        {row.blocked && (
          <span className="tt-badge tt-badge--block" title="Parada: sem cota, sem acesso ou esperando outro agente">
            Parada
          </span>
        )}
      </div>

      <div className="tt-cells" onClick={editableCellsClick(editableCells, stop)}>
        <div className="tt-cell tt-cell--resp" data-testid={`tree-resp-${row.ref}`}>
          {editableCells ? (
            <AssigneeCell row={cellRow} agents={agents} workers={workers} actions={actions} />
          ) : (
            row.assignees.length === 0 && parentLike ? <span className="tt-none">—</span> : <AvatarStack ids={row.assignees} more={row.moreAssignees} agents={agents} />
          )}
        </div>
        <div className={`tt-cell tt-cell--due${due ? ` tt-cell--${due.tone}` : ""}`} data-testid={`tree-due-${row.ref}`}>
          {editableCells ? (
            <DueCell row={cellRow} actions={actions} />
          ) : due ? (
            <span className="tt-due" title={due.title}>
              {due.label}
            </span>
          ) : (
            <span className="tt-none">—</span>
          )}
        </div>
        <div className="tt-cell tt-cell--prio" data-testid={`tree-prio-${row.ref}`}>
          {editableCells ? <PrioCell row={cellRow} actions={actions} /> : row.priority ? <PriorityFlag priority={row.priority} /> : <span className="tt-none">—</span>}
        </div>
        {sprintColumn ? (
          <div className="tt-cell tt-cell--sprint" data-testid={`tree-sprint-${row.ref}`}>
            {editableCells ? (
              <SprintCell row={cellRow} project={project} actions={actions} />
            ) : row.sprints.length > 0 ? (
              <span className="tt-sprint">{row.sprints.length === 1 ? row.sprints[0] : `${row.sprints[0]}–${row.sprints.at(-1)}`}</span>
            ) : (
              <span className="tt-none">—</span>
            )}
          </div>
        ) : (
          <div className="tt-cell tt-cell--state" data-testid={`tree-state-${row.ref}`}>
            <StateChip state={row.state} />
          </div>
        )}
      </div>

      <div className="tt-more" onClick={stop}>
        <RowMenu
          row={row}
          project={project}
          index={index}
          editable={editable}
          canCreate={canCreate}
          actions={actions}
          onRename={() => onRename(row.ref, true)}
          onAddChild={(group) => onAddChild(row.ref, row.isGroup, group)}
          onMove={() => onMove(row.ref)}
          onMoveSprint={() => onMoveSprint(row.ref)}
          hasSprints={sprintColumn}
          onCancel={() => onCancel(row.ref)}
          onOpen={() => onSelect(row.ref)}
          {...(onConvert ? { onConvert } : {})}
          {...(onDelete ? { onDelete } : {})}
        />
      </div>

      {hasSub && (
        <div className="tt-sub">
          {row.flow && <FlowLine flow={row.flow} agents={agents} refId={row.ref} {...(row.isContainer && row.waits && row.plannedWaits.length === 0 ? { waits: row.waits } : {})} />}
          {!row.flow && row.isContainer && row.waits && row.plannedWaits.length === 0 && (
            <div className="tt-flow tt-flow--waits" data-testid={`tree-waits-${row.ref}`}>
              <span className="tt-flow__text tt-flow__text--wait">{row.waits}</span>
            </div>
          )}
          {row.plannedWaits.length > 0 && (
            <div className="tt-flow tt-flow--planned" onClick={stop} onPointerDown={(event) => event.stopPropagation()} data-testid={`tree-planned-wait-${row.ref}`}>
              <span className="tt-flow__text tt-flow__text--planned">{plannedWaitText(row.plannedWaits)}</span>
              {editable && (
                <button
                  type="button"
                  className="tt-release-inline"
                  disabled={actions.busy}
                  onClick={() => void actions.release({ refs: row.plannedWaits.map((item) => item.ref) })}
                  data-testid={`tree-release-wait-${row.ref}`}
                >
                  {plannedWaitButton(row.plannedWaits)}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}, areNodeRowPropsEqual);

/** A linha de fluxo debaixo do nome: subtarefa = avatar, nome e o que espera; tarefa-mãe = todos os responsáveis e o resumo. */
function FlowLine({ flow, agents, refId, waits }: { flow: FlowInfo; agents: ReadonlyMap<string, Agent>; refId: string; waits?: string }) {
  if (flow.kind === "mother") {
    const total = flow.total ?? 0;
    const done = flow.done ?? 0;
    const allDone = total > 0 && done >= total;
    return (
      <div className={`tt-flow tt-flow--mother${allDone ? " tt-flow--done" : ""}`} data-testid={`tree-flow-${refId}`}>
        {total > 0 && (
          <span className="tt-meter" role="img" aria-label={`${done} de ${total} prontas`}>
            <span className="tt-meter__fill" style={{ width: `${Math.round((done / total) * 100)}%` }} />
          </span>
        )}
        {(flow.everyone?.length ?? 0) > 0 && <AvatarStack ids={flow.everyone ?? []} more={0} agents={agents} />}
        {allDone && (
          <svg className="tt-flow__check" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        <span className="tt-flow__text">{allDone ? "Tudo pronto" : flow.summary}</span>
        {waits && (
          <span className="tt-flow__text tt-flow__text--wait" data-testid={`tree-waits-${refId}`}>
            {waits}
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="tt-flow" data-testid={`tree-flow-${refId}`}>
      {flow.ownerId ? (
        <span className="tt-flow__who">
          <AgentAvatar agent={agents.get(flow.ownerId)} size={18} />
          <b>{flow.ownerName}</b>
        </span>
      ) : (
        <span className="tt-flow__who tt-flow__who--none">sem responsável</span>
      )}
      {flow.text && <span className={`tt-flow__text${flow.text === "entregou" ? " tt-flow__text--done" : ""}`}>{flow.text === "entregou" ? "✓ entregou" : flow.text}</span>}
    </div>
  );
}

/** Um passo de tarefa antiga (`steps`): só leitura, marcado como passo, com o agente, o que faz e o que espera. */
const StepRow = memo(function StepRow({ row, agents, mobile }: { row: TreeStepRow; agents: ReadonlyMap<string, Agent>; mobile: boolean }) {
  const agent = agents.get(row.agentId);
  return (
    <li className={`tt-row tt-row--step${row.status === "concluida" ? " is-done" : ""}`} style={levelStyle(row.depth, mobile)} role="treeitem" aria-level={row.depth} data-testid={`tree-step-${row.parentRef}-${row.index}`} data-status={row.status}>
      <div className="tt-name">
        <span className="tt-arrow tt-arrow--none" aria-hidden="true" />
        <StatusIcon status={row.status} />
        <span className="tt-tag tt-tag--step" title="Passo da tarefa (formato antigo): só leitura">
          passo {row.index + 1}/{row.total}
        </span>
        <span className="tt-title" title={row.what}>
          {row.what}
        </span>
      </div>
      <div className="tt-flow">
        <span className="tt-flow__who">
          <AgentAvatar agent={agent} size={18} />
          <b>{agent?.name ?? row.agentId}</b>
        </span>
        <span className="tt-flow__text">{row.text}</span>
      </div>
    </li>
  );
});

/** Em cada coluna editável, o clique não abre o painel (só o do botão da coluna conta). */
const editableCellsClick = (editable: boolean, stop: (event: MouseEvent) => void) => (editable ? stop : undefined);

function RenameInput({ value, onDone }: { value: string; onDone: (title: string) => void }) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(save ? text.trim() : "");
  };
  return (
    <input
      ref={ref}
      className="tt-input"
      value={text}
      aria-label="Nome da tarefa"
      maxLength={120}
      autoFocus
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setText(event.currentTarget.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(true);
        else if (event.key === "Escape") finish(false);
      }}
      data-testid="tree-rename-input"
    />
  );
}

export function AssigneeCell({ row, agents, workers, actions }: { row: CellRow; agents: ReadonlyMap<string, Agent>; workers: readonly Agent[]; actions: CellActions }) {
  const locked = started(row);
  const current = row.node.ownerId;
  return (
    <Popover
      label="Responsável"
      testId={`tree-assignee-pop-${row.ref}`}
      anchor={({ toggle, ref, open }) => (
        <button type="button" ref={ref} className="tt-cellbtn" aria-haspopup="dialog" aria-expanded={open} onClick={toggle} aria-label={`Responsável de ${row.node.title}`}>
          <AvatarStack ids={row.assignees} more={row.moreAssignees} agents={agents} />
        </button>
      )}
    >
      {(close) =>
        locked ? (
          <p className="tt-pop__note">A tarefa já começou: o responsável não muda. Para trocar, cancele e crie de novo.</p>
        ) : (
          <ul className="tt-pop__list">
            <li>
              <button type="button" className={`tt-pop__item${current === "" ? " is-on" : ""}`} onClick={() => void actions.update(row.ref, { assignee: null }).then(close)}>
                <span className="tt-nobody" aria-hidden="true" />
                Sem responsável
              </button>
            </li>
            {workers.map((agent) => (
              <li key={agent.id}>
                <button type="button" className={`tt-pop__item${current === agent.id ? " is-on" : ""}`} onClick={() => void actions.update(row.ref, { assignee: agent.id }).then(close)} data-testid={`tree-assign-${agent.id}`}>
                  <AgentAvatar agent={agent} />
                  <span>{agent.name}</span>
                  <small>{agent.role}</small>
                </button>
              </li>
            ))}
          </ul>
        )
      }
    </Popover>
  );
}

export function DueCell({ row, actions }: { row: CellRow; actions: CellActions }) {
  return (
    <Popover
      label="Data"
      testId={`tree-due-pop-${row.ref}`}
      anchor={({ toggle, ref, open }) => (
        <button type="button" ref={ref} className="tt-cellbtn tt-cellbtn--text" aria-haspopup="dialog" aria-expanded={open} onClick={toggle} aria-label={`Prazo de ${row.node.title}`}>
          {row.due ? <span className="tt-due" title={row.due.title}>{row.due.label}</span> : <span className="tt-none tt-none--add">+ Data</span>}
        </button>
      )}
    >
      {(close) => <DueForm value={row.node.dueAt} onSave={(iso) => void actions.update(row.ref, { dueAt: iso }).then(close)} />}
    </Popover>
  );
}

/** Formulário de prazo (Brasília): salvar e limpar. */
export function DueForm({ value, onSave, label = true }: { value: string | undefined; onSave: (iso: string | null) => void; label?: boolean }) {
  const [text, setText] = useState(toBrasiliaInput(value));
  return (
    <form
      className="tt-pop__form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(fromBrasiliaInput(text));
      }}
    >
      <label className="tt-pop__label">
        {label ? `Prazo${brasiliaNote()}` : <span className="sr-only">Prazo</span>}
        <input className="ui-input ui-input--compact" type="datetime-local" value={text} onChange={(event) => setText(event.currentTarget.value)} data-testid="tree-due-input" />
      </label>
      <div className="tt-pop__actions">
        {value && (
          <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={() => onSave(null)}>
            Limpar
          </button>
        )}
        <span className="w-grow" />
        <button type="submit" className="ui-button ui-button--small" disabled={!fromBrasiliaInput(text)} data-testid="tree-due-save">
          Salvar
        </button>
      </div>
    </form>
  );
}

export function PrioCell({ row, actions }: { row: CellRow; actions: CellActions }) {
  return (
    <Popover
      label="Prioridade"
      testId={`tree-prio-pop-${row.ref}`}
      anchor={({ toggle, ref, open }) => (
        <button type="button" ref={ref} className="tt-cellbtn tt-cellbtn--text" aria-haspopup="dialog" aria-expanded={open} onClick={toggle} aria-label={`Prioridade de ${row.node.title}`}>
          <PriorityFlag priority={row.node.priority} />
        </button>
      )}
    >
      {(close) => (
        <ul className="tt-pop__list">
          {PROJECT_PRIORITIES.map((priority: ProjectPriority) => (
            <li key={priority}>
              <button type="button" className={`tt-pop__item${row.node.priority === priority ? " is-on" : ""}`} onClick={() => void actions.update(row.ref, { priority }).then(close)} data-testid={`tree-set-prio-${priority}`}>
                <PriorityFlag priority={priority} label={false} />
                {PROJECT_PRIORITY_LABELS[priority]}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
}

/** As etiquetas da linha: duas, uma ou nenhuma (conforme o nível de encaixe); o que fica de fora vira "+N". */
function labelPills(row: TreeNodeRow, level: number) {
  const names = row.labels.map((label) => label.name);
  const shown = level >= 3 ? 0 : level === 2 ? 1 : 2;
  const rest = names.slice(shown);
  return [
    ...row.labels.slice(0, shown).map((label) => (
      <span key={label.id} className={`tt-label tt-label--${label.color}`} title={`Etiqueta: ${label.name}`}>
        {label.name}
      </span>
    )),
    ...(rest.length > 0 ? [<span key="more" className="tt-labelmore" title={`${shown > 0 ? "Mais etiquetas" : "Etiquetas"}: ${rest.join(", ")}`}>+{rest.length}</span>] : []),
  ];
}

function LabelsCell({ row, project, actions, interactive, level }: { row: TreeNodeRow; project: Project; actions: TaskActions; interactive: boolean; level: number }) {
  const pills = labelPills(row, level);
  if (!interactive) return <>{pills}</>;
  return (
    <Popover
      label="Etiquetas"
      testId={`tree-labels-pop-${row.ref}`}
      anchor={({ toggle, ref, open }) => (
        <button
          type="button"
          ref={ref}
          className={`tt-labelbtn${pills.length === 0 ? " tt-labelbtn--empty" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Etiquetas de ${row.node.title}`}
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
          data-testid={`tree-labels-${row.ref}`}
        >
          {pills}
          {pills.length === 0 && <span className="tt-labelbtn__add">+ etiqueta</span>}
        </button>
      )}
    >
      {() => <LabelsForm row={row} project={project} actions={actions} />}
    </Popover>
  );
}

/** Lista as etiquetas do projeto (marcar e desmarcar) e cria uma nova pelo nome. */
export function LabelsForm({ row, project, actions }: { row: Pick<TreeNodeRow, "ref" | "node">; project: Project; actions: TaskActions }) {
  const [name, setName] = useState("");
  const mine = row.node.labels ?? [];
  const toggle = (id: string) => void actions.update(row.ref, { labels: mine.includes(id) ? mine.filter((item) => item !== id) : [...mine, id] });
  return (
    <div className="tt-pop__form">
      {(project.labels ?? []).length > 0 && (
        <ul className="tt-pop__list">
          {(project.labels ?? []).map((label) => (
            <li key={label.id}>
              <label className="tt-pop__item">
                <input type="checkbox" checked={mine.includes(label.id)} onChange={() => toggle(label.id)} />
                <span className={`tt-label tt-label--${label.color}`}>{label.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <form
        className="tt-pop__new"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          void actions.label(row.ref, name.trim()).then((ok) => ok && setName(""));
        }}
      >
        <input className="ui-input ui-input--compact" value={name} maxLength={24} placeholder="Nova etiqueta" aria-label="Nome da nova etiqueta" onChange={(event) => setName(event.currentTarget.value)} data-testid="tree-label-new" />
        <button type="submit" className="ui-button ui-button--small" disabled={!name.trim()}>
          Criar
        </button>
      </form>
    </div>
  );
}

type MenuProps = {
  row: TreeNodeRow;
  project: Project;
  index: ProjectIndex;
  editable: boolean;
  canCreate: boolean;
  actions: TaskActions;
  onRename: () => void;
  onAddChild: (group?: boolean) => void;
  onMove: () => void;
  onMoveSprint: () => void;
  hasSprints: boolean;
  onCancel: () => void;
  onOpen: () => void;
  onConvert?: (ref: string) => void;
  /** Pede para apagar o item (quem chama abre a confirmação apropriada). */
  onDelete?: (ref: string) => void;
};

function RowMenu({ row, project, index, editable, canCreate, actions, onRename, onAddChild, onMove, onMoveSprint, hasSprints, onCancel, onOpen, onConvert, onDelete }: MenuProps) {
  const done = row.status === "concluida" || row.status === "cancelada";
  const item = (label: string, run: () => void, close: () => void, testId?: string, danger = false) => (
    <li key={label} role="none">
      <button
        type="button"
        role="menuitem"
        className={`tt-pop__item${danger ? " tt-pop__item--danger" : ""}`}
        onClick={() => {
          close();
          run();
        }}
        {...(testId ? { "data-testid": testId } : {})}
      >
        {label}
      </button>
    </li>
  );
  return (
    <Popover
      label={`Ações de ${row.node.title}`}
      align="end"
      testId={`tree-menu-${row.ref}`}
      anchor={({ toggle, ref, open }) => (
        <button type="button" ref={ref} className="tt-kebab" aria-haspopup="menu" aria-expanded={open} aria-label={`Ações de ${row.node.title}`} onClick={toggle} data-testid={`tree-kebab-${row.ref}`}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <circle cx="8" cy="3" r="1.4" />
            <circle cx="8" cy="8" r="1.4" />
            <circle cx="8" cy="13" r="1.4" />
          </svg>
        </button>
      )}
    >
      {(close) => {
        // Só calcula os itens de liberação quando o dono realmente abre o menu da linha (evita custo por linha fechada).
        const releaseItems = editable && canCreate ? releaseMenu(project, row.node, index) : [];
        return (
          <ul className="tt-pop__list" role="menu">
            {item("Abrir detalhes", onOpen, close)}
            {releaseItems.map((entry) =>
              item(
                entry.label,
                () => {
                  if (entry.id === "release") void actions.release({ refs: [row.ref] });
                  else if (entry.id === "release_with") void actions.release({ refs: [row.ref], withPrerequisites: true });
                  else void actions.hold([row.ref]);
                },
                close,
                entry.id === "release" ? `tree-release-${row.ref}` : entry.id === "release_with" ? `tree-release-with-${row.ref}` : `tree-hold-${row.ref}`,
              ),
            )}
            {editable && canCreate && row.canAddChild && item(row.isGroup ? "Adicionar tarefa" : "Adicionar subtarefa", () => onAddChild(), close, `tree-add-child-${row.ref}`)}
            {editable && canCreate && row.canAddChild && row.isGroup && item("Adicionar módulo", () => onAddChild(true), close, `tree-add-module-${row.ref}`)}
            {editable && item("Renomear", onRename, close)}
            {editable && canCreate && item("Mover para…", onMove, close, `tree-move-${row.ref}`)}
            {editable && canCreate && hasSprints && !row.isGroup && !row.hasChildren && !done && item("Mover para sprint…", onMoveSprint, close, `tree-move-sprint-${row.ref}`)}
            {editable && canCreate && item("Subir", () => void actions.move(row.ref, { step: "up" }), close)}
            {editable && canCreate && item("Descer", () => void actions.move(row.ref, { step: "down" }), close)}
            {editable && canCreate && item("Duplicar", () => void actions.duplicate(row.ref), close, `tree-duplicate-${row.ref}`)}
            {editable && onConvert && !row.isGroup && !row.hasChildren && !done && item("Transformar em projeto", () => onConvert(row.ref), close, `tree-convert-${row.ref}`)}
            {editable && !done && item("Cancelar", onCancel, close, `tree-cancel-${row.ref}`, true)}
            {done && item("Arquivar", () => void actions.archive(row.ref), close, `tree-archive-${row.ref}`)}
            {onDelete && canDeleteTaskNode(project, row.node) && item("Apagar", () => onDelete(row.ref), close, `tree-delete-${row.ref}`, true)}
          </ul>
        );
      }}
    </Popover>
  );
}

type AddRowProps = {
  row: TreeAddRow;
  mobile: boolean;
  active: boolean;
  group: boolean;
  onStart: (parentRef: string | undefined, group: boolean) => void;
  onStop: () => void;
  onCreate: (parentRef: string | undefined, title: string, group: boolean) => Promise<boolean>;
};

/** "Adicionar tarefa" no fim de cada nível: Enter cria e deixa o campo pronto para a próxima; Esc fecha. */
const AddRow = memo(function AddRow({ row, mobile, active, group, onStart, onStop, onCreate }: AddRowProps) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (active) input.current?.focus();
  }, [active]);
  const submit = async () => {
    const title = text.trim();
    if (!title || saving) return;
    setSaving(true);
    const ok = await onCreate(row.parentRef, title, group);
    setSaving(false);
    if (ok) {
      setText("");
      input.current?.focus();
    }
  };
  const noun = group ? "módulo" : row.parentRef ? (row.label === "Adicionar tarefa" ? "tarefa" : "subtarefa") : "tarefa";
  const article = noun === "módulo" ? "o" : "a";
  return (
    <li className="tt-row tt-row--add" style={levelStyle(row.depth, mobile)} role="none" data-testid={`tree-${row.key}`}>
      <div className="tt-name">
        <span className="tt-arrow tt-arrow--none" aria-hidden="true" />
        {active ? (
          <input
            ref={input}
            className="tt-input tt-input--add"
            value={text}
            placeholder={`Nome d${article} ${noun} (Enter cria, Esc fecha)`}
            aria-label={`Nome d${article} nov${article} ${noun}`}
            maxLength={120}
            readOnly={saving}
            onChange={(event) => setText(event.currentTarget.value)}
            onBlur={() => {
              if (!text.trim()) onStop();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              } else if (event.key === "Escape") onStop();
            }}
            data-testid={`tree-add-input-${row.parentRef ?? "root"}`}
          />
        ) : row.both ? (
          <span className="tt-add">
            <button type="button" className="tt-addbtn" onClick={() => onStart(row.parentRef, true)} data-testid={row.root ? "tree-add-group" : `tree-add-module-${row.parentRef}`}>
              + Módulo
            </button>
            <button type="button" className="tt-addbtn" onClick={() => onStart(row.parentRef, false)} data-testid={row.root ? "tree-add-task" : `tree-add-${row.parentRef}`}>
              + Tarefa
            </button>
          </span>
        ) : (
          <button type="button" className="tt-addbtn" onClick={() => onStart(row.parentRef, false)} data-testid={`tree-add-${row.parentRef}`}>
            + {row.label}
          </button>
        )}
      </div>
    </li>
  );
});

/** A coluna Sprint de uma folha: o chip da sprint abre a lista das sprints do projeto (e "sem sprint"). */
export function SprintCell({ row, project, actions }: { row: CellRow; project: Project; actions: CellActions }) {
  const current = row.node.sprintId;
  const chosen = project.sprints?.find((sprint) => sprint.id === current);
  const finished = row.status === "concluida" || row.status === "cancelada";
  return (
    <Popover
      label="Sprint"
      testId={`tree-sprint-pop-${row.ref}`}
      anchor={({ toggle, ref, open }) => (
        <button type="button" ref={ref} className="tt-cellbtn tt-cellbtn--text" aria-haspopup="dialog" aria-expanded={open} onClick={toggle} aria-label={`Sprint de ${row.node.title}`} title={chosen ? `${chosen.name} · ${sprintRange(chosen)}` : "Sem sprint"}>
          {current ? <span className="tt-sprint">{row.carried ? "↩ " : ""}{current}</span> : <span className="tt-none tt-none--add">+ Sprint</span>}
        </button>
      )}
    >
      {(close) =>
        finished ? (
          <p className="tt-pop__note">A tarefa já terminou: ela fica na sprint em que terminou.</p>
        ) : (
          <ul className="tt-pop__list">
            <li>
              <button type="button" className={`tt-pop__item${!current ? " is-on" : ""}`} onClick={() => void actions.move(row.ref, { sprintId: null }).then(close)} data-testid="tree-sprint-none">
                Sem sprint
              </button>
            </li>
            {openSprints(project).map((sprint) => (
              <li key={sprint.id}>
                <button type="button" className={`tt-pop__item${current === sprint.id ? " is-on" : ""}`} onClick={() => void actions.move(row.ref, { sprintId: sprint.id }).then(close)} data-testid={`tree-sprint-${sprint.id}`}>
                  <span className="tt-sprint">{sprint.id}</span>
                  <span>{shortSprintName(sprint.name)}</span>
                  <small>{sprintRange(sprint)}</small>
                </button>
              </li>
            ))}
          </ul>
        )
      }
    </Popover>
  );
}

/** "Mover para sprint…" (menu da linha): a lista das sprints que ainda aceitam tarefa. */
function MoveSprintDialog({ project, row, actions, onClose }: { project: Project; row: TreeNodeRow; actions: TaskActions; onClose: () => void }) {
  const sprints = openSprints(project);
  const [choice, setChoice] = useState<string | null | undefined>(undefined);
  return (
    <Modal title={`Mandar “${row.node.title}” para uma sprint`} onClose={onClose} testId="tree-move-sprint-dialog">
      <ul className="tt-targets" role="radiogroup" aria-label="Sprint">
        <li>
          <label className="tt-target">
            <input type="radio" name="move-sprint" checked={choice === null} onChange={() => setChoice(null)} data-testid="tree-move-to-nosprint" />
            <span>Sem sprint (o agente não começa até ela ganhar uma)</span>
          </label>
        </li>
        {sprints.map((sprint) => (
          <li key={sprint.id}>
            <label className="tt-target">
              <input type="radio" name="move-sprint" checked={choice === sprint.id} onChange={() => setChoice(sprint.id)} data-testid={`tree-move-to-sprint-${sprint.id}`} />
              <span>
                {sprint.name} <small className="ui-muted">· {sprintRange(sprint)}{sprint.status === "ativa" ? " · ativa" : ""}</small>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <ErrorText>{actions.error}</ErrorText>
      <div className="ui-actions">
        <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
          Fechar
        </button>
        <button type="button" className="ui-button" disabled={choice === undefined || actions.busy} onClick={() => void actions.move(row.ref, { sprintId: choice ?? null }).then((ok) => ok && onClose())} data-testid="tree-move-sprint-confirm">
          {actions.busy ? "Movendo…" : "Mover"}
        </button>
      </div>
    </Modal>
  );
}

/** Quantos destinos a janela "Mover para…" desenha de uma vez (a busca afunila o resto). */
const MOVE_SHOWN = 60;

/** "Mover para…": busca pelo nome ou pelo caminho. Sem busca só os módulos e itens que já têm filhas; buscando, qualquer destino. */
function MoveDialog({ project, index, row, actions, onClose, onMoved }: { project: Project; index: ProjectIndex; row: TreeNodeRow; actions: TaskActions; onClose: () => void; onMoved: (parent: string | null) => void }) {
  const targets = useMemo(() => moveTargets(project, row.ref, index), [project, row.ref, index]);
  const [choice, setChoice] = useState<string | null | undefined>(undefined);
  const [query, setQuery] = useState("");
  const needle = normalizeText(query.trim());
  const small = targets.length <= 8;
  const listed = useMemo(() => (needle ? targets.filter((target) => normalizeText(`${target.label} ${target.path}`).includes(needle)) : small ? targets : targets.filter((target) => target.container)), [targets, needle, small]);
  const visible = listed.slice(0, MOVE_SHOWN);
  return (
    <Modal title={`Mover “${row.node.title}” para…`} onClose={onClose} testId="tree-move-dialog">
      {targets.length === 0 ? (
        <p>Não há outro lugar para mover: os destinos que sobram estão dentro dela mesma, esperam o que ela contém ou já começaram.</p>
      ) : (
        <>
          {!small && (
            <input
              className="ui-input"
              type="search"
              value={query}
              placeholder="Buscar módulo ou tarefa"
              aria-label="Buscar o destino"
              autoFocus
              onChange={(event) => setQuery(event.currentTarget.value)}
              data-testid="tree-move-search"
            />
          )}
          {visible.length === 0 ? (
            <p className="ui-muted">Nenhum destino com esse nome.</p>
          ) : (
            <ul className="tt-targets" role="radiogroup" aria-label="Destino">
              {visible.map((target) => (
                <li key={target.ref ?? "root"} style={{ paddingLeft: needle ? 0 : `${Math.min(target.depth, 6) * 16}px` }}>
                  <label className="tt-target">
                    <input type="radio" name="move-target" checked={choice === target.ref} onChange={() => setChoice(target.ref)} data-testid={`tree-move-to-${target.ref ?? "root"}`} />
                    <span>
                      {target.label}
                      {needle && target.path ? <small className="ui-muted"> · {target.path}</small> : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {listed.length > visible.length && <p className="ui-muted tt-targets__more">Mostrando {visible.length} de {listed.length}: busque pelo nome para achar o resto.</p>}
          {!needle && !small && targets.some((target) => !target.container) && <p className="ui-muted tt-targets__more">Só aparecem módulos e itens com subtarefas. Busque pelo nome para escolher uma tarefa.</p>}
        </>
      )}
      <ErrorText>{actions.error}</ErrorText>
      <div className="ui-actions">
        <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
          Fechar
        </button>
        <button
          type="button"
          className="ui-button"
          disabled={choice === undefined || actions.busy}
          onClick={() =>
            void actions.move(row.ref, { parent: choice ?? null }).then((ok) => {
              if (!ok) return;
              onMoved(choice ?? null);
              onClose();
            })
          }
          data-testid="tree-move-confirm"
        >
          {actions.busy ? "Movendo…" : "Mover"}
        </button>
      </div>
    </Modal>
  );
}
