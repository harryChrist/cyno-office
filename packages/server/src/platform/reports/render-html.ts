import type { PlatformReport, ReportDigest } from "@cyno/shared";
import { ptDuration, ptPercent, ptUsd } from "../../workspace/reports/model";
import { esc, REPORT_CSS } from "../../workspace/reports/render-html";

/**
 * A semana da plataforma como uma página HTML autossuficiente (o mesmo visual e o mesmo CSS dos relatórios dos workspaces: nada de
 * rede, sem script). Abre dentro do iframe isolado do app, como a revisão da semana de cada workspace.
 */

const rate = (value: { hits: number; n: number }): string => (value.n === 0 ? "—" : `${ptPercent(value.hits / value.n)} (${value.hits} de ${value.n}${value.n < 5 ? ", poucos dados" : ""})`);
const goals = (digest: ReportDigest): string => (digest.goals.total === 0 ? "—" : `${digest.goals.hit} de ${digest.goals.total}`);

export function renderPlatformReportHtml(report: PlatformReport): string {
  const t = report.total;
  const out: string[] = [];
  out.push(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Semana da plataforma · ${esc(report.period)}</title><style>${REPORT_CSS}</style></head><body><main class="page">`);
  out.push(`<header class="head"><div><p class="eyebrow">Plataforma</p><h1>Semana da plataforma</h1><p class="sub">${esc(report.period)} · ${report.workspaces.length} ${report.workspaces.length === 1 ? "workspace" : "workspaces"}</p></div><p class="meta"><strong>Fechado</strong><br>gerado por código em ${esc(new Date(report.generatedAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }))}</p></header>`);
  out.push(`<p class="headline">${t.deliveries} ${t.deliveries === 1 ? "entrega" : "entregas"} na plataforma, com gasto equivalente à API de ${esc(ptUsd(t.spendUsd))} (a conta é assinatura: leia junto da cota).</p>`);
  out.push(`<section class="kpis" aria-label="Números principais">`);
  const kpi = (label: string, value: string, sub: string) => out.push(`<div class="card kpi"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub2">${esc(sub)}</div></div>`);
  kpi("Entregas", String(t.deliveries), "soma de todos os workspaces");
  kpi("Gasto equivalente", ptUsd(t.spendUsd), t.costPerDelivery === null ? "sem entregas para dividir" : `${ptUsd(t.costPerDelivery)} por entrega`);
  kpi("Recusado", t.rejection.n === 0 ? "—" : ptPercent(t.rejection.hits / t.rejection.n), t.rejection.n === 0 ? "nenhuma decisão" : `${t.rejection.hits} de ${t.rejection.n} decisões`);
  kpi("Metas batidas", goals(t), "no fechamento da semana");
  out.push("</section>");
  out.push(`<section><h2>Por workspace</h2><div class="card"><table><thead><tr><th>Workspace</th><th class="num">Entregas</th><th class="num">Gasto equivalente</th><th class="num">Tempo até entregar</th><th class="num">Recusado</th><th class="num">Metas</th><th>Mais entregou</th></tr></thead><tbody>`);
  for (const block of report.workspaces) {
    const cycle = block.digest.cycle.median === null ? "—" : `${ptDuration(block.digest.cycle.median)}${block.digest.cycle.n < 5 ? " (poucos dados)" : ""}`;
    out.push(`<tr><td>${esc(block.name)}</td><td class="num">${block.deliveries}</td><td class="num">${esc(ptUsd(block.digest.spendUsd))}</td><td class="num">${esc(cycle)}</td><td class="num">${esc(rate(block.digest.rejection))}</td><td class="num">${esc(goals(block.digest))}</td><td>${esc(block.bestAgent ?? "—")}</td></tr>`);
  }
  out.push("</tbody></table></div></section>");
  out.push(`<section><h2>Em conjunto</h2><div class="card cost"><ul class="lines"><li>Refeito a pedido: ${esc(rate(t.rework))}</li><li>Falhas: ${esc(rate(t.failure))}</li><li>Textos que você editou: ${esc(rate(t.edit))}</li>${t.quotaPeak === null ? "" : `<li class="q">Cota: o maior uso entre as janelas foi ${Math.round(t.quotaPeak)}%</li>`}</ul></div></section>`);
  out.push(`<footer>Calculado por código sobre as revisões da semana de cada workspace; uma vez gerada, não muda. Valores em dólar são equivalentes à API.</footer></main></body></html>`);
  return out.join("");
}
