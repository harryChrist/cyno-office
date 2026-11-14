import { parseGestaoWeekly, GESTAO_WEEKDAY_LABELS, GESTAO_WEEKDAYS, REPORT_KINDS, type ReportKind, type ReportList, type ReportListItem } from "@cyno/shared";

/** As três listas da aba Relatórios; a quarta opção, "O que aprendemos" (a retrospectiva), tem o próprio painel. */
export const REPORT_TABS: readonly { id: ReportKind; label: string }[] = [
  { id: "day", label: "Dia" },
  { id: "week", label: "Semana" },
  { id: "month", label: "Mês" },
];

/** As opções do seletor: os três tipos de relatório e a retrospectiva. */
export type ReportTabId = ReportKind | "retro";
export const RETRO_TAB: { id: "retro"; label: string } = { id: "retro", label: "O que aprendemos" };

const TIME_ZONE = "America/Sao_Paulo";
const dayFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: TIME_ZONE, weekday: "short", day: "2-digit", month: "2-digit" });
const shortDay = new Intl.DateTimeFormat("pt-BR", { timeZone: TIME_ZONE, day: "numeric", month: "numeric" });
const clockFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: TIME_ZONE, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const monthFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", month: "long", year: "numeric" });

const strip = (text: string): string => text.replace(/\./g, "");

/** Os relatórios de um tipo, do período mais novo ao mais antigo. */
export function itemsOf(list: ReportList | null, kind: ReportKind): ReportListItem[] {
  return (list?.items ?? []).filter((item) => item.kind === kind).sort((a, b) => b.period.localeCompare(a.period));
}

/** "sex 13/11", "Semana 46 · 9/11 a 15/11", "novembro de 2026". */
export function itemLabel(item: ReportListItem): string {
  if (item.kind === "day") return strip(dayFormat.format(new Date(`${item.period}T12:00:00-03:00`)));
  if (item.kind === "week") {
    const last = new Date(Date.parse(item.to) - 3_600_000);
    return `Semana ${Number(/-W(\d+)$/.exec(item.period)?.[1] ?? 0)} · ${shortDay.format(new Date(item.from))} a ${shortDay.format(last)}`;
  }
  const [year, month] = item.period.split("-").map(Number);
  return monthFormat.format(new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, 15)));
}

/** A segunda linha da lista: "12 entregas · fechado" ou "parcial". */
export function itemSub(item: ReportListItem): string {
  const count = `${item.deliveries} ${item.deliveries === 1 ? "entrega" : "entregas"}`;
  return `${count} · ${item.final ? "fechado" : "parcial"}${item.hasAi ? " · com parágrafo do Maestro" : ""}`;
}

/** O texto curto de cada opção do seletor do celular (cabe em 390 px sem cortar): o período e, se ainda não fechou, "parcial". */
export function selectLabel(item: ReportListItem): string {
  return `${itemLabel(item)}${item.final ? "" : " · parcial"}`;
}

/** Quando o relatório foi montado, para a linha de cima do relatório aberto. */
export function generatedText(item: ReportListItem): string {
  return `Gerado ${strip(clockFormat.format(new Date(item.generatedAt)))} · ${item.final ? "fechado e guardado" : "parcial: será refeito quando o período fechar"}`;
}

/** O item aberto: o que já estava, se ainda existe; senão o mais novo. */
export function pickSelection(items: readonly ReportListItem[], current: string | null): string | null {
  if (current && items.some((item) => item.period === current)) return current;
  return items[0]?.period ?? null;
}

/** "A primeira revisão sai na segunda, 08:30." e as frases dos outros tipos (o estado vazio diz o que falta). */
export function emptyMessage(kind: ReportKind, settings: ReportList["settings"] | undefined): string {
  if (kind === "week") {
    const parsed = settings ? parseGestaoWeekly(settings.weekly) : undefined;
    const day = parsed ? GESTAO_WEEKDAY_LABELS[GESTAO_WEEKDAYS[parsed.weekday - 1]!] : "segunda";
    const time = settings?.weekly.split(/\s+/)[1] ?? "08:30";
    return `A primeira revisão sai na ${day}, ${time}.`;
  }
  if (kind === "day") return settings?.dailyAt ? `O primeiro resumo do dia sai hoje às ${settings.dailyAt}, se houver movimento.` : "O resumo do dia está desligado nas Configurações: ele só sai quando você pede.";
  return "O resumo do mês sai quando a última semana do mês fecha, somando as semanas guardadas.";
}

/** O texto do botão de gerar de cada tipo. */
export const GENERATE_LABEL: Record<ReportKind, string> = { day: "Gerar a de agora", week: "Gerar a de agora", month: "Gerar a do mês" };

/** Nome do arquivo baixado ("relatorio-week-2026-W46.md"). */
export function downloadName(kind: ReportKind, period: string, extension: string): string {
  return `relatorio-${kind}-${period}.${extension}`;
}

/**
 * A página do relatório para o `srcdoc`: o mesmo HTML do servidor, mais uma política (CSP) sem script nenhum dentro dele.
 * Junto do `sandbox` do iframe (sem `allow-scripts`), o relatório não consegue rodar código nem alcançar a sessão do app.
 */
export function sandboxedHtml(html: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`;
  // Dentro do app a moldura tem a altura do conteúdo e quem rola é a página: o documento nunca mostra a própria barra de rolagem
  // (era ela, clara e grossa, que aparecia ao lado do relatório).
  const embedded = `${policy}<style>html{overflow:hidden}</style>`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (head) => `${head}${embedded}`) : `${embedded}${html}`;
}

/** O `sandbox` do iframe do relatório: sem scripts e sem formulários; `allow-same-origin` só para o botão "Salvar PDF" chamar `print()` e medir a altura (sem script lá dentro, não há com o que abusar); links abrem em aba nova, fora do sandbox. */
export const REPORT_FRAME_SANDBOX = "allow-same-origin allow-modals allow-popups allow-popups-to-escape-sandbox";

export { REPORT_KINDS };
