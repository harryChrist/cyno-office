import { ROUTINE_TIMEZONE, type Card } from "@cyno/shared";

/** Limites do formato compacto que entra no contexto do Cyno (caracteres). Passou do total, os workspaces mais parados viram uma linha. */
export const COMPACT_LIMITS = { card: 900, total: 6000 } as const;

const dayFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: ROUTINE_TIMEZONE, day: "2-digit", month: "2-digit" });
const hourFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: ROUTINE_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "14/11" */
export const shortDay = (iso: string): string => dayFormat.format(new Date(iso));
/** "08h" ou "08h30" */
export const shortHour = (iso: string): string => {
  const [h = "", m = ""] = hourFormat.format(new Date(iso)).split(":");
  return m === "00" ? `${h}h` : `${h}h${m}`;
};

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text);
const model = (engine: string, name?: string) => (name ? `${engine}/${name}` : engine);
/** Id curto: os projetos nascem com o id do pedido (um uuid); só os 8 primeiros caracteres entram no contexto. */
export const shortId = (id: string): string => (id.length > 12 ? id.slice(0, 8) : id);
const PERIOD: Record<string, string> = { semana: "sem", mes: "mês", dia: "dia" };

/** Uma linha por workspace quando não cabe mais: nome, quantos esperam e quantos projetos andam. */
function oneLine(card: Card): string {
  return `- ${card.workspace} · ${card.name}: ${card.waitingForYou} esperando você, ${card.projects.active.length} em andamento (use get_workspace_card)`;
}

/**
 * A ficha em poucas linhas para o contexto do Cyno (até 900 caracteres). Tudo vem do código; a única
 * frase escrita à mão é "Faz:".
 */
export function renderCardCompact(card: Card): string {
  const maestro = card.team.maestro;
  const lines: string[] = [`## ${card.workspace} · ${card.name}  [maestro ${model(maestro.engine, maestro.model)} · ${maestro.status}]`];
  lines.push(`Faz: ${card.summary.summary ? clip(card.summary.summary, 280) : "(sem frase ainda; peça ao dono ou use set_workspace_summary)"}`);
  const rooms = card.team.rooms.length > 0 ? ` · salas ${card.team.rooms.map((room) => room.name).join(", ")}` : "";
  const agents = card.team.agents.map((agent) => `${agent.name}(${model(agent.engine, agent.model)}${agent.focus ? `: ${clip(agent.focus, 40)}` : ""})`);
  lines.push(`Equipe: ${agents.length > 0 ? agents.join(" ") : "só o Maestro"}${rooms}`);
  const extras: string[] = [];
  if (card.sites.length > 0) extras.push(`Sites: ${card.sites.map((site) => `${site.domain}${site.login === "ok" ? "" : site.login === "faltando" ? " (sem login)" : " (login não verificado)"}`).join(", ")}`);
  if (card.connectors.length > 0) extras.push(`Conectores: ${card.connectors.map((connector) => connector.id).join(", ")}`);
  if (extras.length > 0) lines.push(extras.join(" · "));
  if (card.routines.length > 0) {
    lines.push(
      `Rotinas: ${card.routines
        .map((routine) => `${clip(routine.title, 40)}${routine.target ? ` ${routine.target}/${PERIOD[routine.period ?? ""] ?? routine.period ?? ""}` : ""}${routine.next ? ` (próx. ${shortDay(routine.next)} ${shortHour(routine.next)})` : ""}`)
        .join(" · ")}`,
    );
  }
  const projects = card.projects.active.map((project) => `${shortId(project.id)} "${clip(project.title, 50)}"${project.total ? ` ${project.done ?? 0}/${project.total}` : ""}${project.dueAt ? ` (prazo ${shortDay(project.dueAt)})` : ""}${project.stage ? ` — ${clip(project.stage, 60)}` : ""}`);
  lines.push(`Andamento: ${projects.length > 0 ? projects.join(" · ") : "nada em andamento"}`);
  const tail = [`Esperando você: ${card.waitingForYou}`];
  if (card.deliveries.length > 0) tail.push(`Entregas: ${card.deliveries.slice(0, 2).map((delivery) => `"${clip(delivery.title, 40)}" (${shortDay(delivery.at)})`).join(", ")}`);
  tail.push(card.usage.windowPercent !== undefined ? `Uso 5h: ${card.usage.windowEngine} ${card.usage.windowPercent}%` : `Turnos 5h: ${card.usage.turns5h}`);
  lines.push(tail.join(" · "));
  return clip(lines.join("\n"), COMPACT_LIMITS.card);
}

