import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseJointMarker, type AgentLogBody, type CynoServerEvent, type JointView, type SentRequestView } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { useTestApp } from "../../dev/test-app";
import { writeAuthFile } from "../auth/store";
import { createWorkspace } from "../../dev/test-api";
import { useTempDirs } from "../../dev/test-utils";
import type { SendRequestInput } from "../../mcp/cyno/request-tools";
import { WriteQueue } from "../../store/write-queue";
import { fakePng } from "../../workspace/media/test-files";
import { JointCoordinator, type JointInput } from "./joint-coordinator";

const setupApp = useTestApp();
const tempDir = useTempDirs();
const queues: WriteQueue[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.idle()));
});

type Sent = { id: string; workspace: string; title: string; brief: string; joint?: SendRequestInput["joint"] };

/**
 * O coordenador com workspaces de verdade (Design, Posts, Redes) e um `CynoRequests` falso: o teste decide
 * em que estado cada pedido está (`state`), o que entregou (`summary`, mídias na biblioteca) e vê quem foi
 * "acordado" (`sent`). Nenhuma CLI sobe.
 */
async function setup(options: { dir?: string; app?: Awaited<ReturnType<typeof setupApp>> } = {}) {
  const test = options.app ?? (await setupApp());
  if (!options.app) {
    for (const name of ["Design", "Posts", "Redes"]) await createWorkspace(test.app, name);
    for (const id of ["design", "posts", "redes"]) {
      const response = await test.app.inject({ method: "PATCH", url: `/api/w/${id}/agents/maestro`, payload: { engine: "claude" } });
      expect(response.statusCode, id).toBe(200);
    }
  }
  const dir = options.dir ?? path.join(await tempDir(), "joint");
  const queue = new WriteQueue();
  queues.push(queue);
  const sent: Sent[] = [];
  const states = new Map<string, SentRequestView["state"]>();
  const summaries = new Map<string, string>();
  const cancelled: string[] = [];
  const chat: AgentLogBody[] = [];
  const events: CynoServerEvent[] = [];
  let counter = 0;
  const names: Record<string, string> = { design: "Design", posts: "Posts", redes: "Redes" };
  const requests = {
    sendRequest: (input: SendRequestInput) => {
      const id = `req-${++counter}`;
      sent.push({ id, workspace: input.workspace, title: input.title, brief: input.brief, ...(input.joint ? { joint: input.joint } : {}) });
      states.set(id, "andando");
      return { projectId: id, workspace: input.workspace, workspaceName: names[input.workspace] ?? input.workspace, address: `${input.workspace}/maestro`, duplicate: false };
    },
    peek: (workspace: string, projectId: string, title: string): SentRequestView => ({ projectId, workspace, workspaceName: names[workspace] ?? workspace, title, address: "", sentAt: "2026-11-11T12:00:00.000Z", state: states.get(projectId) ?? "andando", tasksDone: 0, tasksTotal: 0, waitingForYou: 0 }),
    deliveries: (workspace: string, projectId: string) => ({ summary: summaries.get(projectId) ?? "", media: test.workspaces.get(workspace).media.list({ taskId: projectId }).filter((item) => item.status !== "descartado") }),
    cancelRequest: async (projectId: string) => {
      cancelled.push(projectId);
      states.set(projectId, "cancelado");
      return "cancelled";
    },
    updateRequest: async () => "ok",
  };
  const open = () =>
    JointCoordinator.open({
      workspaces: test.workspaces,
      requests,
      dir,
      queue,
      now: () => new Date("2026-11-11T12:00:00.000Z"),
      log: test.app.log,
      chat: (body) => chat.push(body),
      emit: (event) => events.push(event),
    });
  const coordinator = await open();
  const finish = async (id: string, state: SentRequestView["state"], summary = "") => {
    states.set(id, state);
    if (summary) summaries.set(id, summary);
  };
  /** Cria uma mídia na biblioteca do workspace ligada ao pedido (o que `deliveries` entrega). */
  const makeMedia = (workspace: string, projectId: string, title: string, status: "rascunho" | "descartado" = "rascunho") =>
    test.workspaces
      .get(workspace)
      .media.addBuffer(fakePng(1200, 627), "image/png", { title, createdBy: "ana", origin: "html", taskId: projectId, rootTaskId: projectId })
      .then((item) => (status === "descartado" ? test.workspaces.get(workspace).media.update(item.id, { status: "descartado" }) : item));
  const tick = async (current: JointCoordinator = coordinator) => {
    current.refresh();
    await current.idle();
  };
  return { ...test, coordinator, dir, queue, sent, states, cancelled, chat, events, finish, makeMedia, tick, open, names };
}

