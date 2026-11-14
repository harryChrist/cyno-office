import { USAGE_TONE_AMBER, USAGE_TONE_RED, type StoredReport } from "@cyno/shared";
import { ARROWS, isHttpUrl, reportModel, type Arrow, type ModelItem, type QuotaModel, type ReportModel } from "./model";

/**
 * O relatório como UMA página HTML autossuficiente: CSS e gráficos SVG embutidos, nenhum pedido à rede (sem fontes da web,
 * sem script, sem imagem de fora, sem `@import`). Na tela segue o escuro do app; o `@media print` vira A4 claro, de uma ou duas
 * páginas. Todo texto que vem dos dados passa por `esc`. Os links só viram `<a>` se quem pede dá o endereço do app
 * (`linkBase`, só a origem): sem ele, aparecem como texto.
 */

/** Como `esc`, mas "2 h 58 min" não quebra entre o número e a unidade (nem no celular, em coluna estreita). */
export const escDur = (text: string): string => esc(text).replace(/(\d) (d|h|min|s)\b/g, "$1&nbsp;$2");

export const esc = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A origem do app que os links usam (só `http(s)://host[:porta]`); qualquer outra coisa é ignorada. */
export function safeLinkBase(base: string | undefined): string | undefined {
  const text = base?.trim().replace(/\/+$/, "");
  return text && /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(text) ? text : undefined;
}

