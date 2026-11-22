import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  findMaestroAgent,
  isoFromInput,
  JOINT_LIMITS,
  JOINT_PART_STATE_LABELS,
  jointMarker,
  jointProjectSchema,
  type AgentLogBody,
  type CynoServerEvent,
  type JointPart,
  type JointPartState,
  type JointPartView,
  type JointProject,
  type JointReceived,
  type JointView,
  type SentRequestView,
  type WaitingItem,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { findByRef } from "../../mcp/structure-tools";
import { writeJsonAtomic } from "../../store/atomic-write";
import type { WriteQueue } from "../../store/write-queue";
import { errorMessage, shorten } from "../../util/text";
import { activity } from "../../workspace/activity/log";
import type { WorkspaceRuntime } from "../../workspace/runtime";
import { HttpError } from "../http/errors";
import type { WorkspaceManager } from "../workspaces/manager";
import type { CynoRequests } from "./cyno-requests";

/** O que cada parte pede ao criar um projeto conjunto. */
export type JointInput = {
  title: string;
  brief?: string;
  dueAt?: string;
  parts: { workspace: string; title: string; brief: string; dependsOn?: string[]; doneWhen?: string[]; dueAt?: string; expects?: string }[];
};

export type JointHost = {
  workspaces: Pick<WorkspaceManager, "list" | "find">;
  requests: Pick<CynoRequests, "sendRequest" | "peek" | "deliveries" | "cancelRequest" | "updateRequest">;
  /** `data/platform/joint/`. */
  dir: string;
  queue: WriteQueue;
  now: () => Date;
  log: FastifyBaseLogger;
  chat: (body: AgentLogBody) => void;
  emit: (event: CynoServerEvent) => void;
};

/** Um projeto conjunto igual (mesmo título) ainda aberto, criado há menos que isto, não é criado de novo. */
const DUPLICATE_WINDOW_MS = 30 * 60_000;
const FAILED: ReadonlySet<JointPart["status"]> = new Set(["falhou", "cancelada", "bloqueada"]);
const isClosed = (joint: JointProject): boolean => joint.status === "concluido" || joint.status === "cancelado";

const STATE_OF_REQUEST: Record<SentRequestView["state"], JointPartState> = {
  enviado: "enviado",
  andando: "andando",
  esperando_voce: "esperando_voce",
  pausado: "pausado",
  concluido: "concluida",
  falhou: "falhou",
  cancelado: "cancelada",
};

/**
 * O coordenador dos projetos que envolvem mais de um workspace. TUDO por código, sem IA e sem acordar o
 * Cyno: uma parte em cada workspace (cada uma um Projeto `origin:"cyno"`), ligadas num registro em
 * `data/platform/joint/J-0001.json`. As partes que dependem de outra ficam num projeto PAUSADO, sem pedido
 * ao Maestro (custo zero); quando a anterior conclui, o coordenador copia as mídias dela e o resumo para o
 * workspace seguinte, abre o pedido de verdade (o Maestro de lá acorda UMA vez, com o briefing e a
 * entrega) e segue. Falha ou cancelamento no meio: as dependentes ficam bloqueadas com o motivo e o dono é
 * avisado. O estado é conferido a cada mudança dos projetos (eventos dos workspaces) e no boot, então
 * um reinício no meio não perde nada nem libera uma parte duas vezes.
 */
export class JointCoordinator {
  private joints: JointProject[] = [];
  private readonly busy = new Set<string>();
  private readonly again = new Set<string>();
  private notices: string[] = [];
  private lastEmitted = "";
  private closed = false;

  private constructor(private readonly host: JointHost) {}

  static async open(host: JointHost): Promise<JointCoordinator> {
    const coordinator = new JointCoordinator(host);
    try {
      for (const name of (await readdir(host.dir)).filter((file) => /^J-\d{4,}\.json$/.test(file)).sort()) {
        try {
          const parsed = jointProjectSchema.safeParse(JSON.parse(await readFile(path.join(host.dir, name), "utf8")));
          if (parsed.success) coordinator.joints.push(parsed.data);
        } catch {
          // Arquivo quebrado: ignorado (o resto continua).
        }
      }
    } catch {
      // Sem pasta ainda: nenhum projeto conjunto.
    }
    return coordinator;
  }

  // ---------- Leitura ----------

  list(): JointProject[] {
    return structuredClone(this.joints);
  }

  find(id: string): JointProject | undefined {
    const found = this.joints.find((joint) => joint.id === id.trim().toUpperCase());
    return found ? structuredClone(found) : undefined;
  }