const part = (workspace: string, title: string, extra: Partial<JointInput["parts"][number]> = {}): JointInput["parts"][number] => ({ workspace, title, brief: `Briefing completo de ${title}: fazer a parte direito, com cuidado e no tom do dono.`, ...extra });
const view = (ctx: { coordinator: JointCoordinator }, id = "J-0001"): JointView => ctx.coordinator.views().find((joint) => joint.id === id)!;
const plans = (ctx: Awaited<ReturnType<typeof setup>>, workspace: string) => ctx.workspaces.get(workspace).plans.list();

describe("JointCoordinator: validação", () => {
  it("recusa menos de 2 partes, um workspace só, workspace desconhecido, dependência inexistente e ciclo", async () => {
    const ctx = await setup();
    const create = (input: JointInput) => () => ctx.coordinator.create(input);
    expect(create({ title: "Um só", parts: [part("design", "A")] })).toThrow(/at least 2 parts/);
    expect(create({ title: "Mesmo workspace", parts: [part("design", "A"), part("design", "B", { dependsOn: ["P1"] })] })).toThrow(/at least 2 different workspaces/);
    expect(create({ title: "Sem workspace", parts: [part("design", "A"), part("nada", "B")] })).toThrow(/no workspace "nada"/);
    expect(create({ title: "Dep ruim", parts: [part("design", "A"), part("posts", "B", { dependsOn: ["P7"] })] })).toThrow(/not one of the parts/);
    expect(create({ title: "Ciclo", parts: [part("design", "A", { dependsOn: ["P2"] }), part("posts", "B", { dependsOn: ["P1"] })] })).toThrow(/cycle/);
    expect(create({ title: "Ninguém começa", parts: [part("design", "A", { dependsOn: ["P3"] }), part("posts", "B", { dependsOn: ["P1"] }), part("redes", "C", { dependsOn: ["P2"] })] })).toThrow(/cycle|without|no dependencies/);
    expect(ctx.sent).toHaveLength(0);
    expect(plans(ctx, "posts").filter((project) => project.joint)).toHaveLength(0);
  });

  it("o mesmo título ainda aberto não cria outro conjunto", async () => {
    const ctx = await setup();
    const first = ctx.coordinator.create({ title: "Post com arte", parts: [part("design", "Arte"), part("posts", "Texto", { dependsOn: ["P1"] })] });
    const second = ctx.coordinator.create({ title: "post com arte", parts: [part("design", "Arte"), part("posts", "Texto", { dependsOn: ["P1"] })] });
    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({ duplicate: true, joint: { id: first.joint.id } });
    expect(ctx.sent).toHaveLength(1);
  });
});