export const REPORT_CSS = `
:root{color-scheme:dark;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.16) transparent;--bg:#0b0d1a;--surface:#15182e;--surface2:#1c2040;--border:rgba(255,255,255,.1);--text:#eef0fb;--text2:#c3c7e2;--muted:#a9aecf;--accent:#9d90ff;--accent-bg:rgba(139,124,255,.14);--ok:#3ddc97;--ok-bg:rgba(61,220,151,.12);--warn:#f5b544;--warn-bg:rgba(245,181,68,.13);--danger:#ff7d90;--bar:#8b7cff;--bar-soft:rgba(139,124,255,.35);--avg:#f5b544;color-scheme:dark}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;padding:36px 28px 48px;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
.page{max-width:960px;margin:0 auto}
header.head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:10px 28px;padding-bottom:20px;border-bottom:1px solid var(--border)}
.eyebrow{margin:0 0 6px;font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);font-weight:650}
h1{margin:0;font-size:32px;line-height:1.15;font-weight:700;letter-spacing:-.015em}
.sub{margin:6px 0 0;color:var(--text2);font-size:17px}
.meta{margin:0;color:var(--muted);font-size:13px;line-height:1.5;text-align:right}
.meta strong{color:var(--text2);font-weight:650}
.warn{margin:18px 0 0;padding:11px 14px;border-radius:10px;background:var(--warn-bg);border:1px solid rgba(245,181,68,.35);color:var(--warn);font-size:15px;line-height:1.5}
.headline{max-width:72ch;margin:22px 0 0;font-size:19px;line-height:1.45;font-weight:550;color:var(--text);text-wrap:pretty}
h2{margin:34px 0 12px;font-size:14px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);font-weight:650}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(196px,1fr));gap:12px;margin-top:20px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px 18px;break-inside:avoid}
.kpi .label{font-size:14px;color:var(--muted)}
.kpi .value{margin-top:4px;font-size:32px;line-height:1.1;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;white-space:nowrap}
.kpi .sub2{margin-top:6px;font-size:13px;line-height:1.45;color:var(--text2);text-wrap:pretty}
.arrow{display:inline-block;margin-left:6px;font-size:20px;color:var(--accent);font-weight:700}
.arrow.flat{color:var(--muted);font-weight:500}
.ai{margin-top:20px;border-color:rgba(139,124,255,.35);background:var(--accent-bg)}
.ai h3{margin:0 0 8px;font-size:13px;letter-spacing:.07em;text-transform:uppercase;color:var(--accent)}
.ai p{max-width:72ch;margin:0;font-size:16px;color:var(--text)}
.two{display:grid;grid-template-columns:minmax(0,1fr);gap:0 16px;align-items:start}
.two>div:only-child{grid-column:1/-1}
@media (min-width:980px){.two{grid-template-columns:minmax(0,1fr) minmax(0,1.1fr)}}
table{width:100%;border-collapse:collapse;font-size:15px;line-height:1.45;font-variant-numeric:tabular-nums}
th{padding:6px 10px;text-align:left;font-size:13px;font-weight:600;color:var(--muted);border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:top}
tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right}td.num{white-space:nowrap}
td .note{display:block;font-size:13px;color:var(--muted)}
.chart{display:block;width:100%;height:auto;max-height:290px}
.chart text{fill:var(--muted);font-size:13px;font-family:inherit}
.chart .val{fill:var(--text2);font-weight:600}
.chart .bar{fill:var(--bar)}
.chart .bar.cur{fill:var(--bar-soft);stroke:var(--bar);stroke-dasharray:4 3}
.chart .avg{fill:none;stroke:var(--avg);stroke-width:2}
.chart .dot{fill:var(--avg)}
.chart .grid{stroke:var(--border);stroke-width:1}
.legend{margin:8px 0 0;font-size:13px;color:var(--muted)}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:-1px;margin-right:4px}
.agents{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:12px;align-items:start}
.agent h3{display:flex;justify-content:space-between;align-items:baseline;margin:0 0 10px;font-size:17px}
.agent h3 span{font-size:13px;color:var(--text2);font-weight:600}
.share{height:5px;border-radius:3px;background:var(--surface2);margin:-2px 0 12px;overflow:hidden}
.share b{display:block;height:100%;background:var(--bar)}
.agent ul,.lines{margin:0;padding:0;list-style:none}
.agent li{padding:7px 0;border-top:1px solid var(--border);font-size:15px;line-height:1.45}
.agent li:first-child{border-top:0}
.agent li small{display:block;color:var(--muted);font-size:13px}
.more{color:var(--muted);font-size:13px;margin:8px 0 0}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.url{color:var(--text2);word-break:break-all}
.pill{display:inline-block;padding:1px 10px;border-radius:999px;font-size:13px;font-weight:600}
.pill.ok{background:var(--ok-bg);color:var(--ok)}
.pill.bad{background:var(--warn-bg);color:var(--warn)}
.pill.skip{background:var(--surface2);color:var(--muted)}
.attn{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.attn h3{margin:0 0 8px;font-size:15px}
.attn li{padding:4px 0;font-size:15px;line-height:1.45;color:var(--text2)}
.cost li{padding:3px 0;color:var(--text2);font-size:15px;max-width:76ch}
.quota{margin-top:14px;border-top:1px solid var(--border)}
.quota th.eng{padding:14px 10px 4px;font-size:14px;color:var(--text);border-bottom:0;letter-spacing:0}
.quota td{padding:4px 10px;border-bottom:0}
.quota td.use{white-space:nowrap;width:44%}
.quota td.when{color:var(--muted);font-size:14px}
.meter{display:inline-block;width:62%;height:7px;margin-right:10px;border-radius:4px;background:var(--surface2);vertical-align:middle;overflow:hidden}
.meter b{display:block;height:100%;background:var(--ok)}
.meter.hot b{background:var(--warn)}
.meter.full b{background:var(--danger)}
.quota .pct{display:inline-block;min-width:3.2ch;font-weight:650}
.idle{margin:10px 0 0;color:var(--muted);font-size:14px}
footer{margin-top:36px;padding-top:16px;border-top:1px solid var(--border);color:var(--muted);font-size:13px;line-height:1.55}
footer p{max-width:80ch;margin:0}
.empty{color:var(--muted);font-size:15px;margin:0}
.quiet{max-width:80ch;margin:18px 0 0;padding:2px 0 2px 14px;border-left:2px solid var(--border);color:var(--muted);font-size:15px;line-height:1.5}
.quiet b{display:block;color:var(--text2);font-weight:600;font-size:14px}
.quiet+.quiet{margin-top:12px}
.note{color:var(--muted);font-size:13px}
@media (max-width:640px){body{padding:20px 16px 36px}h1{font-size:25px}.meta{text-align:left}.kpi .value{font-size:27px}.headline{font-size:17px}.quota td.use{width:auto}.meter{width:48%}.card{padding:14px 12px}table{font-size:13.5px}td,th{padding-left:5px;padding-right:5px}}
@page{size:A4;margin:13mm 12mm}
@media print{
:root{color-scheme:light;--bg:#fff;--surface:#fff;--surface2:#eef0f7;--border:#d9dce8;--text:#161827;--text2:#3a3e58;--muted:#5c6080;--accent:#4f3fd4;--accent-bg:#f1efff;--ok:#12794a;--ok-bg:#e3f6ec;--warn:#8a5a00;--warn-bg:#fff3d9;--danger:#b3243c;--bar:#4f3fd4;--bar-soft:#cfc9fb;--avg:#c4780a;color-scheme:light}
html,body{background:#fff}
body{padding:0;font-size:10pt;line-height:1.45;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:none}
h1{font-size:19pt}.sub{font-size:11pt}
h2{margin:15px 0 7px;font-size:9pt}
.kpi .value{font-size:20pt}
.card{padding:9px 11px;border-radius:9px}
.headline{margin-top:10px;font-size:10.5pt;max-width:none}
.kpis{margin-top:10px;gap:7px}
.kpis{grid-template-columns:repeat(4,1fr)}
.two{grid-template-columns:minmax(0,1fr) minmax(0,1.1fr)}
.agents{grid-template-columns:repeat(3,1fr)}
.attn{grid-template-columns:repeat(2,1fr)}
.agent h3{font-size:10.5pt;margin-bottom:5px}
.share{margin-bottom:6px}
.agent li{display:flex;flex-wrap:wrap;justify-content:space-between;gap:0 8px;padding:2px 0;font-size:8.8pt;line-height:1.3}
.agent li small{display:inline;white-space:nowrap;font-size:7.8pt}
.agent li small.url{flex-basis:100%;white-space:normal}
.attn li{font-size:9pt;padding:2px 0}
td .note{display:inline;margin-left:6px;font-size:7.8pt}
.kpi .label{font-size:8.5pt}
.card.kpi{padding:7px 10px}
.kpi .sub2{margin-top:2px;font-size:8pt}
.chart{max-height:200px}
.chart text{font-size:12px}
.agent.card{break-inside:auto}
.cost li{font-size:9.5pt;padding:1px 0}
table{font-size:9.5pt}
td{padding:4px 6px}
.quota td{padding:2px 6px}
.quota th.eng{padding:6px 6px 1px;font-size:9.5pt}
.idle,.quiet{font-size:8.8pt}
.warn{font-size:9.5pt}
.agents,.attn{gap:7px}
a{color:inherit}
footer{margin-top:14px;font-size:8pt}footer p{max-width:none}
section{break-inside:auto}
h2{break-after:avoid}
}
`;