  private runtimeOf(workspace: string): WorkspaceRuntime | undefined {
    return this.host.workspaces.find(workspace);
  }

  private nameOf(workspace: string): string {
    return this.host.workspaces.list().find((item) => item.id === workspace)?.name ?? workspace;
  }

  private viewOfPart(part: JointPart): SentRequestView | undefined {
    return part.projectId && part.status === "em-andamento" ? this.host.requests.peek(part.workspace, part.projectId, part.title) : undefined;
  }

  /** Como a tela vê: o estado de cada parte calculado agora, por código. */
  views(): JointView[] {
    return this.joints
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((joint) => this.viewOf(joint));
  }

  viewOf(joint: JointProject): JointView {
    const parts = joint.parts.map((part): JointPartView => {
      const live = this.viewOfPart(part);
      const state: JointPartState = part.status === "em-andamento" ? (live ? STATE_OF_REQUEST[live.state] : "enviado") : part.status === "concluida" ? "concluida" : part.status;
      const waitingFor = part.status === "esperando" || part.status === "bloqueada" ? part.dependsOn.filter((ref) => joint.parts.find((other) => other.ref === ref)?.status !== "concluida") : [];
      return {
        ref: part.ref,
        workspace: part.workspace,
        workspaceName: this.nameOf(part.workspace),
        title: part.title,
        dependsOn: [...part.dependsOn],
        state,
        ...(live?.stage ? { stage: live.stage } : {}),
        ...(live && live.tasksTotal > 0 ? { tasksDone: live.tasksDone, tasksTotal: live.tasksTotal, ...(live.unit ? { unit: live.unit } : {}) } : {}),
        waitingFor,
        ...(part.projectId ? { projectId: part.projectId } : {}),
        ...(part.blockedReason ? { blockedReason: part.blockedReason } : {}),
        ...(part.summary ? { summary: part.summary } : {}),
        ...(part.received ? { received: structuredClone(part.received) } : {}),
      };
    });
    return { id: joint.id, title: joint.title, status: joint.status, paused: joint.paused === true, createdAt: joint.createdAt, ...(joint.dueAt ? { dueAt: joint.dueAt } : {}), ...(joint.finishedAt ? { finishedAt: joint.finishedAt } : {}), parts };
  }

  /** O texto de `get_joint_status`: o conjunto inteiro ou a lista dos abertos (por código; ninguém acorda). */
  statusText(id?: string): string {
    if (id) {
      const joint = this.joints.find((candidate) => candidate.id === id.trim().toUpperCase());
      if (!joint) throw new Error(`No joint project "${id}". Use get_joint_status without arguments to list them.`);
      const view = this.viewOf(joint);
      const lines = [`Joint project ${joint.id} "${joint.title}": ${view.status}${view.paused ? " (paused by the owner)" : ""}.${joint.dueAt ? ` Due ${joint.dueAt.slice(0, 10)}.` : ""}`];
      for (const part of view.parts) {
        const wait = part.waitingFor.length > 0 ? ` (waiting for part ${part.waitingFor.join(", ")})` : "";
        const stage = part.stage ? `, now: ${part.stage}` : "";
        const tasks = part.tasksTotal ? `, ${part.tasksDone}/${part.tasksTotal} ${part.unit === "modulos" ? "modules" : "tasks"}` : "";
        lines.push(`- ${part.ref} → ${part.workspace} "${shorten(part.title, 80)}": ${JOINT_PART_STATE_LABELS[part.state]}${wait}${stage}${tasks}${part.dependsOn.length > 0 ? `; depends on ${part.dependsOn.join(", ")}` : ""}${part.blockedReason ? `; ${part.blockedReason}` : ""}`);
        if (part.summary) lines.push(`    delivered: ${shorten(part.summary.replace(/\s+/g, " "), 400)}`);
        if (part.received) lines.push(`    received: ${part.received.items.map((item) => `${item.from}${item.media.length > 0 ? ` + ${item.media.map((media) => media.mediaId).join(",")}` : ""}`).join("; ")}`);
      }
      if (view.status === "travado") lines.push("Blocked: tell the owner which part failed and offer to cancel the joint project or redo the part from the Cyno page (the dependent parts stay paused until then).");
      return lines.join("\n");
    }
    if (this.joints.length === 0) return "There are no joint projects yet.";
    const open = this.joints.filter((joint) => !isClosed(joint)).length;
    return [`${this.joints.length} joint project(s), ${open} open:`, ...this.joints.slice().reverse().slice(0, 15).map((joint) => `- ${joint.id} "${shorten(joint.title, 80)}": ${joint.status} · ${joint.parts.filter((part) => part.status === "concluida").length}/${joint.parts.length} parts done`)].join("\n");
  }