/** O digest de todas as fichas (abre a conversa nova do Cyno): até 6 mil caracteres; o que passar vira uma linha por workspace. */
export function renderDigest(cards: Card[]): string {
  if (cards.length === 0) return "Workspaces: nenhum ainda (o dono pode criar o primeiro).";
  const full = cards.map(renderCardCompact);
  let total = full.join("\n\n").length;
  if (total <= COMPACT_LIMITS.total) return full.join("\n\n");
  // Os mais parados (nada esperando e nada andando) caem primeiro para uma linha.
  const order = cards.map((card, index) => ({ index, busy: card.waitingForYou * 2 + card.projects.active.length })).sort((a, b) => a.busy - b.busy);
  const out = [...full];
  for (const { index } of order) {
    if (total <= COMPACT_LIMITS.total) break;
    const short = oneLine(cards[index]!);
    total -= out[index]!.length - short.length;
    out[index] = short;
  }
  return out.join("\n\n");
}

/** O que o delta compara (por workspace): só fatos que o dono ou o Cyno querem saber que mudaram. */
export type CardFacts = { name: string; summary: string; waiting: number; agents: number; maestro: string; active: Record<string, string>; delivered: string[]; routines: number };

export function factsOf(card: Card): CardFacts {
  return {
    name: card.name,
    summary: card.summary.summary,
    waiting: card.waitingForYou,
    agents: card.team.agents.length,
    maestro: card.team.maestro.status,
    active: Object.fromEntries(card.projects.active.map((project) => [project.id, `${project.title}|${project.done ?? 0}/${project.total ?? 0}`])),
    delivered: card.deliveries.map((delivery) => delivery.title),
    routines: card.routines.length,
  };
}

export type FactsMap = Record<string, CardFacts>;

export const factsMapOf = (cards: Card[]): FactsMap => Object.fromEntries(cards.map((card) => [card.workspace, factsOf(card)]));

/**
 * O que mudou desde a última vez que o Cyno viu as fichas, uma linha por workspace (calculado por
 * código, sem IA). Vazio = nada mudou: nada vai na mensagem.
 */
export function diffFacts(before: FactsMap, after: FactsMap): string[] {
  const lines: string[] = [];
  for (const [id, facts] of Object.entries(after)) {
    const old = before[id];
    if (!old) {
      lines.push(`${id}: new workspace "${facts.name}"`);
      continue;
    }
    const changes: string[] = [];
    if (facts.name !== old.name) changes.push(`renamed to "${facts.name}"`);
    if (facts.summary !== old.summary) changes.push("the 'what it does' sentence changed");
    if (facts.waiting !== old.waiting) changes.push(`${facts.waiting > old.waiting ? `+${facts.waiting - old.waiting}` : `-${old.waiting - facts.waiting}`} waiting for you (now ${facts.waiting})`);
    for (const [project, value] of Object.entries(facts.active)) {
      const prev = old.active[project];
      const [title = "", progress = ""] = value.split("|");
      if (prev === undefined) changes.push(`"${title}" started`);
      else if (prev !== value) changes.push(`"${title}" ${progress}`);
    }
    for (const project of Object.keys(old.active)) {
      if (facts.active[project] !== undefined) continue;
      const title = (old.active[project] ?? "").split("|")[0] ?? "";
      changes.push(`"${title}" ${facts.delivered.includes(title) ? "finished" : "is no longer active"}`);
    }
    if (facts.agents !== old.agents) changes.push(`${facts.agents} team agents (was ${old.agents})`);
    if (facts.routines !== old.routines) changes.push(`${facts.routines} active routines (was ${old.routines})`);
    if (changes.length > 0) lines.push(`${id}: ${changes.join("; ")}`);
  }
  for (const id of Object.keys(before)) if (!after[id]) lines.push(`${id}: workspace removed`);
  return lines;
}

