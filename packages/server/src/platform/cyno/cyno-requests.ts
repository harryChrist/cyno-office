import {
  agentAddress,
  ASK_LIMITS,
  askMarker,
  CYNO_SEND_LIMITS,
  findMaestroAgent,
  isCliEngine,
  isMaestroAgent,
  isoFromInput,
  agentEngine,
  PROJECT_BRIEF_MAX,
  requestMarker,
  requestProject,
  isSentRequestClosed,
  sentRequestSchema,
  type AgentLogBody,
  type AskRecord,
  type CynoServerEvent,
  type MediaItem,
  type ProjectPriority,
  type SentRequest,
  type SentRequestView,
  type ServerEvent,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { findByRef } from "../../mcp/structure-tools";
import type { RequestToolsDeps, SendRequestInput } from "../../mcp/cyno/request-tools";
import type { WriteQueue } from "../../store/write-queue";
import { errorMessage, shorten } from "../../util/text";
import { HttpError } from "../http/errors";
import type { WorkspaceManager } from "../workspaces/manager";
import type { WorkspaceRuntime } from "../../workspace/runtime";
import { AskLedger } from "./asks";
import { JsonRecords } from "./records";
import { requestDetail, requestLine, requestView, type RequestSnapshot } from "./request-view";

const HOUR_MS = 3_600_000;
/** Debounce (ms) do recálculo do estado dos pedidos depois de um evento do workspace. */
const WATCH_DEBOUNCE_MS = 400;
/** Um pedido igual (mesmo workspace e título) ainda aberto, enviado há menos que isto, não é enviado de novo. */
const DUPLICATE_WINDOW_MS = 30 * 60_000;

/** Eventos do workspace que mudam o estado de um pedido enviado. */
const WATCHED_EVENTS: ReadonlySet<ServerEvent["type"]> = new Set(["project:upserted", "project:deleted", "task:upserted", "foryou:upserted", "foryou:deleted"]);

const PRIORITY: Record<"high" | "normal" | "low", ProjectPriority> = { high: "alta", normal: "normal", low: "baixa" };

export type CynoRequestsHost = {
  workspaces: Pick<WorkspaceManager, "list" | "find" | "listHub">;
  now: () => Date;
  log: FastifyBaseLogger;
  /** Escreve no chat do Cyno (log da conversa do dia). */
  chat: (body: AgentLogBody) => void;
  emit: (event: CynoServerEvent) => void;
  /** Acorda o Cyno com uma mensagem (`build` monta o texto só quando ela sai). Lança se ele não pode acordar. */
  wake: (tag: string, build: () => string) => void;
  /** Os estados dos pedidos foram recalculados (os projetos conjuntos conferem as partes por aqui). */
  onChange?: () => void;
};

/**
 * Os pedidos que o Cyno manda aos Maestros e as perguntas que os Maestros fazem a ele (`ask_cyno`).
 * - `send_request`: cria a tarefa do Maestro, o Projeto com `origin:"cyno"` e o briefing, e acorda o Maestro UMA vez.
 * - Acompanhar (`get_request_status`, `list_sent_requests`) lê o projeto por código: ninguém acorda.
 * - Avisos passivos: quando um pedido enviado conclui, falha ou passa a esperar o dono, o servidor avisa no
 *   chat e guarda uma linha para o contexto do Cyno na próxima vez que ele acordar. NUNCA acorda o Cyno.
 * - `ask_cyno`: limites no servidor (veja `AskLedger`); o Cyno responde uma vez e a resposta volta ao Maestro
 *   como mensagem de conversa.
 */
export class CynoRequests {
  private readonly views = new Map<string, SentRequestView>();
  /** Linhas para o contexto do Cyno (o que mudou nos pedidos enviados desde a última mensagem). */
  private notices: string[] = [];
  private readonly watching = new Map<string, () => void>();
  private readonly dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private offList: (() => void) | undefined;
  private readonly askTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly messageTimes: number[] = [];
  private closed = false;

  private constructor(
    private readonly host: CynoRequestsHost,
    private readonly records: JsonRecords<SentRequest>,
    readonly asks: AskLedger,
  ) {}

  static async open(host: CynoRequestsHost, files: { requests: string; asks: string }, queue: WriteQueue): Promise<CynoRequests> {
    const onError = (error: unknown) => host.log.warn({ err: error }, "não foi possível gravar os pedidos do Cyno");
    const records = await JsonRecords.open<SentRequest>(files.requests, queue, (raw) => {
      const parsed = sentRequestSchema.safeParse(raw);
      return parsed.success ? parsed.data : undefined;
    }, onError);
    const asks = new AskLedger(await JsonRecords.open<AskRecord>(files.asks, queue, AskLedger.parse, onError), host.now);
    const requests = new CynoRequests(host, records, asks);
    // Os pedidos que já existem continuam vigiados depois de um reinício (os avisos passivos não dependem de o Cyno estar de pé).
    if (records.all().length > 0) requests.watch();
    // Perguntas que ficaram abertas passam do prazo no reinício: o Maestro é avisado.
    requests.expireAsks();
    return requests;
  }

  // ---------- Estado dos pedidos ----------

  private runtimeOf(workspace: string): WorkspaceRuntime | undefined {
    return this.host.workspaces.find(workspace);
  }

  private snapshotOf(workspace: string, projectId: string): RequestSnapshot | undefined {
    const runtime = this.runtimeOf(workspace);
    if (!runtime) return undefined;
    const office = runtime.store.snapshot();
    const name = this.host.workspaces.list().find((item) => item.id === workspace)?.name ?? workspace;
    return {
      workspaceName: name,
      project: requestProject(runtime.plans.list(), projectId),
      tasks: office.tasks,
      forYou: runtime.forYou.list(),
      media: runtime.media.list({ taskId: projectId }),
      agentName: (agentId) => office.agents.find((agent) => agent.id === agentId)?.name,
    };
  }

  /** Uma view por pedido (a do último cálculo; recalcula se o pedido ainda não foi visto). */
  views_(): SentRequestView[] {
    return this.records
      .all()
      .map((record) => this.viewOf(record))
      .flatMap((view) => view ?? [])
      .sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  }

  private viewOf(record: SentRequest): SentRequestView | undefined {
    const snap = this.snapshotOf(record.workspace, record.projectId);
    if (!snap) {
      // Workspace apagado: o pedido some da lista (o registro fica no arquivo).
      return undefined;
    }
    const view = requestView(record, snap, this.host.now().getTime());
    this.views.set(record.projectId, view);
    return view;
  }

  /** O estado de um pedido de um workspace (para o coordenador dos projetos conjuntos); undefined se o workspace sumiu. */
  peek(workspace: string, projectId: string, title: string): SentRequestView | undefined {
    const snap = this.snapshotOf(workspace, projectId);
    return snap ? requestView({ projectId, workspace, title, address: "", sentAt: this.host.now().toISOString() }, snap, this.host.now().getTime()) : undefined;
  }

  /** O que um pedido concluído entregou: o resumo (a resposta final do Maestro) e as mídias do pedido (sem as descartadas). */
  deliveries(workspace: string, projectId: string): { summary: string; media: MediaItem[] } | undefined {
    const snap = this.snapshotOf(workspace, projectId);
    if (!snap) return undefined;
    const request = snap.tasks.find((task) => task.id === projectId);
    const parts: string[] = [];
    if (request?.result?.trim()) parts.push(request.result.trim());
    else {
      for (const task of snap.project?.tasks ?? []) {
        const result = snap.tasks.find((candidate) => candidate.id === task.steps.at(-1)?.taskId)?.result;
        if (task.status === "concluida" && !task.skipped && result?.trim()) parts.push(`${task.title}: ${result.trim()}`);
      }
    }
    return { summary: parts.join("\n\n"), media: snap.media.filter((item) => item.status !== "descartado") };
  }

  /** Quantos pedidos enviados estão abertos num workspace (o selo da ficha, por código). */
  openCount(workspace: string): number {
    return this.views_().filter((view) => view.workspace === workspace && !isSentRequestClosed(view.state)).length;
  }

  // ---------- Vigia (avisos passivos) ----------

  /** Assina o barramento de cada workspace com pedido enviado e a lista de workspaces. */
  watch(): void {
    if (this.closed) return;
    this.offList ??= this.host.workspaces.listHub.subscribe((event) => {
      if (event.type === "workspaces:list") this.watch();
    });
    const wanted = new Set(this.records.all().map((record) => record.workspace));
    for (const [id, off] of this.watching) {
      if (wanted.has(id) && this.runtimeOf(id)) continue;
      off();
      this.watching.delete(id);
    }
    for (const id of wanted) {
      const runtime = this.runtimeOf(id);
      if (!runtime || this.watching.has(id)) continue;
      this.watching.set(
        id,
        runtime.hub.subscribe((event) => {
          if (!WATCHED_EVENTS.has(event.type)) return;
          this.dirty.add(id);
          this.schedule();
        }),
      );
    }
    this.dirty.add("*");
    this.schedule();
  }

  private schedule(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.refresh();
    }, WATCH_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /** Recalcula os pedidos dos workspaces sujos, avisa as mudanças que importam e publica a lista se mudou. */
  refresh(): void {
    if (this.closed) return;
    const all = this.dirty.has("*");
    const targets = new Set(this.dirty);
    this.dirty.clear();
    let changed = false;
    for (const record of this.records.all()) {
      if (!all && !targets.has(record.workspace)) continue;
      const before = this.views.get(record.projectId);
      const view = this.viewOf(record);
      if (!view) continue;
      if (!before || JSON.stringify(before) !== JSON.stringify(view)) changed = true;
      this.noteTransition(record, view);
    }
    if (changed) this.host.emit({ type: "cyno:requests", requests: this.views_() });
    this.host.onChange?.();
  }

  /** Mudou para concluído, falhou, cancelado ou esperando o dono: aviso no chat (sem acordar) e linha no contexto do Cyno. */
  private noteTransition(record: SentRequest, view: SentRequestView): void {
    if (record.notified === view.state) return;
    const first = record.notified === undefined;
    record.notified = view.state;
    this.records.save();
    if (first && view.state === "enviado") return;
    // Parte de um projeto conjunto: quem avisa é o conjunto (uma linha por passo do projeto, não uma por parte).
    if (record.jointId) return;
    const where = `no ${view.workspaceName}`;
    const title = shorten(view.title, 80);
    switch (view.state) {
      case "concluido":
        this.host.chat({ kind: "status", status: "resumed", message: `Pedido “${title}” ${where}: concluído` });
        this.notices.push(`request ${view.projectId} "${title}" (${view.workspace}) is now DONE`);
        break;
      case "falhou":
        this.host.chat({ kind: "status", status: "failed", message: `Pedido “${title}” ${where}: falhou` });
        this.notices.push(`request ${view.projectId} "${title}" (${view.workspace}) FAILED`);
        break;
      case "cancelado":
        this.host.chat({ kind: "status", status: "resumed", message: `Pedido “${title}” ${where}: cancelado` });
        this.notices.push(`request ${view.projectId} "${title}" (${view.workspace}) was CANCELLED`);
        break;
      case "esperando_voce":
        this.host.chat({ kind: "status", status: "waiting", message: `Pedido “${title}” ${where}: espera você${view.waitingForYou > 0 ? ` (${view.waitingForYou} no Para você)` : ""}` });
        this.notices.push(`request ${view.projectId} "${title}" (${view.workspace}) now WAITS FOR THE OWNER${view.waitingForYou > 0 ? ` (${view.waitingForYou} item(s) in Para você)` : ""}`);
        break;
      default:
    }
  }

  /** Uma linha por pedido ainda aberto (abre uma conversa nova do Cyno). */
  openLines(): string[] {
    return this.views_().filter((view) => !isSentRequestClosed(view.state)).map(requestLine);
  }

  /** As linhas dos pedidos que mudaram desde a última mensagem ao Cyno (esvazia a lista). */
  takeNotices(): string[] {
    return this.notices.splice(0);
  }

  // ---------- send_request ----------

  sendRequest(input: SendRequestInput): ReturnType<RequestToolsDeps["sendRequest"]> & { note?: string } {
    const found = findByRef(this.host.workspaces.list().map((ws) => ({ id: ws.id, name: ws.name })), input.workspace);
    const runtime = found ? this.runtimeOf(found.id) : undefined;
    if (!found || !runtime) throw new Error(`No workspace "${input.workspace}". Use list_workspaces.`);
    if (!runtime.cliMaestro.enabled()) throw new Error(`The Maestro of ${found.name} does not run on a CLI engine, so it cannot receive requests.`);
    const state = runtime.store.snapshot();
    const maestro = findMaestroAgent(state);
    if (!maestro) throw new Error(`${found.name} has no Maestro.`);
    const now = this.host.now().getTime();
    // Um pedido igual e ainda aberto não é enviado de novo (um laço ou um clique duplo não gastam outro turno do Maestro).
    const same = this.records.all().find((record) => record.workspace === found.id && record.title.trim().toLowerCase() === input.title.trim().toLowerCase() && now - Date.parse(record.sentAt) < DUPLICATE_WINDOW_MS && !isSentRequestClosed(this.viewOf(record)?.state ?? "concluido"));
    if (same) return { projectId: same.projectId, workspace: found.id, workspaceName: found.name, address: same.address, duplicate: true };
    if (this.records.all().filter((record) => now - Date.parse(record.sentAt) < HOUR_MS).length >= CYNO_SEND_LIMITS.requestsPerHour) {
      throw new Error(`Limit reached: ${CYNO_SEND_LIMITS.requestsPerHour} requests per hour. Tell the owner and wait.`);
    }
    const dueAt = input.dueAt ? isoFromInput(input.dueAt) : undefined;
    const startAt = input.startAt ? isoFromInput(input.startAt) : undefined;
    if (input.dueAt && !dueAt) throw new Error(`due_at "${input.dueAt}" is not a valid date (use ISO 8601)`);
    if (input.startAt && !startAt) throw new Error(`start_at "${input.startAt}" is not a valid date (use ISO 8601)`);
    if (dueAt && startAt && startAt > dueAt) throw new Error("start_at is after due_at");
    const brief = input.brief.trim().slice(0, PROJECT_BRIEF_MAX);
    const title = input.title.trim().replace(/\s+/g, " ");
    const block = runtime.cliMaestro.blocked();
    const task = runtime.cliMaestro.openServerRequest({
      title,
      description: `Pedido do Cyno, em nome do dono. O briefing completo está no projeto.\n\n${shorten(brief, 600)}`,
      origin: "Cyno (agente da plataforma), em nome do dono",
      originLabel: "Origem (Cyno)",
      before: (request) => {
        void runtime.plans.openFromCyno(request, {
          title,
          kind: input.kind === "project" ? "projeto" : "tarefa",
          brief,
          ...(input.priority ? { priority: PRIORITY[input.priority] } : {}),
          ...(startAt ? { startAt } : {}),
          ...(dueAt ? { dueAt } : {}),
          ...(input.doneWhen?.length ? { doneWhen: input.doneWhen } : {}),
          ...(input.joint ? { joint: input.joint } : {}),
        });
      },
      message: (request) => briefingMessage(request.id, { ...input, title, brief, ...(dueAt ? { dueAt } : {}), ...(startAt ? { startAt } : {}) }),
    });
    const record: SentRequest = { projectId: task.id, workspace: found.id, title, address: agentAddress(found.id, maestro.id), sentAt: this.host.now().toISOString(), ...(input.joint ? { jointId: input.joint.id } : {}) };
    this.records.add(record);
    this.watch();
    // Parte de um projeto conjunto: o cartão do conjunto é o que aparece no chat, não um cartão por parte.
    if (!input.joint) this.host.chat({ kind: "status", status: "started", message: requestMarker(found.id, task.id, title) });
    this.host.emit({ type: "cyno:requests", requests: this.views_() });
    this.host.log.info({ workspace: found.id, projectId: task.id }, "Cyno enviou um pedido ao Maestro");
    return {
      projectId: task.id,
      workspace: found.id,
      workspaceName: found.name,
      address: record.address,
      duplicate: false,
      ...(block ? { note: "The Maestro engine has no quota right now: the request waits in its queue and starts when the engine returns." } : {}),
    };
  }

  // ---------- Acompanhar ----------

  private recordOf(requestId: string): SentRequest {
    const record = this.records.all().find((item) => item.projectId === requestId);
    if (!record) throw new Error(`No request "${requestId}" sent by you. Use list_sent_requests.`);
    return record;
  }

  requestStatus(ref: { requestId?: string; workspace?: string }): string {
    if (ref.requestId) {
      const record = this.recordOf(ref.requestId);
      const snap = this.snapshotOf(record.workspace, record.projectId);
      if (!snap) throw new Error(`The workspace of request ${ref.requestId} no longer exists.`);
      const view = requestView(record, snap, this.host.now().getTime());
      this.views.set(record.projectId, view);
      return requestDetail(view, snap);
    }
    return this.listSent({ ...(ref.workspace ? { workspace: ref.workspace } : {}), open: true });
  }

  listSent(filter: { workspace?: string; open?: boolean }): string {
    const found = filter.workspace ? findByRef(this.host.workspaces.list().map((ws) => ({ id: ws.id, name: ws.name })), filter.workspace) : undefined;
    if (filter.workspace && !found) throw new Error(`No workspace "${filter.workspace}". Use list_workspaces.`);
    let views = this.views_().filter((view) => !found || view.workspace === found.id);
    if (filter.open) {
      const open = views.filter((view) => !isSentRequestClosed(view.state));
      views = open.length > 0 ? open : views.slice(0, 3);
    }
    if (views.length === 0) return "You have not sent any request yet.";
    const open = views.filter((view) => !isSentRequestClosed(view.state)).length;
    return [`${views.length} request(s), ${open} open:`, ...views.slice(0, 25).map(requestLine)].join("\n");
  }

  // ---------- Falar com um agente ----------

  async messageAgent(input: { workspace: string; agent: string; message: string }): Promise<string> {
    const found = findByRef(this.host.workspaces.list().map((ws) => ({ id: ws.id, name: ws.name })), input.workspace);
    const runtime = found ? this.runtimeOf(found.id) : undefined;
    if (!found || !runtime) throw new Error(`No workspace "${input.workspace}". Use list_workspaces.`);
    const now = this.host.now().getTime();
    while (this.messageTimes.length > 0 && now - this.messageTimes[0]! > HOUR_MS) this.messageTimes.shift();
    if (this.messageTimes.length >= CYNO_SEND_LIMITS.messagesPerHour) throw new Error(`Limit reached: ${CYNO_SEND_LIMITS.messagesPerHour} direct messages per hour. Use send_request for real work.`);
    const state = runtime.store.snapshot();
    const wantsMaestro = input.agent.trim().toLowerCase() === "maestro";
    const target = wantsMaestro ? findMaestroAgent(state) : findByRef(state.agents, input.agent);
    if (!target) throw new Error(`No agent "${input.agent}" in ${found.name}. Use get_workspace_card for the team.`);
    const text = `[Mensagem do Cyno, o agente da plataforma, em nome do dono] ${input.message.trim()}`;
    if (isMaestroAgent(state, target)) {
      const delivered = runtime.cliMaestro.deliverNote({ id: `cyno-${now}`, text, line: `Cyno escreveu ao Maestro: ${input.message.trim()}` });
      if (!delivered) throw new Error(`The Maestro of ${found.name} does not run on a CLI engine.`);
    } else {
      if (!isCliEngine(agentEngine(target))) throw new Error(`${target.name} does not run on a CLI engine, so it cannot be messaged.`);
      try {
        await runtime.agentChat.send(target.id, text);
      } catch (error) {
        throw new Error(`Could not deliver to ${target.name}: ${error instanceof HttpError ? error.message : errorMessage(error)}`, { cause: error });
      }
    }
    this.messageTimes.push(now);
    return `Delivered to ${target.name} (${agentAddress(found.id, target.id)}). No task was created and the reply does not come back to you: the owner sees it in the workspace. For real work, use send_request.`;
  }

  // ---------- Mudar e cancelar ----------

  async updateRequest(requestId: string, patch: { priority?: "high" | "normal" | "low"; dueAt?: string | null; startAt?: string | null; paused?: boolean }): Promise<string> {
    const record = this.recordOf(requestId);
    const runtime = this.runtimeOf(record.workspace);
    if (!runtime) throw new Error("The workspace of this request no longer exists.");
    const change = {
      ...(patch.priority ? { priority: PRIORITY[patch.priority] } : {}),
      ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
      ...(patch.startAt !== undefined ? { startAt: patch.startAt } : {}),
      ...(patch.paused !== undefined ? { status: patch.paused ? ("pausado" as const) : ("ativo" as const) } : {}),
    };
    if (Object.keys(change).length === 0) throw new Error("Nothing to change: pass priority, due_at, start_at or paused.");
    try {
      await runtime.plans.updateProject(requestId, change);
    } catch (error) {
      throw new Error(error instanceof HttpError ? error.message : errorMessage(error), { cause: error });
    }
    this.dirty.add(record.workspace);
    this.schedule();
    return `Request ${requestId} updated (${Object.keys(change).join(", ")}).`;
  }

  async cancelRequest(requestId: string, reason: string): Promise<string> {
    const record = this.recordOf(requestId);
    const runtime = this.runtimeOf(record.workspace);
    if (!runtime) throw new Error("The workspace of this request no longer exists.");
    const view = this.viewOf(record);
    if (view && isSentRequestClosed(view.state)) throw new Error(`Request ${requestId} is already ${view.state}.`);
    try {
      runtime.cliMaestro.closeByUser(requestId, "cancelar", `Cancelado pelo Cyno: ${reason}`);
    } catch (error) {
      throw new Error(error instanceof HttpError ? error.message : errorMessage(error), { cause: error });
    }
    // O próprio Cyno cancelou: não vira aviso passivo.
    record.notified = "cancelado";
    this.records.save();
    this.dirty.add(record.workspace);
    this.schedule();
    return `Request ${requestId} cancelled. Tell the owner in one sentence.`;
  }

  // ---------- ask_cyno (Maestro -> Cyno) ----------

  /** O Maestro de `workspaceId` pergunta ao Cyno. Lança `Error` (em inglês, para o Maestro) se um limite barrar. */
  ask(workspaceId: string, input: { question: string; context?: string; requestId?: string }): string {
    const name = this.host.workspaces.list().find((ws) => ws.id === workspaceId)?.name ?? workspaceId;
    this.expireAsks();
    // Um limite barrado lança `AskRefused` com o motivo (o Maestro lê e decide sozinho ou pergunta ao dono).
    const record = this.asks.open({ workspace: workspaceId, ...(input.requestId ? { requestId: input.requestId } : {}), question: input.question, ...(input.context ? { context: input.context } : {}) });
    try {
      this.host.wake(`ask:${record.id}`, () => askMessage(record, name, this.requestTitle(workspaceId, input.requestId), this.takeNotices()));
    } catch (error) {
      // O Cyno não pode acordar (motor ausente): a pergunta não fica aberta para sempre.
      this.asks.answer(record.id, "(not delivered)");
      throw new Error(`The Cyno cannot be reached right now: ${errorMessage(error)}`, { cause: error });
    }
    this.host.chat({ kind: "status", status: "resumed", message: askMarker(`Maestro de ${name} perguntou: ${input.question}`) });
    const timer = setTimeout(() => {
      this.askTimers.delete(timer);
      this.expireAsks();
    }, ASK_LIMITS.expireMs + 1000);
    timer.unref?.();
    this.askTimers.add(timer);
    return `Sent to the Cyno (question ${record.id}). The answer arrives as a message in this conversation, once; continue with what does not depend on it and end your turn. To continue the conversation afterwards you must open another question (it counts in the limit).`;
  }

  private requestTitle(workspaceId: string, requestId: string | undefined): string | undefined {
    if (!requestId) return undefined;
    return requestProject(this.runtimeOf(workspaceId)?.plans.list() ?? [], requestId)?.title;
  }

  /** O Cyno responde (a ferramenta `answer_maestro`, ou o texto final do turno da pergunta). */
  answer(askId: string, message: string): string {
    const record = this.asks.get(askId);
    if (!record) throw new Error(`There is no question ${askId}.`);
    if (record.status !== "aberto") throw new Error(`Question ${askId} is already closed (${record.status}); the Maestro gets one answer per question.`);
    const text = message.trim();
    if (!text) throw new Error("The answer is empty.");
    this.asks.answer(askId, text);
    const name = this.host.workspaces.list().find((ws) => ws.id === record.workspace)?.name ?? record.workspace;
    this.host.chat({ kind: "status", status: "resumed", message: askMarker(`Cyno respondeu ao Maestro de ${name}: ${text}`) });
    const runtime = this.runtimeOf(record.workspace);
    const delivered = runtime?.cliMaestro.deliverNote({ id: `ask-${record.id}`, text: answerMessage(record, text), line: `Cyno respondeu (${record.id}): ${text}` }) ?? false;
    return delivered ? `Answer delivered to the Maestro of ${name}.` : `Answer recorded, but the Maestro of ${name} is not reachable (not on a CLI engine).`;
  }

  /** Se a pergunta ainda está aberta no fim do turno que a recebeu, o texto final do turno é a resposta. */
  settleAskTurn(askId: string, ok: boolean, text: string): void {
    const record = this.asks.get(askId);
    if (!record || record.status !== "aberto") return;
    if (ok && text.trim()) this.answer(askId, text);
    else this.host.chat({ kind: "status", status: "failed", message: askMarker(`O Cyno não conseguiu responder ${askId}: o Maestro decide sozinho se não houver resposta em 1 h`) });
  }

  /** Perguntas sem resposta depois do prazo: o Maestro é avisado para decidir sozinho ou perguntar ao dono. */
  expireAsks(): void {
    for (const record of this.asks.expire()) {
      const runtime = this.runtimeOf(record.workspace);
      runtime?.cliMaestro.deliverNote({
        id: `ask-${record.id}`,
        text: `[Sem resposta do Cyno à sua pergunta ${record.id}] O Cyno não respondeu em 1 hora. Decida sozinho com o que você sabe, ou pergunte ao dono com \`ask_user\`${record.requestId ? ` (pedido ${record.requestId})` : ""}.`,
        line: `O Cyno não respondeu à pergunta ${record.id}`,
      });
    }
  }

  // ---------- Ferramentas ----------

  toolDeps(): RequestToolsDeps {
    return {
      sendRequest: (input) => this.sendRequest(input),
      requestStatus: (ref) => this.requestStatus(ref),
      listSent: (filter) => this.listSent(filter),
      messageAgent: (input) => this.messageAgent(input),
      cancelRequest: (id, reason) => this.cancelRequest(id, reason),
      updateRequest: (id, patch) => this.updateRequest(id, patch),
      answerMaestro: (id, message) => this.answer(id, message),
    };
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const timer of this.askTimers) clearTimeout(timer);
    this.askTimers.clear();
    this.offList?.();
    for (const off of this.watching.values()) off();
    this.watching.clear();
  }
}