  /** O que espera o dono por causa de um conjunto travado (aparece no "Esperando você"). */
  waitingItems(): WaitingItem[] {
    return this.joints.flatMap((joint) => {
      if (joint.status !== "travado" || joint.paused) return [];
      const failed = joint.parts.find((part) => part.status === "falhou" || part.status === "cancelada");
      if (!failed) return [];
      const what = failed.status === "falhou" ? "falhou" : "foi cancelada";
      return [
        {
          workspace: failed.workspace,
          workspaceName: this.nameOf(failed.workspace),
          id: joint.id,
          type: "conjunto",
          title: `Projeto conjunto “${shorten(joint.title, 60)}”: a parte ${failed.ref} (${shorten(failed.title, 50)}) ${what}. Refazer ou cancelar?`,
          at: failed.finishedAt ?? joint.createdAt,
          href: "#/cyno",
        },
      ];
    });
  }

  /** As linhas do que mudou nos conjuntos desde a última mensagem ao Cyno (esvazia a lista). */
  takeNotices(): string[] {
    return this.notices.splice(0);
  }

  /** Quantos conjuntos abertos envolvem o workspace (para a ficha). */
  openCount(workspace: string): number {
    return this.joints.filter((joint) => !isClosed(joint) && joint.parts.some((part) => part.workspace === workspace)).length;
  }

  // ---------- Criar ----------

  private nextId(): string {
    const max = this.joints.reduce((top, joint) => Math.max(top, Number(joint.id.slice(2)) || 0), 0);
    return `J-${String(max + 1).padStart(4, "0")}`;
  }

