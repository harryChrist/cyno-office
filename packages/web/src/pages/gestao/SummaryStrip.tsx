import { isDeadlineAtRisk, type ManagementSummary } from "@cyno/shared";
import { useNow } from "../../ui/ActivityFeed";
import { useNavStore } from "../../store/navStore";
import { openSpend } from "../../store/navTargets";
import { useWorkStore } from "../../store/workStore";
import { GIcon } from "./GIcon";
import { formatBrl, quotaBars, troubleParts, verdictSentence, waitingParts } from "./gestaoView";

/** Faixa compacta do topo da Gestão: veredito, o que espera você, falhas, cota e gasto da semana. */
export function SummaryStrip({ summary, trackings = 0 }: { summary: ManagementSummary; /** Acompanhamentos ativos (a frase não diz "nenhuma meta" quando só há eles). */ trackings?: number }) {
  const go = useNavStore((state) => state.go);
  const verdict = verdictSentence(summary.goals, trackings);
  const waiting = waitingParts(summary.waiting);
  const trouble = troubleParts(summary.tasks);
  const now = useNow().getTime();
  const bars = quotaBars(summary.quota, now);
  const urgent = summary.waiting.olderThan24h > 0;
  const atRisk = useWorkStore((state) => state.projects.filter((project) => isDeadlineAtRisk(project, Date.parse(summary.at))).length);

  return (
    <section className="gs" aria-label="Resumo da gestão" data-testid="gestao-summary">
      <p className={`gs__verdict gs__verdict--${verdict.tone}`} data-testid="gestao-verdict">
        <GIcon name={verdict.tone === "warn" ? "alert" : verdict.tone === "ok" ? "check" : "pause"} size={16} />
        {verdict.text}
      </p>
      <div className="gs__cells">
        <div className="gs__cell">
          <span className="gs__label">Esperando você</span>
          <button type="button" className={`gs__value gs__link${urgent ? " gs__value--warn" : ""}`} onClick={() => go("para-voce")} data-testid="gestao-waiting">
            {summary.waiting.count === 0 ? "Nada" : summary.waiting.count}
            <GIcon name="inbox" size={13} />
          </button>
          <span className="gs__sub">{waiting.details.length > 0 ? waiting.details.join(" · ") : "Tudo em dia"}</span>
        </div>
        <div className="gs__cell">
          <span className="gs__label">Tarefas com problema</span>
          <button type="button" className={`gs__value gs__link${trouble.failed + trouble.blocked > 0 ? " gs__value--danger" : ""}`} onClick={() => go("trabalho")} data-testid="gestao-trouble">
            {trouble.failed + trouble.blocked}
            <GIcon name="alert" size={13} />
          </button>
          <span className="gs__sub">{trouble.text}</span>
          {atRisk > 0 && (
            <button
              type="button"
              className="gs__risk gs__sub--warn gs__link"
              onClick={() => {
                useWorkStore.getState().openFiltered(true);
                go("trabalho");
              }}
              data-testid="gestao-at-risk"
            >
              {atRisk === 1 ? "1 projeto com prazo em risco" : `${atRisk} projetos com prazo em risco`}
            </button>
          )}
        </div>
        <div className="gs__cell gs__cell--quota">
          <span className="gs__label">Cota da assinatura</span>
          {bars.length === 0 ? (
            <span className="gs__sub">Sem leitura de uso</span>
          ) : (
            <ul className="gs__quota">
              {bars.map((bar) => (
                <li key={bar.key} className="gs__bar" data-tone={bar.tone} data-old={bar.old || undefined} data-renewed={bar.renewed || undefined} title={bar.old ? `Leitura de ${bar.ageLabel}: pode não refletir o uso de agora` : bar.ageLabel ? `Atualizado ${bar.ageLabel}` : undefined}>
                  <span className="gs__bar-label">{bar.label}</span>
                  <span className="gs__bar-track" role="progressbar" aria-label={`Uso ${bar.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={bar.percent ?? undefined} aria-valuetext={bar.percent === null ? bar.text : undefined}>
                    <span className="gs__bar-fill" style={{ width: `${bar.percent ?? 0}%` }} />
                  </span>
                  <span className="gs__bar-value">{bar.percent === null ? (bar.renewed ? "↻ renovada" : "–") : `${bar.percent}%`}</span>
                  {bar.old && !bar.renewed && <span className="gs__bar-age" data-testid="gestao-quota-age">{bar.ageLabel}</span>}
                </li>
              ))}
            </ul>
          )}
          {summary.enginesBlocked.length > 0 && <span className="gs__sub gs__sub--warn">{summary.enginesBlocked.map((engine) => engine.label).join(", ")} sem cota</span>}
        </div>
        <div className="gs__cell">
          <span className="gs__label">Gasto da semana</span>
          <button type="button" className="gs__value gs__link" onClick={() => openSpend()} data-testid="gestao-spend">
            {formatBrl(summary.weekSpend.costBrl)}
            <GIcon name="link" size={13} />
          </button>
          <span className="gs__sub">{summary.weekSpend.turns} {summary.weekSpend.turns === 1 ? "turno" : "turnos"} dos agentes</span>
        </div>
      </div>
    </section>
  );
}
