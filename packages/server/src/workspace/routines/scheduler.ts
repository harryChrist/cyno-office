import {
  closeAtFor,
  goalOf,
  isActiveTaskStatus,
  isRoutinePaused,
  pad2,
  periodBoundsFor,
  ROUTINE_TIMEZONE,
  zoned,
  previousPeriodKeyFor,
  type Agent,
  type EngineBlock,
  type MetaPlan,
  type OfficeState,
  type Routine,
  type RoutinePeriod,
  type RoutineResult,
  type Task,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { shorten } from "../../util/text";
import type { MetaTracker } from "./meta-tracker";
import type { RoutineService } from "./routine-service";

/** De quanto em quanto tempo o vigia confere (como o usage-poller: uma cadeia de setTimeout). */
export const ROUTINE_TICK_MS = 10 * 60_000;
/** Depois de uma tarefa sem entrega (falhou ou terminou sem item), espera isto antes de tentar de novo. */
export const ROUTINE_BACKOFF_MS = 60 * 60_000;
/** Faltando menos que isto para o fim do período e atrasada: a meta está em risco. */
export const ROUTINE_RISK_MS = 2 * 86_400_000;
/** Reduz a meta em 30% na pergunta de "baixar a meta". */
const LOWER_FACTOR = 0.7;

/**
 * Quando o vigia volta a tentar depois de uma tarefa sem entrega (ISO), ou undefined se não há espera.
 * A espera conta a partir do fim da última tarefa da rotina que não entregou nada.
 */
export function backoffRetryAt(routine: Pick<Routine, "id" | "lastTaskId" | "lastDispatchAt">, tasks: readonly Pick<Task, "id" | "status" | "updatedAt">[], entries: readonly { taskId: string; stage: string }[], now: Date): string | undefined {
  const last = routine.lastTaskId ? tasks.find((task) => task.id === routine.lastTaskId) : undefined;
  if (!last || isActiveTaskStatus(last.status) || !routine.lastDispatchAt) return undefined;
  const until = Date.parse(last.updatedAt) + ROUTINE_BACKOFF_MS;
  if (until <= now.getTime()) return undefined;
  if (entries.some((entry) => entry.taskId === last.id && entry.stage === "entregue")) return undefined;
  return new Date(until).toISOString();
}

export type WakeInput = { kind: "weekly" | "risk"; title: string; message: string; origin: string };

export type RoutineSchedulerDeps = {
  routines: RoutineService;
  /** As contas da Meta v2: plano, o que está em andamento e a dispensa das opções que sobram. */
  meta: Pick<MetaTracker, "plan" | "flight" | "delivered" | "dismissLeftovers" | "approvedLines">;
  state: { read(): OfficeState };
  /** Quem executa a rotina agora: o agente dono, ou o escolhido no time dela. */
  pickAgent: (routine: Routine) => Agent | undefined;
  /** Motor do agente sem cota/CLI? (mesmo teste do delegate do Maestro) */
  blocked: (agent: Agent) => EngineBlock | undefined;
  /** Cria o trabalho do agente já na fila: um Projeto "tarefa" de origem "rotina" (ProjectService.startRoutineTask), com o período. */
  createTask: (routine: Routine, agent: Agent, prompt: string, period: string) => Promise<Task>;
  /** Acorda o Maestro com uma mensagem (false = não deu: sem Maestro de CLI). */
  wake: (input: WakeInput) => boolean;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
  now: () => Date;
  /** Intervalo do vigia (testes). */
  everyMs?: number;
};

/**
 * Vigia das metas (sem gastar token). A cada 10 minutos, para cada meta ativa, pergunta a `planMeta` o
 * que falta no período (semana ou mês): se está atrasada pela curva (que usa os dias preferidos como
 * sugestão), o que já está em preparo, esperando OK ou aprovado não cobre o que falta, não há tarefa
 * aberta, o motor está livre e o teto diário permite, cria UMA tarefa (um lote por vez, com
 * `prepareFactor` vezes mais opções para escolher) direto para o agente. Bateu o alvo: para até o
 * próximo período e dispensa, sem IA, as opções que sobraram. Período que não bateu não acumula. O
 * Maestro só é acordado no fechamento (segunda 08:00 para semana, dia 1 08:00 para mês, São Paulo) e
 * quando uma meta está em risco (uma vez por meta por período).
 */
export class RoutineScheduler {
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private running = false;

  constructor(private readonly deps: RoutineSchedulerDeps) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((error: unknown) => this.deps.log.error({ err: error }, "vigia de rotinas falhou"))
        .finally(() => this.schedule());
    }, this.deps.everyMs ?? ROUTINE_TICK_MS);
    this.timer.unref();
  }

  /** Uma passada do vigia (os testes chamam direto). */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.deps.now();
      this.closeIfDue(now, "week");
      this.closeIfDue(now, "month");
      for (const routine of this.deps.routines.active()) {
        // Rotina fabricada pela semente do app de teste: não é cobrada (seria um turno de verdade por uma meta inventada).
        if (routine.seed) continue;
        try {
          await this.visit(routine, now);
        } catch (error) {
          this.deps.log.error({ err: error, routineId: routine.id }, "falha ao vigiar a rotina");
        }
      }
      this.wakeForRisk(now);
    } finally {
      this.running = false;
    }
  }

  // ---------- Uma rotina ----------

  private skip(routine: Routine, reason: string): void {
    this.deps.routines.logDecision(routine.id, { kind: "skipped", reason });
  }

  private async visit(routine: Routine, now: Date): Promise<void> {
    const { routines } = this.deps;
    const goal = goalOf(routine);
    const key = periodBoundsFor(now, goal.period).key;
    // Bateu: as opções que sobraram nos cartões são dispensadas (sem IA), mesmo com a rotina pausada.
    if (goal.stopOnHit && this.deps.meta.plan(routine, now).hit) await this.deps.meta.dismissLeftovers(routine);
    if (isRoutinePaused(routine, now)) return this.skip(routine, "pausada");
    if (routine.blocked) return this.skip(routine, `bloqueada: ${routine.blocked.reason} (use "Tentar de novo")`);
    if (routine.skipPeriods.includes(key)) return this.skip(routine, goal.period === "month" ? "mês pulado" : "semana pulada");
    const plan = this.deps.meta.plan(routine, now);
    if (plan.action === "pular") return this.skip(routine, plan.reason);
    const tasks = this.deps.state.read().tasks;
    const agent = this.deps.pickAgent(routine);
    if (!agent) return this.skip(routine, "sem agente para executar");
    const block = this.deps.blocked(agent);
    if (block) return this.skip(routine, `motor de ${agent.name} indisponível (${block.reason})`);
    // Tarefa anterior que não entregou nada: espera um pouco em vez de repetir (e gastar) a cada passada.
    const retryAt = backoffRetryAt(routine, tasks, routines.entries, now);
    if (retryAt) return this.skip(routine, `a última tarefa não entregou nada: espera antes de tentar de novo (volta às ${clockOf(retryAt)})`);
    if (plan.action === "registrar") {
      // Cobra só o registro dos links das aprovadas, no máximo uma vez por espera.
      if (routine.linkChaseAt && now.getTime() - Date.parse(routine.linkChaseAt) < ROUTINE_BACKOFF_MS) return this.skip(routine, `falta registrar o link de ${plan.approvedNoLink} aprovada(s); a cobrança do registro já saiu há pouco`);
      const task = await this.deps.createTask(routine, agent, linkChasePrompt(routine, plan, this.deps.meta.approvedLines(routine, now)), key);
      routines.markDispatched(routine.id, task.id);
      routines.markLinkChase(routine.id);
      routines.logDecision(routine.id, { kind: "dispatched", reason: `${plan.reason} para ${agent.name}`, taskId: task.id });
      this.deps.log.info({ routineId: routine.id, taskId: task.id, approvedNoLink: plan.approvedNoLink }, "rotina: cobrança só do registro dos links");
      return;
    }
    const prompt = metaPrompt(routine, plan, now);
    const task = await this.deps.createTask(routine, agent, prompt, key);
    routines.markDispatched(routine.id, task.id);
    routines.logDecision(routine.id, { kind: "dispatched", reason: `${plan.reason} para ${agent.name}`, taskId: task.id });
    this.deps.log.info({ routineId: routine.id, taskId: task.id, batch: plan.batch, candidates: plan.candidates }, "rotina: tarefa criada");
  }

  // ---------- Fechamento do período ----------

  /** A partir de segunda 08:00 (semana) ou do dia 1, 08:00 (mês), São Paulo: fecha o período anterior uma vez e acorda o Maestro para o resumo. */
  private closeIfDue(now: Date, period: RoutinePeriod): void {
    const { routines } = this.deps;
    const previous = previousPeriodKeyFor(now, period);
    const closed = period === "month" ? routines.closedMonth() : routines.closedPeriod();
    if (now.getTime() < closeAtFor(now, period).getTime() || closed === previous) return;
    const results = routines.closePeriod(previous);
    const noun = period === "month" ? "mensal" : "semanal";
    this.deps.log.info({ period: previous, routines: results.length }, `rotinas: período ${noun} fechado`);
    if (results.length === 0) return;
    for (const result of results) this.maybeAskLowerGoal(result);
    const lines = results.map((result) => {
      const routine = routines.find(result.routineId);
      const label = routine ? `${routine.title} (${routine.id})` : result.routineId;
      const verdict = result.outcome === "pulada" ? "período pulado" : result.outcome === "bateu" ? "bateu a meta" : "NÃO bateu a meta";
      const prep = result.prepared ? ` (${result.prepared} opções preparadas, ${result.approved ?? 0} aprovadas, ${result.dismissed ?? 0} dispensadas)` : "";
      return `- ${label}: ${result.delivered}/${result.target} entregues, ${verdict}${prep}`;
    });
    const message = [
      `Fechamento ${noun} das rotinas (${previous}).`,
      lines.join("\n"),
      "Escreva o resumo: o que bateu, o que não bateu e por quê (use routine_status e routine_list para ver o ritmo, o custo e o histórico), o custo por unidade e uma sugestão por meta. Salve o resumo como nota no Cérebro (save_note, título \"Rotinas - " + (period === "month" ? "mês " : "semana ") + previous + "\") e depois conclua este pedido com complete_request contendo o mesmo resumo curto (o usuário recebe o aviso). Você não muda metas: só sugere ao usuário.",
    ].join("\n\n");
    const woke = this.deps.wake({ kind: "weekly", title: `Resumo ${noun} das rotinas (${previous})`, message, origin: `Fechamento ${noun} ${previous}` });
    routines.logDecision(results[0]!.routineId, { kind: "wake", reason: woke ? `Maestro acordado para o resumo de ${previous}` : `resumo de ${previous} sem Maestro de CLI para escrever` });
  }

  /** Duas semanas ruins seguidas: pergunta (no Para você) se quer baixar a meta; de novo só a cada duas semanas ruins. */
  private maybeAskLowerGoal(result: RoutineResult): void {
    const { routines } = this.deps;
    if (result.outcome !== "nao_bateu") return;
    const streak = routines.badStreak(result.routineId);
    if (streak < 2 || streak % 2 !== 0) return;
    const routine = routines.find(result.routineId);
    if (!routine || routine.status === "encerrada" || routine.target <= 1) return;
    const suggested = Math.max(1, Math.min(routine.target - 1, Math.floor(routine.target * LOWER_FACTOR)));
    routines.askLowerGoal(routine, suggested, `A meta não foi batida em ${streak} ${routine.period === "month" ? "meses" : "semanas"} seguidos. Baixar de ${routine.target} para ${suggested} por ${routine.period === "month" ? "mês" : "semana"}?`);
  }

  // ---------- Meta em risco ----------

  /** Atrasada com menos de 2 dias para o fim do período: acorda o Maestro uma vez por meta por período (uma mensagem para todas). */
  private wakeForRisk(now: Date): void {
    const { routines } = this.deps;
    const risky: { routine: Routine; plan: MetaPlan }[] = [];
    for (const routine of routines.active()) {
      if (routine.seed) continue;
      const bounds = periodBoundsFor(now, routine.period);
      if (bounds.end.getTime() - now.getTime() >= ROUTINE_RISK_MS) continue;
      if (isRoutinePaused(routine, now) || routine.skipPeriods.includes(bounds.key) || routine.riskWokenPeriod === bounds.key) continue;
      const plan = this.deps.meta.plan(routine, now);
      if (plan.pace === "atrasada") risky.push({ routine, plan });
    }
    if (risky.length === 0) return;
    const lines = risky.map(({ routine, plan }) => `- ${routine.title} (${routine.id}): ${plan.delivered}/${routine.target} entregues (${plan.periodKey})`);
    const message = [
      "Meta em risco: faltam menos de 2 dias para o fim do período e estas rotinas estão atrasadas.",
      lines.join("\n"),
      "Veja o motivo com routine_status (tarefas, limites do site, motor sem cota). Você não muda metas nem retoma rotinas: avise o usuário com uma frase curta e, se fizer sentido, sugira o que fazer. Feche este pedido com complete_request.",
    ].join("\n\n");
    const woke = this.deps.wake({ kind: "risk", title: "Meta de rotina em risco", message, origin: `Meta em risco ${risky[0]!.plan.periodKey}` });
    for (const { routine, plan } of risky) {
      // Marca mesmo sem Maestro de CLI: um aviso por período, nunca a cada passada.
      routines.markRiskWoken(routine.id, plan.periodKey);
      routines.logDecision(routine.id, { kind: "wake", reason: woke ? "Maestro acordado: meta em risco" : "meta em risco (sem Maestro de CLI para avisar)" });
    }
  }
}