  /**
   * Monta o projeto conjunto: valida (sem ciclo, workspaces existem e têm Maestro de CLI), grava o registro,
   * abre as partes sem dependência como pedidos normais (cada Maestro acorda UMA vez) e as que dependem como
   * projetos pausados (ninguém acorda). Lança `Error` (em inglês, para o Cyno) com o motivo se algo não serve.
   */
  create(input: JointInput): { joint: JointProject; duplicate: boolean } {
    const now = this.host.now();
    const title = input.title.trim().replace(/\s+/g, " ");
    const same = this.joints.find((joint) => !isClosed(joint) && joint.title.trim().toLowerCase() === title.toLowerCase() && now.getTime() - Date.parse(joint.createdAt) < DUPLICATE_WINDOW_MS);
    if (same) return { joint: structuredClone(same), duplicate: true };
    if (input.parts.length < 2) throw new Error("A joint project needs at least 2 parts in different workspaces. For one workspace use send_request.");
    if (input.parts.length > JOINT_LIMITS.parts) throw new Error(`At most ${JOINT_LIMITS.parts} parts per joint project.`);
    const dueAt = input.dueAt ? isoFromInput(input.dueAt) : undefined;
    if (input.dueAt && !dueAt) throw new Error(`due_at "${input.dueAt}" is not a valid date (use ISO 8601)`);
    const list = this.host.workspaces.list().map((ws) => ({ id: ws.id, name: ws.name }));
    const refs = input.parts.map((_, index) => `P${index + 1}`);
    const parts: JointPart[] = input.parts.map((raw, index) => {
      const found = findByRef(list, raw.workspace);
      const runtime = found ? this.runtimeOf(found.id) : undefined;
      if (!found || !runtime) throw new Error(`Part ${refs[index]}: no workspace "${raw.workspace}". Use list_workspaces.`);
      if (!runtime.cliMaestro.enabled() || !findMaestroAgent(runtime.store.snapshot())) throw new Error(`Part ${refs[index]}: the Maestro of ${found.name} does not run on a CLI engine, so it cannot receive requests.`);
      const dependsOn = [...new Set((raw.dependsOn ?? []).map((ref) => ref.trim().toUpperCase()))];
      for (const ref of dependsOn) {
        if (!refs.includes(ref)) throw new Error(`Part ${refs[index]} depends on "${ref}", which is not one of the parts (${refs.join(", ")}).`);
        if (ref === refs[index]) throw new Error(`Part ${refs[index]} cannot depend on itself.`);
      }
      const partDue = raw.dueAt ? isoFromInput(raw.dueAt) : undefined;
      if (raw.dueAt && !partDue) throw new Error(`Part ${refs[index]}: due_at "${raw.dueAt}" is not a valid date (use ISO 8601)`);
      return {
        ref: refs[index]!,
        workspace: found.id,
        title: raw.title.trim().replace(/\s+/g, " ").slice(0, 200),
        briefing: raw.brief.trim().slice(0, JOINT_LIMITS.briefChars),
        dependsOn,
        ...(raw.expects ? { expects: raw.expects.trim().slice(0, 500) } : {}),
        ...(raw.doneWhen?.length ? { doneWhen: raw.doneWhen.slice(0, 10) } : {}),
        ...(partDue ? { dueAt: partDue } : {}),
        status: "esperando" as const,
        deliverables: [],
      };
    });
    if (new Set(parts.map((part) => part.workspace)).size < 2) throw new Error("A joint project needs parts in at least 2 different workspaces. For one workspace use send_request.");
    const cycle = findCycle(parts);
    if (cycle) throw new Error(`The dependencies form a cycle (${cycle.join(" → ")}). Fix depends_on.`);
    if (!parts.some((part) => part.dependsOn.length === 0)) throw new Error("At least one part must have no dependencies (the one that starts).");

    const joint: JointProject = { id: this.nextId(), title: title.slice(0, 200), brief: (input.brief ?? "").trim().slice(0, JOINT_LIMITS.briefChars), status: "ativo", parts, createdAt: now.toISOString(), ...(dueAt ? { dueAt } : {}) };
    this.joints.push(joint);
    // Quem não depende de ninguém começa já (um pedido normal ao Maestro); quem depende espera num projeto pausado.
    for (const part of joint.parts) {
      const runtime = this.runtimeOf(part.workspace)!;
      if (part.dependsOn.length === 0) this.send(joint, part);
      else part.placeholderId = runtime.plans.openJointPlaceholder({ title: part.title, brief: part.briefing, joint: { id: joint.id, part: part.ref, dependsOn: part.dependsOn }, ...(part.dueAt ? { dueAt: part.dueAt } : {}), ...(part.doneWhen?.length ? { doneWhen: part.doneWhen } : {}) }).id;
    }
    this.finish(joint, "criado");
    this.host.chat({ kind: "status", status: "started", message: jointMarker(joint.id, joint.title) });
    this.host.log.info({ joint: joint.id, parts: joint.parts.length }, "projeto conjunto criado");
    activity({ category: "plano", action: "conjunto_criado", actor: "cyno", summary: `Projeto conjunto “${shorten(joint.title, 80)}” com ${joint.parts.length} partes (${[...new Set(joint.parts.map((part) => this.nameOf(part.workspace)))].join(", ")})`, data: { joint: joint.id } });
    return { joint: structuredClone(joint), duplicate: false };
  }

  /** O que cada parte vê ao abrir: o conjunto, as outras partes, o que ela deve entregar e o que recebeu. */
  private briefingOf(joint: JointProject, part: JointPart): string {
    const lines = joint.parts.map((other) => {
      const state = other.status === "concluida" ? " (concluída)" : "";
      const dep = other.dependsOn.length > 0 ? `, depois de ${other.dependsOn.join(" e ")}` : "";
      return `- ${other.ref} · ${this.nameOf(other.workspace)}: ${other.title}${dep}${state}${other.ref === part.ref ? "  ← ESTA PARTE" : ""}`;
    });
    const next = joint.parts.filter((other) => other.dependsOn.includes(part.ref));
    const received = part.received?.items ?? [];
    return [
      part.briefing,
      "",
      `## Projeto conjunto: “${joint.title}” (${joint.id})`,
      `Este pedido é a parte ${part.ref} de um projeto que envolve mais de um workspace. Faça SÓ a sua parte; o servidor leva o resultado dela para quem depende. Não fale com os outros workspaces (o Cyno cuida disso).`,
      ...(joint.brief ? ["", "Contexto geral:", joint.brief] : []),
      "",
      "As partes:",
      ...lines,
      ...(part.expects ? ["", `O que se espera desta parte: ${part.expects}`] : []),
      ...(received.length > 0
        ? [
            "",
            "## O que chegou da parte anterior",
            ...received.flatMap((item) => [
              `De ${item.from} (${this.nameOf(item.workspace)}): ${item.summary ? shorten(item.summary.replace(/\s+/g, " "), 1200) : "(sem resumo)"}`,
              ...(item.media.length > 0 ? [`Mídias já copiadas para a biblioteca DESTE workspace (media_list): ${item.media.map((media) => `${media.mediaId} “${media.title}”`).join("; ")}. Use-as (por exemplo, anexe com request_approval mediaIds).`] : []),
            ]),
          ]
        : []),
      ...(next.length > 0 ? ["", `## Entrega\nQuando você concluir, o servidor leva para a parte ${next.map((other) => `${other.ref} (${this.nameOf(other.workspace)})`).join(", ")} o resumo da sua resposta final e as mídias da biblioteca deste workspace ligadas a este pedido. Salve o entregável na biblioteca de mídia (media_render_html ou media_save_file) e diga na resposta final o que foi entregue.`] : []),
    ].join("\n");
  }