const arrowHtml = (value: Arrow): string => (value ? `<span class="arrow ${value}" aria-label="${value === "up" ? "subiu" : value === "down" ? "caiu" : "estável"}">${ARROWS[value]}</span>` : "");

/** Gráfico de barras por semana (SVG): a semana corrente tracejada e a média de 4 semanas em linha. */
function seriesSvg(series: NonNullable<ReportModel["series"]>): string {
  const width = 640;
  const height = 260;
  const left = 8;
  const right = 8;
  const top = 22;
  const bottom = 24;
  const n = series.bars.length;
  const max = Math.max(1, ...series.bars.map((bar) => bar.value), ...series.avg.map((value) => value ?? 0));
  const step = (width - left - right) / Math.max(1, n);
  const barWidth = Math.min(52, step * 0.62);
  const y = (value: number): number => top + (height - top - bottom) * (1 - value / max);
  const base = height - bottom;
  const parts: string[] = [`<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(series.title)}: ${series.bars.map((bar) => `${esc(bar.label)} ${bar.value}`).join(", ")}"><title>${esc(series.title)}</title>`];
  parts.push(`<line class="grid" x1="${left}" x2="${width - right}" y1="${base}" y2="${base}"/>`);
  series.bars.forEach((bar, index) => {
    const x = left + step * index + (step - barWidth) / 2;
    const h = Math.max(bar.value > 0 ? 2 : 0, base - y(bar.value));
    parts.push(`<rect class="bar${bar.current ? " cur" : ""}" x="${x.toFixed(1)}" y="${(base - h).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${h.toFixed(1)}" rx="3"/>`);
    parts.push(`<text class="val" x="${(x + barWidth / 2).toFixed(1)}" y="${(base - h - 5).toFixed(1)}" text-anchor="middle">${bar.value}</text>`);
    parts.push(`<text x="${(x + barWidth / 2).toFixed(1)}" y="${height - 7}" text-anchor="middle">${esc(bar.label)}</text>`);
  });
  const points = series.avg.map((value, index) => (value === null ? undefined : `${(left + step * index + step / 2).toFixed(1)},${y(value).toFixed(1)}`)).filter((point): point is string => point !== undefined);
  if (points.length > 1) parts.push(`<polyline class="avg" points="${points.join(" ")}"/>`);
  for (const point of points) {
    const [px, py] = point.split(",");
    parts.push(`<circle class="dot" cx="${px}" cy="${py}" r="2.8"/>`);
  }
  parts.push("</svg>");
  return parts.join("");
}

