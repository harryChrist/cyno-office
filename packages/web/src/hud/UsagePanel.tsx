import { useEffect, useMemo, useState } from "react";
import { useAgentUsageStore } from "../store/agentUsageStore";
import { useNavStore } from "../store/navStore";
import { openSpend } from "../store/navTargets";
import { useOfficeStore } from "../store/officeStore";
import { useUsageStore } from "../store/usageStore";
import { NavIcon } from "./navIcons";
import {
  agentUsageRows,
  closestToLimit,
  sessionWindowStart,
  shortReset,
  splitIdleGroups,
  windowFullLabel,
  type UsageView,
  type UsageWindowView,
} from "./usage";
import { RefreshButton, useUsageViews } from "./UsageMeter";
import { useNow } from "../ui/ActivityFeed";
import "./usagePanel.css";

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (iso: string) => {
  const at = new Date(iso);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
};

/**
 * "Por agente": quanto cada agente de CLI deste workspace relatou ter gastado (tokens e turnos)
 * desde o começo da sessão de 5 h. Busca uma vez ao abrir; depois cada turno terminado chega pelo
 * WebSocket (`usage:agents`) e entra na soma, sem consultar a rota de novo.
 */
function AgentUsage({ onOpenSpend }: { onOpenSpend: () => void }) {
  const workspaceId = useNavStore((state) => state.workspaceId);
  const agents = useOfficeStore((state) => state.office?.agents);
  const state = useAgentUsageStore();
  // A sessão de 5 h virou (o server mandou um usage:updated com outro reset): a soma recomeça.
  const sessionResets = useUsageStore((usage) => usage.byProvider.claude?.windows.find((window) => window.id === "five_hour")?.resetsAt);

  useEffect(() => {
    void useAgentUsageStore.getState().load(sessionWindowStart(useUsageStore.getState().byProvider.claude, Date.now()));
  }, [workspaceId, sessionResets]);

  const rows = useMemo(() => (state.data ? agentUsageRows(state.data.agents, agents ?? []) : []), [state.data, agents]);

  return (
    <details className="usagep__agents" data-testid="usage-agents" open>
      <summary className="usagep__section">
        Por agente
        {state.data && <span className="usagep__since">desde {clock(state.data.since)} · estimativa</span>}
      </summary>
      {!state.data && !state.error && <p className="usagep__empty">Carregando…</p>}
      {!state.data && state.error && (
        <p className="usagep__empty usagep__empty--error" role="alert">
          {state.error}
        </p>
      )}
      {state.data && rows.length === 0 && <p className="usagep__empty">Nenhum agente de CLI terminou um turno nesta sessão ainda.</p>}
      {rows.length > 0 && (
        <ul className="usage-agents__list">
          {rows.map((row) => (
            <li
              key={row.agentId}
              className={`usage-agents__row usage-agents__row--${row.provider}`}
              title={row.detail}
              data-testid="usage-agent-row"
              data-agent-id={row.agentId}
              data-provider={row.provider}
            >
              <span className="usage-agents__who">
                <span className="usage-agents__name">{row.name}</span>
                <span className={`usage-agents__engine agents-chip agents-chip--${row.provider}`}>{row.providerLabel}</span>
              </span>
              <span className="usage-agents__tokens ui-tabular">
                {row.tokensLabel}
                {row.tokens !== null && <span className="usage-agents__unit"> tokens</span>}
              </span>
              <span className="usage-agents__bar" aria-hidden="true">
                <span className="usage-agents__fill" style={{ width: `${row.share}%` }} />
              </span>
              <span className="usage-agents__turns ui-tabular">
                {row.turnsLabel}
                {row.costLabel && <span className="usage-agents__cost" data-testid="usage-agent-cost"> · {row.costLabel}</span>}
              </span>
              <span className="sr-only">. {row.detail}</span>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="ui-link usagep__spend" onClick={onOpenSpend} data-testid="usage-agents-spend">
        Ver gastos em dinheiro (dia, semana, mês) →
      </button>
    </details>
  );
}

/** Uma janela: nome, barra, porcentagem e a renovação em forma curta (a hora exata e a idade ficam na dica). */
function PanelWindow({ view, window, now }: { view: UsageView; window: UsageWindowView; now: number }) {
  const aria = `${view.providerLabel} · ${windowFullLabel(window)}`;
  const reset = window.renewed ? "" : shortReset(window.resetsAt, now);
  const note = window.renewed ? "aguardando leitura" : [reset ? `renova ${reset}` : "", window.old ? `⏱ ${window.ageLabel}` : ""].filter(Boolean).join(" · ");
  const title = [window.renewed ? "A janela renovou depois da última leitura; o uso de agora é desconhecido." : window.resetLabel, window.old ? `Leitura ${window.ageLabel}: pode não refletir o uso de agora.` : ""]
    .filter(Boolean)
    .join("\n");
  return (
    <li
      className={`usagep__window usagep__window--${window.tone}${window.old ? " usagep__window--old" : ""}${window.renewed ? " usagep__window--renewed" : ""}`}
      data-window={window.id}
      data-old={window.old || undefined}
      data-renewed={window.renewed || undefined}
      title={title || undefined}
    >
      <span className="usagep__label">{window.label}</span>
      {window.percent === null ? (
        <span className="usagep__bar usagep__bar--empty" role="img" aria-label={`${aria}: ${window.text}`} />
      ) : (
        <span className="usagep__bar" role="meter" aria-label={aria} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.percent}>
          <span className="usagep__fill" style={{ width: `${window.percent}%` }} />
        </span>
      )}
      <span className="usagep__pct ui-tabular" data-testid="usage-pct">
        {window.percent === null ? (window.renewed ? "↻ renovada" : "–") : `${window.percent}%`}
      </span>
      {note && (
        <span className={`usagep__note${window.old && !window.renewed ? " usagep__note--old" : ""}`} data-testid={window.old && !window.renewed ? "usage-window-age" : undefined}>
          {note}
        </span>
      )}
    </li>
  );
}

/** Os grupos de modelos do Antigravity sem uso, numa linha só ("3 grupos sem uso"), que abre para mostrar os nomes. */
function IdleGroups({ view }: { view: UsageView }) {
  const { idle } = splitIdleGroups(view.groups);
  if (idle.length === 0) return null;
  return (
    <details className="usagep__idle" data-testid="usage-idle-groups">
      <summary>{idle.length === 1 ? "1 grupo sem uso" : `${idle.length} grupos sem uso`}</summary>
      <ul>
        {idle.map((group) => (
          <li key={group.group}>
            {group.group} <span className="usagep__idle-pct ui-tabular">0%</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * O Freebuff: a cota dele é em HORAS ABERTAS. As horas do dia (lidas da tela do Freebuff = medido; o que o Cyno
 * abriu depois da leitura = estimado) e, por agente com a hora aberta, "hora em uso: restam 37 min" com a barra.
 */
function FreebuffBlock({ view }: { view: UsageView }) {
  const fb = view.freebuff!;
  return (
    <section className="usagep__block usagep__block--freebuff" data-provider="freebuff" data-testid="usage-provider" aria-label="Freebuff">
      <header className="usagep__head">
        <h3 className="usagep__provider">
          <span className="usage__badge" aria-hidden="true" />
          Freebuff
        </h3>
        {fb.measuredLabel && (
          <span className={`usagep__updated${fb.old ? " usagep__updated--old" : ""}`} data-testid="usage-updated">
            {fb.old ? "⏱ " : ""}
            {fb.measuredLabel}
          </span>
        )}
      </header>
      <ul className="usagep__windows">
        <li className={`usagep__window usagep__window--${fb.tone}${fb.old ? " usagep__window--old" : ""}`} data-window="daily_hours" data-testid="freebuff-hours">
          <span className="usagep__label">Horas do dia</span>
          {fb.percent === null ? (
            <span className="usagep__bar usagep__bar--empty" role="img" aria-label="Freebuff · horas do dia: sem leitura" />
          ) : (
            <span className="usagep__bar" role="meter" aria-label="Freebuff · horas do dia" aria-valuemin={0} aria-valuemax={100} aria-valuenow={fb.percent}>
              <span className="usagep__fill" style={{ width: `${fb.percent}%` }} />
            </span>
          )}
          <span className="usagep__pct ui-tabular" data-testid="freebuff-hours-text">
            {fb.shortText}
          </span>
          <span className={`usagep__note${fb.old ? " usagep__note--old" : ""}`}>
            {[fb.resetLabel, fb.wallet !== undefined && fb.wallet > 0 ? `${hoursLabel(fb.wallet)} na carteira` : "", fb.estimated ? `estimado: o Cyno abriu ${hoursLabel(fb.openedSince)} depois da leitura` : fb.total !== undefined ? "medido na tela do Freebuff" : ""]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </li>
      </ul>
      {fb.sessions.length === 0 && fb.pending.length === 0 && <p className="usagep__empty">Nenhuma hora aberta agora (a hora abre na primeira mensagem de um agente).</p>}
      {fb.sessions.length > 0 && (
        <ul className="usagep__hours" aria-label="Horas abertas" data-testid="freebuff-sessions">
          {fb.sessions.map((session) => (
            <li key={session.key} className="usagep__hour" data-testid="freebuff-session" data-agent-id={session.agentId} title={`${session.modelLabel}\n${session.measured ? "Fim da hora lido do arquivo da sessão do Freebuff." : "Fim da hora estimado (abertura + 60 min)."}`}>
              <span className="usagep__hour-who">{session.agentName}</span>
              <span className="usagep__hour-left" data-testid="freebuff-session-left">
                {session.label}
              </span>
              <span className="usagep__bar" role="meter" aria-label={`${session.agentName}: ${session.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={session.elapsedPercent}>
                <span className="usagep__fill usagep__fill--hour" style={{ width: `${session.elapsedPercent}%` }} />
              </span>
              <span className="usagep__note">
                {session.untilLabel} · {session.modelLabel}
                {!session.hasProcess && " · sem processo agora (reabre na próxima tarefa)"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {fb.pending.length > 0 && (
        <p className="usagep__fbnote" data-testid="freebuff-pending">
          Abrindo a hora: {fb.pending.join(", ")}.
        </p>
      )}
      <p className="usagep__fbnote" data-testid="freebuff-model">
        {fb.modelLine}. No máximo {fb.maxOpenHours} {fb.maxOpenHours === 1 ? "hora aberta" : "horas abertas"} ao mesmo tempo.
      </p>
    </section>
  );
}

const hoursLabel = (hours: number) => `${Math.round(hours * 10) / 10} h`.replace(".", ",");

/** Um motor: nome com o selo da cor dele, atualização, atualizar agora e as janelas (por grupo, no Antigravity). */
function PanelProvider({ view, now }: { view: UsageView; now: number }) {
  if (view.freebuff) return <FreebuffBlock view={view} />;
  const { shown } = splitIdleGroups(view.groups);
  const grouped = view.groups.some((group) => group.group !== "");
  return (
    <section className={`usagep__block usagep__block--${view.provider}`} data-provider={view.provider} data-testid="usage-provider" aria-label={view.providerLabel}>
      <header className="usagep__head">
        <h3 className="usagep__provider">
          <span className="usage__badge" aria-hidden="true" />
          {view.providerLabel}
        </h3>
        {view.updatedLabel && (
          <span className={`usagep__updated${view.old ? " usagep__updated--old" : ""}`} data-testid="usage-updated">
            {view.updatedLabel}
          </span>
        )}
        {view.account && (view.provider === "claude" || view.provider === "gemini") && <RefreshButton provider={view.provider} label={view.providerLabel} />}
      </header>
      {view.stale && (
        <p className="usagep__stale" data-testid="usage-stale">
          <span aria-hidden="true">⚠</span> {view.stale}
          {view.windows.length > 0 && <span className="usagep__stale-note"> · mostrando o último valor</span>}
        </p>
      )}
      {view.windows.length === 0 && !view.stale && <p className="usagep__empty">Sem leitura ainda.</p>}
      {(grouped ? shown : view.groups).map((group) => (
        <div key={group.group} className="usagep__group" data-group={group.group}>
          {group.group && <h4 className="usagep__group-name">{group.group}</h4>}
          <ul className="usagep__windows">
            {group.windows.map((window) => (
              <PanelWindow key={window.id} view={view} window={window} now={now} />
            ))}
          </ul>
        </div>
      ))}
      {grouped && <IdleGroups view={view} />}
    </section>
  );
}

/** Há agente do Antigravity neste workspace, mas nenhuma cota dele chegou (consulta desligada ou agy ausente)? */
function useMissingAntigravity(views: UsageView[]): boolean {
  const hasGeminiAgent = useOfficeStore((state) => state.office?.agents.some((agent) => agent.engine === "gemini") ?? false);
  return hasGeminiAgent && !views.some((view) => view.provider === "gemini");
}

/**
 * O painel de detalhe do uso do plano (abre ao lado do menu; no celular, a folha): no topo a janela
 * mais perto do limite, depois um bloco por motor, com as janelas (barra, porcentagem, renovação em
 * forma curta, idade só quando o dado é antigo), os grupos do Antigravity sem uso recolhidos, o
 * atualizar por motor e, com um workspace aberto, o "Por agente" e os avisos do workspace.
 */
export function UsagePanel({ onClose, titleId }: { onClose: () => void; titleId?: string }) {
  const views = useUsageViews();
  const now = useNow().getTime();
  const workspaceId = useNavStore((state) => state.workspaceId);
  const missingAntigravity = useMissingAntigravity(views) && Boolean(workspaceId);
  return <UsagePanelView views={views} now={now} workspaceOpen={Boolean(workspaceId)} missingAntigravity={missingAntigravity} onClose={onClose} {...(titleId ? { titleId } : {})} />;
}

/** O painel em si, a partir das leituras (separado do UsagePanel para dar para testar sem as lojas). */
export function UsagePanelView({
  views,
  now,
  workspaceOpen,
  missingAntigravity,
  onClose,
  titleId,
}: {
  views: UsageView[];
  now: number;
  workspaceOpen: boolean;
  missingAntigravity: boolean;
  onClose: () => void;
  titleId?: string;
}) {
  const closest = useMemo(() => closestToLimit(views), [views]);
  const [info, setInfo] = useState(false);
  return (
    <>
      <header className="usagep__top">
        <h2 className="usagep__title" id={titleId}>
          Uso do plano
        </h2>
        <button type="button" className="usagep__icon-button" aria-label="Sobre estes números" aria-expanded={info} onClick={() => setInfo((on) => !on)} data-testid="usage-info">
          i
        </button>
        <button type="button" className="usagep__icon-button" aria-label="Fechar" onClick={onClose} data-testid="usage-close">
          <NavIcon name="close" />
        </button>
      </header>
      {info && (
        <p className="usagep__info" data-testid="usage-info-text">
          Os limites são da conta inteira (inclui o que você usa fora daqui). As assinaturas só informam esses números; o gasto por agente, abaixo, é uma soma estimada.
        </p>
      )}
      <div className="usagep__body" data-testid="usage-panel-body">
        {views.length === 0 && (
          <p className="usagep__empty" data-testid="usage-empty">
            Nenhuma leitura de uso ainda. Quando o Claude Code ou o Antigravity informarem os limites da conta, eles aparecem aqui.
          </p>
        )}
        {closest && (
          <section className={`usagep__closest usagep__closest--${closest.window.tone}`} aria-label="Mais perto do limite" data-testid="usage-closest">
            <h3 className="usagep__section">Mais perto do limite</h3>
            <p className="usagep__closest-line">
              <span className="usagep__closest-name">
                {closest.view.providerLabel} · {windowFullLabel(closest.window)}
              </span>
              <span className="usagep__closest-pct ui-tabular">{closest.window.percent}%</span>
            </p>
            <span className="usagep__bar usagep__bar--big" role="presentation">
              <span className="usagep__fill" style={{ width: `${closest.window.percent}%` }} />
            </span>
            {shortReset(closest.window.resetsAt, now) && (
              <p className="usagep__closest-reset" title={closest.window.resetLabel}>
                renova {shortReset(closest.window.resetsAt, now)}
              </p>
            )}
          </section>
        )}
        {views.map((view) => (
          <PanelProvider key={view.provider} view={view} now={now} />
        ))}
        {missingAntigravity && (
          <section className="usagep__block usagep__block--gemini" data-provider="gemini" data-testid="usage-provider">
            <header className="usagep__head">
              <h3 className="usagep__provider">
                <span className="usage__badge" aria-hidden="true" />
                Antigravity
              </h3>
            </header>
            <p className="usagep__empty">Sem a cota da conta Google ainda (consulta desligada ou agy não encontrado). O uso estimado por agente aparece abaixo.</p>
          </section>
        )}
        {workspaceOpen && (
          <AgentUsage
            onOpenSpend={() => {
              onClose();
              openSpend();
            }}
          />
        )}
      </div>
    </>
  );
}
