import { findMaestroAgent, forYouArchiveMonth, forYouKind, forYouOriginalText, type ForYouDecisionStatus, type ForYouItem, type OfficeState } from "@cyno/shared";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, describeError } from "../../api/client";
import { useForYouFocus } from "../../store/forYouFocus";
import { useForYouTypesSheet } from "../../store/forYouTypesSheet";
import { useWorkStore } from "../../store/workStore";
import { groupByRequest, waitingLabel } from "../work/planView";
import { RoutineCard } from "./RoutineCard";
import { PlanItemCard, QuestionnaireCard } from "./SpecialCards";
import { OrganizeCard } from "./OrganizeCard";
import { RuleCard } from "./RuleCard";
import { SprintCard } from "./SprintCard";
import { ForYouTypesSheet } from "./ForYouTypesSheet";
import { ForYouCard, type DecisionValues } from "./ForYouCard";
import { ForYouRow } from "./ForYouRow";
import { ForYouSidebar } from "./ForYouSidebar";
import { ArchiveBlock, hasArchive } from "./ArchiveBlock";
import { useForYouArchive } from "./useForYouArchive";
import {
  batchLabel,
  batchOf,
  DONE_LABELS,
  inlineRequestLabel,
  pruneDrafts,
  showGroupHeader,
  statusCounts,
  statusGroup,
  sections,
  STATUS_VIEW_LABELS,
  stepIndex,
  typeDisplay,
  updateBadge,
  visibleItems,
  type CardDraft,
  type StatusView,
  type TypeFilter,
  type TypeList,
} from "./forYouView";
import { Icon } from "./icons";
import { ToastStack, useToasts } from "./Toasts";

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = (() => {
      try {
        return document.execCommand("copy");
      } catch {
        return false;
      }
    })();
    area.remove();
    return ok;
  }
}

/** Celular: lista e detalhe viram duas telas (lista → detalhe, com botão de voltar). */
const MOBILE_QUERY = "(max-width: 767px)";
function useIsMobile(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(MOBILE_QUERY);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  );
}

const isTyping = (element: Element | null) => element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement;

type ForYouBoardProps = { items: readonly ForYouItem[]; types: TypeList; office: OfficeState | null };

/**
 * Lateral e lista de cards. Os textos editados ficam aqui (rascunhos por item) até a decisão,
 * então os eventos do WebSocket redesenham a lista sem perder o que o usuário digitou.
 */