/** A mensagem que o Maestro recebe: o briefing completo do Cyno e a regra de que ele só distribui. */
export function briefingMessage(projectId: string, input: Pick<SendRequestInput, "title" | "brief" | "kind" | "priority" | "dueAt" | "startAt" | "doneWhen" | "suggestedAgents">): string {
  return [
    "[Briefing completo do Cyno, em nome do dono]",
    `Este pedido veio do Cyno, o agente da plataforma, que já conversou com o dono e montou o briefing abaixo. O projeto ${projectId} (origem: Cyno) já existe com o briefing gravado; ${input.kind === "project" ? "o Cyno acha que é um PROJETO (várias partes ou etapas)" : input.kind === "task" ? "o Cyno acha que é uma TAREFA (um agente, um entregável)" : "decida se é projeto ou tarefa"}.`,
    "",
    "## Briefing",
    input.brief,
    ...(input.doneWhen?.length ? ["", "## Pronto quando", ...input.doneWhen.map((item) => `- ${item}`)] : []),
    ...(input.suggestedAgents?.length ? ["", "## Agentes sugeridos pelo Cyno", input.suggestedAgents.map((agent) => `- ${agent}`).join("\n")] : []),
    ...(input.priority || input.dueAt || input.startAt ? ["", `## Prazo e prioridade`, [input.priority ? `prioridade ${input.priority}` : "", input.startAt ? `não começar antes de ${input.startAt}` : "", input.dueAt ? `prazo ${input.dueAt}` : ""].filter(Boolean).join(" · ")] : []),
    "",
    "## Regras",
    `- O briefing está COMPLETO: NÃO refaça ao dono as perguntas que ele já respondeu e não reabra o briefing. Só DISTRIBUA o trabalho (\`delegate_task\` para um agente, ou \`create_project\` para várias partes), seguindo os agentes sugeridos quando fizerem sentido. Use o id do pedido (${projectId}) como \`request_id\`: o projeto dele já existe, não abra outro.`,
    "- Pergunte ao dono (`ask_user`) APENAS o que falta e SÓ ELE sabe; a pergunta aparece no Para você do workspace, como sempre.",
    "- `ask_cyno` só se faltar algo que envolve outro workspace ou a plataforma. Termine o turno depois de distribuir.",
  ].join("\n");
}

