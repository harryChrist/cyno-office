import { randomUUID } from "node:crypto";
import {
  batchPlan,
  formatAnswers,
  DEFAULT_FOR_YOU_LIVE_DAYS,
  forYouKind,
  forYouOriginalText,
  batchHistoryKeepers,
  isForYouArchivable,
  isMaestroTask,
  MAX_REWORK,
  normalizeSources,
  type ForYouActor,
  type ForYouArchiveSummary,
  type ForYouAnswer,
  type ForYouItem,
  type BrainOrganizePlan,
  type ForYouRule,
  type ForYouRuleScope,
  type ForYouQuestion,
  type ForYouSource,
  type forYouDecisionBodySchema,
  type RoutineProposalPayload,
  type ServerEvent,
  type Task,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import type { z } from "zod";
import { HttpError } from "../../platform/http/errors";
import type { ApprovalCancel, ApprovalDecision, ApprovalDraft, ApprovalItemResult, ApprovalRequest } from "../../engines/runner/types";
import type { StateManager } from "../../store/state-manager";
import type { ForYouTypesService } from "./types-service";

type DecisionInput = z.output<typeof forYouDecisionBodySchema>;

/** Quem recebe os pedidos de aprovação do orquestrador (cria o item do "Para você"). */
export type ApprovalInbox = {
  open(task: Task, request: ApprovalRequest): ForYouItem;
  /** Lote (`request.items`): um item por rascunho, todos com o mesmo `groupId`. */
  openMany(task: Task, request: ApprovalRequest): ForYouItem[];
  /**
   * Modo Automático: os itens recém-abertos que saíram decididos sozinhos (todos, ou o lote inteiro)
   * viram a decisão que o agente recebe agora, sem esperar o usuário. undefined = ainda há o que decidir.
   */
  autoDecision?(task: Task, items: readonly ForYouItem[]): ApprovalDecision | undefined;
};

/** Resposta do Modo Automático a um item: liberado (com "3 de 8 hoje") ou não (com o motivo, para a nota do cartão). */
export type AutoVerdict = { ok: true; projectId: string; label: string } | { ok: false; note?: string };


export type ForYouDeps = {
  state: StateManager;
  log: Pick<FastifyBaseLogger, "error">;
  now: () => Date;
  /** Dias que um item decidido fica na lista viva antes de ir para o arquivo (0 = nunca; ausente = o padrão). Lido a cada varredura, então a configuração vale na hora. */
  liveDays?: () => number;
  /**
   * Itens que precisam continuar na lista viva mesmo decididos há tempo (a Meta de uma rotina conta as aprovações do
   * período, que pode ser o mês). Chamada uma vez por varredura; devolve o teste por item.
   */
  holdLive?: () => (item: ForYouItem) => boolean;
  /** Biblioteca de mídia: liga as mídias do pedido ao item e aprova as em rascunho quando o item é aprovado. */
  media?: { linkForYou(ids: readonly string[], forYouId: string): void; approve(ids: readonly string[]): void };
  /** Tipos do workspace: um tipo desconhecido no pedido é criado na hora (nunca falha). */
  types: Pick<ForYouTypesService, "ensure" | "list" | "resolve">;
  /** Decide a aprovação pendente da tarefa (orquestrador): a tarefa segue ou falha. */
  decideTask: (taskId: string, decision: ApprovalDecision) => Promise<Task>;
  /** Decisão num item de plano (aprovar, ajustar com a nota, cancelar): quem decide é o ProjectService. */
  decidePlan?: (item: ForYouItem, decision: { status: "aprovado" | "rejeitado" | "respondido"; response?: string }) => Promise<void>;
  /** Decisão num cartão "sprint" (aprovar a entrega ou devolver com o motivo e as tarefas de retrabalho): quem decide é o ProjectService, que fecha o item. */
  decideSprint?: (item: ForYouItem, decision: { status: "aprovado" | "rejeitado" | "respondido"; reason?: string; returnRefs?: string[] }) => Promise<void>;
  /**
   * Decisão num cartão "regra" (a retrospectiva da Gestão): aprovar grava a nota no Cérebro (com o texto e o escopo que o dono
   * ajustou), recusar esconde o padrão por 8 semanas. Só o dono decide, pelo clique: nenhum modo automático chega aqui. Quem
   * decide é o RetroService; o item fecha aqui.
   */
  decideRule?: (item: ForYouItem, decision: { status: "aprovado" | "rejeitado"; rule?: { text?: string; scope?: ForYouRuleScope } }) => Promise<void>;
  /**
   * Decisão num cartão "organizacao" (organizar o Cérebro): aprovar aplica as ações que o dono deixou marcadas (as que
   * falham ficam registradas no cartão), recusar não muda nada. Só o clique do dono chega aqui: o item fecha aqui.
   */
  decideOrganize?: (item: ForYouItem, decision: { status: "aprovado" | "rejeitado"; organize?: { skip?: number[] } }) => Promise<void>;
  /** Decisão num cartão "rotina" (criar/ajustar): quem decide é o RoutineService; o item fecha aqui. */
  decideRoutine?: (item: ForYouItem, decision: { status: "aprovado" | "rejeitado" | "respondido"; response?: string; routine?: DecisionInput["routine"] }) => Promise<void>;
  /** Questionário do Maestro enviado: as respostas vão numa mensagem só para ele (pedido ou conversa). */
  maestroAnswers?: (item: ForYouItem, answers: string) => void;
  /**
   * Item cancelado (já gravado como "cancelado"): solta quem ele segurava. `waitingTaskId` = a tarefa
   * que espera por ele (se houver). O runtime manda para o Maestro de CLI (itens dele) ou para o
   * orquestrador (a tarefa do agente segue sem a resposta).
   */
  release?: (item: ForYouItem, cancel: ApprovalCancel, waitingTaskId: string | undefined, decision?: ApprovalDecision) => Promise<void> | void;
  /**
   * Recusa com motivo numa tarefa de projeto: conta o retrabalho (`rework.count`, `rework.last`).
   * Devolve false quando o limite (MAX_REWORK) já foi usado ou a tarefa não é de um projeto: aí a
   * recusa segue o fluxo antigo (a tarefa falha como "Recusado" e o Maestro decide).
   */
  registerRework?: (task: Task, input: { reason: string; itemId: string }) => boolean;
  /** Modo Automático: libera (e conta) um item de aprovação do tipo dado numa tarefa de projeto. */
  autoReserve?: (task: Task, type: string) => AutoVerdict;
  /**
   * Meta com preparo (Rotinas): o servidor conta o que já está comprometido (entregue + aprovado) para
   * nunca aprovar além do alvo. `standing` = undefined quando a tarefa não é de uma Meta. `opened` e
   * `counted` só mantêm o histórico do período (preparadas, aprovadas, dispensadas).
   */
  routineMeta?: {
    standing(task: Task): { committed: number; target: number; stopOnHit: boolean } | undefined;
    opened(task: Task, items: readonly ForYouItem[]): void;
    counted(task: Task, delta: { approved?: number; dismissed?: number }): void;
  };
  /** Um item foi decidido sozinho (Atividade: "… (Automático · 3 de 8 hoje)"). */
  onAutoDecided?: (item: ForYouItem, task: Task, label: string) => void;
  /** Aprovação em lote concluída (Atividade: "Você aprovou 3 itens em lote"). */
  onBatchApproved?: (items: readonly ForYouItem[]) => void;
  /** O item é uma aprovação do Maestro que o pedido dele ainda espera (mesmo sem ser o mais novo)? */
  holdsItem?: (item: ForYouItem) => boolean;
  /** Quantos retrabalhos a tarefa já usou (para o agente saber em que tentativa está). */
  reworkCount?: (task: Task) => number;
};

/** "Descartado pelo usuário: motivo", "Cancelado pelo Maestro", "Cancelado pelo agente" (log da tarefa). */
export function cancelNote(cancel: ApprovalCancel): string {
  const head = cancel.by === "usuario" ? "Descartado pelo usuário" : cancel.by === "maestro" ? "Cancelado pelo Maestro" : "Cancelado pelo agente";
  const reason = cancel.reason?.trim();
  return reason ? `${head}: ${reason}` : head;
}

/** O que `update_pending_item` troca num item pendente (só os campos dados). */
export type ForYouChange = { title?: string; questions?: ForYouQuestion[]; text?: string; question?: string; sources?: ForYouSource[]; reason?: string };

/** Pergunta de um questionário como o modelo manda (ferramentas MCP). */
export type QuestionInput = { question: string; options?: string[]; default?: string };

/** Perguntas com id (q1, q2…), sem as vazias. */
export function toQuestions(input: readonly QuestionInput[]): ForYouQuestion[] {
  return input
    .map((question) => ({ text: question.question.trim(), options: question.options?.map((option) => option.trim()).filter(Boolean), default: question.default?.trim() || undefined }))
    .filter((question) => question.text)
    .map((question, index) => compact({ id: `q${index + 1}`, text: question.text, options: question.options && question.options.length > 0 ? question.options : undefined, default: question.default }));
}

const sameQuestion = (text: string) => text.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Perguntas novas de um questionário com o rascunho das respostas preservado: a resposta de uma
 * pergunta que continua igual (mesmo texto, sem diferença de maiúsculas/espaços) vai para o id
 * novo dela; as das perguntas que saíram ou mudaram somem.
 */
export function remapAnswers(
  before: readonly ForYouQuestion[],
  answers: Readonly<Record<string, ForYouAnswer>> | undefined,
  next: readonly ForYouQuestion[],
): Record<string, ForYouAnswer> {
  const used = new Set<string>();
  const out: Record<string, ForYouAnswer> = {};
  for (const question of next) {
    const old = before.find((candidate) => !used.has(candidate.id) && sameQuestion(candidate.text) === sameQuestion(question.text));
    if (!old) continue;
    used.add(old.id);
    const answer = answers?.[old.id];
    if (answer) out[question.id] = answer;
  }
  return out;
}

/** "3 pergunta(s); responda…" (o "por quê" do questionário do Maestro) com a contagem nova. */
const QUESTION_COUNT = /^\d+ pergunta\(s\)/;

/** Texto do item criado no boot para uma aprovação de antes do "Para você" (sem rascunho). */
export const BACKFILL_WHY = "Esta tarefa pediu aprovação antes do Para você existir: o rascunho do agente não foi guardado.";

/** Motivo gravado nas opções de uma Meta que sobraram quando ela fechou. */
export const DISMISSED_REASON = "Dispensado: meta batida";

/** Itens que já podem ir para o arquivo: os decididos há mais que o prazo; num lote, só quando o lote inteiro pode. */
export function dueForArchive(items: readonly ForYouItem[], nowMs: number, liveDays: number, hold?: (item: ForYouItem) => boolean): ForYouItem[] {
  // Ficam sempre na lista viva: os cartões de regra (são poucos e a retrospectiva lista as já decididas), a aprovação
  // individual mais recente de cada agente em convite e post (é ela que libera o lote: veja batchHistoryKeepers) e o cartão
  // de sprint cancelado (o fechamento da sprint o refaz enquanto a sprint estiver fechando).
  const keepers = batchHistoryKeepers(items);
  const stays = (item: ForYouItem) => forYouKind(item) === "regra" || keepers.has(item.id) || (item.status === "cancelado" && forYouKind(item) === "sprint");
  const archivable = items.filter((item) => isForYouArchivable(item, nowMs, liveDays) && !hold?.(item) && !stays(item));
  if (archivable.length === 0) return [];
  const ok = new Set(archivable);
  const blockedGroups = new Set(items.filter((item) => item.groupId !== undefined && !ok.has(item)).map((item) => item.groupId));
  return archivable.filter((item) => item.groupId === undefined || !blockedGroups.has(item.groupId));
}

/** Tira os campos undefined (o item fica igual ao que volta do JSON). */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

/**
 * Tira os itens que casam com `drop` (quarto, agente ou tarefa removidos). Devolve a lista nova
 * (undefined = nada mudou) e os eventos foryou:deleted, para irem no mesmo commit da remoção.
 */
export function dropForYouItems(
  items: ForYouItem[],
  drop: (item: ForYouItem) => boolean,
): { forYou: ForYouItem[] | undefined; events: ServerEvent[] } {
  const removed = items.filter(drop);
  if (removed.length === 0) return { forYou: undefined, events: [] };
  return {
    forYou: items.filter((item) => !drop(item)),
    events: removed.map((item): ServerEvent => ({ type: "foryou:deleted", id: item.id })),
  };
}

/**
 * Itens do "Para você" de um workspace (for-you.json). Cada pedido de aprovação de um agente vira
 * um item ligado à tarefa (`taskId`). Decidir o item decide a tarefa, se ela ainda espera:
 * aprovado/respondido -> a tarefa segue com o texto final e a resposta; rejeitado -> a tarefa
 * falha com a nota como motivo. Reabrir só volta o item para "pendente": a tarefa não volta
 * (se ela já seguiu, decidir de novo só muda o item).
 */
export class ForYouService implements ApprovalInbox {
  /** Itens com decisão em curso (evita decidir duas vezes enquanto a tarefa grava). */
  private readonly deciding = new Set<string>();
  /** "3 de 8 hoje" de cada item decidido sozinho (só até a Atividade registrar). */
  private readonly autoLabels = new Map<string, string>();

  constructor(private readonly deps: ForYouDeps) {}

  /** Itens em ordem de criação. */
  list(): ForYouItem[] {
    return this.deps.state.readForYou();
  }

  /**
   * Pedido de aprovação do agente: cria o item pendente com o rascunho (síncrono no estado). Com
   * `questions` (ask_user), o item é um questionário que segura só esta tarefa.
   */
  open(task: Task, request: ApprovalRequest): ForYouItem {
    const items = this.deps.state.readForYou();
    const item = this.build(items, task, request.question, request.draft, request.questions);
    this.auto(task, item);
    items.push(item);
    void this.save(items, [item]);
    this.deps.routineMeta?.opened(task, [item]);
    if (item.mediaIds) this.deps.media?.linkForYou(item.mediaIds, item.id);
    if (item.mediaIds && item.decidedBy === "automatico") this.deps.media?.approve(item.mediaIds);
    return item;
  }

  /** Lote de aprovações: um item por rascunho, com `groupId` comum; a tarefa espera todos. */
  openMany(task: Task, request: ApprovalRequest): ForYouItem[] {
    const batch = request.items ?? [];
    if (batch.length === 0) return [this.open(task, request)];
    const items = this.deps.state.readForYou();
    const groupId = `G-${randomUUID().slice(0, 8)}`;
    const created: ForYouItem[] = [];
    // A posição da meta antes do lote: os itens que o lote aprova sozinho entram na conta um a um.
    const standing = this.deps.routineMeta?.standing(task);
    for (const entry of batch) {
      const item = { ...this.build(items, task, entry.question, entry.draft, undefined), groupId };
      this.auto(task, item, { standing, batchApproved: created.filter((other) => other.status === "aprovado").length });
      items.push(item);
      created.push(item);
    }
    void this.save(items, created);
    this.deps.routineMeta?.opened(task, created);
    for (const item of created) {
      if (!item.mediaIds) continue;
      this.deps.media?.linkForYou(item.mediaIds, item.id);
      if (item.decidedBy === "automatico") this.deps.media?.approve(item.mediaIds);
    }
    return created;
  }

  /**
   * Modo Automático: o projeto da tarefa está em Automático, o tipo do item está no `grant` e o teto do
   * dia não acabou -> o item já nasce decidido ("aprovado", decidedBy "automatico"). Senão fica pendente
   * como sempre, com uma nota do motivo. Perguntas (ask_user) nunca: precisam da resposta do usuário.
   */
  private auto(task: Task, item: ForYouItem, batch?: { standing: ReturnType<NonNullable<ForYouDeps["routineMeta"]>["standing"]>; batchApproved: number }): void {
    if (item.kind === "questionario" || !task.work || !this.deps.autoReserve) return;
    // Meta batida (entregue + aprovado >= alvo): nada é aprovado além do alvo, nem no Automático.
    const standing = batch ? batch.standing : this.deps.routineMeta?.standing(task);
    if (standing?.stopOnHit && standing.committed + (batch?.batchApproved ?? 0) >= standing.target) {
      item.meta = { ...item.meta, Meta: `Meta batida (${standing.target}/${standing.target}): não é aprovado além do alvo` };
      return;
    }
    const verdict = this.deps.autoReserve(task, item.type);
    if (!verdict.ok) {
      if (verdict.note) item.meta = { ...item.meta, "Modo Automático": verdict.note };
      return;
    }
    Object.assign(item, { status: "aprovado" as const, decidedBy: "automatico" as const, decidedAt: this.deps.now().toISOString() });
    item.meta = { ...item.meta, "Modo Automático": `Decidido sozinho (${verdict.label})` };
    this.autoLabels.set(item.id, verdict.label);
    this.deps.routineMeta?.counted(task, { approved: 1 });
  }

  /**
   * Meta batida: as opções ainda pendentes viram "cancelado" por "servidor" com o motivo
   * "Dispensado: meta batida" (o histórico do cartão fica; nenhuma IA é acordada por isso). Marca
   * também os objetos recebidos, que o chamador ainda usa.
   */
  private dismiss(candidates: readonly ForYouItem[], task: Task): ForYouItem[] {
    const pending = candidates.filter((item) => item.status === "pendente");
    if (pending.length === 0) return [];
    const all = this.deps.state.readForYou();
    const at = this.deps.now().toISOString();
    const changed: ForYouItem[] = [];
    for (const item of pending) {
      const current = all.find((other) => other.id === item.id);
      if (!current || current.status !== "pendente") continue;
      for (const target of [current, item]) {
        Object.assign(target, { status: "cancelado" as const, cancelledBy: "servidor" as const, cancelReason: DISMISSED_REASON, decidedAt: at });
        target.history = [...(target.history ?? []), { at, by: "servidor" as const, action: "cancelado" as const, reason: DISMISSED_REASON }];
      }
      changed.push(current);
    }
    if (changed.length > 0) {
      void this.save(all, changed);
      this.deps.routineMeta?.counted(task, { dismissed: changed.length });
    }
    return changed;
  }

  /** Ao fim do lote: o agente segue com a decisão automática e a Atividade ganha uma linha por item. */
  autoDecision(task: Task, items: readonly ForYouItem[]): ApprovalDecision | undefined {
    const auto = items.filter((item) => item.decidedBy === "automatico");
    for (const item of auto) {
      const label = this.autoLabels.get(item.id);
      this.autoLabels.delete(item.id);
      if (label) this.deps.onAutoDecided?.(item, task, label);
    }
    // Automático: o que passou do alvo é dispensado; o lote só segue quando tudo foi decidido.
    const standing = this.deps.routineMeta?.standing(task);
    const dismissed = standing?.stopOnHit && standing.committed >= standing.target ? this.dismiss(items, task) : [];
    if (items.length === 0 || auto.length + dismissed.length !== items.length || auto.length === 0 && dismissed.length === 0) return undefined;
    const first = items[0]!;
    if (first.groupId) return this.aggregate(task, this.deps.state.readForYou(), first);
    return { approved: true, text: first.text, itemId: first.id };
  }

  private build(items: ForYouItem[], task: Task, question: string, draft: ApprovalDraft | undefined, questions: ForYouQuestion[] | undefined): ForYouItem {
    const asked = questions && questions.length > 0 ? questions : undefined;
    const text = asked ? formatAnswers(asked) : (draft?.text ?? question);
    const state = this.deps.state.read();
    // O projeto da tarefa: o que a executa (`work`; para um pedido simples, o "Avulsas"), senão o pedido.
    const projectId = task.work?.projectId ?? task.projectId ?? (isMaestroTask(state, task) ? task.id : undefined);
    return compact({
      id: this.nextId(items),
      taskId: task.id,
      agentId: task.agentId ?? "",
      roomId: task.roomId,
      type: asked ? this.deps.types.ensure("pergunta") : this.typeFor(draft, question, task.prompt),
      status: "pendente" as const,
      title: asked ? question : draft?.title,
      where: draft?.where,
      to: draft?.to,
      why: draft?.why ?? question,
      meta: draft?.meta ?? {},
      text,
      editedByUser: false,
      kind: asked ? ("questionario" as const) : undefined,
      mediaIds: draft?.mediaIds && draft.mediaIds.length > 0 ? [...new Set(draft.mediaIds)] : undefined,
      sources: normalizeSources(draft?.sources),
      questions: asked,
      answers: asked ? {} : undefined,
      projectId,
      taskRef: task.work?.ref,
      createdAt: this.deps.now().toISOString(),
    });
  }

  /**
   * Item novo de plano ou de questionário do Maestro (não passa pelo orquestrador). `taskId` = o
   * pedido (o questionário de uma conversa não tem pedido).
   */
  openSpecial(input: {
    kind: "plano" | "questionario" | "rotina" | "sprint" | "regra" | "organizacao";
    agentId: string;
    roomId: string;
    taskId?: string;
    projectId?: string;
    sprintId?: string;
    title: string;
    why?: string;
    text?: string;
    questions?: ForYouQuestion[];
    routine?: RoutineProposalPayload;
    rule?: ForYouRule;
    organize?: BrainOrganizePlan;
  }): ForYouItem {
    const items = this.deps.state.readForYou();
    const text = input.text ?? (input.questions ? formatAnswers(input.questions) : input.title);
    const item: ForYouItem = compact({
      id: this.nextId(items),
      taskId: input.taskId,
      agentId: input.agentId,
      roomId: input.roomId,
      type: this.deps.types.ensure(input.kind === "questionario" ? "pergunta" : "outro"),
      status: "pendente" as const,
      title: input.title,
      why: input.why,
      meta: {},
      text,
      editedByUser: false,
      kind: input.kind,
      projectId: input.projectId ?? input.taskId,
      sprintId: input.sprintId,
      routineId: input.routine?.routineId,
      routine: input.routine,
      rule: input.rule,
      organize: input.organize,
      questions: input.questions,
      answers: input.questions ? {} : undefined,
      createdAt: this.deps.now().toISOString(),
    });
    items.push(item);
    void this.save(items, [item]);
    return item;
  }

  /** Grava a regra que o dono ajustou no cartão (texto e escopo), antes de o item fechar: o cartão aprovado mostra o que valeu. */
  async updateRule(id: string, rule: ForYouRule): Promise<ForYouItem> {
    const items = this.deps.state.readForYou();
    const current = this.require(items, id);
    if (forYouKind(current) !== "regra") throw new HttpError(409, `O item ${id} não é uma regra`);
    current.rule = rule;
    this.keepDraft(current);
    current.text = rule.text;
    await this.save(items, [current]);
    return current;
  }

  /** Grava no cartão "organizacao" o que valeu na aprovação (as ações desmarcadas e as que não deram para aplicar). */
  async updateOrganize(id: string, plan: BrainOrganizePlan): Promise<ForYouItem> {
    const items = this.deps.state.readForYou();
    const current = this.require(items, id);
    if (forYouKind(current) !== "organizacao") throw new HttpError(409, `O item ${id} não é uma organização do Cérebro`);
    current.organize = plan;
    await this.save(items, [current]);
    return current;
  }

  /** Fecha um item sem decidir tarefa nenhuma (o plano já decidiu, ou foi substituído). */
  async close(id: string, status: "aprovado" | "rejeitado" | "respondido", response?: string, extra: { decidedBy?: "usuario" | "automatico"; reason?: string } = {}): Promise<ForYouItem | undefined> {
    const items = this.deps.state.readForYou();
    const current = items.find((candidate) => candidate.id === id);
    if (!current || current.status !== "pendente") return current;
    Object.assign(current, { status, decidedAt: this.deps.now().toISOString(), ...(response ? { response } : {}), ...(extra.decidedBy ? { decidedBy: extra.decidedBy } : {}), ...(extra.reason ? { rejection: { reason: extra.reason } } : {}) });
    await this.save(items, [current]);
    return current;
  }

  /** Rascunho das respostas de um questionário: só grava (não acorda ninguém). */
  async saveAnswers(id: string, answers: Record<string, ForYouAnswer>): Promise<ForYouItem> {
    const items = this.deps.state.readForYou();
    const current = this.require(items, id);
    if (forYouKind(current) !== "questionario") throw new HttpError(409, `O item ${id} não é um questionário`);
    if (current.status !== "pendente") throw new HttpError(409, `O questionário ${id} já foi enviado`);
    const known = new Set((current.questions ?? []).map((question) => question.id));
    const next = { ...current.answers };
    for (const [questionId, answer] of Object.entries(answers)) {
      if (!known.has(questionId)) throw new HttpError(400, `Pergunta "${questionId}" não existe neste questionário`);
      next[questionId] = compact({ text: answer.text, skipped: answer.skipped || undefined });
    }
    current.answers = next;
    this.keepDraft(current);
    current.text = formatAnswers(current.questions ?? [], next);
    await this.save(items, [current]);
    return current;
  }

  /**
   * Envia o questionário (o botão "Enviar respostas"): marca respondido e acorda UMA vez quem
   * perguntou. Do Maestro: uma mensagem com todas as respostas; de um agente: só a tarefa dele segue.
   */
  async submit(id: string): Promise<ForYouItem> {
    const item = this.require(this.deps.state.readForYou(), id);
    if (forYouKind(item) !== "questionario") throw new HttpError(409, `O item ${id} não é um questionário`);
    const answers = formatAnswers(item.questions ?? [], item.answers);
    const state = this.deps.state.read();
    const agent = state.agents.find((candidate) => candidate.id === item.agentId);
    const fromMaestro = agent !== undefined && state.teams.some((team) => team.id === agent.teamId && state.rooms.find((room) => room.id === team.roomId)?.kind === "maestro");
    if (!fromMaestro) return (await this.settle(item, { status: "respondido", response: answers })).item;
    if (item.status !== "pendente" || this.deciding.has(id)) throw new HttpError(409, `O questionário ${id} já foi enviado`);
    const closed = (await this.close(id, "respondido", answers.slice(0, 4000))) ?? item;
    this.deps.maestroAnswers?.(closed, answers);
    return closed;
  }

  /**
   * `update_pending_item`: troca perguntas (questionário; o rascunho das que continuam iguais fica),
   * texto ou pergunta (aprovação) e título de um item ainda pendente. Fica no histórico ("alterado",
   * com quem e o motivo) e a UI mostra o selo "Atualizado". Não acorda ninguém.
   */
  async update(id: string, change: ForYouChange, by: ForYouActor): Promise<ForYouItem> {
    const items = this.deps.state.readForYou();
    const current = this.require(items, id);
    if (current.status !== "pendente" || this.deciding.has(id)) throw new HttpError(409, `O item ${id} não está pendente`);
    const kind = forYouKind(current);
    if (kind === "plano") throw new HttpError(409, `O item ${id} é um plano: mande uma versão nova do plano`);
    if (kind === "sprint") throw new HttpError(409, `O item ${id} é o resumo de uma sprint: ele se monta sozinho e só o dono decide`);
    if (kind === "regra") throw new HttpError(409, `O item ${id} é uma regra da retrospectiva: só o dono muda o texto e o escopo, ao aprovar`);
    if (kind === "organizacao") throw new HttpError(409, `O item ${id} é uma proposta de organização do Cérebro: só o dono aprova ou recusa`);
    const title = change.title?.trim();
    const question = change.question?.trim();
    if (change.questions !== undefined) {
      if (kind !== "questionario") throw new HttpError(409, `O item ${id} não é um questionário`);
      if (change.questions.length === 0) throw new HttpError(400, "O questionário precisa de ao menos uma pergunta");
      current.answers = remapAnswers(current.questions ?? [], current.answers, change.questions);
      current.questions = change.questions;
      current.text = formatAnswers(change.questions, current.answers);
      current.originalText = current.text;
      if (current.why && QUESTION_COUNT.test(current.why)) current.why = current.why.replace(QUESTION_COUNT, `${change.questions.length} pergunta(s)`);
    }
    if (change.text !== undefined) {
      if (kind !== "aprovacao") throw new HttpError(409, `O item ${id} não tem texto para aprovar`);
      // O rascunho novo do agente vale como original (uma edição sua que ainda não foi enviada se perde).
      current.text = change.text.trim();
      current.originalText = current.text;
      current.editedByUser = false;
    }
    if (question) {
      if (kind === "aprovacao") current.why = question;
      else current.title = question;
    }
    if (title) current.title = title;
    if (change.sources !== undefined) {
      if (kind !== "aprovacao") throw new HttpError(409, `O item ${id} não aceita fontes (só aprovações)`);
      const sources = normalizeSources(change.sources);
      if (sources) current.sources = sources;
      else delete current.sources;
    }
    if (change.questions === undefined && change.text === undefined && !question && !title && change.sources === undefined) throw new HttpError(400, "Nada para alterar");
    const at = this.deps.now().toISOString();
    current.history = [...(current.history ?? []), compact({ at, by, action: "alterado" as const, reason: change.reason?.trim() || undefined })];
    await this.save(items, [current]);
    return current;
  }

  /**
   * Retira um item pendente sem decisão: status "cancelado" com quem e o motivo. A tarefa que ele
   * segurava segue sem a resposta (`release`); o Maestro não é acordado por isso. Planos não (eles
   * têm o próprio Cancelar).
   */
  async cancel(id: string, input: { by: ForYouActor; reason?: string }): Promise<ForYouItem> {
    const items = this.deps.state.readForYou();
    const current = this.require(items, id);
    if (current.status !== "pendente" || this.deciding.has(id)) throw new HttpError(409, `O item ${id} já foi decidido ou cancelado`);
    if (forYouKind(current) === "plano") throw new HttpError(409, `O item ${id} é um plano: use Cancelar no plano`);
    if (forYouKind(current) === "sprint") throw new HttpError(409, `O item ${id} é o resumo de uma sprint: aprove a entrega ou devolva com o motivo`);
    if (forYouKind(current) === "regra") throw new HttpError(409, `O item ${id} é uma regra da retrospectiva: aprove ou recuse (recusar a esconde por 8 semanas)`);
    const waiting = this.waitingTask(current);
    const reason = input.reason?.trim() || undefined;
    const at = this.deps.now().toISOString();
    Object.assign(current, compact({ status: "cancelado" as const, cancelledBy: input.by, cancelReason: reason, decidedAt: at }));
    current.history = [...(current.history ?? []), compact({ at, by: input.by, action: "cancelado" as const, reason })];
    this.deciding.add(id);
    try {
      await this.save(items, [current]);
      // O dono que dispensa ou cancela uma opção da Meta à mão também conta como "dispensada" (as do servidor já são contadas onde ele dispensa).
      if (input.by === "usuario" && forYouKind(current) === "aprovacao") {
        const counted = waiting ?? this.deps.state.read().tasks.find((candidate) => candidate.id === current.taskId);
        if (counted) this.deps.routineMeta?.counted(counted, { dismissed: 1 });
      }
      try {
        // Num lote, a tarefa só é solta quando o último item sai (decidido ou cancelado).
        const last = !this.hasPendingSibling(items, current);
        const decision = last && waiting && current.groupId ? this.aggregate(waiting, items, current) : undefined;
        const cancel = compact({ by: input.by, reason });
        if (last) await (decision ? this.deps.release?.(current, cancel, waiting?.id, decision) : this.deps.release?.(current, cancel, waiting?.id));
      } catch (error) {
        this.deps.log.error({ err: error, id }, "falha ao soltar a tarefa do item cancelado");
      }
    } finally {
      this.deciding.delete(id);
    }
    return current;
  }

  /**
   * Pedido cancelado: os itens pendentes dele (e das subtarefas) viram "cancelado" sem soltar
   * ninguém (as tarefas estão sendo canceladas junto). Planos ficam com o ProjectService.
   */
  async cancelAllFor(taskIds: ReadonlySet<string>, input: { by: ForYouActor; reason?: string }): Promise<ForYouItem[]> {
    const items = this.deps.state.readForYou();
    const at = this.deps.now().toISOString();
    const reason = input.reason?.trim() || undefined;
    const changed = items.filter(
      (item) => item.status === "pendente" && forYouKind(item) !== "plano" && forYouKind(item) !== "sprint" && forYouKind(item) !== "regra" && forYouKind(item) !== "organizacao" && ((item.taskId && taskIds.has(item.taskId)) || (item.projectId && taskIds.has(item.projectId))),
    );
    for (const item of changed) {
      Object.assign(item, compact({ status: "cancelado" as const, cancelledBy: input.by, cancelReason: reason, decidedAt: at }));
      item.history = [...(item.history ?? []), compact({ at, by: input.by, action: "cancelado" as const, reason })];
    }
    if (changed.length > 0) await this.save(items, changed);
    return changed;
  }

  /**
   * Decide um item (ou reabre, com "pendente"). Um item já decidido só aceita "pendente" (409).
   * Se a tarefa ligada espera aprovação por este item, ela é decidida antes (um erro dela, como
   * 409, não muda o item).
   */
  async decide(id: string, input: DecisionInput): Promise<ForYouItem> {
    const item = this.require(this.deps.state.readForYou(), id);
    if (input.status === "pendente") return this.reopen(item);
    const kind = forYouKind(item);
    if (kind === "plano" && this.deps.decidePlan) {
      if (item.status !== "pendente") throw new HttpError(409, `O item ${id} já foi decidido`);
      await this.deps.decidePlan(item, { status: input.status, response: input.response?.trim() || undefined });
      return this.require(this.deps.state.readForYou(), id);
    }
    if (kind === "sprint") {
      if (item.status !== "pendente" || this.deciding.has(id)) throw new HttpError(409, `O item ${id} já foi decidido`);
      if (!this.deps.decideSprint) throw new HttpError(409, "Sprints não estão disponíveis neste workspace");
      if (input.status === "respondido") throw new HttpError(400, "Aprove a entrega ou devolva com o motivo");
      this.deciding.add(id);
      try {
        await this.deps.decideSprint(item, { status: input.status, reason: input.reason?.trim() || input.response?.trim() || undefined, ...(input.returnRefs ? { returnRefs: input.returnRefs } : {}) });
      } finally {
        this.deciding.delete(id);
      }
      return this.require(this.deps.state.readForYou(), id);
    }
    if (kind === "regra") {
      if (item.status !== "pendente" || this.deciding.has(id)) throw new HttpError(409, `O item ${id} já foi decidido`);
      if (!this.deps.decideRule) throw new HttpError(409, "A retrospectiva não está disponível neste workspace");
      if (input.status === "respondido") throw new HttpError(400, "Aprove ou recuse a regra");
      this.deciding.add(id);
      try {
        await this.deps.decideRule(item, { status: input.status, ...(input.rule ? { rule: input.rule } : {}) });
        await this.close(id, input.status, undefined, { decidedBy: "usuario", ...(input.status === "rejeitado" ? { reason: input.reason?.trim() || "Regra recusada" } : {}) });
      } finally {
        this.deciding.delete(id);
      }
      return this.require(this.deps.state.readForYou(), id);
    }
    if (kind === "organizacao") {
      if (item.status !== "pendente" || this.deciding.has(id)) throw new HttpError(409, `O item ${id} já foi decidido`);
      if (!this.deps.decideOrganize) throw new HttpError(409, "Organizar o Cérebro não está disponível neste workspace");
      if (input.status === "respondido") throw new HttpError(400, "Aprove ou recuse a proposta");
      this.deciding.add(id);
      try {
        await this.deps.decideOrganize(item, { status: input.status, ...(input.organize ? { organize: input.organize } : {}) });
        await this.close(id, input.status, undefined, { decidedBy: "usuario", ...(input.status === "rejeitado" ? { reason: input.reason?.trim() || "Proposta recusada" } : {}) });
      } finally {
        this.deciding.delete(id);
      }
      return this.require(this.deps.state.readForYou(), id);
    }
    if (kind === "rotina") {
      if (item.status !== "pendente" || this.deciding.has(id)) throw new HttpError(409, `O item ${id} já foi decidido`);
      if (!this.deps.decideRoutine) throw new HttpError(409, "Rotinas não estão disponíveis neste workspace");
      this.deciding.add(id);
      try {
        await this.deps.decideRoutine(item, { status: input.status, response: input.response?.trim() || undefined, routine: input.routine });
        await this.close(id, input.status, input.response?.trim() || undefined);
      } finally {
        this.deciding.delete(id);
      }
      return this.require(this.deps.state.readForYou(), id);
    }
    if (kind === "questionario") {
      // Uma resposta solta (sem o formulário) vale como resposta da primeira pergunta em branco.
      if (input.response?.trim() && item.questions?.length) {
        const blank = item.questions.find((question) => !item.answers?.[question.id]?.text?.trim()) ?? item.questions[0]!;
        await this.saveAnswers(id, { [blank.id]: { text: input.response.trim() } });
      }
      return this.submit(id);
    }
    return (await this.settle(item, input)).item;
  }

  /**
   * Aprova vários itens de uma vez (`POST /for-you/batch`, a Gestão). Só aprovação de texto, pendente, sem edição pendente e de
   * um tipo só; convite e post só se o agente já tem uma aprovação individual desse tipo (veja `batchPlan`). Confere TUDO antes de
   * decidir qualquer um: um item fora da regra recusa o lote inteiro (400) e diz quem e por quê. Aprovados em sequência, cada um
   * pelo caminho normal (a tarefa dele segue como se fosse individual); se um falhar no meio, os anteriores ficam aprovados.
   */
  async decideBatch(ids: readonly string[]): Promise<ForYouItem[]> {
    const plan = batchPlan(this.deps.state.readForYou(), ids);
    if (plan.excluded.length > 0) throw new HttpError(400, `Não dá para aprovar em lote: ${plan.excluded.map((entry) => `${entry.id} (${entry.text})`).join("; ")}`);
    if (plan.types.length > 1) throw new HttpError(400, `O lote é de um tipo por vez (há ${plan.types.join(", ")})`);
    const approved: ForYouItem[] = [];
    for (const item of plan.eligible) {
      try {
        approved.push((await this.settle(item, { status: "aprovado" }, { viaBatch: true })).item);
      } catch (error) {
        const done = approved.length > 0 ? ` ${approved.length} de ${plan.eligible.length} já foram aprovados (${approved.map((entry) => entry.id).join(", ")}).` : "";
        const reason = error instanceof Error ? error.message : String(error);
        throw new HttpError(error instanceof HttpError ? error.statusCode : 500, `O lote parou em ${item.id}: ${reason}.${done}`);
      }
    }
    if (approved.length > 0) this.deps.onBatchApproved?.(approved);
    return approved;
  }

  /** Decide o item pendente (e a tarefa, se ela espera por ele). Devolve a tarefa como ficou. */
  private async settle(item: ForYouItem, input: DecisionInput, options: { viaBatch?: boolean } = {}): Promise<{ item: ForYouItem; task?: Task }> {
    const { id } = item;
    if (item.status !== "pendente" || this.deciding.has(id)) {
      throw new HttpError(409, `O item ${id} já foi decidido; reabra antes de decidir de novo`);
    }
    const text = input.text !== undefined ? input.text.trim() : item.text;
    const response = input.response?.trim() || undefined;
    const rejected = input.status === "rejeitado";
    // O motivo da recusa: o campo novo, ou a nota (que era o motivo antes de existir o campo).
    const reason = rejected ? input.reason?.trim() || response || undefined : undefined;
    this.deciding.add(id);
    try {
      const waiting = this.waitingTask(item);
      const before = this.require(this.deps.state.readForYou(), id);
      let task: Task | undefined;
      const counted = waiting ?? this.deps.state.read().tasks.find((candidate) => candidate.id === item.taskId);
      if (counted && !rejected && (forYouKind(item) === "aprovacao")) {
        // Aprovar este item fecha a Meta? Então as opções que sobraram no lote são dispensadas já.
        const standing = this.deps.routineMeta?.standing(counted);
        this.deps.routineMeta?.counted(counted, { approved: 1 });
        if (standing?.stopOnHit && standing.committed + 1 >= standing.target && before.groupId) {
          this.dismiss(this.deps.state.readForYou().filter((other) => other.groupId === before.groupId && other.id !== id), counted);
        }
      }
      if (waiting) {
        // Num lote, a tarefa só segue quando o último item sai (a decisão leva o resultado de cada um).
        const snapshot = this.deps.state.readForYou();
        if (!this.hasPendingSibling(snapshot, before)) {
          const decision = before.groupId
            ? this.aggregate(waiting, snapshot, before, { status: input.status, text, response, reason })
            : this.single(waiting, before, { approved: !rejected, text, response, reason });
          task = await this.deps.decideTask(waiting.id, decision);
        } else {
          task = waiting;
        }
      }
      // A lista é lida de novo: decidir a tarefa pode ter aberto itens novos (o agente refez o rascunho).
      const items = this.deps.state.readForYou();
      const current = this.require(items, id);
      // O rascunho anterior é guardado antes de `text` mudar (a gravação tira o `originalText` quando os dois ficam iguais).
      const editedByUser = text !== forYouOriginalText(current);
      this.keepDraft(current);
      const decided = { status: input.status, text, editedByUser, response, decidedAt: this.deps.now().toISOString() };
      Object.assign(current, decided, { decidedBy: "usuario" as const, ...(options.viaBatch ? { viaBatch: true as const } : {}) });
      if (response === undefined) delete current.response;
      // A categoria rápida da recusa (opcional) vale mesmo sem o motivo escrito.
      const category = rejected ? input.category : undefined;
      if (reason || category) current.rejection = { reason: reason ?? "", ...(category ? { category } : {}) };
      else delete current.rejection;
      await this.save(items, [current]);
      // Aprovado (ou respondido): a mídia em rascunho do pedido vira "aprovado".
      if (current.mediaIds && !rejected) this.deps.media?.approve(current.mediaIds);
      return { item: current, task };
    } finally {
      this.deciding.delete(id);
    }
  }

  /** Decisão de um item solto: recusa com motivo volta ao agente (retrabalho) enquanto couber. */
  private single(task: Task, item: ForYouItem, input: { approved: boolean; text: string; response?: string; reason?: string }): ApprovalDecision {
    const base: ApprovalDecision = { approved: input.approved, text: input.text, response: input.response, itemId: item.id, ...(input.reason ? { reason: input.reason } : {}) };
    if (input.approved || !input.reason) return base;
    const allowed = this.deps.registerRework?.(task, { reason: input.reason, itemId: item.id });
    return allowed ? { ...base, retry: true, rework: this.reworkInfo(task) } : base;
  }

  /** Quantas vezes a tarefa já foi refeita (depois de `registerRework`), para a mensagem ao agente. */
  private reworkInfo(task: Task): { count: number; max: number } {
    return { count: this.deps.reworkCount?.(task) ?? 1, max: MAX_REWORK };
  }

  private hasPendingSibling(items: readonly ForYouItem[], item: ForYouItem): boolean {
    return item.groupId !== undefined && items.some((other) => other.id !== item.id && other.groupId === item.groupId && other.status === "pendente");
  }

  /**
   * Decisão única de um lote: o resultado de cada item (o `current` entra com o que acabou de ser
   * decidido ou cancelado). Recusa com motivo (de pelo menos um item) conta UM retrabalho: a tarefa
   * segue com `retry` e o agente refaz só os recusados; sem retrabalho sobrando, a tarefa falha
   * como "Recusado" (o Maestro decide).
   */
  private aggregate(task: Task, items: readonly ForYouItem[], current: ForYouItem, now?: { status: DecisionInput["status"]; text: string; response?: string; reason?: string }): ApprovalDecision {
    const group = items.filter((item) => item.groupId === current.groupId);
    const results: ApprovalItemResult[] = group.map((item) => {
      const question = item.why ?? item.title ?? item.text.slice(0, 80);
      if (item.id === current.id && now) {
        if (now.status === "rejeitado") return compact({ itemId: item.id, question, status: "rejected" as const, response: now.response, reason: now.reason });
        return compact({ itemId: item.id, question, status: "approved" as const, text: now.text, response: now.response });
      }
      if (item.status === "rejeitado") return compact({ itemId: item.id, question, status: "rejected" as const, response: item.response, reason: item.rejection?.reason });
      if (item.status === "cancelado") return compact({ itemId: item.id, question, status: "cancelled" as const, cancelled: compact({ by: item.cancelledBy ?? "usuario", reason: item.cancelReason }) });
      return compact({ itemId: item.id, question, status: "approved" as const, text: item.text, response: item.response });
    });
    const rejected = results.filter((result) => result.status === "rejected");
    const reasons = rejected.filter((result) => result.reason);
    if (rejected.length === 0) return { approved: true, items: results };
    const base = { items: results, response: rejected[0]?.reason, reason: rejected[0]?.reason };
    if (reasons.length === 0) return { approved: false, ...base };
    const joined = reasons.map((result) => `${result.itemId}: ${result.reason}`).join(" | ");
    const allowed = this.deps.registerRework?.(task, { reason: joined, itemId: reasons[0]!.itemId });
    if (!allowed) return { approved: false, ...base };
    return { approved: true, retry: true, rework: this.reworkInfo(task), ...base };
  }

  /**
   * Atalho de POST /tasks/:id/approval: aprova ou rejeita o item pendente MAIS ANTIGO ligado à tarefa
   * (sem mudar o texto). Sem item (ex.: dados antigos), decide direto no orquestrador.
   */
  async decideTask(taskId: string, approved: boolean): Promise<Task> {
    const task = this.deps.state.read().tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new HttpError(404, `Tarefa "${taskId}" não encontrada`);
    const item = this.deps.state.readForYou().find((candidate) => candidate.taskId === taskId && candidate.status === "pendente");
    if (task.status === "waiting_approval" && item) {
      const settled = await this.settle(item, { status: approved ? "aprovado" : "rejeitado" });
      return settled.task ?? task;
    }
    return this.deps.decideTask(taskId, { approved });
  }

  /**
   * Boot (depois do orquestrador): aprovação pendente sem item (de antes do "Para você") ganha um
   * item com o pedido como texto, para aparecer na página.
   */
  backfill(): void {
    const state = this.deps.state.read();
    const items = this.deps.state.readForYou();
    const created: ForYouItem[] = [];
    for (const task of state.tasks) {
      if (task.status !== "waiting_approval" || isMaestroTask(state, task) || !task.agentId) continue;
      if (items.some((item) => item.taskId === task.id)) continue;
      const item: ForYouItem = {
        id: this.nextId(items),
        taskId: task.id,
        agentId: task.agentId,
        roomId: task.roomId,
        type: this.typeFor(undefined, undefined, task.prompt),
        status: "pendente",
        why: BACKFILL_WHY,
        meta: {},
        text: task.prompt,
        editedByUser: false,
        createdAt: this.deps.now().toISOString(),
      };
      items.push(item);
      created.push(item);
    }
    if (created.length > 0) void this.save(items, created);
  }

  /** Tipo do item: o do rascunho ou o deduzido do pedido; se o workspace não tem, nasce agora. */
  private typeFor(draft: ApprovalDraft | undefined, question: string | undefined, prompt: string): string {
    // "Outro", ausente ou desconhecido: tenta casar com um tipo que existe (onde, para quem, título, pedido, texto).
    return this.deps.types.resolve(draft?.type, [draft?.where, draft?.to, draft?.title, question, prompt, draft?.text], prompt);
  }

  private reopen(item: ForYouItem): Promise<ForYouItem> | ForYouItem {
    if (item.status === "pendente") return item;
    if (item.status === "cancelado") throw new HttpError(409, `O item ${item.id} foi cancelado e não reabre`);
    if (forYouKind(item) === "sprint") throw new HttpError(409, `O item ${item.id} é o resumo de uma sprint: a entrega já foi decidida`);
    if (forYouKind(item) === "rotina") throw new HttpError(409, `O item ${item.id} é uma rotina: ela já foi decidida (pause ou ajuste pela página Rotinas)`);
    if (forYouKind(item) === "regra") throw new HttpError(409, `O item ${item.id} é uma regra da retrospectiva: ela já foi decidida (a nota aprovada fica no Cérebro; recusada, a regra volta só depois de 8 semanas)`);
    if (forYouKind(item) === "organizacao") throw new HttpError(409, `O item ${item.id} é uma proposta de organização do Cérebro: ela já foi decidida (as notas que saíram da raiz estão no histórico do Cérebro)`);
    const items = this.deps.state.readForYou();
    const current = this.require(items, item.id);
    current.status = "pendente";
    delete current.decidedAt;
    delete current.rejection;
    delete current.decidedBy;
    return this.save(items, [current]).then(() => current);
  }

  /**
   * A tarefa ligada, se ela espera aprovação por este item: o item mais novo dela ou, num lote, um
   * item do mesmo lote que o mais novo (os itens do lote seguram a tarefa juntos).
   */
  private waitingTask(item: ForYouItem): Task | undefined {
    if (!item.taskId) return undefined;
    const task = this.deps.state.read().tasks.find((candidate) => candidate.id === item.taskId);
    if (task?.status !== "waiting_approval") return undefined;
    const latest = this.latestFor(this.deps.state.readForYou(), task.id);
    if (latest?.id === item.id || this.deps.holdsItem?.(item)) return task;
    return item.groupId !== undefined && latest?.groupId === item.groupId ? task : undefined;
  }

  private latestFor(items: ForYouItem[], taskId: string): ForYouItem | undefined {
    return items.filter((item) => item.taskId === taskId).at(-1);
  }

  private require(items: ForYouItem[], id: string): ForYouItem {
    const item = items.find((candidate) => candidate.id === id);
    if (item) return item;
    // Decidido há mais tempo que o prazo: está no arquivo (só leitura), não dá para decidir, reabrir nem cancelar.
    if (this.deps.state.forYouArchive.has(id)) throw new HttpError(409, `O item "${id}" já foi para o arquivo (decidido há mais tempo que o prazo da lista) e não pode mais ser alterado`);
    throw new HttpError(404, `Item "${id}" não encontrado`);
  }

  /** Próximo id: um a mais que o maior entre a lista viva e o arquivo (um id arquivado nunca volta). */
  private nextId(items: readonly ForYouItem[]): string {
    return this.deps.state.forYouArchive.nextId(items);
  }

  /** Guarda o rascunho do agente em `originalText` antes de `text` mudar (a forma compacta não o repete). */
  private keepDraft(item: ForYouItem): void {
    item.originalText = forYouOriginalText(item);
  }

  /** O prazo em vigor (dias na lista viva; 0 = nunca arquivar). */
  liveDays(): number {
    return this.deps.liveDays?.() ?? DEFAULT_FOR_YOU_LIVE_DAYS;
  }

  /** GET /for-you/archive: o prazo e os meses do arquivo com a contagem. */
  archiveSummary(): ForYouArchiveSummary {
    return this.deps.state.forYouArchive.summary(this.liveDays());
  }

  /** GET /for-you/archive/:month: os itens do mês (mês sem arquivo = lista vazia). */
  archiveMonth(month: string): Promise<ForYouItem[]> {
    return this.deps.state.forYouArchive.readMonth(month);
  }

  /** GET /for-you/archive/find: os itens arquivados daquela tarefa e/ou daquele id. */
  archiveFind(query: { taskId?: string; id?: string }): Promise<ForYouItem[]> {
    return this.deps.state.forYouArchive.find(query);
  }

  /** O item foi para o arquivo? */
  isArchived(id: string): boolean {
    return this.deps.state.forYouArchive.has(id);
  }

  /** Lista viva mais o que o arquivo guarda a partir de `fromMs` (para quem olha para trás: métricas, Atividade do dia, retrospectiva). */
  async listSince(fromMs: number): Promise<ForYouItem[]> {
    const live = this.deps.state.readForYou();
    const archived = await this.deps.state.forYouArchive.since(fromMs);
    const liveIds = new Set(live.map((item) => item.id));
    return [...archived.filter((item) => !liveIds.has(item.id)), ...live];
  }

  /**
   * Varredura: os itens decididos há mais que o prazo (configuração da plataforma) vão para o arquivo e saem da lista
   * viva (evento `foryou:archived`). Itens de um mesmo lote só vão quando TODOS do lote já podem. O arquivo é gravado
   * PRIMEIRO: se falhar, nada sai da lista. Devolve quantos saíram.
   */
  async sweep(): Promise<number> {
    const liveDays = this.liveDays();
    const nowMs = this.deps.now().getTime();
    const items = this.deps.state.readForYou();
    const due = dueForArchive(items, nowMs, liveDays, this.deps.holdLive?.());
    if (due.length === 0) return 0;
    await this.deps.state.forYouArchive.append(due);
    // A lista pode ter mudado enquanto o arquivo gravava (ex.: um item reaberto): relê e solta só o que continua igual ao arquivado.
    const sent = new Map(due.map((item) => [item.id, JSON.stringify(item)]));
    const fresh = this.deps.state.readForYou();
    const gone = new Set(fresh.filter((item) => sent.get(item.id) === JSON.stringify(item)).map((item) => item.id));
    if (gone.size === 0) return 0;
    await this.deps.state.commit({ forYou: fresh.filter((item) => !gone.has(item.id)), events: [{ type: "foryou:archived", ids: [...gone] }] });
    return gone.size;
  }

  /** Grava e publica foryou:upserted. A promessa nunca rejeita (a falha vai para o log). */
  private save(items: ForYouItem[], changed: ForYouItem[]): Promise<void> {
    const events: ServerEvent[] = changed.map((item) => ({ type: "foryou:upserted", item }));
    return this.deps.state
      .commit({ forYou: items, events })
      .catch((error: unknown) => this.deps.log.error({ err: error }, "falha ao gravar o Para você"));
  }
}
