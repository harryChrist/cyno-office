import type { StoredReport } from "@cyno/shared";
import { ARROWS, isHttpUrl, quotaLines, reportModel, type Arrow, type ModelItem } from "./model";

const arrow = (value: Arrow): string => (value ? ARROWS[value] : "—");

/**
 * Texto que vem dos dados (título de tarefa, nome de agente, parágrafo de IA) entra no Markdown como TEXTO: sem quebra de
 * linha dentro do campo, sem `#`, `>`, marcador de lista ou `---` no começo, e sem `[]<>` nem crases (que abririam título,
 * citação, lista, link ou HTML). A pontuação comum fica como está, para o texto continuar legível.
 */
export function mdText(text: string): string {
  let out = text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").trim();
  out = out.replace(/([\\`[\]<>])/g, "\\$1").replace(/\\\]\(/g, "\\]\\(");
  out = out.replace(/^(#|>|[-+*](?=\s|$)|\d+[.)](?=\s|$)|={2,}$|-{3,}$|\|)/, "\\$1");
  return out;
}

const cell = (text: string): string => mdText(text).replace(/\|/g, "\\|");

function itemLine(item: ModelItem): string {
  const where = item.link?.kind === "task" ? ` (projeto ${mdText(item.link.projectId)}, tarefa ${mdText(item.link.ref)})` : "";
  // O endereço entra como link só com http(s) e sem caracteres que fechariam o link; o resto é texto.
  const safe = item.link?.kind === "url" && isHttpUrl(item.link.url) && !/[\s()<>]/.test(item.link.url.trim()) ? item.link.url.trim() : undefined;
  const title = safe ? `[${cell(item.title)}](${safe})` : mdText(item.title);
  const shown = item.link?.kind === "url" && !safe ? ` · ${mdText(item.link.url)}` : "";
  return `- ${title} · ${mdText(item.meta)}${where}${shown}`;
}

/**
 * O relatório em Markdown (tabelas simples, pt-BR): é o que o Cyno e o Maestro leem e o que o botão "Markdown" baixa.
 * Mesmo modelo do HTML (`reportModel`): os dois dizem a mesma coisa. Valores em dólar sempre "equivalentes".
 */
export function renderReportMarkdown(report: StoredReport): string {
  const m = reportModel(report);
  const out: string[] = [];
  out.push(`# ${mdText(m.title)} · ${mdText(m.subtitle)}`, "", `**${mdText(m.workspaceName)}** · ${mdText(m.generated)}`, "");
  for (const warning of m.warnings) out.push(`> ${mdText(warning)}`, "");
  out.push(`**Em uma linha:** ${mdText(m.headline)}`, "");

  if (m.ai) out.push(`## O que mudou (escrito pelo ${mdText(m.ai.by)})`, "", mdText(m.ai.text), "");

  out.push("## Números", "", "| Indicador | Valor | Detalhe |", "|---|---|---|");
  for (const kpi of m.kpis) out.push(`| ${cell(kpi.label)} | ${`${cell(kpi.value)} ${kpi.arrow ? arrow(kpi.arrow) : ""}`.trim()} | ${cell(kpi.sub)} |`);
  out.push("");

  if (m.compare.length > 0) {
    out.push(`## ${mdText(m.compareTitle)}`, "", "| Indicador | Agora | Antes | Variação | Observação |", "|---|---|---|---|---|");
    for (const row of m.compare) out.push(`| ${cell(row.label)} | ${cell(row.now)} | ${cell(row.prev)} | ${arrow(row.arrow)} | ${cell(row.note)} |`);
    out.push("");
  }

  if (m.compareNote) out.push(`## ${mdText(m.compareTitle)}`, "", mdText(m.compareNote), "");
  if (m.seriesNote) out.push(`## ${mdText(m.seriesNote.title)}`, "", mdText(m.seriesNote.text), "");

  if (m.series) {
    out.push(`## ${mdText(m.series.title)}`, "", "| Semana | Entregas | Média de 4 semanas |", "|---|---|---|");
    m.series.bars.forEach((bar, index) => out.push(`| ${cell(bar.label)}${bar.current ? " (esta)" : ""} | ${bar.value} | ${m.series!.avg[index] === null || m.series!.avg[index] === undefined ? "—" : String(m.series!.avg[index]).replace(".", ",")} |`));
    out.push("");
  }

  if (m.weeks) {
    out.push("## Semanas guardadas", "", "| Semana | Período | Entregas | Gasto equivalente | Recusado | Metas |", "|---|---|---|---|---|---|");
    for (const week of m.weeks) out.push(`| ${cell(week.period)} | ${cell(week.label)} | ${week.deliveries} | US$ ${week.costUsd.toFixed(2).replace(".", ",")} | ${cell(week.rejection)} | ${cell(String(week.goals))} |`);
    out.push("");
  }

  out.push("## O que cada agente fez", "");
  if (m.agents.length === 0) out.push("Nenhuma entrega no período.", "");
  for (const agent of m.agents) {
    out.push(`### ${mdText(agent.name)} (${agent.count})`, "", ...agent.items.map(itemLine));
    if (agent.more > 0) out.push(`- … e mais ${agent.more}`);
    out.push("");
  }

  if (m.goals.length > 0) {
    out.push("## Metas", "", "| Meta | Entregue | Resultado |", "|---|---|---|");
    for (const goal of m.goals) out.push(`| ${cell(goal.title)} | ${cell(goal.text)} | ${goal.skipped ? "pulada" : goal.ok ? "bateu" : "não bateu"} |`);
    out.push("");
  }

  for (const section of m.next ?? []) out.push(`## ${mdText(section.title)}`, "", ...section.lines.map((line) => `- ${mdText(line)}`), "");
  if (m.attention.length > 0) {
    out.push("## O que pede atenção", "");
    for (const block of m.attention) out.push(`**${mdText(block.title)}**`, "", ...block.lines.map((line) => `- ${mdText(line)}`), "");
  }

  out.push("## Custo e cota", "", ...m.cost.lines.map((line) => `- ${mdText(line)}`), ...quotaLines(m.cost.quota).map((line) => `- Cota · ${mdText(line)}`), "", `_${mdText(m.footer)}_`, "");
  return out.join("\n");
}