export function ForYouBoard({ items, types, office }: ForYouBoardProps) {
  const [status, setStatus] = useState<StatusView>("todos");
  const [type, setType] = useState<TypeFilter>("todos");
  const [drafts, setDrafts] = useState<Record<string, CardDraft>>({});
  const { toasts, push, dismiss } = useToasts();
  const cards = useRef(new Map<string, HTMLElement>());
  /** Depois de decidir, o foco vai para o card que ficou nesta posição (para seguir no teclado). */
  const focusIndexAfter = useRef<number | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  /** Item aberto no detalhe (null = o primeiro da lista, no computador) e, no celular, se o detalhe está na tela. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const rows = useRef(new Map<string, HTMLElement>());
  const [lastIndex, setLastIndex] = useState(0);
  const mobile = useIsMobile();
  const requestedId = useForYouFocus((state) => state.itemId);
  const typesOpen = useForYouTypesSheet((state) => state.open);
  // "Mais antigos": o arquivo das decididas fica em estado local desta página (nunca no store global).
  const archive = useForYouArchive();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveMonth, setArchiveMonth] = useState<string | null>(null);
  /** Item do arquivo aberto no detalhe (só leitura); tem prioridade sobre o item da lista viva. */
  const [archived, setArchived] = useState<ForYouItem | null>(null);

  const plans = useWorkStore((state) => state.plans);
  const listed = useMemo(() => visibleItems(items, status, type), [items, status, type]);
  // Em "Todos": "Esperando você" e "Decididos" são dois grupos; os decididos começam recolhidos se houver pendentes.
  const split = useMemo(() => (status === "todos" ? sections(items, type) : null), [items, status, type]);
  const [decidedToggle, setDecidedToggle] = useState<boolean | null>(null);
  const decidedOpen = decidedToggle ?? (split ? split.waiting.length === 0 : true);
  // Agrupados por pedido (com quantas coisas dele esperam você); a ordem da tela é a dos grupos.
  const groupsOf = useCallback((list: readonly ForYouItem[]) => groupByRequest(list, office?.tasks ?? [], plans, items), [office, plans, items]);
  const groups = useMemo(() => groupsOf(split ? split.waiting : listed), [groupsOf, split, listed]);
  const decidedGroups = useMemo(() => (split && decidedOpen ? groupsOf(split.decided) : []), [groupsOf, split, decidedOpen]);
  const visible = useMemo(() => [...groups, ...decidedGroups].flatMap((group) => group.items), [groups, decidedGroups]);
  const found = selectedId ? visible.findIndex((item) => item.id === selectedId) : -1;
  // Quem foi decidido sai da lista: o detalhe segue para o que ocupa o lugar dele (só no computador).
  const selectedIndex = found >= 0 ? found : mobile ? -1 : Math.min(lastIndex, visible.length - 1);
  const selected: ForYouItem | undefined = selectedIndex >= 0 ? visible[selectedIndex] : undefined;
  if (found >= 0 && found !== lastIndex) setLastIndex(found);
  const maestroId = office ? findMaestroAgent(office)?.id : undefined;
  const liveDrafts = useMemo(() => pruneDrafts(drafts, items), [drafts, items]);
  const agentMap = useMemo(() => new Map((office?.agents ?? []).map((agent) => [agent.id, agent])), [office]);
  const names = useMemo(
    () => ({
      agents: new Map(office?.agents.map((agent) => [agent.id, agent.name]) ?? []),
      rooms: new Map(office?.rooms.map((room) => [room.id, room.name]) ?? []),
      tasks: new Map(office?.tasks.map((task) => [task.id, task]) ?? []),
    }),
    [office],
  );

  // "Abrir em Aprovações": mostra o grupo do item, sem filtro de tipo, e foca nele (ajuste de
  // estado durante o render, quando o pedido muda; o pedido no store é limpo no efeito).
  const [handledRequest, setHandledRequest] = useState<string | null>(null);
  const requested = requestedId ? items.find((candidate) => candidate.id === requestedId) : undefined;
  if (requested && requested.id !== handledRequest) {
    setHandledRequest(requested.id);
    setStatus(statusGroup(requested));
    setType("todos");
    setFocusId(requested.id);
    setSelectedId(requested.id);
    setDetailOpen(true);
  } else if (!requestedId && handledRequest !== null) {
    setHandledRequest(null);
  }
  useEffect(() => {
    if (requested) useForYouFocus.getState().clear();
  }, [requested]);

  // "Abrir em Aprovações" de algo que já saiu da lista viva: procura no arquivo e abre em só leitura.
  const missingRequest = requestedId && !requested ? requestedId : null;
  const { findItem, loadMonth } = archive;
  useEffect(() => {
    if (!missingRequest) return;
    let stale = false;
    void findItem(missingRequest).then((found) => {
      if (stale) return;
      if (useForYouFocus.getState().itemId === missingRequest) useForYouFocus.getState().clear();
      if (!found) {
        push({ message: `A aprovação ${missingRequest} não está mais disponível.`, tone: "aviso" });
        return;
      }
      const month = forYouArchiveMonth(found);
      setStatus((current) => (current === "pendente" ? "todos" : current));
      setType("todos");
      setArchiveOpen(true);
      setArchiveMonth(month);
      loadMonth(month);
      setArchived(found);
      setDetailOpen(true);
    });
    return () => {
      stale = true;
    };
  }, [missingRequest, findItem, loadMonth, push]);

  useEffect(() => {
    if (focusId) {
      const card = cards.current.get(focusId);
      if (!card) return;
      card.focus({ preventScroll: true });
      rows.current.get(focusId)?.scrollIntoView({ block: "nearest" });
      setFocusId(null);
      return;
    }
    if (focusIndexAfter.current === null) return;
    const index = Math.min(focusIndexAfter.current, visible.length - 1);
    focusIndexAfter.current = null;
    const next = visible[index];
    if (next) cards.current.get(next.id)?.focus({ preventScroll: true });
  }, [focusId, visible, selected?.id]);

  // J/K andam pela lista (fora dos campos de texto); Enter numa linha abre o item e foca o detalhe.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(document.activeElement)) return;
      const key = event.key.toLowerCase();
      if (key !== "j" && key !== "k") return;
      if (document.querySelector("dialog[open]")) return;
      const current = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-item-id]")?.dataset.itemId ?? selected?.id;
      const index = stepIndex(visible.findIndex((item) => item.id === current), visible.length, key === "j" ? 1 : -1);
      const target = visible[index];
      if (!target) return;
      event.preventDefault();
      setSelectedId(target.id);
      setArchived(null);
      const row = rows.current.get(target.id);
      row?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: "nearest" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible, selected?.id]);

  // Texto editado e não enviado: o navegador confirma antes de fechar a aba.
  const hasDrafts = Object.keys(liveDrafts).length > 0;
  useEffect(() => {
    if (!hasDrafts) return;
    const onUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [hasDrafts]);

  const setDraft = useCallback((id: string, draft: CardDraft) => setDrafts((current) => ({ ...current, [id]: draft })), []);

  const reopen = useCallback(
    async (id: string) => {
      try {
        await api.decideForYou(id, { status: "pendente" });
        push({ message: `Reaberto · ${id}` });
      } catch (error) {
        push({ message: `Não deu para reabrir ${id}: ${describeError(error)}`, tone: "erro" });
      }
    },
    [push],
  );

  const decide = useCallback(
    async (item: ForYouItem, next: ForYouDecisionStatus, values: DecisionValues) => {
      const linked = item.taskId ? names.tasks.get(item.taskId) : undefined;
      const movesTask = next !== "pendente" && linked?.status === "waiting_approval";
      const index = visible.findIndex((candidate) => candidate.id === item.id);
      try {
        await api.decideForYou(item.id, { status: next, ...values });
      } catch (error) {
        push({ message: `Não gravou ${item.id}: ${describeError(error)}`, tone: "erro" });
        throw error;
      }
      setDrafts((current) => {
        const rest = { ...current };
        delete rest[item.id];
        return rest;
      });
      focusIndexAfter.current = index;
      if (next === "pendente") {
        push({ message: `Reaberto · ${item.id}` });
        return;
      }
      const label = `${DONE_LABELS[next]} · ${item.id}`;
      // Desfazer só reabre o item: quando a decisão já moveu a tarefa, não faz sentido oferecer.
      // A entrega de uma sprint não reabre (a sprint já fechou): sem "Desfazer".
      if (forYouKind(item) === "sprint") push({ message: next === "rejeitado" ? `Entrega devolvida · ${item.id}` : `Entrega aprovada · ${item.id}` });
      else if (forYouKind(item) === "regra") push({ message: next === "rejeitado" ? `Regra recusada (não volta por 8 semanas) · ${item.id}` : `Regra aprovada: já vale no Cérebro · ${item.id}` });
      else if (forYouKind(item) === "organizacao") push({ message: next === "rejeitado" ? `Proposta recusada: nada mudou · ${item.id}` : `Cérebro organizado · ${item.id}` });
      else if (movesTask) push({ message: `${label} · ${next === "rejeitado" ? "a tarefa foi encerrada" : "a tarefa seguiu"}` });
      else push({ message: label, action: { label: "Desfazer", run: () => void reopen(item.id) } });
    },
    [names.tasks, visible, push, reopen],
  );

  /** Decide, um por vez, os pendentes de um lote (aprovar todos / recusar todos). */
  const decideBatch = useCallback(
    async (pending: readonly ForYouItem[], next: "aprovado" | "rejeitado", reason: string) => {
      for (const item of pending) {
        const text = drafts[item.id]?.text;
        try {
          await api.decideForYou(item.id, { status: next, ...(next === "aprovado" && text !== undefined ? { text } : {}), ...(next === "rejeitado" && reason ? { reason } : {}) });
        } catch (error) {
          push({ message: `Parou em ${item.id}: ${describeError(error)}`, tone: "erro" });
          throw error;
        }
        setDrafts((current) => {
          const rest = { ...current };
          delete rest[item.id];
          return rest;
        });
      }
      push({ message: `${next === "aprovado" ? "Aprovados" : "Recusados"} · ${pending.length} ${pending.length === 1 ? "item" : "itens"} do lote` });
    },
    [drafts, push],
  );

  const discard = useCallback(
    async (item: ForYouItem, reason: string) => {
      const index = visible.findIndex((candidate) => candidate.id === item.id);
      await api.cancelForYou(item.id, reason);
      focusIndexAfter.current = index;
      push({ message: `${DONE_LABELS.cancelado} · ${item.id}${item.taskId ? " · a tarefa segue sem a resposta" : ""}` });
    },
    [visible, push],
  );

  const copy = useCallback(
    async (item: ForYouItem, text: string) => {
      const ok = await copyToClipboard(text);
      push(ok ? { message: `Texto de ${item.id} copiado.` } : { message: "Não deu para copiar. Selecione o texto e use Ctrl+C.", tone: "erro" });
    },
    [push],
  );

  const undoEdit = useCallback(
    (item: ForYouItem, previous: string) => {
      setDrafts((current) => ({ ...current, [item.id]: { ...current[item.id], text: forYouOriginalText(item) } }));
      push({
        message: `Edição de ${item.id} desfeita.`,
        action: { label: "Refazer", run: () => setDrafts((current) => ({ ...current, [item.id]: { ...current[item.id], text: previous } })) },
      });
    },
    [push],
  );

  const filtered = type !== "todos";
  const typeName = filtered ? typeDisplay(types, type).name : "";
  const heading = `${STATUS_VIEW_LABELS[status]}${filtered ? ` · ${typeName}` : ""}`;

  const select = (item: ForYouItem) => {
    setArchived(null);
    setSelectedId(item.id);
    setDetailOpen(true);
    setFocusId(item.id);
  };

  /** O card do item aberto: aprovação, plano ou questionário (cada um com as suas ações). */
  const renderDetail = (item: ForYouItem) => {
    const task = item.taskId ? names.tasks.get(item.taskId) : undefined;
    const cardRef = (element: HTMLElement | null) => {
      if (element) cards.current.set(item.id, element);
      else cards.current.delete(item.id);
    };
    const kind = forYouKind(item);
    if (kind === "plano") {
      return <PlanItemCard key={item.id} item={item} plan={plans.find((plan) => plan.id === item.projectId)} agentName={names.agents.get(item.agentId)} cardRef={cardRef} />;
    }
    if (kind === "sprint") {
      return <SprintCard key={item.id} item={item} project={plans.find((plan) => plan.id === item.projectId)} agents={agentMap} agentName={names.agents.get(item.agentId)} cardRef={cardRef} onDecide={decide} />;
    }
    if (kind === "regra" && item.rule) {
      return <RuleCard key={item.id} item={item} rule={item.rule} agentName={names.agents.get(item.agentId)} roomName={names.rooms.get(item.roomId)} cardRef={cardRef} onDecide={decide} />;
    }
    if (kind === "organizacao" && item.organize) {
      return <OrganizeCard key={item.id} item={item} plan={item.organize} agentName={names.agents.get(item.agentId)} cardRef={cardRef} onDecide={decide} />;
    }
    if (kind === "rotina" && item.routine) {
      return <RoutineCard key={item.id} item={item} routine={item.routine} agentName={names.agents.get(item.agentId)} cardRef={cardRef} onDecide={decide} onDiscard={discard} />;
    }
    if (kind === "questionario") {
      return (
        <QuestionnaireCard
          // Perguntas trocadas (update_pending_item): o card recomeça com o rascunho do server.
          key={`${item.id}:${updateBadge(item)?.count ?? 0}`}
          item={item}
          fromMaestro={item.agentId === maestroId}
          agentName={names.agents.get(item.agentId)}
          cardRef={cardRef}
          onDiscard={discard}
        />
      );
    }
    const progress = batchOf(items, item);
    return (
      <ForYouCard
        key={item.id}
        batch={
          progress
            ? { progress, onApproveAll: () => decideBatch(progress.pending, "aprovado", ""), onRejectAll: (reason) => decideBatch(progress.pending, "rejeitado", reason) }
            : undefined
        }
        item={item}
        types={types}
        agentName={names.agents.get(item.agentId)}
        roomName={names.rooms.get(item.roomId)}
        linkedTask={task}
        draft={liveDrafts[item.id] ?? {}}
        onDraft={setDraft}
        onDecide={decide}
        onCopy={(target, text) => void copy(target, text)}
        onUndoEdit={undoEdit}
        onDiscard={discard}
        cardRef={cardRef}
      />
    );
  };

  const renderGroup = (group: (typeof groups)[number]) => (
    <section key={group.key} className="fy-group" data-testid={group.requestId ? `foryou-group-${group.requestId}` : "foryou-group-outros"}>
      {showGroupHeader(group) && !(split && !group.requestId) && (
        <header className="fy-group__head">
          <h4 className="fy-group__title" title={group.title}>
            {group.requestId ? `Pedido: ${group.title}` : group.title}
          </h4>
          <span className="fy-group__count">{group.items.length} itens</span>
          {waitingLabel(group.waiting) && (
            <span className="fy-group__waiting" data-testid="foryou-group-waiting">
              {waitingLabel(group.waiting)}
            </span>
          )}
        </header>
      )}
      <ol className="fy-list">
        {group.items.map((item) => (
          <li key={item.id}>
            <ForYouRow
              item={item}
              types={types}
              agentName={names.agents.get(item.agentId)}
              roomName={names.rooms.get(item.roomId)}
              requestLabel={inlineRequestLabel(group)}
              batchLabel={(() => {
                const progress = batchOf(items, item);
                return progress ? batchLabel(progress) : undefined;
              })()}
              selected={item.id === selected?.id && !archived}
              onSelect={select}
              rowRef={(element) => {
                if (element) rows.current.set(item.id, element);
                else rows.current.delete(item.id);
              }}
            />
          </li>
        ))}
      </ol>
    </section>
  );

  const selectArchived = (item: ForYouItem) => {
    setArchived(item);
    setDetailOpen(true);
  };
  const noop = () => undefined;
  const showDetail = !mobile || (detailOpen && (!!selected || !!archived));
  // Com arquivo, a lista aparece mesmo sem nenhum item vivo (tudo já pode ter ido para "Mais antigos").
  const archiveShown = status !== "pendente" && hasArchive(archive);
  const archiveBlock = archiveShown && (
    <ArchiveBlock
      archive={archive}
      types={types}
      agentNames={names.agents}
      roomNames={names.rooms}
      open={archiveOpen}
      onToggle={() => setArchiveOpen((current) => !current)}
      month={archiveMonth}
      onMonth={setArchiveMonth}
      selectedId={archived?.id ?? null}
      onSelect={selectArchived}
    />
  );

  return (
    <div className={`fy-dash${mobile && showDetail ? " fy-dash--detail" : ""}`}>
      <ForYouSidebar
        items={items}
        types={types}
        status={status}
        type={type}
        onStatus={(value) => {
          setStatus(value);
          setType("todos");
        }}
        onType={setType}
        onManageTypes={() => useForYouTypesSheet.getState().setOpen(true)}
      />
      {visible.length > 0 || archiveShown ? (
        <>
          <div className="fy-main">
            <div className="fy-main__top">
              <h3 className="fy-main__title" data-testid="foryou-list-title">
                {heading}
              </h3>
              {visible.length > 0 && <span className="fy-main__sub">{visible.length === 1 ? "1 item" : `${visible.length} itens`}</span>}
            </div>
            <div className="fy-groups fy-main__scroll" data-testid="foryou-list">
              {split ? (
                <>
                  <header className="fy-sec__head" data-testid="foryou-section-waiting">
                    <h4 className="fy-sec__title">Esperando você</h4>
                    <span className="fy-sec__count">{split.waiting.length}</span>
                  </header>
                  {split.waiting.length === 0 && (
                    <p className="fy-sec__empty" data-testid="foryou-waiting-empty">
                      Nada esperando você.
                    </p>
                  )}
                  {groups.map(renderGroup)}
                  {split.decided.length > 0 && (
                    <>
                      <header className="fy-sec__head fy-sec__head--decided" data-testid="foryou-section-decided">
                        <button type="button" className="fy-sec__toggle" aria-expanded={decidedOpen} onClick={() => setDecidedToggle(!decidedOpen)} data-testid="foryou-decided-toggle">
                          <Icon name="back" size={12} />
                          <span className="fy-sec__title">Decididos</span>
                          <span className="fy-sec__count">{split.decided.length}</span>
                        </button>
                      </header>
                      {decidedGroups.map(renderGroup)}
                    </>
                  )}
                </>
              ) : (
                groups.map(renderGroup)
              )}
              {archiveBlock}
            </div>
          </div>
          {showDetail && (
            <div className="fy-detail" data-testid="foryou-detail">
              {archived ? (
                <>
                  <button type="button" className="fy-back" onClick={() => setDetailOpen(false)} data-testid="foryou-back">
                    <Icon name="back" size={14} />
                    Voltar à lista
                  </button>
                  {forYouKind(archived) === "organizacao" && archived.organize ? (
                    <OrganizeCard key={`arquivo:${archived.id}`} readOnly item={archived} plan={archived.organize} agentName={names.agents.get(archived.agentId)} onDecide={() => Promise.resolve()} />
                  ) : (
                  <ForYouCard
                      key={`arquivo:${archived.id}`}
                      readOnly
                      item={archived}
                      types={types}
                      agentName={names.agents.get(archived.agentId)}
                      roomName={names.rooms.get(archived.roomId)}
                      linkedTask={undefined}
                      draft={{}}
                      onDraft={noop}
                      onDecide={() => Promise.resolve()}
                      onCopy={(target, text) => void copy(target, text)}
                      onUndoEdit={noop}
                      onDiscard={() => Promise.resolve()}
                    />
                  )}
                </>
              ) : selected ? (
                <>
                  <button type="button" className="fy-back" onClick={() => setDetailOpen(false)} data-testid="foryou-back">
                    <Icon name="back" size={14} />
                    Voltar à lista
                  </button>
                  {renderDetail(selected)}
                </>
              ) : (
                <div className="fy-detail__blank">
                  <Icon name="todos" size={26} />
                  <p>Escolha um item na lista para ver o detalhe.</p>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="fy-empty" data-testid="foryou-empty">
          <svg className="fy-empty__art" viewBox="0 0 120 96" width="120" height="96" fill="none" aria-hidden="true">
            <ellipse cx="60" cy="86" rx="40" ry="5" fill="currentColor" opacity="0.08" />
            <path d="M18 54l14-30a6 6 0 0 1 5.4-3.5h45.2A6 6 0 0 1 88 24l14 30" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.5" />
            <path d="M18 54h26a4 4 0 0 1 4 4 12 12 0 0 0 24 0 4 4 0 0 1 4-4h26v22a6 6 0 0 1-6 6H24a6 6 0 0 1-6-6z" fill="currentColor" opacity="0.07" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
            <circle cx="60" cy="34" r="11" fill="var(--ui-ok-bg)" stroke="var(--ui-ok)" strokeWidth="2.5" />
            <path d="M55 34l3.6 3.6L65 31" stroke="var(--ui-ok)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p>
            <strong>
              {status === "todos"
                ? filtered
                  ? `Nenhum item de ${typeName.toLowerCase()}.`
                  : "Nada esperando você."
                : status === "pendente"
                ? filtered
                  ? `Nenhum item de ${typeName.toLowerCase()} pendente.`
                  : "Tudo decidido. Nada esperando você."
                : status === "cancelados"
                  ? filtered
                    ? `Nenhum item de ${typeName.toLowerCase()} cancelado.`
                    : "Nenhum item cancelado."
                  : filtered
                    ? `Nenhum item de ${typeName.toLowerCase()} decidido.`
                    : "Nenhum item decidido ainda."}
            </strong>
          </p>
          {filtered ? (
            <button type="button" className="fy-link" onClick={() => setType("todos")}>
              Ver todos os tipos
            </button>
          ) : (
            <p className="fy-empty__hint">
              {status === "cancelados"
                ? "Itens retirados sem decisão (pelo Maestro, pelo agente ou descartados por você) aparecem aqui com o motivo."
                : status === "pendente" || status === "todos"
                  ? "Quando um agente pedir sua aprovação, escrever um texto ou tirar uma dúvida, o pedido aparece aqui na hora."
                  : "Os itens que você aprovar, recusar ou responder ficam guardados aqui."}
            </p>
          )}
          {!filtered && status === "pendente" && statusCounts(items).decididos > 0 && (
            <button type="button" className="fy-link" onClick={() => setStatus("decididos")} data-testid="foryou-empty-see-decided">
              Ver os {statusCounts(items).decididos} já decididos
            </button>
          )}
        </div>
      )}
      <ToastStack toasts={toasts} dismiss={dismiss} />
      {typesOpen && (
        <ForYouTypesSheet
          items={items}
          types={types ?? []}
          onClose={() => useForYouTypesSheet.getState().setOpen(false)}
          onDone={(message) => push({ message })}
          onRemoved={(id) => setType((current) => (current === id ? "todos" : current))}
        />
      )}
    </div>
  );
}
