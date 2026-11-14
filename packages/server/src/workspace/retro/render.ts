import type { RetroGroup, RetroRule, StoredRetro } from "@cyno/shared";
import { esc, REPORT_CSS } from "../reports/render-html";

/**
 * A retrospectiva em três formas, todas por código: HTML (a página isolada da aba "O que aprendemos"), Markdown (pt-BR, para o
 * dono) e texto (inglês, compacto, para o `get_report({ kind: "retro" })` do Maestro e do Cyno).
 */

const STATE_LABEL: Record<RetroRule["state"], string> = { esperando: "esperando seu OK", aprovada: "aprovada", recusada: "recusada" };
const STATE_PILL: Record<RetroRule["state"], string> = { esperando: "skip", aprovada: "ok", recusada: "bad" };
const SOURCE_LABEL = { molde: "texto por molde (sem IA)", maestro: "escrita pelo Maestro" } as const;

const day = (iso: string): string => new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });
const scopeText = (rule: RetroRule): string => rule.scopeLabel;
const pending = (report: StoredRetro): RetroGroup[] => {
  const taken = new Set(report.rules.filter((rule) => rule.state !== "recusada").map((rule) => rule.groupId));
  return report.candidates.filter((group) => !taken.has(group.id));
};
const fewData = (report: StoredRetro): string | undefined => (report.considered.decided < 5 ? `Poucos dados: só ${report.considered.decided} ${report.considered.decided === 1 ? "decisão sua entrou" : "decisões suas entraram"} na conta.` : undefined);