  /** Abre o pedido de uma parte no workspace dela (o Maestro acorda uma vez). Lança se o Cyno-requests recusar. */
  private send(joint: JointProject, part: JointPart): void {
    const runtime = this.runtimeOf(part.workspace);
    const placeholder = part.placeholderId;
    if (placeholder) {
      runtime?.plans.dropJointPlaceholder(placeholder);
      delete part.placeholderId;
    }
    try {
      const sent = this.host.requests.sendRequest({
        workspace: part.workspace,
        title: part.title,
        brief: this.briefingOf(joint, part),
        ...(part.doneWhen?.length ? { doneWhen: part.doneWhen } : {}),
        ...(part.dueAt ?? joint.dueAt ? { dueAt: (part.dueAt ?? joint.dueAt)! } : {}),
        joint: { id: joint.id, part: part.ref, dependsOn: [...part.dependsOn] },
      });
      part.projectId = sent.projectId;
      part.status = "em-andamento";
      part.startedAt = this.host.now().toISOString();
      delete part.blockedReason;
      delete part.finishedAt;
    } catch (error) {
      part.status = "falhou";
      part.blockedReason = `Não conseguiu começar: ${errorMessage(error)}`.slice(0, 400);
      part.finishedAt = this.host.now().toISOString();
      this.host.log.warn({ joint: joint.id, part: part.ref, err: error }, "não foi possível abrir a parte do projeto conjunto");
    }
  }

  // ---------- Andamento (por código) ----------

  /** Confere todos os conjuntos abertos: partes que terminaram, partes a liberar, partes bloqueadas. */
  refresh(): void {
    if (this.closed) return;
    for (const joint of this.joints) if (!isClosed(joint)) void this.advance(joint);
    this.emitIfChanged();
  }

  private async advance(joint: JointProject): Promise<void> {
    if (this.busy.has(joint.id)) {
      this.again.add(joint.id);
      return;
    }
    this.busy.add(joint.id);
    try {
      do {
        this.again.delete(joint.id);
        await this.step(joint);
      } while (this.again.has(joint.id) && !this.closed);
    } catch (error) {
      this.host.log.error({ joint: joint.id, err: error }, "falha ao conferir o projeto conjunto");
    } finally {
      this.busy.delete(joint.id);
      this.emitIfChanged();
    }
  }

