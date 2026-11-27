import {
  confirmationMarker,
  CONFIRMATION_TTL_MS,
  DANGEROUS_ACTION_LABELS,
  proposalMarker,
  type AgentLogBody,
  type Confirmation,
  type CynoServerEvent,
  type EngineInfo,
  type WorkspaceProposal,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import type { StructureHostDeps } from "../../mcp/cyno/structure-tools";
import type { WriteQueue } from "../../store/write-queue";
import { errorMessage, shorten } from "../../util/text";
import type { ActivityInput } from "../../workspace/activity/log";
import { HttpError } from "../http/errors";
import type { WorkspaceManager } from "../workspaces/manager";
import { ConfirmationBook, type ConfirmationRequest } from "./confirmations";
import { HostCommandFailed, StructureActions } from "./structure-actions";
import { HostCommandRunner } from "./host-command";
import { executeProposal, ProposalFailed } from "./proposal-executor";
import { ProposalBook, validateProposal, type ProposalInput } from "./proposals";
import type { PlatformPaths } from "../../store/paths";
import { catalogText } from "./catalog";
import { findByRef } from "../../mcp/structure-tools";
import { modelChoiceSchema } from "@cyno/shared";

export type CynoStructureHost = {
  workspaces: Pick<WorkspaceManager, "list" | "find" | "create" | "remove" | "update" | "rename" | "models">;
  engines: () => Promise<EngineInfo[]>;
  simulated: boolean;
  paths: PlatformPaths;
  now: () => Date;
  log: FastifyBaseLogger;
  env?: NodeJS.ProcessEnv;
  /** Escreve no chat do Cyno (log da conversa do dia). */
  chat: (body: AgentLogBody) => void;
  emit: (event: CynoServerEvent) => void;
  /** Acorda o Cyno com uma mensagem (`build` monta o texto só quando ela sai). Lança se ele não pode acordar. */
  wake: (tag: string, build: () => string) => void;
  /** Atividade da plataforma (quem pediu, o quê, decisão, resultado). */
  record: (input: ActivityInput) => void;
  /**
   * As ações perigosas pedem o OK do dono num cartão (duas fases)? Padrão: sim. Com `false` (o servidor em
   * produção, `CYNO_REQUIRE_APPROVAL=0`) elas executam na hora, ficam só na Atividade, e o limite passa a ser
   * a regra das instruções do Cyno: só faz o que o dono pediu e pergunta no chat sobre o que passar disso.
   */
  requireApproval?: boolean;
};

/**
 * Estrutura do Cyno: montar e mudar workspaces, com as ações perigosas em DUAS FASES.
 * - Fase 1 (ferramenta MCP): `request()` só VALIDA e REGISTRA uma confirmação (resumo por código,
 *   parâmetros congelados, validade de 30 min) e mostra o cartão no chat. Nada muda.
 * - Fase 2 (rota HTTP do dono, com a sessão): `approve()` executa SÓ os parâmetros gravados; `reject()` recusa.
 *   O resultado volta ao Cyno como mensagem (acorda: ele pediu).
 * O MCP nunca chega em `approve`/`reject`: não há ferramenta que os chame e as rotas exigem a senha.
 * Propostas de workspace seguem o mesmo molde (`propose` registra; `approveProposal` cria tudo por código).
 */
export class CynoStructure {
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Linhas para o contexto do Cyno na próxima mensagem (confirmações que venceram...). */
  private notices: string[] = [];
  private closed = false;
  readonly actions: StructureActions;
  readonly hostCommands: HostCommandRunner;
  /** Propostas em criação agora (um duplo clique não cria o workspace duas vezes). */
  private readonly creating = new Set<string>();

  private constructor(
    private readonly host: CynoStructureHost,
    readonly confirmations: ConfirmationBook,
    readonly proposals: ProposalBook,
  ) {
    this.hostCommands = new HostCommandRunner({ workDir: host.paths.workDir, logFile: host.paths.hostCommandsFile, ...(host.env ? { env: host.env } : {}), now: host.now });
    this.actions = new StructureActions({ workspaces: host.workspaces, hostCommands: this.hostCommands });
  }

  static async open(host: CynoStructureHost, queue: WriteQueue): Promise<CynoStructure> {
    const onError = (error: unknown) => host.log.warn({ err: error }, "não foi possível gravar as confirmações/propostas do Cyno");
    const structure = new CynoStructure(host, await ConfirmationBook.open(host.paths.confirmationsFile, queue, host.now, onError), await ProposalBook.open(host.paths.proposalsFile, queue, host.now, onError));
    structure.confirmations.onExpired = (expired) => structure.onExpired(expired);
    structure.armExpiry();
    return structure;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.expiryTimer);
  }

  /** O que mudou desde a última mensagem do dono (uma linha por fato), e esvazia. */
  takeNotices(): string[] {
    return this.notices.splice(0);
  }

  // ---------- Leitura (rotas e tela) ----------

  listConfirmations(): Confirmation[] {
    return this.confirmations.list();
  }

  listProposals(): WorkspaceProposal[] {
    return this.proposals.list();
  }

  // ---------- Fase 1: registrar (ferramentas do Cyno) ----------

  /** Registra o pedido de OK e devolve o texto para o modelo. `prepared` já foi validado e tem o resumo por código. */
  request(prepared: ConfirmationRequest, reason: string | undefined): string {
    const { confirmation, duplicate } = this.confirmations.create({ ...prepared, ...(reason ? { reason: shorten(reason, 600) } : {}) });
    if (!duplicate) {
      this.host.chat({ kind: "status", status: "waiting", message: confirmationMarker(confirmation.id) });
      this.record("confirmacao_pedida", "cyno", `O Cyno pediu OK: ${shorten(confirmation.summary, 200)}`, confirmation);
      this.armExpiry();
      this.emitConfirmations();
    }
    return duplicate
      ? `PENDING_CONFIRMATION ${confirmation.id} (the same request is already waiting). The owner was asked in the chat. Do not retry and do not try another way; you will get a message with the result.`
      : `PENDING_CONFIRMATION ${confirmation.id}. The owner was asked in the chat (a card with the summary: "${confirmation.summary}"). Nothing has been done yet. Do not retry and do not try another way; you will get a message with the result. Tell the owner, in Brazilian Portuguese and without technical ids, what you asked approval for and that you are waiting.`;
  }

  /**
   * Sem cartão de OK (`requireApproval: false`): executa na hora o que a ferramenta preparou (os mesmos
   * parâmetros já validados e resolvidos), deixa o rastro na Atividade e devolve o resultado real ao modelo.
   * Não grava confirmação, não põe cartão no chat e não acorda o Cyno (ele já recebe o resultado na chamada).
   */
  private async runNow(prepared: ConfirmationRequest, reason: string | undefined): Promise<string> {
    const label = DANGEROUS_ACTION_LABELS[prepared.action];
    const data = { tipo: label, ...(prepared.workspace ? { workspace: prepared.workspace } : {}), ...(reason ? { motivo: shorten(reason, 300) } : {}) };
    this.record("acao_direta", "cyno", `O Cyno executou: ${shorten(prepared.summary, 200)}`, undefined, data);
    try {
      const result = await this.actions.execute(prepared.action, prepared.params);
      this.record("acao_executada", "cyno", `Executado: ${shorten(prepared.summary, 160)}`, undefined, { ...data, result: shorten(result, 300) });
      return `DONE: ${prepared.summary}\nResult:\n${result || "(no output)"}\nTell the owner the outcome briefly, in Brazilian Portuguese and without technical ids.`;
    } catch (error) {
      const text = errorMessage(error);
      this.record("acao_falhou", "cyno", `Falhou: ${shorten(prepared.summary, 120)} (${shorten(text, 120)})`, undefined, data);
      if (!(error instanceof HostCommandFailed)) this.host.log.warn({ err: error }, "ação direta do Cyno falhou");
      throw new Error(`FAILED: ${prepared.summary}\n${text}`);
    }
  }

  // ---------- Fase 2: o dono decide (rotas HTTP) ----------

  /** O dono clicou "Confirmar": executa os parâmetros gravados, uma vez. Devolve a confirmação já com o resultado. */
  async approve(id: string): Promise<Confirmation> {
    const authorized = this.confirmations.decide(id, "autorizada");
    this.emitConfirmations();
    this.record("confirmacao_autorizada", "usuario", `O dono autorizou: ${shorten(authorized.summary, 200)}`, authorized);
    let done: Confirmation;
    try {
      const result = await this.actions.execute(authorized.action, authorized.params);
      done = this.confirmations.finish(id, true, result);
      this.record("acao_executada", "cyno", `Executado: ${shorten(authorized.summary, 160)}`, done);
    } catch (error) {
      const text = errorMessage(error);
      done = this.confirmations.finish(id, false, text);
      this.record("acao_falhou", "cyno", `Falhou: ${shorten(authorized.summary, 120)} (${shorten(text, 120)})`, done);
      if (!(error instanceof HostCommandFailed)) this.host.log.warn({ err: error, confirmation: id }, "ação confirmada do Cyno falhou");
    }
    this.emitConfirmations();
    this.tell(`decision:${id}`, () => `[Decision on ${id}] The owner APPROVED and the server ran it: ${done.summary}\nResult (${done.status === "executada" ? "success" : "FAILED"}):\n${done.result ?? "(no output)"}\nTell the owner the outcome briefly, in Brazilian Portuguese, with no technical ids. If it was a command, show the useful part of the output in a code block.`);
    return done;
  }

  /** O dono clicou "Recusar": nada acontece; o Cyno é avisado. */
  reject(id: string): Confirmation {
    const refused = this.confirmations.decide(id, "recusada");
    this.emitConfirmations();
    this.record("confirmacao_recusada", "usuario", `O dono recusou: ${shorten(refused.summary, 200)}`, refused);
    this.tell(`decision:${id}`, () => `[Decision on ${id}] The owner REFUSED: ${refused.summary}\nNothing was done. Do not ask again for the same thing or try another way to do it; acknowledge briefly in Brazilian Portuguese and ask what they prefer instead.`);
    return refused;
  }

  // ---------- Propostas de workspace ----------

  /** Valida, grava a proposta e mostra o cartão no chat (nada é criado). */
  private async registerProposal(input: ProposalInput & { replaces?: string }): Promise<{ proposal: WorkspaceProposal; warnings: string[] }> {
    const { replaces, ...plan } = input;
    const { plan: normalized, warnings } = validateProposal(plan, {
      engines: await this.host.engines(),
      simulated: this.host.simulated,
      workspaceNames: this.host.workspaces.list().map((workspace) => workspace.name),
      knownConnectors: this.host.workspaces.list().flatMap((workspace) => this.host.workspaces.find(workspace.id)?.connectors.list().map((connector) => ({ id: connector.id, name: connector.name })) ?? []),
    });
    const proposal = this.proposals.create(normalized, warnings, replaces);
    this.host.chat({ kind: "status", status: "waiting", message: proposalMarker(proposal.id) });
    this.record("workspace_proposto", "cyno", `O Cyno propôs o workspace "${proposal.plan.name}"`, undefined, { proposal: proposal.id });
    this.emitProposals();
    return { proposal, warnings };
  }

  /** Sem OK (`requireApproval: false`): registra e já cria tudo (a mesma criação do botão, numa transação); o cartão fica como registro. */
  private async proposeAndCreate(input: ProposalInput & { replaces?: string }): Promise<string> {
    const { proposal, warnings } = await this.registerProposal(input);
    const outcome = await this.runProposal(proposal.id, "cyno");
    const warn = warnings.length > 0 ? `\nWarnings: ${warnings.join(" ")}` : "";
    if (outcome.error !== undefined) {
      throw new Error(`FAILED to create the workspace "${proposal.plan.name}" (everything was undone): ${outcome.error}${warn}\nExplain briefly to the owner in Brazilian Portuguese what failed and fix it (a new propose_workspace with replaces: "${proposal.id}").`);
    }
    return `DONE: the server created the whole workspace "${proposal.plan.name}". ${outcome.summary} Workspace id: ${outcome.workspaceId}.${outcome.logins}${outcome.pending}${warn}\nTell the owner it is ready (Brazilian Portuguese, no technical ids) and what is left for them (logins, routines waiting in "Para você", pending connectors).`;
  }

  async propose(input: ProposalInput & { replaces?: string }): Promise<string> {
    const { proposal, warnings } = await this.registerProposal(input);
    return `Proposal ${proposal.id} (version ${proposal.version}) is now shown to the owner as a card with the whole package and a "Criar workspace" button. NOTHING was created. Do not create anything yourself: the server creates everything when the owner approves, and you will get a message with the result. If the owner asks for changes, call propose_workspace again with replaces: "${proposal.id}".${warnings.length > 0 ? `\nWarnings: ${warnings.join(" ")}` : ""}\nTell the owner in one or two sentences (Brazilian Portuguese, no technical ids) that the proposal is ready for their review.`;
  }

  /** Cria tudo por código, numa transação (falhou = desfaz). `by` diz quem mandou criar (o dono no botão; o Cyno sem OK). */
  private async runProposal(
    id: string,
    by: "usuario" | "cyno",
  ): Promise<{ proposal: WorkspaceProposal; error?: string; summary: string; workspaceId: string; logins: string; pending: string }> {
    const found = this.proposals.get(id);
    if (!found) throw new HttpError(404, "Proposta não encontrada");
    if (found.status !== "proposta" && found.status !== "falhou") throw new HttpError(409, `Esta proposta já foi decidida (${found.status}).`);
    if (this.creating.has(id)) throw new HttpError(409, "Esta proposta já está sendo criada.");
    this.creating.add(id);
    this.proposals.update(id, { status: "criando", progress: [], error: undefined });
    this.emitProposals();
    if (by === "usuario") this.record("workspace_aprovado", "usuario", `O dono aprovou criar o workspace "${found.plan.name}"`, undefined, { proposal: id });
    try {
      const result = await executeProposal(this.proposals.get(id)!, {
        workspaces: this.host.workspaces,
        progress: (steps) => {
          this.proposals.update(id, { progress: steps });
          this.emitProposals();
        },
      });
      const done = this.proposals.update(id, { status: "criada", workspaceId: result.workspaceId, error: undefined });
      this.record("workspace_criado", "cyno", result.summary, undefined, { proposal: id, workspace: result.workspaceId });
      this.emitProposals();
      const logins = result.logins.length > 0 ? `\nSites that need the owner to log in manually (tell them): ${result.logins.join(", ")}.` : "";
      const connectorsNote = this.host.requireApproval === false ? "" : " (needs the owner's OK)";
      const pending = result.pendingConnectors.length > 0 ? `\nConnectors NOT created (they were not registered anywhere): ${result.pendingConnectors.join(", ")}. Register them with add_connector${connectorsNote} and then give them to the agents with set_agent_connectors${connectorsNote}.` : "";
      return { proposal: done, summary: result.summary, workspaceId: result.workspaceId, logins, pending };
    } catch (error) {
      const message = errorMessage(error);
      const failed = this.proposals.update(id, { status: "falhou", error: message, ...(error instanceof ProposalFailed ? { progress: error.steps } : {}) });
      this.record("workspace_falhou", "cyno", `Falhou criar o workspace "${found.plan.name}": ${shorten(message, 200)}`, undefined, { proposal: id });
      this.emitProposals();
      return { proposal: failed, error: message, summary: "", workspaceId: "", logins: "", pending: "" };
    } finally {
      this.creating.delete(id);
    }
  }

  /** O dono clicou "Criar workspace": cria tudo por código, numa transação (falhou = desfaz) e avisa o Cyno. */
  async approveProposal(id: string): Promise<WorkspaceProposal> {
    const outcome = await this.runProposal(id, "usuario");
    if (outcome.error !== undefined) {
      this.tell(`proposal:${id}`, () => `[Proposal ${id}] The owner approved but the creation FAILED and was undone: ${outcome.error}\nExplain briefly to the owner in Brazilian Portuguese what failed and propose a fix (a new propose_workspace with replaces: "${id}").`);
    } else {
      this.tell(`proposal:${id}`, () => `[Proposal ${id}] The owner APPROVED and the server created everything. ${outcome.summary} Workspace id: ${outcome.workspaceId}.${outcome.logins}${outcome.pending}\nTell the owner it is ready (Brazilian Portuguese, no technical ids) and what is left for them (logins, routines waiting in "Para você", pending connectors).`);
    }
    return outcome.proposal;
  }

  rejectProposal(id: string): WorkspaceProposal {
    const found = this.proposals.get(id);
    if (!found) throw new HttpError(404, "Proposta não encontrada");
    if (found.status !== "proposta" && found.status !== "falhou") throw new HttpError(409, `Esta proposta já foi decidida (${found.status}).`);
    const refused = this.proposals.update(id, { status: "recusada" });
    this.record("workspace_recusado", "usuario", `O dono recusou a proposta do workspace "${found.plan.name}"`, undefined, { proposal: id });
    this.emitProposals();
    this.tell(`proposal:${id}`, () => `[Proposal ${id}] The owner REFUSED the proposal for "${found.plan.name}". Nothing was created. Acknowledge briefly in Brazilian Portuguese and ask what they would change.`);
    return refused;
  }

  // ---------- Ferramentas (as dependências das ferramentas MCP de estrutura) ----------

  /** As dependências das ferramentas MCP de estrutura do Cyno. */
  toolDeps(): StructureHostDeps {
    const run = async (prepare: () => Promise<ConfirmationRequest> | ConfirmationRequest, reason: string | undefined): Promise<string> => {
      const prepared = await prepare();
      return this.host.requireApproval === false ? this.runNow(prepared, reason) : this.request(prepared, reason);
    };
    return {
      workspaceOf: (ref) => this.actions.workspaceOf(ref),
      catalog: async () => catalogText({ engines: await this.host.engines(), simulated: this.host.simulated, workspaces: this.host.workspaces }),
      createWorkspace: async (input) => {
        const created = await this.host.workspaces.create(input.name, input.maestro ? { choice: input.maestro } : undefined);
        if (input.summary) await this.host.workspaces.find(created.id)?.cardSummary.write(input.summary, "cyno");
        this.record("workspace_criado", "cyno", `O Cyno criou o workspace "${created.name}" (vazio)`, undefined, { workspace: created.id });
        return created;
      },
      renameWorkspace: async (ref, name) => {
        const workspace = this.actions.workspaceOf(ref);
        return this.host.workspaces.rename(workspace.id, name);
      },
      setWorkspaceModels: async (ref, models) => {
        const workspace = this.actions.workspaceOf(ref);
        const current = this.host.workspaces.models(workspace.id);
        const next = { ...current, ...(models.maestro ? { maestro: modelChoiceSchema.parse(models.maestro) } : {}), ...(models.agents ? { agentes: modelChoiceSchema.parse(models.agents) } : {}) };
        return this.host.workspaces.update(workspace.id, { models: next });
      },
      propose: (input) => (this.host.requireApproval === false ? this.proposeAndCreate(input) : this.propose(input)),
      confirm: {
        deleteWorkspace: (input) => run(() => this.actions.prepareDeleteWorkspace(input), input.reason),
        deleteRoom: (input) => run(() => this.actions.prepareDeleteRoom(input), input.reason),
        deleteTeam: (input) => run(() => this.actions.prepareDeleteTeam(input), input.reason),
        deleteAgent: (input) => run(() => this.actions.prepareDeleteAgent(input), input.reason),
        addConnector: (input) => run(() => this.actions.prepareAddConnector(input), input.reason),
        setAgentConnectors: (input) => run(() => this.actions.prepareSetAgentConnectors(input), input.reason),
        setAgentAccess: (input) => run(() => this.actions.prepareSetAgentAccess(input), input.reason),
        setWorkspaceAccess: (input) => run(() => this.actions.prepareSetWorkspaceAccess(input), input.reason),
        runHostCommand: (input) => run(() => this.actions.prepareRunHostCommand(input), input.reason),
      },
      findWorkspace: (ref) => findByRef(this.host.workspaces.list(), ref),
    };
  }

  // ---------- Infra ----------

  private record(action: string, actor: string, summary: string, confirmation?: Confirmation, data?: Record<string, unknown>): void {
    try {
      this.host.record({
        category: "sistema",
        action,
        actor,
        summary,
        data: { ...(confirmation ? { confirmation: confirmation.id, tipo: DANGEROUS_ACTION_LABELS[confirmation.action], status: confirmation.status, ...(confirmation.workspace ? { workspace: confirmation.workspace } : {}), ...(confirmation.result ? { result: shorten(confirmation.result, 300) } : {}) } : {}), ...data },
      });
    } catch {
      // A Atividade nunca derruba a ação.
    }
  }

  /** Avisa o Cyno do resultado (acorda: ele pediu). Se não pode acordar (sem motor), o chat registra e a próxima mensagem leva a linha. */
  private tell(tag: string, build: () => string): void {
    try {
      this.host.wake(tag, build);
    } catch (error) {
      this.notices.push(shorten(build(), 300));
      this.host.log.warn({ err: error }, "não foi possível avisar o Cyno da decisão");
    }
  }

  private emitConfirmations(): void {
    if (!this.closed) this.host.emit({ type: "cyno:confirmations", confirmations: this.confirmations.list() });
  }

  private emitProposals(): void {
    if (!this.closed) this.host.emit({ type: "cyno:proposals", proposals: this.proposals.list() });
  }

  /** Um relógio para a próxima validade: o cartão vira "Expirou" na hora, sem polling. */
  private armExpiry(): void {
    clearTimeout(this.expiryTimer);
    const next = this.confirmations.nextExpiry();
    if (next === undefined || this.closed) return;
    const wait = Math.min(Math.max(next - this.host.now().getTime(), 0) + 50, CONFIRMATION_TTL_MS + 1000, 2 ** 30);
    this.expiryTimer = setTimeout(() => this.afterExpiry(), wait);
    this.expiryTimer.unref();
  }

  private afterExpiry(): void {
    this.confirmations.sweep();
    this.armExpiry();
  }

  /** Venceu sem resposta: registra, deixa a linha para a próxima mensagem e atualiza o cartão ao vivo. */
  private onExpired(expired: Confirmation[]): void {
    for (const confirmation of expired) {
      this.record("confirmacao_expirada", "sistema", `Expirou sem resposta: ${shorten(confirmation.summary, 200)}`, confirmation);
      this.notices.push(`Confirmation ${confirmation.id} EXPIRED without an answer (nothing was done): ${shorten(confirmation.summary, 160)}`);
    }
    this.emitConfirmations();
  }
}
