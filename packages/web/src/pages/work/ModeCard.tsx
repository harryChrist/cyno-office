import { isProjectOpen, type AutoGrant, type Project, type ProjectMode, type ProjectModeBody } from "@cyno/shared";
import { useId, useMemo, useState } from "react";
import { api, describeError } from "../../api/client";
import { useOfficeStore } from "../../store/officeStore";
import { ErrorText } from "../../ui/widgets";
import { actionNames, buildModeBody, grantSummary, initialForm, modeView, NEVER_AUTO_TYPES, onlyOtherTypesNote, type ModeForm } from "./modeView";

/** Manda uma mudança de modo e guarda o estado (pendente, erro). O evento project:upserted atualiza a tela. */
function useModeRequest(project: Project) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (body: ProjectModeBody): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      await api.setProjectMode(project.id, body);
      return true;
    } catch (caught) {
      setError(describeError(caught));
      return false;
    } finally {
      setPending(false);
    }
  };
  return { pending, error, send };
}

type TypeOption = { id: string; name: string };

function AutoForm({ mode, proposed, options, onClose, send, pending }: { mode: ProjectMode; proposed: AutoGrant | undefined; options: TypeOption[]; onClose: () => void; send: (body: ProjectModeBody) => Promise<boolean>; pending: boolean }) {
  const id = useId();
  const [form, setFormState] = useState<ModeForm>(() => initialForm(mode.kind === "automatico" ? mode.grant : proposed));
  const [problem, setProblem] = useState<string | null>(null);
  // Mexeu no formulário: o aviso de antes não vale mais.
  const setForm = (next: ModeForm | ((current: ModeForm) => ModeForm)) => {
    setProblem(null);
    setFormState(next);
  };
  const toggle = (type: string) => setForm((current) => ({ ...current, actions: current.actions.includes(type) ? current.actions.filter((item) => item !== type) : [...current.actions, type] }));
  const submit = async () => {
    const built = buildModeBody(form);
    if ("problem" in built) return setProblem(built.problem);
    setProblem(null);
    if (await send(built.body)) onClose();
  };
  // Tipos que o Maestro sugeriu e o workspace ainda não tem entram na lista também (o id aparece como está).
  const known = new Set(options.map((option) => option.id));
  const extra = form.actions.filter((action) => !known.has(action)).map((action) => ({ id: action, name: action }));
  return (
    <form className="w-mode__form" onSubmit={(event) => { event.preventDefault(); void submit(); }} data-testid="work-mode-form">
      <fieldset className="w-mode__types">
        <legend>O que pode ser feito sem perguntar</legend>
        {[...options, ...extra].map((option) => (
          <label key={option.id} className="w-mode__type">
            <input type="checkbox" checked={form.actions.includes(option.id)} onChange={() => toggle(option.id)} data-testid={`work-mode-type-${option.id}`} />
            {option.name}
          </label>
        ))}
        {onlyOtherTypesNote(options) ? (
          <p className="w-mode__hint ui-muted" data-testid="work-mode-only-other">
            {onlyOtherTypesNote(options)}
          </p>
        ) : null}
      </fieldset>
      <div className="w-mode__fields">
        <label htmlFor={`${id}-cap`}>
          Teto por dia
          <input id={`${id}-cap`} className="ui-input ui-input--compact" inputMode="numeric" value={form.cap} onChange={(event) => setForm({ ...form, cap: event.currentTarget.value })} data-testid="work-mode-cap" />
        </label>
        <label htmlFor={`${id}-sites`}>
          Só nestes sites (opcional)
          <input id={`${id}-sites`} className="ui-input ui-input--compact" value={form.sites} placeholder="ex.: linkedin.com" onChange={(event) => setForm({ ...form, sites: event.currentTarget.value })} data-testid="work-mode-sites" />
        </label>
      </div>
      <p className="w-mode__hint ui-muted">
        O que estiver marcado é aprovado na hora, sem aparecer em Aprovações, até o teto de cada dia (horário de Brasília). Passou do teto ou saiu da lista, volta a pedir o seu OK. Tudo o que for feito sozinho fica na Atividade.
      </p>
      <div className="w-mode__actions">
        <button type="submit" className="ui-button ui-button--small" disabled={pending} data-testid="work-mode-save">
          {mode.kind === "automatico" ? "Salvar" : "Ligar Automático"}
        </button>
        <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={onClose}>
          Fechar
        </button>
      </div>
      <ErrorText>{problem}</ErrorText>
    </form>
  );
}

const NO_TYPES: readonly { id: string; name: string }[] = [];
/** No projeto, além dos tipos do Para você: o resumo de entrega da sprint. */
const PROJECT_TYPES = [{ id: "sprint", name: "Aprovar a entrega da sprint" }];

/** O que o cartão precisa de quem manda a mudança (projeto ou rotina): estado, pedido e os textos que variam. */
export type ModeCardViewProps = {
  mode: ProjectMode;
  modeProposal?: Project["modeProposal"];
  autoUsage?: Project["autoUsage"];
  /** Pausado: o Automático não aprova nada até retomar. */
  paused: boolean;
  /** Aberto e editável: mostra os botões. Fechado e em Pede OK, o cartão some. */
  open: boolean;
  closed: boolean;
  send: (body: ProjectModeBody) => Promise<boolean>;
  pending: boolean;
  error: string | null;
  /** "este projeto" / "esta rotina" e o aviso de pausa. */
  subject?: string;
  pausedText?: string;
  /** Tipos de ação a mais que só este contexto tem (o projeto libera "sprint": aprovar sozinho o resumo de entrega). */
  extraTypes?: readonly { id: string; name: string }[];
};