export function renderRetroHtml(report: StoredRetro): string {
  const out: string[] = [];
  out.push(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>O que aprendemos · ${esc(report.period)} · ${esc(report.workspaceName)}</title><style>${REPORT_CSS}</style></head><body><main class="page">`);
  out.push(`<header class="head"><div><p class="eyebrow">${esc(report.workspaceName)}</p><h1>O que aprendemos</h1><p class="sub">${esc(report.period)} · ${esc(day(report.from))} a ${esc(day(report.to))}</p></div><p class="meta"><strong>${report.trigger === "schedule" ? "Junto da revisão" : "Sob demanda"}</strong><br>gerado por código</p></header>`);
  const warning = fewData(report);
  if (warning) out.push(`<p class="warn">${esc(warning)}</p>`);
  out.push(`<p class="headline">${report.considered.decided} decisões suas nos últimos 14 dias: ${report.considered.rejected} recusas, ${report.considered.edited} textos editados e ${report.considered.failed} falhas olhados. ${report.candidates.length === 0 ? "Nenhum padrão passou do limite (3 itens em 2 dias, ou 5 no total)." : `${report.candidates.length} ${report.candidates.length === 1 ? "padrão passou" : "padrões passaram"} do limite.`}</p>`);

  out.push("<section><h2>Regras propostas</h2>");
  if (report.rules.length === 0) out.push(`<p class="empty">Nenhuma regra proposta ainda.</p>`);
  else {
    out.push(`<div class="card"><table><thead><tr><th>Regra</th><th>Vale para</th><th>De onde veio</th><th>Estado</th></tr></thead><tbody>`);
    for (const rule of report.rules) out.push(`<tr><td>${esc(rule.text)}<span class="note">${esc(rule.line)}</span></td><td>${esc(scopeText(rule))}</td><td>${esc(SOURCE_LABEL[rule.source])}</td><td><span class="pill ${STATE_PILL[rule.state]}">${STATE_LABEL[rule.state]}</span></td></tr>`);
    out.push("</tbody></table></div>");
  }
  out.push("</section>");

  const left = pending(report);
  if (left.length > 0) {
    out.push(`<section><h2>Padrões achados que esperam texto</h2><div class="attn">`);
    for (const group of left) out.push(`<div class="card"><h3>${esc(group.typeName)} · ${esc(group.agentNames.join(", "))}</h3><ul class="lines"><li>${esc(group.line)} (${group.days} ${group.days === 1 ? "dia" : "dias"})</li>${group.samples.slice(0, 2).map((sample) => `<li>${esc(sample)}</li>`).join("")}</ul></div>`);
    out.push("</div></section>");
  }

  if (report.impacts.length > 0) {
    out.push(`<section><h2>Duas semanas depois</h2><div class="card"><ul class="lines">${report.impacts.map((impact) => `<li>${esc(impact.line)}</li>`).join("")}</ul></div></section>`);
  }
  if (report.notices.length > 0) {
    out.push(`<section><h2>Avisos (não viram regra)</h2><div class="card"><ul class="lines">${report.notices.map((notice) => `<li>${esc(notice.text)}</li>`).join("")}</ul></div></section>`);
  }
  out.push(`<footer>Os padrões saem das suas decisões dos últimos 14 dias, por código. Nada entra no Cérebro sem o seu clique.</footer></main></body></html>`);
  return out.join("");
}

export function renderRetroMarkdown(report: StoredRetro): string {
  const out = [`# O que aprendemos · ${report.period}`, "", `${day(report.from)} a ${day(report.to)} · ${report.considered.decided} decisões suas olhadas (${report.considered.rejected} recusas, ${report.considered.edited} edições, ${report.considered.failed} falhas).`, ""];
  const warning = fewData(report);
  if (warning) out.push(`> ${warning}`, "");
  out.push("## Regras propostas", "");
  if (report.rules.length === 0) out.push("Nenhuma regra proposta ainda.", "");
  else {
    out.push("| Regra | Vale para | Origem | Estado |", "|---|---|---|---|");
    for (const rule of report.rules) out.push(`| ${rule.text} (${rule.line}) | ${scopeText(rule)} | ${SOURCE_LABEL[rule.source]} | ${STATE_LABEL[rule.state]} |`);
    out.push("");
  }
  const left = pending(report);
  if (left.length > 0) {
    out.push("## Padrões que esperam texto", "");
    for (const group of left) out.push(`- ${group.typeName} · ${group.agentNames.join(", ")}: ${group.line} (${group.days} dias)`);
    out.push("");
  }
  if (report.impacts.length > 0) out.push("## Duas semanas depois", "", ...report.impacts.map((impact) => `- ${impact.line}`), "");
  if (report.notices.length > 0) out.push("## Avisos", "", ...report.notices.map((notice) => `- ${notice.text}`), "");
  return `${out.join("\n")}\n`;
}

/** O texto (inglês, compacto) para o modelo: as regras propostas e o estado delas. */
export function renderRetroText(report: StoredRetro): string {
  const out = [
    `Retrospective ${report.period} of ${report.workspaceName} (last 14 days, found by code, no AI; generated ${report.generatedAt}). Considered ${report.considered.decided} owner decisions: ${report.considered.rejected} refusals, ${report.considered.edited} edits, ${report.considered.failed} failures.${report.considered.decided < 5 ? " Few data: draw no conclusions." : ""}`,
    `Rules proposed (${report.rules.length}):`,
  ];
  if (report.rules.length === 0) out.push("  none yet");
  for (const rule of report.rules) out.push(`  - [${rule.state === "esperando" ? "waiting for the owner" : rule.state === "aprovada" ? "approved" : "refused"}] ${rule.text} (scope: ${rule.scope.global ? "global" : rule.scope.agentId ? `agent ${rule.scope.agentId}` : `room ${rule.scope.roomId}`}; ${rule.source === "molde" ? "template" : "written by the Maestro"}; evidence: ${rule.line})`);
  const left = pending(report);
  if (left.length > 0) {
    out.push(`Patterns still without a rule (${left.length}):`);
    for (const group of left) out.push(`  - ${group.id} ${group.kind} · ${group.typeName} · ${group.agentNames.join(", ")}: ${group.line} (${group.days} days)${group.template ? " [template rule available]" : " [needs the owner to ask the Maestro]"}`);
  }
  if (report.impacts.length > 0) {
    out.push("Two weeks after approval:");
    for (const impact of report.impacts) out.push(`  - ${impact.what}: ${impact.before} before, ${impact.after} after (rule: ${impact.text})`);
  }
  for (const notice of report.notices) out.push(`Notice (not a rule): ${notice.kind} ran out for ${notice.agentName ?? notice.agentId} in ${notice.count} tasks.`);
  out.push("Computed by the server; nothing to recompute. Rules enter the Brain only when the owner approves them.");
  return out.join("\n");
}