describe("JointCoordinator: sequência de 2 partes", () => {
  it("só a primeira acorda; a segunda espera num projeto pausado e é liberada com a mídia e o resumo da primeira", async () => {
    const ctx = await setup();
    const { joint } = ctx.coordinator.create({ title: "Post sobre café com arte", brief: "Tom leve.", parts: [part("design", "Arte do café", { expects: "uma imagem 1200x627" }), part("posts", "Texto do post", { dependsOn: ["P1"] })] });
    expect(joint).toMatchObject({ id: "J-0001", status: "ativo" });
    // Só o Design foi acordado, com o contexto do conjunto; o Posts tem só o marcador pausado.
    expect(ctx.sent.map((item) => [item.workspace, item.joint])).toEqual([["design", { id: "J-0001", part: "P1", dependsOn: [] }]]);
    expect(ctx.sent[0]!.brief).toContain("Projeto conjunto: “Post sobre café com arte” (J-0001)");
    expect(ctx.sent[0]!.brief).toContain("P2 · Posts: Texto do post, depois de P1");
    expect(ctx.sent[0]!.brief).toContain("Salve o entregável na biblioteca de mídia");
    const waiting = plans(ctx, "posts").filter((project) => project.joint);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ status: "pausado", origin: "cyno", tasks: [], joint: { id: "J-0001", part: "P2", dependsOn: ["P1"] } });
    expect(view(ctx).parts.map((item) => [item.ref, item.state, item.waitingFor])).toEqual([["P1", "andando", []], ["P2", "esperando", ["P1"]]]);
    // O chat ganha o cartão do conjunto (marca).
    expect(ctx.chat.some((body) => body.kind === "status" && parseJointMarker(body.message)?.jointId === "J-0001")).toBe(true);

    // Enquanto a primeira não conclui, conferir não libera nada.
    await ctx.tick();
    await ctx.tick();
    expect(ctx.sent).toHaveLength(1);

    // A primeira conclui, com uma imagem na biblioteca do Design (e uma descartada, que não vai).
    const art = await ctx.makeMedia("design", "req-1", "Arte do café");
    await ctx.makeMedia("design", "req-1", "Rascunho jogado fora", "descartado");
    await ctx.finish("req-1", "concluido", "Entreguei a arte do café, fundo creme.");
    await ctx.tick();

    expect(ctx.sent).toHaveLength(2);
    const second = ctx.sent[1]!;
    expect(second).toMatchObject({ workspace: "posts", joint: { id: "J-0001", part: "P2", dependsOn: ["P1"] } });
    expect(second.brief).toContain("O que chegou da parte anterior");
    expect(second.brief).toContain("Entreguei a arte do café, fundo creme.");
    // A mídia foi copiada para a biblioteca do Posts, com a origem registrada, e o briefing diz o id novo dela.
    const copies = ctx.workspaces.get("posts").media.list();
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ title: "Arte do café", origin: "mural", status: "rascunho", createdBy: "cyno" });
    expect(copies[0]!.note).toContain("Da parte P1 (Design) do projeto conjunto J-0001");
    expect(second.brief).toContain(`${copies[0]!.id} “Arte do café”`);
    expect(ctx.workspaces.get("design").media.find(art.id)).toBeDefined();
    // O marcador pausado sumiu (o projeto de verdade nasce com o pedido) e a parte guarda o que recebeu.
    expect(plans(ctx, "posts").filter((project) => project.status === "pausado" && project.tasks.length === 0 && project.joint)).toHaveLength(0);
    expect(view(ctx).parts[1]).toMatchObject({ state: "andando", received: { items: [{ from: "P1", media: [{ title: "Arte do café" }] }] } });

    // A segunda conclui: o conjunto termina.
    await ctx.finish("req-2", "concluido", "Post pronto.");
    await ctx.tick();
    expect(view(ctx)).toMatchObject({ status: "concluido" });
    expect(ctx.sent).toHaveLength(2);
    // Avisos passivos (uma vez cada) e nada além da mensagem aos dois Maestros.
    const notices = ctx.coordinator.takeNotices();
    expect(notices.join(" | ")).toContain("part P1 (design) is DONE with 1 media");
    expect(notices.join(" | ")).toContain("part P2 (posts) was RELEASED");
    expect(notices.join(" | ")).toContain("is DONE (all 2 parts)");
    expect(ctx.coordinator.takeNotices()).toEqual([]);
    // Estado persistido em data/platform/joint/J-0001.json.
    const saved = JSON.parse(await readFile(path.join(ctx.dir, "J-0001.json"), "utf8")) as { status: string; parts: { status: string }[] };
    expect(saved).toMatchObject({ status: "concluido", parts: [{ status: "concluida" }, { status: "concluida" }] });
  });
});