  private async step(joint: JointProject): Promise<void> {
    if (isClosed(joint)) return;
    const before = JSON.stringify(joint);
    const at = this.host.now().toISOString();
    const events: string[] = [];
    // 1) Partes em andamento que terminaram.
    for (const part of joint.parts) {
      if (part.status !== "em-andamento" || !part.projectId) continue;
      const view = this.host.requests.peek(part.workspace, part.projectId, part.title);
      if (!view) {
        part.status = "cancelada";
        part.blockedReason = "O workspace desta parte não existe mais.";
        part.finishedAt = at;
        events.push(`a parte ${part.ref} (${part.title}) perdeu o workspace`);
        continue;
      }
      if (view.state === "concluido") {
        const delivered = this.host.requests.deliveries(part.workspace, part.projectId);
        part.status = "concluida";
        part.finishedAt = at;
        if (delivered?.summary) part.summary = delivered.summary.slice(0, JOINT_LIMITS.summaryChars);
        part.deliverables = (delivered?.media ?? []).slice(0, JOINT_LIMITS.mediaPerPart).map((media) => media.id);
        this.host.chat({ kind: "status", status: "resumed", message: `Projeto conjunto “${shorten(joint.title, 70)}”: a parte ${part.ref} (${this.nameOf(part.workspace)}) terminou` });
        this.notices.push(`joint ${joint.id} "${shorten(joint.title, 60)}": part ${part.ref} (${part.workspace}) is DONE${part.deliverables.length > 0 ? ` with ${part.deliverables.length} media` : ""}`);
      } else if (view.state === "falhou" || view.state === "cancelado") {
        part.status = view.state === "falhou" ? "falhou" : "cancelada";
        part.finishedAt = at;
        const delivered = this.host.requests.deliveries(part.workspace, part.projectId);
        part.blockedReason = shorten(`O pedido ${view.state === "falhou" ? "falhou" : "foi cancelado"}${delivered?.summary ? `: ${delivered.summary.replace(/\s+/g, " ")}` : ""}`, 400);
        events.push(`a parte ${part.ref} (${this.nameOf(part.workspace)}) ${view.state === "falhou" ? "falhou" : "foi cancelada"}`);
      }
    }
    // 2) Partes que esperam e já podem começar (o conjunto pausado não libera nada).
    if (!joint.paused) {
      for (const part of joint.parts) {
        if (part.status !== "esperando") continue;
        const deps = part.dependsOn.map((ref) => joint.parts.find((other) => other.ref === ref)!);
        if (!deps.every((dep) => dep.status === "concluida")) continue;
        await this.release(joint, part, deps);
        const now = part.status as JointPart["status"];
        if (now === "em-andamento") {
          this.host.chat({ kind: "status", status: "resumed", message: `Projeto conjunto “${shorten(joint.title, 70)}”: a parte ${part.ref} (${this.nameOf(part.workspace)}) foi liberada com a entrega de ${part.dependsOn.join(" e ")}` });
          this.notices.push(`joint ${joint.id} "${shorten(joint.title, 60)}": part ${part.ref} (${part.workspace}) was RELEASED with the output of ${part.dependsOn.join(", ")}`);
        } else if (now === "falhou") events.push(`a parte ${part.ref} (${this.nameOf(part.workspace)}) não conseguiu começar`);
      }
    }
    // 3) Quem depende de uma parte que falhou fica bloqueado, com o motivo.
    for (const part of joint.parts) {
      if (part.status !== "esperando") continue;
      const bad = part.dependsOn.map((ref) => joint.parts.find((other) => other.ref === ref)!).find((dep) => FAILED.has(dep.status));
      if (!bad) continue;
      part.status = "bloqueada";
      part.blockedReason = `Espera a parte ${bad.ref}, que ${bad.status === "falhou" ? "falhou" : bad.status === "cancelada" ? "foi cancelada" : "está bloqueada"}.`;
    }
    // 4) O estado do conjunto.
    const failed = joint.parts.some((part) => FAILED.has(part.status));
    const done = joint.parts.every((part) => part.status === "concluida");
    const status: JointProject["status"] = done ? "concluido" : failed ? "travado" : "ativo";
    if (status !== joint.status) {
      joint.status = status;
      if (status === "concluido") {
        joint.finishedAt = at;
        this.host.chat({ kind: "status", status: "resumed", message: `Projeto conjunto “${shorten(joint.title, 70)}” concluído: todas as partes terminaram` });
        this.notices.push(`joint ${joint.id} "${shorten(joint.title, 60)}" is DONE (all ${joint.parts.length} parts)`);
        activity({ category: "plano", action: "conjunto_concluido", actor: "cyno", summary: `Projeto conjunto “${shorten(joint.title, 80)}” concluído`, data: { joint: joint.id } });
      } else if (status === "travado") {
        this.host.chat({ kind: "status", status: "failed", message: `Projeto conjunto “${shorten(joint.title, 70)}” travou: ${events.join("; ") || "uma parte falhou"}. As partes que dependem dela ficam bloqueadas até você refazer ou cancelar` });
        this.notices.push(`joint ${joint.id} "${shorten(joint.title, 60)}" is BLOCKED: ${events.join("; ") || "a part failed"}; the owner was warned and decides (redo or cancel)`);
        activity({ category: "plano", action: "conjunto_travado", actor: "cyno", summary: `Projeto conjunto “${shorten(joint.title, 80)}” travou: ${events.join("; ") || "uma parte falhou"}`, data: { joint: joint.id } });
      }
    }
    if (JSON.stringify(joint) !== before) this.persist(joint);
  }

