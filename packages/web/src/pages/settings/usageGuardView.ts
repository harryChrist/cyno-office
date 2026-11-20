import { resumeTimeLabel, usagePercent, USAGE_GUARD_MIN_PERCENT, type UsageGuardRuleView, type UsageGuardView } from "@cyno/shared";

/** O estado de uma linha em texto curto (a tela mostra sempre em palavras, a cor só reforça). */
export type GuardRowState = { text: string; tone: "paused" | "warn" | "ok" | "idle" };

/** As horas aparecem no horário de Brasília, como nos avisos do servidor (não no fuso do navegador). */
const ZONE = "America/Sao_Paulo";

/** "às 14:30" ou, se for outro dia, "em 22/11 14:30". */
function whenLabel(iso: string, now: number): string {
  const label = resumeTimeLabel(iso, now, ZONE);
  return `${label.includes(" ") ? "em" : "às"} ${label}`;
}

/** "Pausado · volta às 14:30" / "62% de uso" / "62% de uso · liberado até as 14:30" / "Desligada · 62% de uso" / "Sem leitura". */
export function guardRowState(rule: UsageGuardRuleView, now: number): GuardRowState {
  if (rule.paused) return { text: `Pausado${rule.resumesAt ? ` · volta ${whenLabel(rule.resumesAt, now)}` : ""}`, tone: "paused" };
  if (rule.utilization === undefined) return { text: rule.enabled ? "Sem leitura" : "Desligada", tone: "idle" };
  const percent = usagePercent(rule.utilization);
  // Desligada: o uso continua à vista, para decidir se vale ligar.
  if (!rule.enabled) return { text: `Desligada · ${percent}% de uso`, tone: "idle" };
  // Liberada na mão: o uso segue acima do limite, mas a regra só volta a pausar depois desta hora (ou se for alterada).
  if (rule.releasedUntil) {
    const until = resumeTimeLabel(rule.releasedUntil, now, ZONE);
    return { text: `${percent}% de uso · liberado até ${until.includes(" ") ? "" : "as "}${until}`, tone: "warn" };
  }
  return { text: `${percent}% de uso`, tone: percent >= rule.percent - 10 ? "warn" : "ok" };
}

export type GuardEngineGroup = { engine: string; engineLabel: string; rules: UsageGuardRuleView[] };

/** As linhas agrupadas por motor, na ordem em que o servidor mandou. */
export function groupGuardRules(view: Pick<UsageGuardView, "rules">): GuardEngineGroup[] {
  const groups: GuardEngineGroup[] = [];
  for (const rule of view.rules) {
    const group = groups.find((item) => item.engine === rule.engine);
    if (group) group.rules.push(rule);
    else groups.push({ engine: rule.engine, engineLabel: rule.engineLabel, rules: [rule] });
  }
  return groups;
}

/** Limita o que o dono digitou ao intervalo aceito (10 a 100) ou devolve undefined se não for um número. */
export function parseGuardPercent(text: string): number | undefined {
  const value = Number(text.replace("%", "").trim().replace(",", "."));
  if (!Number.isFinite(value) || text.trim() === "") return undefined;
  return Math.min(100, Math.max(USAGE_GUARD_MIN_PERCENT, Math.round(value)));
}