describe("JointCoordinator: 3 partes e partes em paralelo", () => {
  it("P1 → P2 → P3: cada parte só é liberada quando a anterior termina", async () => {
    const ctx = await setup();
    ctx.coordinator.create({ title: "Campanha", parts: [part("design", "Arte"), part("posts", "Texto", { dependsOn: ["P1"] }), part("redes", "Agenda", { dependsOn: ["P2"] })] });
    expect(ctx.sent.map((item) => item.workspace)).toEqual(["design"]);
    expect(plans(ctx, "posts").filter((project) => project.joint)).toHaveLength(1);
    expect(plans(ctx, "redes").filter((project) => project.joint)).toHaveLength(1);
    await ctx.finish("req-1", "concluido", "arte ok");
    await ctx.tick();
    expect(ctx.sent.map((item) => item.workspace)).toEqual(["design", "posts"]);
    // A terceira ainda espera (só a P2 libera).
    expect(view(ctx).parts.map((item) => item.state)).toEqual(["concluida", "andando", "esperando"]);
    await ctx.finish("req-2", "concluido", "texto ok");
    await ctx.tick();
    expect(ctx.sent.map((item) => item.workspace)).toEqual(["design", "posts", "redes"]);
    expect(ctx.sent[2]!.brief).toContain("texto ok");
    await ctx.finish("req-3", "concluido");
    await ctx.tick();
    expect(view(ctx).status).toBe("concluido");
  });

  it("partes em paralelo começam juntas e a que depende das duas só sai quando as duas terminam", async () => {
    const ctx = await setup();
    ctx.coordinator.create({ title: "Lançamento", parts: [part("design", "Arte"), part("posts", "Texto"), part("redes", "Publicar", { dependsOn: ["P1", "P2"] })] });
    expect(ctx.sent.map((item) => item.workspace).sort()).toEqual(["design", "posts"]);
    await ctx.finish("req-1", "concluido", "arte");
    await ctx.tick();
    expect(ctx.sent).toHaveLength(2);
    await ctx.finish("req-2", "concluido", "texto");
    await ctx.tick();
    expect(ctx.sent).toHaveLength(3);
    expect(ctx.sent[2]!).toMatchObject({ workspace: "redes" });
    expect(ctx.sent[2]!.brief).toContain("De P1 (Design): arte");
    expect(ctx.sent[2]!.brief).toContain("De P2 (Posts): texto");
  });
});