/** "10:40" (hora de São Paulo) de um instante ISO. */
export function clockOf(iso: string): string {
  const parts = zoned(Date.parse(iso), ROUTINE_TIMEZONE);
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

/** O pedido curto da cobrança do registro: sem preparar nada novo, só os links das aprovadas. */
export function linkChasePrompt(routine: Routine, plan: MetaPlan, lines: readonly string[]): string {
  return [
    `Rotina: ${routine.title}`,
    `Registre os links das ${plan.approvedNoLink} aprovada(s) da meta (${plan.periodKey}): ${plan.delivered}/${plan.target} ${routine.unit} entregues com link.`,
    "O usuário já aprovou estes itens, mas o servidor não tem o link registrado de todos:",
    lines.length > 0 ? lines.join("\n") : "(consulte o que você publicou nesta rotina)",
    `NÃO prepare opções novas nem execute nada novo, e não peça aprovação. ${routine.instruction ? "Faça o que as Instruções da rotina (abaixo) mandam para um item aprovado, se ainda não foi feito, e registre." : ""} Para cada item acima que você de fato fez em ${routine.site}, abra o item e registre o link com routine_record (routine_id "${routine.id}" e o link completo). Se a rotina não publica em site nenhum ou o item foi ENTREGUE AO DONO (ele aprova e usa por conta própria, nada foi publicado), registre SEM link: routine_record com delivered_to "owner" e uma nota dizendo o que foi entregue; nunca invente um link. Se algum não foi feito, não registre: diga qual no submit_result.`,
    routine.instruction ? `Instruções da rotina:\n${shorten(routine.instruction, 2500)}` : "",
    "Termine com submit_result curto listando o que foi registrado.",
  ].join("\n\n");
}

const WEEKDAY_NAMES = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"];

/**
 * O pedido ao agente da cobrança de uma Meta: curto e com tudo que ele precisa (ele não viu a conversa).
 * Diz quanto falta, quantas opções preparar e que no "Pede OK" o certo é UM lote (`request_approval` com
 * `items[]`); no Automático ele executa só até o que falta (o servidor conta e bloqueia além do alvo).
 */
export function metaPrompt(routine: Routine, plan: MetaPlan, now: Date): string {
  const goal = goalOf(routine);
  const days = Math.max(0, Math.ceil((Date.parse(plan.periodEnd) - now.getTime()) / 86_400_000));
  const period = goal.period === "month" ? "do mês" : "da semana";
  const left = plan.missing - plan.pendingCover;
  const preferred = goal.preferredDays?.length ? `Dias preferidos: ${goal.preferredDays.map((day) => WEEKDAY_NAMES[day - 1]).join(", ")} (é só sugestão: o que conta é fechar o alvo no período).` : "";
  const extra = plan.candidates > plan.batch;
  const asking = routine.mode.kind === "pede-ok";
  const how = asking
    ? [
        extra
          ? `Analise e prepare ${plan.candidates} opções bem pensadas (exatamente ${plan.candidates}, nem mais, nem menos), cada uma com a sua recomendação (por que vale), para o usuário escolher as ${plan.batch} melhores. Mande TODAS num único lote: UMA chamada de request_approval com items[] (${plan.candidates} itens, um rascunho por opção), nunca uma por vez. O usuário aprova só ${plan.batch}: quando o alvo fecha, as outras são dispensadas pelo servidor.`
          : `Prepare ${plan.batch} e mande num único lote: UMA chamada de request_approval com items[] (um item por rascunho), nunca uma por vez.`,
        `Quando a resposta chegar, execute SÓ os itens aprovados (ignore os recusados, cancelados e dispensados) e registre cada um com routine_record (routine_id "${routine.id}" e o link do item) logo depois de fazer.`,
      ]
    : [
        `Esta rotina está em modo Automático: execute você mesmo, direto em ${routine.site}, só até ${plan.batch}${extra ? ` (você pode analisar ${plan.candidates} opções para escolher as ${plan.batch} melhores, mas execute apenas as ${plan.batch} melhores)` : ""}. O servidor conta e não deixa passar do alvo: o que passar disso não é aprovado.`,
        `Registre cada item feito com routine_record (routine_id "${routine.id}" e o link do item) logo depois de fazer.`,
      ];
  return [
    `Rotina: ${routine.title}`,
    `Meta ${period} (${plan.periodKey}): ${plan.delivered}/${plan.target} ${routine.unit} entregues${plan.inFlight > 0 ? `, ${plan.inFlight} aprovada(s) esperando execução` : ""}; faltam ${left} para fechar (${days} dia(s) até o fim do período).`,
    preferred,
    `Faça ${plan.batch} agora, em ${routine.site}.`,
    ...how,
    `${plan.missing - plan.pendingCover > plan.batch ? `Faltam ${plan.missing - plan.pendingCover} no período, mas o teto diário do site limita este lote a ${plan.batch}: faça só ${plan.batch} agora.\n\n` : ""}Termine com submit_result listando os links. Só conta o que for entregue (link de ${routine.site}, ou routine_record com delivered_to "owner" e uma nota quando a entrega é para o próprio dono, sem publicar) e submit_result; não registre o que não fez nem repita um link.`,
    routine.instruction ? `Instruções da rotina:\n${shorten(routine.instruction, 2500)}` : "",
    asking
      ? "Ações que publicam, enviam ou conectam pedem a aprovação do usuário (request_approval / o navegador pede sozinho)."
      : "Qualquer ação sensível fora das permitidas desta rotina continua pedindo aprovação.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
