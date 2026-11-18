import {
  BRAIN_RULE_LIMITS,
  DAY_MS,
  forYouKind,
  GLOBAL_BRAIN_ID,
  RETRO_IMPACT_DAYS,
  RETRO_LOOKBACK_DAYS,
  RETRO_MAX_ASK_GROUPS,
  RETRO_SUPPRESS_WEEKS,
  slugify,
  type ForYouItem,
  type ForYouRule,
  type ForYouRuleScope,
  type RetroEstimate,
  type RetroGroup,
  type RetroImpact,
  type RetroRule,
  type RetroView,
  type ServerEvent,
  type StoredRetro,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { computeCost } from "../../engines/usage/pricing";
import { HttpError } from "../../platform/http/errors";
import { renderFields } from "../brain/frontmatter";
import { findRetro, impactLabel, impactLine, ruleImpact, type RetroSnapshot, type RuleTarget } from "../metrics/retro";
import { periodAt } from "../reports/period";
import { RetroStore, type RuleRecord } from "./store";

/** Tokens de entrada por grupo na mensagem ao Maestro (o plano diz "cerca de 400") e de saída por regra. */
export const RETRO_TOKENS_PER_GROUP = 400;
export const RETRO_OUTPUT_TOKENS_PER_RULE = 120;

export type RetroDeps = {
  workspaceId: string;
  workspaceName: () => string;
  store: RetroStore;
  now: () => Date;
  /** O que a retrospectiva lê dos serviços (retrato na hora). `sinceMs`: até onde as aprovações precisam olhar para trás (o que saiu da lista viva vem do arquivo). */
  snapshot: (sinceMs: number) => RetroSnapshot | Promise<RetroSnapshot>;
  forYou: {
    list(): ForYouItem[];
    openSpecial(input: { kind: "regra"; agentId: string; roomId: string; title: string; text: string; rule: ForYouRule }): ForYouItem;
    updateRule(id: string, rule: ForYouRule): Promise<ForYouItem>;
  };
  /** Cérebro: grava a nota da regra aprovada (nunca antes do clique). */
  brain: { hasBrain(brainId: string): boolean; writeRootNote(brainId: string, file: string, content: string, options: { replace: boolean; indexLine?: string }): Promise<string> };
  /** Regras de cada agente: a regra com escopo de um agente vai para as dele (só ele a recebe), não para uma nota da sala. */
  agentRules: { append(agentId: string, text: string): Promise<{ added: boolean; content: string }> };
  /** Quarto de um agente (o quarto onde a regra de um agente vale; confere que o agente ainda existe). */
  roomOfAgent: (agentId: string) => string | undefined;
  roomExists: (roomId: string) => boolean;
  /** O Maestro de CLI: abre o pedido de redigir as regras. Sem ele, o botão fica desligado. */
  maestro: { available(): boolean; model(): string | undefined; ask(input: { title: string; message: string }): { id: string } };
  /** Eventos do workspace (o pedido ao Maestro acabou: `task:upserted`). */
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
};

type Asking = { taskId: string; groups: Map<string, RetroGroup>; at: number };

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * A retrospectiva de um workspace: acha os padrões por código (`findRetro`), abre os cartões de regra dos traços conhecidos (texto
 * por molde, sem IA), deixa o dono pedir ao Maestro que escreva as demais (`ask` + `propose_rule`) e cuida do que o clique faz:
 * aprovar grava a regra: nas regras do agente (escopo de um agente), numa nota do Cérebro do quarto, ou no global quando o padrão vem de 2 ou mais agentes, recusar esconde o
 * padrão por 8 semanas. NADA entra no Cérebro sem o clique do dono.
 */
export class RetroService {
  private asking: Asking | undefined;

  constructor(private readonly deps: RetroDeps) {}

  /** A semana da retrospectiva (a de agora, em São Paulo). */
  period(): string {
    return periodAt("week", this.deps.now().getTime()).key;
  }

  private async state() {
    const state = await this.deps.store.readState();
    // Cartão que sumiu (quarto apagado) ou foi cancelado: a regra deixa de esperar, e o padrão pode voltar.
    const items = new Map(this.deps.forYou.list().filter((item) => forYouKind(item) === "regra").map((item) => [item.id, item]));
    const kept = state.rules.filter((rule) => rule.state !== "esperando" || items.get(rule.itemId)?.status === "pendente");
    if (kept.length !== state.rules.length) {
      state.rules = kept;
      await this.deps.store.writeState(state);
    }
    return state;
  }

  /** Padrões de agora que ainda não viraram regra (nem esperando, nem aprovada) e não foram recusados nas últimas 8 semanas. */
  private candidatesOf(found: ReturnType<typeof findRetro>, state: Awaited<ReturnType<RetroService["state"]>>): RetroGroup[] {
    const now = this.deps.now().getTime();
    const taken = new Set(state.rules.filter((rule) => rule.state !== "recusada").map((rule) => rule.groupId));
    return found.groups.filter((group) => !taken.has(group.id) && !((state.suppressed[group.id] ?? "") > iso(now)));
  }

  private scopeOf(group: Pick<RetroGroup, "agentIds" | "roomIds">): ForYouRuleScope {
    return group.agentIds.length >= 2 ? { global: true } : { agentId: group.agentIds[0]!, roomId: group.roomIds[0]! };
  }

  private scopeLabel(scope: ForYouRuleScope, agentNames: readonly string[]): string {
    if (scope.global) return "Todo o workspace";
    if (scope.agentId) return agentNames.length === 1 ? `Só ${agentNames[0]}` : "Um agente";
    return "Um quarto";
  }

  /** A regra como o relatório e a aba mostram. */
  private ruleView(record: RuleRecord): RetroRule {
    return {
      itemId: record.itemId,
      groupId: record.groupId,
      text: record.text,
      scope: record.scope,
      scopeLabel: this.scopeLabel(record.scope, record.agentNames),
      source: record.source,
      retro: record.retro,
      state: record.state,
      proposedAt: record.proposedAt,
      ...(record.decidedAt ? { decidedAt: record.decidedAt } : {}),
      ...(record.notePath ? { notePath: record.notePath } : {}),
      line: record.line,
    };
  }

  /** Duas semanas depois de aprovada, o antes e o depois da regra (a mesma fórmula nas duas pontas). */
  private async impactsOf(state: Awaited<ReturnType<RetroService["state"]>>): Promise<RetroImpact[]> {
    const now = this.deps.now().getTime();
    const approved = state.rules.filter((record) => record.state === "aprovada" && record.decidedAt).map((record) => Date.parse(record.decidedAt!));
    if (approved.length === 0) return [];
    // O "antes" de cada regra olha 14 dias antes da aprovação: a regra mais antiga decide até onde ler.
    const snapshot = await this.deps.snapshot(Math.min(...approved) - RETRO_IMPACT_DAYS * DAY_MS);
    const out: RetroImpact[] = [];
    for (const record of state.rules) {
      if (record.state !== "aprovada" || !record.decidedAt) continue;
      const approvedAt = Date.parse(record.decidedAt);
      const result = ruleImpact(snapshot, record.target as RuleTarget, approvedAt, now);
      if (!result) continue;
      const what = impactLabel(record.target);
      out.push({ itemId: record.itemId, text: record.text, what, before: result.before, after: result.after, approvedAt: record.decidedAt, line: impactLine(record.text, what, result.before, result.after) });
    }
    return out.sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));
  }

  /** O custo estimado do botão "Escrever as regras com o Maestro": tokens por grupo e o preço no modelo dele (equivalente à API). */
  estimate(groups: number): RetroEstimate {
    const count = Math.min(groups, RETRO_MAX_ASK_GROUPS);
    const tokens = count * (RETRO_TOKENS_PER_GROUP + RETRO_OUTPUT_TOKENS_PER_RULE) + 600;
    const model = this.deps.maestro.model() ?? null;
    const cost = model ? computeCost({ model, at: iso(this.deps.now().getTime()), tokens: { input: count * RETRO_TOKENS_PER_GROUP + 600, output: count * RETRO_OUTPUT_TOKENS_PER_RULE, cacheRead: 0, cacheCreation: 0 } }) : undefined;
    const usd = cost?.usd ?? null;
    const label = count === 0 ? "nenhum padrão para escrever" : usd === null ? `cerca de ${tokens} tokens` : `cerca de US$ ${usd < 0.01 ? "0,01" : usd.toFixed(2).replace(".", ",")} (equivalente)`;
    return { groups: count, tokens, usd, model, label };
  }

  async view(): Promise<RetroView> {
    const now = this.deps.now().getTime();
    const state = await this.state();
    const found = findRetro(await this.deps.snapshot(now - (RETRO_LOOKBACK_DAYS + 1) * DAY_MS), now);
    const candidates = this.candidatesOf(found, state);
    const needsMaestro = candidates.filter((group) => group.template === undefined);
    const available = this.deps.maestro.available();
    return {
      period: this.period(),
      from: iso(found.from),
      to: iso(found.to),
      now: iso(now),
      ready: candidates.filter((group) => group.template !== undefined),
      needsMaestro,
      rules: state.rules.map((record) => this.ruleView(record)).sort((a, b) => b.proposedAt.localeCompare(a.proposedAt)),
      impacts: await this.impactsOf(state),
      notices: found.notices,
      waiting: state.rules.filter((rule) => rule.state === "esperando").length,
      estimate: this.estimate(needsMaestro.length),
      maestro: { available, asking: this.asking !== undefined, ...(available ? {} : { reason: "O Maestro deste workspace não roda numa CLI (Configurações > Maestro)." }) },
      stored: await this.deps.store.list(),
      considered: found.considered,
    };
  }

  private async openCard(group: RetroGroup, text: string, source: "molde" | "maestro", period: string, scope: ForYouRuleScope, state: Awaited<ReturnType<RetroService["state"]>>): Promise<RuleRecord> {
    const days = group.days;
    const rule: ForYouRule = {
      text,
      scope,
      evidence: { itemIds: group.itemIds, count: group.count, days, total: group.total, line: group.line, excerpts: group.excerpts },
      source,
      retro: period,
      groupId: group.id,
    };
    const item = this.deps.forYou.openSpecial({
      kind: "regra",
      agentId: group.agentIds[0]!,
      roomId: group.roomIds[0]!,
      title: `Regra proposta: ${text}`,
      text,
      rule,
    });
    const record: RuleRecord = {
      itemId: item.id,
      groupId: group.id,
      target: { kind: group.kind, type: group.type, key: group.key, ...(group.trait ? { trait: group.trait } : {}), words: group.words, agentIds: group.agentIds },
      typeName: group.typeName,
      agentNames: group.agentNames,
      line: group.line,
      text,
      scope,
      source,
      retro: period,
      state: "esperando",
      proposedAt: iso(this.deps.now().getTime()),
    };
    state.rules.push(record);
    return record;
  }

  /**
   * Monta a retrospectiva de agora, grava em `reports/retro/<semana>.json` e abre os cartões das regras de texto por molde (sem IA).
   * Chamar de novo não duplica nada: um padrão que já tem cartão esperando (ou regra aprovada) não abre outro.
   */
  async generate(trigger: StoredRetro["trigger"], period = this.period()): Promise<{ report: StoredRetro; opened: number }> {
    const state = await this.state();
    const found = findRetro(await this.deps.snapshot(this.deps.now().getTime() - (RETRO_LOOKBACK_DAYS + 1) * DAY_MS), this.deps.now().getTime());
    const candidates = this.candidatesOf(found, state);
    let opened = 0;
    for (const group of candidates) {
      if (!group.template) continue;
      await this.openCard(group, group.template, "molde", period, this.scopeOf(group), state);
      opened += 1;
    }
    if (opened > 0) await this.deps.store.writeState(state);
    const report = this.reportOf(period, trigger, found, state, await this.impactsOf(state));
    await this.deps.store.write(report);
    this.deps.log.info({ period, opened, candidates: candidates.length }, "retrospectiva gerada");
    return { report, opened };
  }

  private reportOf(period: string, trigger: StoredRetro["trigger"], found: ReturnType<typeof findRetro>, state: Awaited<ReturnType<RetroService["state"]>>, impacts: RetroImpact[]): StoredRetro {
    return {
      v: 1,
      kind: "retro",
      period,
      workspace: this.deps.workspaceId,
      workspaceName: this.deps.workspaceName(),
      from: iso(found.from),
      to: iso(found.to),
      generatedAt: iso(this.deps.now().getTime()),
      trigger,
      candidates: found.groups.filter((group) => !((state.suppressed[group.id] ?? "") > iso(this.deps.now().getTime()))),
      rules: state.rules.map((record) => this.ruleView(record)),
      impacts,
      notices: found.notices,
      considered: found.considered,
    };
  }

  /** A retrospectiva guardada de uma semana, com o estado de agora das regras e do antes/depois por cima (o arquivo é o retrato da hora de gerar). */
  async read(period: string): Promise<StoredRetro | undefined> {
    const stored = await this.deps.store.read(period);
    if (!stored) return undefined;
    const state = await this.state();
    return { ...stored, rules: state.rules.map((record) => this.ruleView(record)), impacts: await this.impactsOf(state) };
  }

  /**
   * "latest" (a guardada mais nova) ou uma semana. SÓ LÊ: sem retrospectiva guardada devolve `undefined`, nunca gera uma
   * nem abre cartão de regra (quem gera é o agendador, junto da revisão da semana, e o botão "Atualizar").
   */
  async ensure(requested: string | undefined): Promise<StoredRetro | undefined> {
    const text = requested?.trim();
    if (text && text !== "latest") return this.read(text);
    const newest = (await this.deps.store.list())[0];
    return newest ? this.read(newest.period) : undefined;
  }

  // ---------- Maestro ----------

  /**
   * Manda ao Maestro UMA mensagem com os padrões que precisam de texto (em inglês, compacta) e abre a janela do `propose_rule`
   * só para esses grupos. Nunca é automático: só o clique do dono chega aqui.
   */
  async ask(wanted?: readonly string[]): Promise<{ asked: number; taskId: string }> {
    if (!this.deps.maestro.available()) throw new HttpError(409, "O Maestro deste workspace não roda numa CLI: ligue-o em Configurações para ele escrever as regras.");
    if (this.asking) throw new HttpError(409, "O Maestro já está escrevendo as regras: espere ele terminar.");
    const state = await this.state();
    const found = findRetro(await this.deps.snapshot(this.deps.now().getTime() - (RETRO_LOOKBACK_DAYS + 1) * DAY_MS), this.deps.now().getTime());
    const pool = this.candidatesOf(found, state).filter((group) => group.template === undefined);
    const chosen = (wanted && wanted.length > 0 ? pool.filter((group) => wanted.includes(group.id)) : pool).slice(0, RETRO_MAX_ASK_GROUPS);
    if (chosen.length === 0) throw new HttpError(409, "Não há padrões esperando texto: nada para pedir ao Maestro.");
    const period = this.period();
    const task = this.deps.maestro.ask({ title: `Regras da retrospectiva (${period})`, message: this.message(chosen) });
    const asking: Asking = { taskId: task.id, groups: new Map(chosen.map((group) => [group.id, group])), at: this.deps.now().getTime() };
    this.asking = asking;
    const done = (): void => {
      unsubscribe();
      clearTimeout(timer);
      if (this.asking === asking) this.asking = undefined;
    };
    const unsubscribe = this.deps.subscribe((event) => {
      if (event.type === "task:upserted" && event.task.id === task.id && (event.task.status === "done" || event.task.status === "failed")) done();
    });
    const timer = setTimeout(done, 20 * 60_000);
    timer.unref();
    return { asked: chosen.length, taskId: task.id };
  }

  /** A mensagem ao Maestro (inglês, compacta): os grupos com a evidência e o que ele deve devolver. */
  message(groups: readonly RetroGroup[]): string {
    const blocks = groups.map((group) => {
      const lines = [
        `Group ${group.id} (${group.kind.replace("_", " ")}) · type "${group.typeName}" · agents: ${group.agentNames.join(", ")} · ${group.count} of ${group.total} items over ${group.days} days`,
        `  what the owner did: ${group.line}`,
        group.words.length > 0 ? `  main words: ${group.words.join(", ")}` : "",
        ...group.samples.slice(0, 4).map((sample) => `  sample: ${sample}`),
        ...group.excerpts.slice(0, 2).map((excerpt) => `  draft: "${excerpt.before.slice(0, 160)}"${excerpt.after ? ` -> ${excerpt.after.slice(0, 160)}` : ""}`),
        `  suggested scope: ${group.agentIds.length >= 2 ? "global (2+ agents)" : "agent"}`,
      ];
      return lines.filter(Boolean).join("\n");
    });
    return [
      "Weekly retrospective: patterns found by code in the owner's recent decisions. For EACH group below, call `propose_rule({ group_id, text, scope })` exactly once.",
      "- `text`: one short sentence in Brazilian Portuguese, imperative, general enough to guide future work of that agent (e.g. \"Evitar tom formal demais em comentários: escrever de forma leve e direta.\"). Do not quote the samples and do not invent facts.",
      "- `scope`: 'agent' when the pattern comes from one agent, 'global' when it comes from two or more.",
      "The owner approves each rule by hand; nothing is saved without that click. Do not call other tools. When every group has a rule, call `complete_request` with a one-line result.",
      "",
      ...blocks,
    ].join("\n");
  }

  /** `propose_rule` (só o Maestro, só enquanto o pedido da retrospectiva está aberto): abre o cartão da regra. */
  async proposeRule(input: { groupId: string; text: string; scope: "agent" | "global" }): Promise<string> {
    const asking = this.asking;
    if (!asking) throw new Error("propose_rule only works while the owner's retrospective request is open (the owner asks for it with the button \"Escrever as regras com o Maestro\").");
    const group = asking.groups.get(input.groupId);
    if (!group) throw new Error(`Unknown group "${input.groupId}". Use one of: ${[...asking.groups.keys()].join(", ") || "(none left)"}.`);
    const text = input.text.replace(/\s+/g, " ").trim();
    if (text.length < 8 || text.length > 500) throw new Error("`text` must be one sentence of 8 to 500 characters.");
    if (input.scope === "agent" && group.agentIds.length >= 2) throw new Error(`This pattern comes from ${group.agentIds.length} agents: use scope "global".`);
    const state = await this.state();
    const scope: ForYouRuleScope = input.scope === "global" ? { global: true } : this.scopeOf(group);
    const record = await this.openCard(group, text, "maestro", this.period(), scope, state);
    await this.deps.store.writeState(state);
    asking.groups.delete(group.id);
    return `Rule card ${record.itemId} opened for the owner (${asking.groups.size} group(s) left).`;
  }

  // ---------- A decisão do dono ----------

  /** Aprovar grava a regra (nas regras do agente ou numa nota do Cérebro); recusar esconde o padrão por 8 semanas. Só o clique do dono chega aqui (via `ForYouService.decide`). */
  async decide(item: ForYouItem, decision: { status: "aprovado" | "rejeitado"; rule?: { text?: string; scope?: ForYouRuleScope } }): Promise<void> {
    const rule = item.rule;
    if (!rule) throw new HttpError(409, `O item ${item.id} não tem regra`);
    const state = await this.state();
    const record = state.rules.find((candidate) => candidate.itemId === item.id);
    if (!record) throw new HttpError(409, `A regra do item ${item.id} não está mais na retrospectiva`);
    const now = this.deps.now().getTime();
    if (decision.status === "rejeitado") {
      record.state = "recusada";
      record.decidedAt = iso(now);
      state.suppressed[record.groupId] = iso(now + RETRO_SUPPRESS_WEEKS * 7 * DAY_MS);
      await this.deps.store.writeState(state);
      return;
    }
    const text = (decision.rule?.text ?? rule.text).replace(/\s+/g, " ").trim();
    if (text.length === 0) throw new HttpError(400, "A regra precisa de um texto");
    const scope = this.checkScope(decision.rule?.scope ?? rule.scope);
    let notePath: string | undefined;
    if (scope.agentId) {
      // Regra de UM agente: vai para as regras dele (só ele a recebe), não para uma nota que a sala toda carregaria.
      await this.deps.agentRules.append(scope.agentId, this.agentRuleLine(text));
    } else {
      const brainId = scope.global ? GLOBAL_BRAIN_ID : scope.roomId;
      if (!brainId || !this.deps.brain.hasBrain(brainId)) throw new HttpError(400, "Não achei o Cérebro desse escopo (o quarto ainda existe?)");
      notePath = await this.writeNote(brainId, { text, scope, record, evidence: rule.evidence.line });
    }
    const finalRule: ForYouRule = { ...rule, text, scope };
    if (text !== rule.text || JSON.stringify(scope) !== JSON.stringify(rule.scope)) await this.deps.forYou.updateRule(item.id, finalRule);
    Object.assign(record, { state: "aprovada" as const, text, scope, decidedAt: iso(now), ...(notePath ? { notePath } : {}) });
    await this.deps.store.writeState(state);
    this.deps.log.info({ itemId: item.id, ...(notePath ? { notePath } : { agentId: scope.agentId }) }, scope.agentId ? "regra da retrospectiva aprovada: entrou nas regras do agente" : "regra da retrospectiva aprovada: nota gravada no Cérebro");
  }

  /** A regra como linha das regras do agente (cabe no teto de uma regra de agente). */
  private agentRuleLine(text: string): string {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length <= BRAIN_RULE_LIMITS.agentRule ? line : `${line.slice(0, BRAIN_RULE_LIMITS.agentRule - 1).trimEnd()}…`;
  }

  private checkScope(scope: ForYouRuleScope): ForYouRuleScope {
    if (scope.global) return { global: true };
    if (scope.agentId) {
      const roomId = this.deps.roomOfAgent(scope.agentId);
      if (!roomId) throw new HttpError(400, `O agente "${scope.agentId}" não existe mais`);
      return { agentId: scope.agentId, roomId };
    }
    if (scope.roomId && this.deps.roomExists(scope.roomId)) return { roomId: scope.roomId };
    throw new HttpError(400, "Escolha onde a regra vale: um agente, um quarto ou todo o workspace");
  }

  /** A nota da regra no Cérebro: `tags: [regra, retro]` e `origem: retro-<semana>`; entra no contexto pelo `buildContext` de sempre. */
  private async writeNote(brainId: string, input: { text: string; scope: ForYouRuleScope; record: RuleRecord; evidence: string | undefined }): Promise<string> {
    const { record } = input;
    const who = input.scope.global ? "todos os agentes do workspace" : input.scope.agentId ? (record.agentNames.length === 1 ? record.agentNames[0]! : "um agente") : "os agentes do quarto";
    const heading = `Regra: ${input.text.replace(/\.$/, "")}`;
    const content = [
      renderFields({ tipo: "preferencia", autor: "Retrospectiva da Gestão", data: iso(this.deps.now().getTime()), tags: ["regra", "retro"], origem: `retro-${record.retro}` }),
      `# ${heading}`,
      "",
      input.text,
      "",
      `Vale para: ${who}. Aprovada pelo dono na retrospectiva ${record.retro}${input.evidence ? ` (o dono ${input.evidence})` : ""}.`,
      "",
    ].join("\n");
    const base = `${slugify(input.text, "regra").slice(0, 48).replace(/-+$/g, "")}-${record.groupId.replace(/^g-/, "").slice(0, 6)}`;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const file = `${base}${attempt === 0 ? "" : `-${attempt + 1}`}.md`;
      try {
        await this.deps.brain.writeRootNote(brainId, file, content, { replace: false, indexLine: `- [[${file.replace(/\.md$/i, "")}]] — ${heading.slice(0, 100)}` });
        return `${brainId}/${file}`;
      } catch (error) {
        if (!(error instanceof Error && /already exists/.test(error.message))) throw error;
      }
    }
    throw new HttpError(500, "Não consegui um nome livre para a nota da regra");
  }
}