  /**
   * Libera uma parte: copia as mídias das partes anteriores para a biblioteca do workspace dela, guarda o que
   * recebeu (uma vez só: se o servidor reiniciar no meio, não copia de novo) e abre o pedido de verdade.
   */
  private async release(joint: JointProject, part: JointPart, deps: JointPart[]): Promise<void> {
    const target = this.runtimeOf(part.workspace);
    if (!target) {
      part.status = "falhou";
      part.blockedReason = "O workspace desta parte não existe mais.";
      part.finishedAt = this.host.now().toISOString();
      return;
    }
    if (!part.received) {
      const items: JointReceived["items"] = [];
      for (const dep of deps) {
        const source = this.runtimeOf(dep.workspace);
        const media: { mediaId: string; title: string }[] = [];
        for (const mediaId of dep.deliverables.slice(0, JOINT_LIMITS.mediaPerPart)) {
          const item = source?.media.find(mediaId);
          if (!source || !item) continue;
          try {
            const copy = await target.media.copyFrom(source.media.fileOf(item), item.mime, {
              title: item.title,
              createdBy: "cyno",
              origin: "mural",
              fileName: item.fileName,
              note: `Da parte ${dep.ref} (${this.nameOf(dep.workspace)}) do projeto conjunto ${joint.id}`,
            });
            media.push({ mediaId: copy.id, title: copy.title });
          } catch (error) {
            this.host.log.warn({ joint: joint.id, part: part.ref, media: mediaId, err: error }, "não foi possível copiar a mídia da parte anterior");
          }
        }
        items.push({ from: dep.ref, workspace: dep.workspace, summary: dep.summary ?? "", media });
      }
      part.received = { at: this.host.now().toISOString(), items };
      // Grava o que já foi copiado ANTES de abrir o pedido: um reinício agora não copia as mídias outra vez.
      this.persist(joint);
    }
    this.send(joint, part);
  }

  // ---------- Ações do dono (e do Cyno) ----------

  /** Cancela o conjunto: as partes em andamento são canceladas e as que esperam fecham, com o motivo. */
  async cancel(id: string, reason: string): Promise<JointProject> {
    const joint = this.joints.find((candidate) => candidate.id === id.trim().toUpperCase());
    if (!joint) throw new HttpError(404, `Projeto conjunto "${id}" não encontrado`);
    if (isClosed(joint)) throw new HttpError(409, `O projeto conjunto já está ${joint.status}`);
    const why = reason.trim() || "Cancelado";
    const at = this.host.now().toISOString();
    for (const part of joint.parts) {
      if (part.status === "concluida" || part.status === "cancelada") continue;
      if (part.status === "em-andamento" && part.projectId) {
        try {
          await this.host.requests.cancelRequest(part.projectId, `Projeto conjunto ${joint.id} cancelado: ${why}`);
        } catch {
          // Já tinha fechado: fica como está.
        }
      }
      if (part.placeholderId) {
        this.runtimeOf(part.workspace)?.plans.cancelJointPlaceholder(part.placeholderId, `Projeto conjunto cancelado: ${why}`);
      }
      part.status = "cancelada";
      part.finishedAt = at;
      part.blockedReason = shorten(`Projeto conjunto cancelado: ${why}`, 400);
    }
    joint.status = "cancelado";
    joint.finishedAt = at;
    this.persist(joint);
    this.host.chat({ kind: "status", status: "resumed", message: `Projeto conjunto “${shorten(joint.title, 70)}” cancelado` });
    this.notices.push(`joint ${joint.id} "${shorten(joint.title, 60)}" was CANCELLED (${shorten(why, 80)})`);
    activity({ category: "plano", action: "conjunto_cancelado", actor: "dono", summary: `Projeto conjunto “${shorten(joint.title, 80)}” cancelado`, data: { joint: joint.id } });
    this.emitIfChanged();
    return structuredClone(joint);
  }

  /** Pausa (ou retoma) o conjunto: as partes em andamento pausam e nenhuma parte nova é liberada enquanto durar. */
  async setPaused(id: string, paused: boolean): Promise<JointProject> {
    const joint = this.joints.find((candidate) => candidate.id === id.trim().toUpperCase());
    if (!joint) throw new HttpError(404, `Projeto conjunto "${id}" não encontrado`);
    if (isClosed(joint)) throw new HttpError(409, `O projeto conjunto já está ${joint.status}`);
    if ((joint.paused === true) === paused) return structuredClone(joint);
    if (paused) joint.paused = true;
    else delete joint.paused;
    for (const part of joint.parts) {
      if (part.status !== "em-andamento" || !part.projectId) continue;
      try {
        await this.host.requests.updateRequest(part.projectId, { paused });
      } catch {
        // Projeto ainda sem plano aprovado ou já fechado: segue sem pausar essa parte.
      }
    }
    this.persist(joint);
    this.host.chat({ kind: "status", status: "resumed", message: `Projeto conjunto “${shorten(joint.title, 70)}” ${paused ? "pausado" : "retomado"}` });
    if (!paused) this.refresh();
    this.emitIfChanged();
    return structuredClone(joint);
  }