/** A mensagem que o Cyno recebe quando um Maestro pergunta (`ask_cyno`). */
export function askMessage(record: AskRecord, workspaceName: string, requestTitle: string | undefined, notices: string[]): string {
  return [
    `[Help request from the Maestro of workspace "${workspaceName}" (${record.workspace}) — question ${record.id}${record.requestId ? `, about request ${record.requestId}${requestTitle ? ` "${requestTitle}"` : ""}` : ""}]`,
    record.message,
    ...(record.context ? ["", `Context from the Maestro: ${record.context}`] : []),
    "",
    `Answer ONCE with answer_maestro(ask_id: "${record.id}", message), concrete and short, in Brazilian Portuguese. If it needs action in another workspace, do it first (send_request / message_agent), then answer saying what you did. This is not a conversation: the Maestro gets one answer per question and opens another if it needs more. The owner is not waiting on this chat, so do not address them; if you cannot help, say so in the answer.`,
    ...(notices.length > 0 ? ["", `(Changes in your sent requests since your last message, by code: ${notices.join(" | ")})`] : []),
  ].join("\n");
}

/** A mensagem que o Maestro recebe com a resposta do Cyno. */
export function answerMessage(record: AskRecord, answer: string): string {
  return [
    `[Resposta do Cyno à sua pergunta ${record.id}${record.requestId ? ` (pedido ${record.requestId})` : ""}]`,
    answer,
    "",
    `Continue o que dependia disto${record.requestId ? ` (passe request_id: "${record.requestId}" nas ferramentas do pedido)` : ""}. Esta pergunta está fechada: para continuar a conversa você precisa abrir outra com \`ask_cyno\` (conta no limite).`,
  ].join("\n");
}