describe("JointCoordinator: falha e cancelamento no meio", () => {
  it("a primeira falha: a segunda fica bloqueada com o motivo, o conjunto trava, o dono é avisado e nada é liberado", async () => {
    const ctx = await setup();
    ctx.coordinator.create({ title: "Post com arte", parts: [part("design", "Arte"), part("posts", "Texto", { dependsOn: ["P1"] })] });
    await ctx.finish("req-1", "falhou", "Não consegui renderizar a imagem.");
    await ctx.tick();
    expect(ctx.sent).toHaveLength(1);
    const blocked = view(ctx);
    expect(blocked.status).toBe("travado");
    expect(blocked.parts.map((item) => item.state)).toEqual(["falhou", "bloqueada"]);
    expect(blocked.parts[1]!.blockedReason).toContain("Espera a parte P1, que falhou");
    expect(blocked.parts[0]!.blockedReason).toContain("Não consegui renderizar a imagem.");
    // O marcador pausado continua no Posts (a parte nunca começou).
    expect(plans(ctx, "posts").filter((project) => project.joint && project.status === "pausado")).toHaveLength(1);
    // O dono é avisado: no chat, no Esperando você e para o Cyno (uma vez).
    expect(ctx.chat.some((body) => body.kind === "status" && body.status === "failed" && body.message.includes("travou"))).toBe(true);
    const waiting = ctx.coordinator.waitingItems();
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ workspace: "design", id: "J-0001", type: "conjunto" });
    expect(waiting[0]!.title).toContain("a parte P1");
    expect(ctx.coordinator.takeNotices().join(" | ")).toContain("is BLOCKED");
    expect(ctx.coordinator.takeNotices()).toEqual([]);
    // Conferir de novo não repete o aviso nem libera nada.
    await ctx.tick();
    expect(ctx.coordinator.takeNotices()).toEqual([]);
    expect(ctx.sent).toHaveLength(1);
  });

  it("refazer a parte que falhou reabre o pedido e as bloqueadas voltam a esperar; depois tudo segue", async () => {
    const ctx = await setup();
    ctx.coordinator.create({ title: "Post com arte", parts: [part("design", "Arte"), part("posts", "Texto", { dependsOn: ["P1"] })] });
    await ctx.finish("req-1", "falhou", "erro");
    await ctx.tick();
    await ctx.coordinator.retry("J-0001", "P1");
    expect(ctx.sent.map((item) => item.workspace)).toEqual(["design", "design"]);
    expect(view(ctx)).toMatchObject({ status: "ativo", parts: [{ state: "andando" }, { state: "esperando" }] });
    expect(ctx.coordinator.waitingItems()).toEqual([]);
    await ctx.finish("req-2", "concluido", "agora foi");
    await ctx.tick();
    expect(ctx.sent.map((item) => item.workspace)).toEqual(["design", "design", "posts"]);
    // Refazer o que não falhou é recusado.
    await expect(ctx.coordinator.retry("J-0001", "P1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("a primeira é cancelada no meio de três: as duas seguintes ficam bloqueadas", async () => {
    const ctx = await setup();
    ctx.coordinator.create({ title: "Campanha", parts: [part("design", "Arte"), part("posts", "Texto", { dependsOn: ["P1"] }), part("redes", "Agenda", { dependsOn: ["P2"] })] });
    await ctx.finish("req-1", "cancelado");
    await ctx.tick();
    expect(view(ctx)).toMatchObject({ status: "travado" });
    expect(view(ctx).parts.map((item) => item.state)).toEqual(["cancelada", "bloqueada", "bloqueada"]);
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.coordinator.waitingItems()[0]!.title).toContain("foi cancelada");
  });

  it("falha no meio: a do meio falha depois de a primeira concluir, e a terceira trava", async () => {
    const ctx = await setup();
    ctx.coordinator.create({ title: "Campanha", parts: [part("design", "Arte"), part("posts", "Texto", { dependsOn: ["P1"] }), part("redes", "Agenda", { dependsOn: ["P2"] })] });
    await ctx.finish("req-1", "concluido", "arte");
    await ctx.tick();
    await ctx.finish("req-2", "falhou", "sem acesso");
    await ctx.tick();
    expect(view(ctx).parts.map((item) => item.state)).toEqual(["concluida", "falhou", "bloqueada"]);
    expect(ctx.sent.map((item) => item.workspace)).toEqual(["design", "posts"]);
  });

  it("cancelar o conjunto cancela quem está andando, fecha os marcadores e não deixa nada para liberar", async () => {
    const ctx = await setup();
    ctx.coordinator.create({ title: "Post com arte", parts: [part("design", "Arte"), part("posts", "Texto", { dependsOn: ["P1"] })] });
    await ctx.coordinator.cancel("J-0001", "o dono desistiu");
    expect(ctx.cancelled).toEqual(["req-1"]);
    expect(view(ctx)).toMatchObject({ status: "cancelado", parts: [{ state: "cancelada" }, { state: "cancelada" }] });
    expect(plans(ctx, "posts").filter((project) => project.joint).map((project) => project.status)).toEqual(["cancelado"]);
    // Mesmo que o pedido do Design "conclua" depois, nada é liberado.
    await ctx.finish("req-1", "concluido", "tarde demais");
    await ctx.tick();
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.coordinator.waitingItems()).toEqual([]);
    await expect(ctx.coordinator.cancel("J-0001", "de novo")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("pausar o conjunto segura a liberação da próxima parte até retomar", async () => {
    const ctx = await setup();
    ctx.coordinator.create({ title: "Post com arte", parts: [part("design", "Arte"), part("posts", "Texto", { dependsOn: ["P1"] })] });
    await ctx.coordinator.setPaused("J-0001", true);
    await ctx.finish("req-1", "concluido", "arte");
    await ctx.tick();
    expect(ctx.sent).toHaveLength(1);
    expect(view(ctx)).toMatchObject({ paused: true });
    await ctx.coordinator.setPaused("J-0001", false);
    await ctx.coordinator.idle();
    expect(ctx.sent).toHaveLength(2);
  });
});

describe("JointCoordinator: reinício do servidor no meio", () => {
  it("a parte liberada não é liberada duas vezes e as mídias não são copiadas outra vez", async () => {
    const ctx = await setup();
    ctx.coordinator.create({ title: "Post com arte", parts: [part("design", "Arte"), part("posts", "Texto", { dependsOn: ["P1"] })] });
    await ctx.makeMedia("design", "req-1", "Arte do café");
    // A primeira concluiu enquanto o servidor estava desligado: ninguém conferiu ainda.
    await ctx.finish("req-1", "concluido", "arte ok");
    await ctx.coordinator.idle();
    expect(ctx.sent).toHaveLength(1);

    // Reabre do disco (o servidor voltou) e confere: libera a segunda UMA vez.
    const reopened = await ctx.open();
    expect(reopened.list()[0]).toMatchObject({ id: "J-0001", parts: [{ status: "em-andamento" }, { status: "esperando" }] });
    await ctx.tick(reopened);
    expect(ctx.sent.map((item) => item.workspace)).toEqual(["design", "posts"]);
    expect(ctx.workspaces.get("posts").media.list()).toHaveLength(1);

    // Outro reinício e outra conferência: nada novo.
    const again = await ctx.open();
    await ctx.tick(again);
    await ctx.tick(again);
    expect(ctx.sent).toHaveLength(2);
    expect(ctx.workspaces.get("posts").media.list()).toHaveLength(1);
    expect(again.list()[0]!.parts[1]).toMatchObject({ status: "em-andamento", projectId: "req-2" });
  });

  it("um conjunto travado continua travado (e o aviso não repete) depois de reabrir", async () => {
    const ctx = await setup();
    ctx.coordinator.create({ title: "Post com arte", parts: [part("design", "Arte"), part("posts", "Texto", { dependsOn: ["P1"] })] });
    await ctx.finish("req-1", "falhou", "erro");
    await ctx.tick();
    ctx.coordinator.takeNotices();
    const reopened = await ctx.open();
    await ctx.tick(reopened);
    expect(reopened.takeNotices()).toEqual([]);
    expect(reopened.views()[0]).toMatchObject({ status: "travado" });
    expect(reopened.waitingItems()).toHaveLength(1);
  });
});

describe("JointCoordinator: leitura por código", () => {
  it("get_joint_status descreve as partes, quem espera quem e o que veio da anterior, sem acordar ninguém", async () => {
    const ctx = await setup();
    ctx.coordinator.create({ title: "Post com arte", parts: [part("design", "Arte"), part("posts", "Texto", { dependsOn: ["P1"] })] });
    const before = ctx.sent.length;
    const text = ctx.coordinator.statusText("J-0001");
    expect(text).toContain('Joint project J-0001 "Post com arte": ativo');
    expect(text).toContain("P1 → design");
    expect(text).toContain("P2 → posts");
    expect(text).toContain("waiting for part P1");
    expect(ctx.coordinator.statusText()).toContain("1 joint project(s), 1 open");
    expect(() => ctx.coordinator.statusText("J-0099")).toThrow(/No joint project/);
    expect(ctx.sent).toHaveLength(before);
  });

  it("a API do dono responde 404 para conjunto que não existe e fica atrás da senha", async () => {
    const test = await setupApp();
    const list = await test.app.inject({ method: "GET", url: "/api/cyno/joints" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ joints: [] });
    for (const [method, url] of [
      ["POST", "/api/cyno/joints/J-0099/cancel"],
      ["POST", "/api/cyno/joints/J-0099/pause"],
      ["POST", "/api/cyno/joints/J-0099/resume"],
      ["POST", "/api/cyno/joints/J-0099/parts/P1/retry"],
    ] as const) {
      expect((await test.app.inject({ method, url, payload: {} })).statusCode, url).toBe(404);
    }
    await writeAuthFile(test.dataDir, "senha-de-teste-1");
    for (const [method, url] of [
      ["GET", "/api/cyno/joints"],
      ["POST", "/api/cyno/joints/J-0001/cancel"],
      ["POST", "/api/cyno/joints/J-0001/pause"],
      ["POST", "/api/cyno/joints/J-0001/resume"],
      ["POST", "/api/cyno/joints/J-0001/parts/P1/retry"],
    ] as const) {
      expect((await test.app.inject({ method, url, payload: {} })).statusCode, url).toBe(401);
    }
  });
});

describe("ferramentas MCP de projeto conjunto", () => {
  it("só o Cyno tem send_joint_request, get_joint_status e cancel_joint_request (Maestros e agentes não)", async () => {
    const test = await setupApp();
    const cynoTools = test.app.cyno.tools().map((tool) => tool.name);
    for (const name of ["send_joint_request", "get_joint_status", "cancel_joint_request"]) expect(cynoTools).toContain(name);
    const office = test.workspaces.get("principal");
    for (const agent of ["maestro", "clara", "beto"]) {
      const names = office.officeTools(agent).map((tool) => tool.name);
      expect(names.filter((name) => name.includes("joint")), agent).toEqual([]);
    }
    // O esquema pede ao menos 2 partes e a ferramenta devolve o motivo como erro (o Cyno corrige).
    const tool = test.app.cyno.tools().find((candidate) => candidate.name === "send_joint_request")!;
    expect(tool.input.safeParse({ title: "Sem partes", parts: [] }).success).toBe(false);
    const refused = await tool.call(tool.input.parse({ title: "Só um workspace", parts: [{ workspace: "principal", title: "Parte A", brief: "x".repeat(60) }, { workspace: "principal", title: "Parte B", brief: "y".repeat(60), depends_on: ["P1"] }] }));
    expect(refused).toMatchObject({ isError: true });
  });
});
