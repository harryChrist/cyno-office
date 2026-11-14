import { agentEngine, describeModelChoice, isActiveTaskStatus, isMaestroAgent, type MetricsReport, type ModelSaving } from "@cyno/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, describeError } from "../../api/client";
import { useOfficeStore } from "../../store/officeStore";
import { useWorkStore } from "../../store/workStore";
import { EngineFields, type EngineValues } from "../../ui/EngineFields";
import { ErrorText, Modal } from "../../ui/widgets";
import { agentChoices, batchView, savingView, type AgentChoice } from "./actionsView";
import "./actions.css";

/**
 * Controles das ações do gestor (Gestão): o seletor de agente para reatribuir, o diálogo de aprovar em lote e o de trocar
 * o modelo. Nada roda sem um clique; as ações que mudam o que já está andando (lote, troca de modelo) pedem uma segunda
 * confirmação dentro do próprio diálogo. A lógica de texto vive em `actionsView.ts` (testada); aqui só se desenha.
 */

export type ActionNoteValue = { tone: "ok" | "error"; text: string };

/** Uma ação com resposta curta ao lado do botão ("Feito" ou o erro), que some sozinha depois de alguns segundos. */
export function useActionNote(clearAfterMs = 6000) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<ActionNoteValue | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const run = async (action: () => Promise<unknown>, okText: string): Promise<boolean> => {
    clearTimeout(timer.current);
    setBusy(true);
    setNote(null);
    try {
      await action();
      setNote({ tone: "ok", text: okText });
      timer.current = setTimeout(() => setNote(null), clearAfterMs);
      return true;
    } catch (caught) {
      setNote({ tone: "error", text: describeError(caught) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, note, run };
}

export function ActionNote({ note, testId }: { note: ActionNoteValue | null; testId?: string }) {
  if (!note) return null;
  return (
    <span className={`act__note act__note--${note.tone}`} role={note.tone === "error" ? "alert" : "status"} data-testid={testId ?? "action-note"}>
      {note.text}
    </span>
  );
}

// ---------- Reatribuir ----------

export type ReassignTarget = { projectId: string; ref: string; title: string; agentId?: string; typeLabel: string };

/** Pequena janela com os agentes (e a carga de cada um): escolher um e confirmar passa a tarefa travada para ele. */
export function ReassignPicker({ target, report, onClose, onDone }: { target: ReassignTarget; report: MetricsReport; onClose: () => void; onDone: (text: string) => void }) {
  const office = useOfficeStore((state) => state.office);
  const agents = useMemo(() => (office ? office.agents.filter((agent) => !isMaestroAgent(office, agent)).map((agent) => ({ id: agent.id, name: agent.name })) : []), [office]);
  const choices = useMemo(() => agentChoices(report, agents, target.agentId), [report, agents, target.agentId]);
  const [picked, setPicked] = useState<string | null>(null);
  const { busy, note, run } = useActionNote();
  const chosen = choices.find((choice) => choice.id === picked);

  const confirm = async () => {
    if (!chosen) return;
    const ok = await run(() => api.reassignProjectTask(target.projectId, target.ref, { agentId: chosen.id }), `Passou para ${chosen.name}`);
    if (ok) {
      onDone(`“${target.title}” passou para ${chosen.name}`);
      onClose();
    }
  };

  return (
    <Modal title="Reatribuir tarefa" onClose={onClose} testId="reassign-picker">
      <p className="act__lead">
        <strong>{target.title}</strong> <span className="act__muted">({target.typeLabel})</span>. Escolha quem assume; ela volta para a fila do agente novo.
      </p>
      {choices.length === 0 ? (
        <p className="act__muted">Nenhum agente disponível neste workspace.</p>
      ) : (
        <ul className="act__choices" role="radiogroup" aria-label="Agentes">
          {choices.map((choice) => (
            <li key={choice.id}>
              <ChoiceRow choice={choice} selected={picked === choice.id} onPick={() => setPicked(choice.id)} />
            </li>
          ))}
        </ul>
      )}
      {chosen?.blocked && <p className="act__warn">O motor de {chosen.name} está parado ({chosen.blocked}): a tarefa fica esperando lá.</p>}
      {chosen && !chosen.blocked && chosen.atLimit && <p className="act__warn">{chosen.name} já está no limite de tarefas ao mesmo tempo: a tarefa entra na fila dele.</p>}
      <ErrorText>{note?.tone === "error" ? note.text : undefined}</ErrorText>
      <div className="ui-actions">
        <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
          Cancelar
        </button>
        <button type="button" className="ui-button" disabled={!chosen || busy} onClick={() => void confirm()} data-testid="reassign-confirm">
          {busy ? "Passando…" : chosen ? `Passar para ${chosen.name}` : "Escolha um agente"}
        </button>
      </div>
    </Modal>
  );
}

function ChoiceRow({ choice, selected, onPick }: { choice: AgentChoice; selected: boolean; onPick: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={selected} className={`act__choice${selected ? " is-selected" : ""}`} onClick={onPick} data-testid="reassign-choice" data-agent={choice.id}>
      <span className="act__choice-name">{choice.name}</span>
      <span className={`act__choice-load${choice.busy ? " is-busy" : ""}`}>{choice.load}</span>
      {choice.current && <span className="act__tag">atual</span>}
      {choice.blocked && <span className="act__tag act__tag--warn">{choice.blocked}</span>}
    </button>
  );
}

// ---------- Aprovar em lote ----------

/** O diálogo do lote: o texto de cada item, a recusa de cada agente, quem ficou de fora e por quê; depois uma segunda confirmação. */
export function BatchApproveDialog({ report, onClose, onDone }: { report: MetricsReport | null; onClose: () => void; onDone: (text: string) => void }) {
  const forYou = useOfficeStore((state) => state.forYou);
  const types = useOfficeStore((state) => state.forYouTypes);
  const agents = useOfficeStore((state) => state.office?.agents);
  const [pick, setPick] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { busy, note, run } = useActionNote();
  const typeName = (type: string) => (types ?? []).find((entry) => entry.id === type)?.name ?? type;
  const view = useMemo(
    () => batchView({ items: forYou ?? [], report, typeName, agentName: (id) => agents?.find((agent) => agent.id === id)?.name ?? id, pick }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [forYou, report, types, agents, pick],
  );

  const approve = async () => {
    const ids = view.rows.map((row) => row.id);
    const count = ids.length;
    const ok = await run(() => api.approveForYouBatch(ids), `${count} aprovados`);
    if (ok) {
      onDone(`${count} ${count === 1 ? "item aprovado" : "itens aprovados"} em lote`);
      onClose();
    } else setConfirming(false);
  };

  return (
    <Modal title="Aprovar em lote" onClose={onClose} testId="batch-dialog" wide>
      {view.type === null ? (
        <p className="act__muted" data-testid="batch-empty">
          Nada esperando aprovação de texto agora.
        </p>
      ) : confirming ? (
        <div data-testid="batch-confirm-step">
          <p className="act__lead">{view.confirm}</p>
          <ul className="act__confirm-list">
            {view.rows.map((row) => (
              <li key={row.id}>
                {row.agentName}: {row.title}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <p className="act__lead">Confira o texto de cada um antes de aprovar. Só entram aprovações de texto do mesmo tipo, sem edição sua.</p>
          {view.types.length > 1 && (
            <div className="act__types" role="group" aria-label="Tipo do lote">
              {view.types.map((choice) => (
                <button key={choice.type} type="button" className={`act__type${choice.type === view.type ? " is-active" : ""}`} aria-pressed={choice.type === view.type} onClick={() => setPick(choice.type)} data-testid="batch-type">
                  {choice.label} <span className="act__muted">{choice.eligible}{choice.left > 0 ? ` (+${choice.left} fora)` : ""}</span>
                </button>
              ))}
            </div>
          )}
          {view.rows.length === 0 ? (
            <p className="act__muted" data-testid="batch-none">
              Nenhum item deste tipo pode entrar no lote agora.
            </p>
          ) : (
            <ol className="act__items" data-testid="batch-items">
              {view.rows.map((row) => (
                <li key={row.id} className="act__item" data-testid="batch-item">
                  <p className="act__item-head">
                    <strong>{row.title}</strong>
                    <span className="act__muted">
                      {row.agentName} · {row.rejection}
                    </span>
                  </p>
                  <blockquote className="act__item-text">{row.text}</blockquote>
                </li>
              ))}
            </ol>
          )}
          {view.over > 0 && <p className="act__warn">Mais {view.over} deste tipo passam do teto de 20: ficam para um segundo lote.</p>}
          {view.leftOut.length > 0 && (
            <div className="act__left" data-testid="batch-left-out">
              <p className="act__left-title">Ficaram de fora ({view.leftOut.length})</p>
              <ul>
                {view.leftOut.map((entry) => (
                  <li key={entry.id}>
                    <strong>{entry.title}</strong>
                    {entry.agentName ? ` (${entry.agentName})` : ""}: {entry.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {view.notApproval > 0 && <p className="act__muted">Há também {view.notApproval} {view.notApproval === 1 ? "pedido" : "pedidos"} que não são texto para aprovar (plano, rotina, sprint ou pergunta): esses se decidem um por um em Aprovações.</p>}
        </>
      )}
      <ErrorText>{note?.tone === "error" ? note.text : undefined}</ErrorText>
      <div className="ui-actions">
        {confirming ? (
          <>
            <button type="button" className="ui-button ui-button--secondary" onClick={() => setConfirming(false)} disabled={busy}>
              Voltar
            </button>
            <button type="button" className="ui-button ui-button--success" onClick={() => void approve()} disabled={busy} data-testid="batch-confirm">
              {busy ? "Aprovando…" : `Sim, aprovar ${view.rows.length}`}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
              Fechar
            </button>
            <button type="button" className="ui-button ui-button--success" onClick={() => setConfirming(true)} disabled={view.rows.length === 0} data-testid="batch-review">
              {view.action || "Aprovar"}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------- Trocar o modelo ----------

export type ModelTarget = { id: string; name: string };

/** Debounce simples para o campo de modelo digitado. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * "Trocar modelo": os mesmos campos de motor e modelo do painel do agente, com a estimativa de economia (só estima) e o
 * aviso da recusa; a troca em si vai pelo `PATCH /agents/:id`, depois de uma segunda confirmação.
 */
export function ModelChangeDialog({ target, onClose, onDone }: { target: ModelTarget; onClose: () => void; onDone: (text: string) => void }) {
  const office = useOfficeStore((state) => state.office);
  const agent = office?.agents.find((candidate) => candidate.id === target.id);
  const initial: EngineValues = { engine: agent ? agentEngine(agent) : "mock", model: agent?.model ?? "", effort: agent?.effort ?? "" };
  const [values, setValues] = useState<EngineValues>(initial);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState<{ model: string; result: ModelSaving | null; error: string | null } | null>(null);
  const { busy, note, run } = useActionNote();
  const locked = Boolean(office?.tasks.some((task) => task.agentId === target.id && isActiveTaskStatus(task.status)));
  const changedModel = values.model !== initial.model;
  const changedAnything = changedModel || values.engine !== initial.engine || values.effort !== initial.effort;
  const wanted = useDebounced(values.model.trim(), 400);

  useEffect(() => {
    if (!wanted || wanted === initial.model) return;
    let stale = false;
    api.getModelSaving(target.id, wanted).then(
      (result) => !stale && setSaving({ model: wanted, result, error: null }),
      (failure: unknown) => !stale && setSaving({ model: wanted, result: null, error: describeError(failure) }),
    );
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, target.id]);

  const current = saving && saving.model === wanted && wanted !== initial.model ? saving : null;
  const view = current?.result ? savingView(current.result) : null;
  const waiting = changedModel && wanted !== values.model.trim();

  const save = async () => {
    const ok = await run(
      () => api.updateAgent(target.id, { engine: values.engine, model: values.model.trim() || null, effort: values.effort || null }),
      "Modelo trocado",
    );
    if (ok) {
      onDone(`${target.name} agora usa ${describeModelChoice({ engine: values.engine, model: values.model.trim() || undefined, effort: values.effort || undefined })}`);
      onClose();
    } else setConfirming(false);
  };

  return (
    <Modal title={`Trocar o modelo de ${target.name}`} onClose={onClose} testId="model-dialog" wide>
      {confirming ? (
        <div data-testid="model-confirm-step">
          <p className="act__lead">
            Trocar {target.name} de <strong>{describeModelChoice({ engine: initial.engine, model: initial.model || undefined, effort: initial.effort || undefined })}</strong> para{" "}
            <strong>{describeModelChoice({ engine: values.engine, model: values.model.trim() || undefined, effort: values.effort || undefined })}</strong>?
          </p>
          {view && <p className={`act__headline act__headline--${view.tone}`}>{view.headline}</p>}
          {view?.warning && <p className="act__warn">{view.warning}</p>}
          <p className="act__muted">A troca vale já para a próxima tarefa do agente. Dá para voltar atrás do mesmo jeito.</p>
        </div>
      ) : (
        <>
          <p className="act__lead">Escolha o motor e o modelo novos. A estimativa abaixo só calcula, nada muda até você confirmar.</p>
          <EngineFields values={values} onChange={setValues} locked={locked} testIdPrefix="model-change" />
          <div className="act__saving" data-testid="model-saving" aria-live="polite">
            {!changedModel || !wanted ? (
              <p className="act__muted">Escolha um modelo diferente do atual para ver a estimativa.</p>
            ) : waiting || (current === null && saving?.model !== wanted) ? (
              <p className="act__muted">Calculando…</p>
            ) : current?.error ? (
              <p className="act__warn">Não deu para estimar: {current.error}</p>
            ) : view ? (
              <>
                <p className={`act__headline act__headline--${view.tone}`} data-testid="model-saving-headline">
                  {view.headline}
                </p>
                {view.lines.map((line) => (
                  <p key={line} className="act__muted">
                    {line}
                  </p>
                ))}
                {view.warning && (
                  <p className="act__warn" data-testid="model-saving-warning">
                    {view.warning}
                  </p>
                )}
              </>
            ) : null}
          </div>
        </>
      )}
      <ErrorText>{note?.tone === "error" ? note.text : undefined}</ErrorText>
      <div className="ui-actions">
        {confirming ? (
          <>
            <button type="button" className="ui-button ui-button--secondary" onClick={() => setConfirming(false)} disabled={busy}>
              Voltar
            </button>
            <button type="button" className="ui-button" onClick={() => void save()} disabled={busy} data-testid="model-confirm">
              {busy ? "Trocando…" : "Confirmar a troca"}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
              Cancelar
            </button>
            <button type="button" className="ui-button" disabled={!changedAnything || waiting} onClick={() => setConfirming(true)} data-testid="model-review">
              Trocar modelo…
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------- Fixar ("Isso primeiro") e pausar ----------

/**
 * Botões de um projeto: "Isso primeiro" (fixa na frente da fila; clicar de novo solta) e, se pedido, Pausar ou Retomar.
 * O estado vem do store de projetos (que os eventos do servidor mantêm), então o botão acompanha o que de fato mudou.
 */
export function ProjectActions({ projectId, pause = false, pin = true, onDone }: { projectId: string; pause?: boolean; pin?: boolean; /** Avisa o que foi feito (a linha pode sair da lista, como o projeto pausado, e levar a nota junto). */ onDone?: (text: string) => void }) {
  const project = useWorkStore((state) => state.projects.find((candidate) => candidate.id === projectId));
  const { busy, note, run } = useActionNote();
  const pinned = Boolean(project?.pinnedAt);
  const paused = project?.status === "pausado";
  const act = async (action: () => Promise<unknown>, okText: string) => {
    const ok = await run(action, okText);
    if (ok && onDone && project) onDone(`“${project.title}”: ${okText.toLowerCase()}`);
  };
  const canPause = pause && project !== undefined && project.kind !== "tarefa" && (project.status === "ativo" || project.status === "pausado");
  return (
    <span className="act__row" data-testid="project-actions">
      {pin && (
        <button
          type="button"
          className={`ui-button ui-button--secondary ui-button--small act__btn${pinned ? " is-on" : ""}`}
          aria-pressed={pinned}
          disabled={busy}
          title={pinned ? "Soltar: o projeto volta à ordem normal da fila" : "Passa este projeto na frente de tudo na fila dos agentes"}
          onClick={() => void act(() => api.updateProject(projectId, { pinned: !pinned }), pinned ? "Solto: voltou à ordem normal" : "Fixado na frente da fila")}
          data-testid="pin-button"
        >
          {pinned ? "Fixado · soltar" : "Isso primeiro"}
        </button>
      )}
      {canPause && (
        <button type="button" className="ui-button ui-button--secondary ui-button--small act__btn" disabled={busy} onClick={() => void act(() => api.updateProject(projectId, { status: paused ? "ativo" : "pausado" }), paused ? "Retomado" : "Pausado")} data-testid="project-pause-button">
          {paused ? "Retomar" : "Pausar"}
        </button>
      )}
      <ActionNote note={note} />
    </span>
  );
}