function itemHtml(item: ModelItem, base: string | undefined, workspace: string): string {
  const meta = `<small>${esc(item.meta)}`;
  if (item.link?.kind === "task") {
    const href = base ? `${base}/#/${encodeURIComponent(workspace)}/trabalho/tarefas/${encodeURIComponent(item.link.projectId)}/${encodeURIComponent(item.link.ref)}` : undefined;
    return `<li>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(item.title)}</a>` : esc(item.title)}${meta}</small></li>`;
  }
  if (item.link?.kind === "url") {
    const shown = item.link.url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
    return `<li>${esc(item.title)}${meta}</small><small class="url">${base && isHttpUrl(item.link.url) ? `<a href="${esc(item.link.url.trim())}" target="_blank" rel="noopener">${esc(shown)}</a>` : esc(shown)}</small></li>`;
  }
  return `<li>${esc(item.title)}${meta}</small></li>`;
}


/** Uma seção sem nada a dizer: uma linha apagada, sem título grande nem caixa. */
const quiet = (label: string, text: string): string => `<p class="quiet"><b>${esc(label)}</b>${esc(text)}</p>`;

/** A cota por motor: janelas com nome de gente, o maior uso primeiro; o que está parado em 0% vira uma linha só. */
function quotaHtml(quota: QuotaModel): string {
  if (quota.engines.length === 0 && !quota.idle && !quota.note) return `<p class="idle">Cota: sem leitura neste relatório.</p>`;
  const parts: string[] = [];
  if (quota.engines.length > 0) {
    parts.push(`<table class="quota"><thead><tr><th>Cota por janela</th><th>Uso</th><th>Volta</th></tr></thead>`);
    for (const engine of quota.engines) {
      parts.push(`<tbody><tr><th class="eng" colspan="3">${esc(engine.name)}</th></tr>`);
      for (const row of engine.rows) {
        // A mesma regra de cor das barras de cota do app (Gastos, Painel, barra lateral): calmo, atenção a partir de 50%, crítico a partir de 80%.
        const level = row.percent >= USAGE_TONE_RED * 100 ? " full" : row.percent >= USAGE_TONE_AMBER * 100 ? " hot" : "";
        parts.push(`<tr><td>${escDur(row.label)}${row.fast ? ` <span class="pill bad">ritmo alto</span>` : ""}</td><td class="use"><span class="meter${level}"><b style="width:${Math.min(100, row.percent)}%"></b></span><span class="pct">${row.percent}%</span></td><td class="when">${esc(row.reset)}</td></tr>`);
      }
      parts.push("</tbody>");
    }
    parts.push("</table>");
  }
  if (quota.idle) parts.push(`<p class="idle">${esc(quota.idle)}</p>`);
  if (quota.note) parts.push(`<p class="idle">${esc(quota.note)}</p>`);
  return parts.join("");
}

export type RenderHtmlOptions = { linkBase?: string };

export function renderReportHtml(report: StoredReport, options: RenderHtmlOptions = {}): string {
  const m = reportModel(report);
  const base = safeLinkBase(options.linkBase);
  const out: string[] = [];
  out.push(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(m.title)} · ${esc(m.subtitle)} · ${esc(m.workspaceName)}</title><style>${REPORT_CSS}</style></head><body><main class="page">`);
  out.push(`<header class="head"><div><p class="eyebrow">${esc(m.workspaceName)}</p><h1>${esc(m.title)}</h1><p class="sub">${esc(m.subtitle)}</p></div><p class="meta"><strong>${report.final ? "Fechado" : "Parcial"}</strong><br>${esc(m.generated)}</p></header>`);
  for (const warning of m.warnings) out.push(`<p class="warn">${esc(warning)}</p>`);
  out.push(`<p class="headline">${esc(m.headline)}</p>`);

  out.push(`<section class="kpis" aria-label="Números principais">`);
  for (const kpi of m.kpis) out.push(`<div class="card kpi"><div class="label">${escDur(kpi.label)}</div><div class="value">${escDur(kpi.value)}${arrowHtml(kpi.arrow)}</div><div class="sub2">${escDur(kpi.sub)}</div></div>`);
  out.push("</section>");

  if (m.ai) out.push(`<section class="card ai"><h3>O que mudou · escrito pelo ${esc(m.ai.by)}</h3><p>${esc(m.ai.text)}</p></section>`);

  const chart = m.series ? `<div><h2>${esc(m.series.title)}</h2><div class="card">${seriesSvg(m.series)}<p class="legend"><i style="background:var(--bar)"></i>entregas${m.series.avg.some((value) => value !== null) ? ` <i style="background:var(--avg);margin-left:10px"></i>média de 4 semanas` : ""}${m.series.bars.some((bar) => bar.current) ? ` · tracejada: a semana deste relatório` : ""}</p></div></div>` : "";
  let table = "";
  if (m.compare.length > 0) {
    table = `<div><h2>${esc(m.compareTitle)}</h2><div class="card"><table><thead><tr><th>Indicador</th><th class="num">Agora</th><th class="num">Antes</th><th></th></tr></thead><tbody>`;
    for (const row of m.compare) table += `<tr><td>${escDur(row.label)}${row.note ? `<span class="note">${escDur(row.note)}</span>` : ""}</td><td class="num">${escDur(row.now)}</td><td class="num">${escDur(row.prev)}</td><td>${arrowHtml(row.arrow)}</td></tr>`;
    table += "</tbody></table></div></div>";
  }
  if (chart || table) out.push(`<section class="two">${chart}${table}</section>`);
  // Sem dados: uma frase no lugar do gráfico e da tabela, nunca uma caixa vazia.
  if (m.compareNote) out.push(quiet(m.compareTitle, m.compareNote));
  if (m.seriesNote) out.push(quiet(m.seriesNote.title, m.seriesNote.text));

  if (m.weeks) {
    out.push(`<section><h2>Semanas guardadas</h2><div class="card"><table><thead><tr><th>Semana</th><th>Período</th><th class="num">Entregas</th><th class="num">Gasto equivalente</th><th class="num">Recusado</th><th class="num">Metas</th></tr></thead><tbody>`);
    for (const week of m.weeks) out.push(`<tr><td>${esc(week.period)}</td><td>${esc(week.label)}</td><td class="num">${week.deliveries}</td><td class="num">US$ ${week.costUsd.toFixed(2).replace(".", ",")}</td><td class="num">${escDur(week.rejection)}</td><td class="num">${esc(week.goals)}</td></tr>`);
    out.push("</tbody></table></div></section>");
  }

  if (m.agents.length === 0) out.push(quiet("O que cada agente fez", "Nenhuma entrega no período."));
  else {
    out.push(`<section><h2>O que cada agente fez</h2>`);
    const total = Math.max(1, m.agents.reduce((sum, agent) => sum + agent.count, 0));
    out.push(`<div class="agents">`);
    for (const agent of m.agents) {
      out.push(`<div class="card agent"><h3>${esc(agent.name)}<span>${agent.count} ${agent.count === 1 ? "entrega" : "entregas"}</span></h3><div class="share"><b style="width:${Math.round((agent.count / total) * 100)}%"></b></div><ul>${agent.items.map((item) => itemHtml(item, base, report.workspace)).join("")}</ul>${agent.more > 0 ? `<p class="more">… e mais ${agent.more}</p>` : ""}</div>`);
    }
    out.push("</div></section>");
  }

  if (m.goals.length > 0) {
    out.push(`<section><h2>Metas</h2><div class="card"><table><tbody>`);
    for (const goal of m.goals) out.push(`<tr><td>${esc(goal.title)}</td><td class="num">${escDur(goal.text)}</td><td class="num"><span class="pill ${goal.skipped ? "skip" : goal.ok ? "ok" : "bad"}">${goal.skipped ? "pulada" : goal.ok ? "bateu" : "não bateu"}</span></td></tr>`);
    out.push("</tbody></table></div></section>");
  }

  if (m.next) {
    out.push(`<section><h2>O que vem a seguir</h2><div class="attn">`);
    for (const block of m.next) out.push(`<div class="card"><h3>${esc(block.title)}</h3><ul class="lines">${block.lines.map((line) => `<li>${escDur(line)}</li>`).join("")}</ul></div>`);
    out.push("</div></section>");
  }

  if (m.attention.length === 0) out.push(quiet("O que pede atenção", "Nada travado, nada esperando você e nenhum prazo em risco."));
  else {
    out.push(`<section><h2>O que pede atenção</h2><div class="attn">`);
    for (const block of m.attention) out.push(`<div class="card"><h3>${esc(block.title)}</h3><ul class="lines">${block.lines.map((line) => `<li>${escDur(line)}</li>`).join("")}</ul></div>`);
    out.push("</div></section>");
  }

  out.push(`<section><h2>Custo e cota</h2><div class="card cost"><ul class="lines">${m.cost.lines.map((line) => `<li>${escDur(line)}</li>`).join("")}</ul>${quotaHtml(m.cost.quota)}</div></section>`);
  out.push(`<footer><p>${esc(m.footer)}</p></footer></main></body></html>`);
  return out.join("");
}