/** A ficha completa (a ferramenta `get_workspace_card`): sem os cortes do formato compacto, mas ainda curta. */
export function renderCardFull(card: Card): string {
  const maestro = card.team.maestro;
  const lines = [`# ${card.workspace} · ${card.name}`, `Faz: ${card.summary.summary || "(sem frase ainda)"}${card.summary.proposal ? ` [sugestão de ${card.summary.proposal.by} aguardando o dono: "${card.summary.proposal.summary}"]` : ""}`];
  lines.push(`Maestro: ${model(maestro.engine, maestro.model)} · ${maestro.status}`);
  lines.push(`Salas: ${card.team.rooms.map((room) => room.name).join(", ") || "nenhuma além da sala do Maestro"}`);
  lines.push("Equipe:");
  for (const agent of card.team.agents) lines.push(`- ${agent.name} (${agent.id}) ${model(agent.engine, agent.model)} · ${agent.terminal}${agent.focus ? ` · ${agent.focus}` : ""}`);
  if (card.team.agents.length === 0) lines.push("- (só o Maestro)");
  lines.push(`Motores: ${card.engines.map((engine) => `${engine.engine}${engine.available ? "" : " (indisponível)"}`).join(", ") || "nenhum de CLI"}`);
  lines.push(`Sites declarados: ${card.sites.map((site) => `${site.domain} (login ${site.login === "ok" ? "ok" : site.login === "faltando" ? "faltando" : "não verificado"})`).join(", ") || "nenhum"}`);
  lines.push(`Conectores: ${card.connectors.map((connector) => `${connector.id}${connector.usedBy.length ? ` (${connector.usedBy.join(", ")})` : ""}`).join(", ") || "nenhum"}`);
  lines.push("Rotinas ativas:");
  for (const routine of card.routines) lines.push(`- ${routine.id} ${routine.title} · ${routine.type}${routine.target ? ` ${routine.target} ${routine.unit ?? ""}/${routine.period ?? ""}` : ""}${routine.next ? ` · próxima ${shortDay(routine.next)} ${shortHour(routine.next)}` : ""}`);
  if (card.routines.length === 0) lines.push("- nenhuma");
  const counts = Object.entries(card.projects.counts)
    .map(([status, n]) => `${n} ${status}`)
    .join(", ");
  lines.push(`Projetos (${counts || "nenhum"}), em andamento:`);
  for (const project of card.projects.active) lines.push(`- ${shortId(project.id)} "${project.title}"${project.total ? ` ${project.done ?? 0}/${project.total}` : ""}${project.dueAt ? ` · prazo ${shortDay(project.dueAt)}` : ""}${project.stage ? ` · etapa: ${project.stage}` : ""}`);
  if (card.projects.active.length === 0) lines.push("- nada");
  lines.push(`Últimas entregas: ${card.deliveries.map((delivery) => `"${delivery.title}" (${shortDay(delivery.at)})`).join(", ") || "nenhuma"}`);
  lines.push(`Esperando o dono: ${card.waitingForYou}`);
  lines.push(`Uso: ${card.usage.windowPercent !== undefined ? `${card.usage.windowEngine} ${card.usage.windowPercent}% da janela de 5 h · ` : ""}${card.usage.turns5h} turnos nas últimas 5 h`);
  return lines.join("\n");
}
