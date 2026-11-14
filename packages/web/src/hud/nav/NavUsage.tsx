import { useMemo } from "react";
import { useNavLayoutStore } from "../../store/navLayoutStore";
import { NavIcon } from "../navIcons";
import { planRows, planSummary, type UsageView } from "../usage";
import { useUsageViews } from "../UsageMeter";
import { usePlatformUsage } from "../usePlatformUsage";
import { openPanel } from "./NavItems";

/**
 * "Uso do plano" no rodapé do menu (e da gaveta no celular), sempre à vista: uma linha por motor com a
 * barra da janela mais apertada dele e a porcentagem; ⏱ quando o dado é antigo. Com o menu recolhido
 * vira o ícone com o ponto de alerta. Clicar abre o painel de detalhe (UsagePanel). Sem nenhuma leitura
 * de uso, não aparece.
 */
export function NavUsage({ onBeforeOpen }: { onBeforeOpen?: () => void }) {
  // O uso é da conta, mas só o socket de um workspace o alimentava: aqui ele é buscado também fora de um.
  usePlatformUsage();
  const views = useUsageViews();
  const open = useNavLayoutStore((state) => state.panel === "uso");
  return <NavUsageView views={views} open={open} {...(onBeforeOpen ? { onBeforeOpen } : {})} />;
}

/** O bloco em si, a partir das leituras (separado do NavUsage para dar para testar sem as lojas). */
export function NavUsageView({ views, open, onBeforeOpen }: { views: UsageView[]; open: boolean; onBeforeOpen?: () => void }) {
  const rows = useMemo(() => planRows(views), [views]);
  const summary = useMemo(() => planSummary(views), [views]);
  if (rows.length === 0) return null;
  const dot = summary.tone !== "ok" ? summary.tone : summary.old ? "warn" : null;
  return (
    <button
      type="button"
      className={`navitem navusage navusage--${summary.tone}`}
      aria-label={`${summary.label}. Abrir detalhes`}
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={() => {
        onBeforeOpen?.();
        openPanel("uso");
      }}
      data-tip={summary.label}
      data-panel-trigger="uso"
      data-testid="nav-usage"
    >
      <span className="navusage__head">
        <span className="navitem__icon-wrap">
          <NavIcon name="uso" />
          {dot && <span className={`navusage__dot navusage__dot--${dot}`} aria-hidden="true" data-testid="nav-usage-dot" />}
        </span>
        <span className="navitem__label navusage__title">Uso do plano</span>
      </span>
      <span className="navusage__rows" aria-hidden="true">
        {rows.map((row) => (
          <span key={row.provider} className={`navusage__row navusage__row--${row.tone}${row.old ? " navusage__row--old" : ""}`} title={row.title} data-provider={row.provider} data-testid="nav-usage-row">
            <span className="navusage__name">{row.providerLabel}</span>
            <span className="navusage__bar">
              {row.percent !== null && <span className="navusage__fill" style={{ width: `${row.percent}%` }} />}
            </span>
            <span className="navusage__pct ui-tabular" data-testid="nav-usage-pct">
              {row.old && row.percent !== null && <span className="navusage__old">⏱</span>}
              {row.valueText ?? (row.percent !== null ? `${row.percent}%` : row.text === "renovada" ? "↻" : "–")}
            </span>
          </span>
        ))}
      </span>
    </button>
  );
}