/**
 * Cartão "Modo": "Pede OK" (padrão) ou "Automático". No Automático mostra o que está liberado e o uso
 * de hoje ("3 de 8"); "Ligar Automático" abre o formulário (tipos de ação, teto por dia, sites); uma
 * sugestão do Maestro/Cyno aparece com [Ligar], [Ajustar antes] e [Agora não]. Só você liga: a sugestão
 * não vale até o seu clique. Genérico: o do projeto e o da rotina usam este mesmo corpo.
 */
export function ModeCardView({ mode, modeProposal, autoUsage, paused, open, closed, send, pending, error, subject = "este projeto", pausedText = "O projeto está pausado: nada é aprovado sozinho até você retomar.", extraTypes = NO_TYPES }: ModeCardViewProps) {
  const types = useOfficeStore((state) => state.forYouTypes);
  const [formOpen, setFormOpen] = useState(false);
  const options = useMemo(() => (types ?? []).filter((type) => !NEVER_AUTO_TYPES.includes(type.id)).map((type) => ({ id: type.id, name: type.name })).concat(extraTypes.map((type) => ({ ...type }))), [types, extraTypes]);
  const names = useMemo(() => new Map([...(types ?? []).map((type) => [type.id, type.name] as const), ...extraTypes.map((type) => [type.id, type.name] as const)]), [types, extraTypes]);
  // eslint-disable-next-line react-hooks/purity -- a conta do dia (teto, "3 de 8") precisa da hora de agora a cada render
  const view = modeView({ mode, modeProposal, autoUsage, status: paused ? "pausado" : "ativo" }, Date.now());
  if (closed && view.kind === "pede-ok") return null;
  const proposal = view.kind === "pede-ok" ? view.proposal : undefined;
  return (
    <section className={`w-mode w-mode--${view.kind}`} aria-label="Modo" data-testid="work-mode" data-mode={view.kind}>
      <header className="w-mode__head">
        <h3 className="w-section__title">Modo</h3>
        <span className={`w-mode__badge w-mode__badge--${view.kind}`} data-testid="work-mode-badge">
          {view.kind === "automatico" ? "Automático" : "Pede OK"}
        </span>
        {view.kind === "automatico" && (
          <span className="w-mode__usage" data-testid="work-mode-usage">
            {view.grant.dailyCap !== undefined ? `${view.used} de ${view.grant.dailyCap} hoje` : `${view.used} hoje`}
          </span>
        )}
      </header>

      {view.kind === "pede-ok" ? (
        <p className="w-mode__text">Cada ação que sai (comentário, convite, publicação…) espera o seu OK em Aprovações.</p>
      ) : (
        <>
          <p className="w-mode__text" data-testid="work-mode-summary">
            {grantSummary(view.grant, view.used, names)}
          </p>
          <p className="w-mode__text ui-muted">
            {view.paused
              ? pausedText
              : view.capReached
                ? "O teto de hoje acabou: o que vier até amanhã pede o seu OK."
                : "Isso é aprovado na hora, sem passar por Aprovações (fica registrado na Atividade). O resto continua pedindo OK."}
          </p>
        </>
      )}

      {proposal && open && !formOpen && (
        <div className="w-mode__proposal" data-testid="work-mode-proposal">
          <p className="w-mode__text">
            {proposal.by === "cyno" ? "O Cyno" : "O Maestro"} sugere rodar {subject} no automático, liberando sozinho: {actionNames(proposal.actions, names)}
            {proposal.dailyCap !== undefined ? `, até ${proposal.dailyCap} por dia` : ""}
            {proposal.sites && proposal.sites.length > 0 ? `, em ${proposal.sites.join(", ")}` : ""}. Só vale depois do seu OK.
          </p>
          <div className="w-mode__actions">
            <button type="button" className="ui-button ui-button--success ui-button--small" disabled={pending} onClick={() => void send({ kind: "proposta", accept: true })} data-testid="work-mode-accept">
              Ligar
            </button>
            <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => setFormOpen(true)}>
              Ajustar antes
            </button>
            <button type="button" className="ui-button ui-button--ghost ui-button--small" disabled={pending} onClick={() => void send({ kind: "proposta", accept: false })} data-testid="work-mode-decline">
              Agora não
            </button>
          </div>
        </div>
      )}

      {open && !proposal && !formOpen && (
        <div className="w-mode__actions">
          {view.kind === "pede-ok" ? (
            <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => setFormOpen(true)} data-testid="work-mode-enable">
              Ligar Automático
            </button>
          ) : (
            <>
              <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => setFormOpen(true)} data-testid="work-mode-edit">
                Mudar o que está liberado
              </button>
              <button type="button" className="ui-button ui-button--ghost ui-button--small" disabled={pending} onClick={() => void send({ kind: "pede-ok" })} data-testid="work-mode-disable">
                Voltar para Pede OK
              </button>
            </>
          )}
        </div>
      )}

      {open && formOpen && <AutoForm mode={mode} proposed={modeProposal?.grant} options={options} onClose={() => setFormOpen(false)} send={send} pending={pending} />}
      <ErrorText testId="work-mode-error">{error}</ErrorText>
    </section>
  );
}

/** Cartão "Modo" da trilha do projeto: o genérico ligado à rota do projeto. */
export function ModeCard({ project, editable }: { project: Project; editable: boolean }) {
  const { pending, error, send } = useModeRequest(project);
  const projectOpen = isProjectOpen(project);
  return (
    <ModeCardView
      mode={project.mode}
      modeProposal={project.modeProposal}
      autoUsage={project.autoUsage}
      paused={project.status === "pausado"}
      open={projectOpen && editable}
      closed={!projectOpen}
      send={send}
      pending={pending}
      error={error}
      extraTypes={PROJECT_TYPES}
    />
  );
}