  /** Refaz uma parte que falhou ou foi cancelada: um pedido novo, e as bloqueadas por ela voltam a esperar. */
  async retry(id: string, ref: string): Promise<JointProject> {
    const joint = this.joints.find((candidate) => candidate.id === id.trim().toUpperCase());
    if (!joint) throw new HttpError(404, `Projeto conjunto "${id}" não encontrado`);
    if (isClosed(joint)) throw new HttpError(409, `O projeto conjunto já está ${joint.status}`);
    const part = joint.parts.find((candidate) => candidate.ref === ref.trim().toUpperCase());
    if (!part) throw new HttpError(404, `Parte "${ref}" não encontrada`);
    if (part.status !== "falhou" && part.status !== "cancelada") throw new HttpError(409, "Só uma parte que falhou ou foi cancelada pode ser refeita");
    const deps = part.dependsOn.map((dep) => joint.parts.find((other) => other.ref === dep)!);
    if (!deps.every((dep) => dep.status === "concluida")) throw new HttpError(409, "A parte depende de outra que ainda não terminou: refaça a anterior primeiro");
    delete part.finishedAt;
    delete part.blockedReason;
    delete part.summary;
    part.deliverables = [];
    part.status = "esperando";
    for (const other of joint.parts) {
      if (other.status === "bloqueada" && other.dependsOn.includes(part.ref)) {
        other.status = "esperando";
        delete other.blockedReason;
      }
    }
    joint.status = "ativo";
    // Reabre agora pelo caminho de sempre (copia o que falta e abre o pedido).
    await this.release(joint, part, deps);
    this.persist(joint);
    this.host.chat({ kind: "status", status: "resumed", message: `Projeto conjunto “${shorten(joint.title, 70)}”: a parte ${part.ref} (${this.nameOf(part.workspace)}) foi refeita` });
    this.refresh();
    this.emitIfChanged();
    return structuredClone(joint);
  }

  // ---------- Internos ----------

  /** Grava o registro e publica a lista (a primeira gravação depois de criar). */
  private finish(joint: JointProject, _why: string): void {
    this.persist(joint);
    this.emitIfChanged();
  }

  private persist(joint: JointProject): void {
    const snapshot = structuredClone(joint);
    this.host.queue
      .enqueue(async () => {
        await mkdir(this.host.dir, { recursive: true });
        await writeJsonAtomic(path.join(this.host.dir, `${snapshot.id}.json`), snapshot);
      })
      .catch((error: unknown) => this.host.log.error({ err: error, joint: snapshot.id }, "falha ao gravar o projeto conjunto"));
  }

  private emitIfChanged(): void {
    if (this.closed) return;
    const joints = this.views();
    const key = JSON.stringify(joints);
    if (key === this.lastEmitted) return;
    this.lastEmitted = key;
    this.host.emit({ type: "cyno:joints", joints });
  }

  /** Espera as conferências em andamento (e as gravações pedidas). */
  async idle(): Promise<void> {
    while (this.busy.size > 0) await new Promise((resolve) => setTimeout(resolve, 5));
    await this.host.queue.idle();
  }

  close(): void {
    this.closed = true;
  }
}

/** Um ciclo nas dependências (devolve o caminho), se houver. */
function findCycle(parts: { ref: string; dependsOn: string[] }[]): string[] | undefined {
  const byRef = new Map(parts.map((part) => [part.ref, part]));
  const state = new Map<string, "visiting" | "done">();
  const walk = (ref: string, trail: string[]): string[] | undefined => {
    if (state.get(ref) === "done") return undefined;
    if (state.get(ref) === "visiting") return [...trail.slice(trail.indexOf(ref)), ref];
    state.set(ref, "visiting");
    for (const dep of byRef.get(ref)?.dependsOn ?? []) {
      const found = walk(dep, [...trail, ref]);
      if (found) return found;
    }
    state.set(ref, "done");
    return undefined;
  };
  for (const part of parts) {
    const found = walk(part.ref, []);
    if (found) return found;
  }
  return undefined;
}
