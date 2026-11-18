import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { forYouOriginalText, RETENTION_PATH, type ForYouArchiveSummary, type ForYouItem, type ServerEvent } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, createTask, soloTeam, wsApi } from "../../dev/test-api";
import { EventLog, useTestApp, type TestApp } from "../../dev/test-app";
import { useTempDirs } from "../../dev/test-utils";
import { seedDataDir } from "../office/seed";
import { principalDir } from "../../dev/test-app";
import { OfficeStore } from "../../store/office-store";
import { dueForArchive } from "./service";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-01T12:00:00.000Z");
const setupApp = useTestApp();
const tempDir = useTempDirs();

/** Relógio do app que o teste move à mão. */
function clock(start = T0) {
  const state = { now: start };
  return { state, now: () => new Date(state.now) };
}

const ago = (days: number, from = T0) => new Date(from - days * DAY).toISOString();

function item(id: string, over: Partial<ForYouItem> = {}): ForYouItem {
  return { id, taskId: `t-${id.toLowerCase()}`, agentId: "a", roomId: "r", type: "outro", status: "aprovado", meta: {}, text: `texto ${id}`, editedByUser: false, createdAt: ago(12), decidedAt: ago(10), ...over };
}

const listItems = (setup: TestApp) => call<ForYouItem[]>(setup.app, "GET", `${wsApi()}/for-you`);
const decideItem = (setup: TestApp, id: string, body: object, status = 200) => call<ForYouItem>(setup.app, "POST", `${wsApi()}/for-you/${id}/decision`, body, status);

async function itemFor(log: EventLog, taskId: string): Promise<ForYouItem> {
  const event = await log.waitFor((e) => e.type === "foryou:upserted" && e.item.taskId === taskId);
  return (event as Extract<ServerEvent, { type: "foryou:upserted" }>).item;
}

async function waitingTask(setup: TestApp, prompt: string) {
  const { room, team } = await soloTeam(setup.app, "Solo");
  const task = await createTask(setup.app, room.id, team.id, prompt);
  await setup.log.waitForTask(task.id, "waiting_approval");
  return { task, item: await itemFor(setup.log, task.id), room, team };
}

const runtimeOf = (setup: TestApp) => setup.workspaces.get("principal")!;

describe("Arquivo do Para você: a varredura", () => {
  it("só arquiva o decidido há mais que o prazo; pendente nunca; lote só quando todos já podem", async () => {
    const time = clock();
    const setup = await setupApp({ now: time.now });
    const runtime = runtimeOf(setup);
    await runtime.store.commitForYou([
      item("A-0001"),
      item("A-0002", { status: "pendente", decidedAt: undefined, createdAt: ago(30) }),
      item("A-0003", { groupId: "G-1" }),
      item("A-0004", { groupId: "G-1", decidedAt: ago(2) }),
      item("A-0005", { groupId: "G-2" }),
      item("A-0006", { groupId: "G-2", status: "cancelado", cancelledBy: "usuario" }),
      item("A-0007", { decidedAt: ago(3) }),
      item("A-0008", { status: "rejeitado", decidedAt: ago(8) }),
    ]);
    const eventsBefore = setup.log.events.length;
    expect(await runtime.forYou.sweep()).toBe(4);
    expect(runtime.forYou.list().map((entry) => entry.id)).toEqual(["A-0002", "A-0003", "A-0004", "A-0007"]);
    const archived = runtime.forYou.archiveSummary();
    expect(archived).toEqual({ liveDays: 7, months: [{ month: "2026-10", count: 4 }] });
    expect((await runtime.forYou.archiveMonth("2026-10")).map((entry) => entry.id)).toEqual(["A-0001", "A-0005", "A-0006", "A-0008"]);
    const event = setup.log.events.slice(eventsBefore).find((entry) => entry.type === "foryou:archived");
    expect(event).toEqual({ type: "foryou:archived", ids: ["A-0001", "A-0005", "A-0006", "A-0008"] });
    // Gravou a lista viva sem eles (e o arquivo em disco, antes).
    await setup.store.flush();
    const live = JSON.parse(await readFile(path.join(setup.dir, "for-you", "2026-10.json"), "utf8")) as ForYouItem[];
    expect(live.map((entry) => entry.id)).toEqual(["A-0002", "A-0003", "A-0004", "A-0007"]);
    const file = JSON.parse(await readFile(path.join(setup.dir, "for-you", "archive", "2026-10.json"), "utf8")) as ForYouItem[];
    expect(file.map((entry) => entry.id)).toEqual(["A-0001", "A-0005", "A-0006", "A-0008"]);
    // Rodar de novo não acha mais nada (e o lote A-0003/A-0004 espera o último ficar velho).
    expect(await runtime.forYou.sweep()).toBe(0);
    time.state.now = T0 + 6 * DAY;
    expect(await runtime.forYou.sweep()).toBe(3);
    expect(runtime.forYou.list().map((entry) => entry.id)).toEqual(["A-0002"]);
  });

  it("prazo 0 = nunca arquivar; mudar o prazo na configuração varre na hora", async () => {
    const time = clock();
    const setup = await setupApp({ now: time.now });
    const runtime = runtimeOf(setup);
    await runtime.store.commitForYou([item("A-0001"), item("A-0002", { decidedAt: ago(20) })]);
    await call(setup.app, "PATCH", RETENTION_PATH, { approvalsLiveDays: 0 }, 200);
    expect(await runtime.forYou.sweep()).toBe(0);
    expect(await listItems(setup)).toHaveLength(2);
    expect(runtime.forYou.archiveSummary()).toEqual({ liveDays: 0, months: [] });
    // 14 dias: só o de 20 dias sai, pela mudança da configuração (sem chamar a varredura à mão).
    await call(setup.app, "PATCH", RETENTION_PATH, { approvalsLiveDays: 14 }, 200);
    await setup.log.waitFor((event) => event.type === "foryou:archived");
    expect((await listItems(setup)).map((entry) => entry.id)).toEqual(["A-0001"]);
    expect(runtime.forYou.archiveSummary().liveDays).toBe(14);
  });

  it("a aprovação de uma Meta no período atual e o cartão de sprint cancelado ficam na lista viva", () => {
    const now = T0;
    const list = [item("A-0001"), item("A-0002"), item("A-0003", { kind: "sprint", status: "cancelado" }), item("A-0004", { kind: "sprint" })];
    expect(dueForArchive(list, now, 7).map((entry) => entry.id)).toEqual(["A-0001", "A-0002", "A-0004"]);
    expect(dueForArchive(list, now, 7, (entry) => entry.id === "A-0002").map((entry) => entry.id)).toEqual(["A-0001", "A-0004"]);
    expect(dueForArchive(list, now, 0)).toEqual([]);
  });

  it("os cartões de regra e a aprovação individual mais recente de cada agente em convite e post ficam na lista viva", () => {
    const list = [
      item("A-0001", { kind: "regra" }),
      // Post do agente "a": duas individuais (fica a mais recente), uma em lote e uma do Automático (não seguram nada).
      item("A-0002", { type: "post", decidedAt: ago(30) }),
      item("A-0003", { type: "post", decidedAt: ago(20) }),
      item("A-0004", { type: "post", decidedAt: ago(9), viaBatch: true }),
      item("A-0005", { type: "post", decidedAt: ago(9), decidedBy: "automatico" }),
      // Convite de outro agente: a única individual fica.
      item("A-0006", { type: "convite", agentId: "b", decidedAt: ago(40) }),
      // Tipo sem guarda: sai normalmente.
      item("A-0007", { type: "comentario", decidedAt: ago(40) }),
    ];
    expect(dueForArchive(list, T0, 7).map((entry) => entry.id)).toEqual(["A-0002", "A-0004", "A-0005", "A-0007"]);
  });
});

describe("Arquivo do Para você: o fluxo pela API", () => {
  it("arquiva, lista pelas rotas, recusa mexer no arquivado (409) e nunca reusa o id", async () => {
    const time = clock();
    const setup = await setupApp({ now: time.now });
    const { task, item: first, room, team } = await waitingTask(setup, "Mensagem para a Rita [aprovar]");
    expect(first.id).toBe("A-0001");
    await decideItem(setup, first.id, { status: "aprovado" });
    await setup.log.waitForTask(task.id, "done");

    time.state.now = T0 + 8 * DAY;
    // Mudar o prazo (7 para 3) dispara a varredura em todos os workspaces carregados.
    await call(setup.app, "PATCH", RETENTION_PATH, { approvalsLiveDays: 3 }, 200);
    await setup.log.waitFor((event) => event.type === "foryou:archived");
    expect(await listItems(setup)).toEqual([]);

    expect(await call<ForYouArchiveSummary>(setup.app, "GET", `${wsApi()}/for-you/archive`)).toEqual({ liveDays: 3, months: [{ month: "2026-11", count: 1 }] });
    const month = await call<ForYouItem[]>(setup.app, "GET", `${wsApi()}/for-you/archive/2026-11`);
    expect(month.map((entry) => entry.id)).toEqual(["A-0001"]);
    expect(month[0]).toMatchObject({ status: "aprovado", taskId: task.id });
    expect(await call<ForYouItem[]>(setup.app, "GET", `${wsApi()}/for-you/archive/2026-05`)).toEqual([]);
    expect((await call<ForYouItem[]>(setup.app, "GET", `${wsApi()}/for-you/archive/find?taskId=${task.id}`)).map((entry) => entry.id)).toEqual(["A-0001"]);
    expect((await call<ForYouItem[]>(setup.app, "GET", `${wsApi()}/for-you/archive/find?id=A-0001`)).map((entry) => entry.id)).toEqual(["A-0001"]);
    expect(await call<ForYouItem[]>(setup.app, "GET", `${wsApi()}/for-you/archive/find?id=A-0099`)).toEqual([]);
    await call(setup.app, "GET", `${wsApi()}/for-you/archive/find`, undefined, 400);
    await call(setup.app, "GET", `${wsApi()}/for-you/archive/maio-de-2026`, undefined, 400);

    // Item arquivado: decidir, reabrir e cancelar dão 409 com mensagem clara (nunca 500).
    for (const response of [
      await setup.app.inject({ method: "POST", url: `${wsApi()}/for-you/A-0001/decision`, payload: { status: "rejeitado" } }),
      await setup.app.inject({ method: "POST", url: `${wsApi()}/for-you/A-0001/decision`, payload: { status: "pendente" } }),
      await setup.app.inject({ method: "POST", url: `${wsApi()}/for-you/A-0001/cancel`, payload: {} }),
    ]) {
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: string }>().error).toContain("arquivo");
    }
    expect((await setup.app.inject({ method: "POST", url: `${wsApi()}/for-you/A-0555/decision`, payload: { status: "aprovado" } })).statusCode).toBe(404);

    // A lista viva ficou vazia: o próximo id continua depois do arquivado.
    const second = await createTask(setup.app, room.id, team.id, "Qual o melhor horário? [aprovar]");
    await setup.log.waitForTask(second.id, "waiting_approval");
    expect((await itemFor(setup.log, second.id)).id).toBe("A-0002");
    await decideItem(setup, "A-0002", { status: "aprovado" });
    await setup.store.flush();
    const names = await readdir(path.join(setup.dir, "for-you"));
    expect(names).toContain("archive");
  });

  it("no boot o que já passou do prazo vai para o arquivo, e o contador de ids segue do arquivo", async () => {
    const time = clock();
    const first = await setupApp({ now: time.now });
    const { item: opened } = await waitingTask(first, "Mensagem para a Rita [aprovar]");
    await decideItem(first, opened.id, { status: "aprovado" });
    await first.store.flush();
    const dataDir = first.dataDir;
    time.state.now = T0 + 30 * DAY;
    const second = await setupApp({ dataDir, now: time.now });
    expect(await listItems(second)).toEqual([]);
    expect((await call<ForYouItem[]>(second.app, "GET", `${wsApi()}/for-you/archive/find?id=A-0001`)).map((entry) => entry.id)).toEqual(["A-0001"]);
    const { room, team } = await soloTeam(second.app, "Outra");
    const task = await createTask(second.app, room.id, team.id, "Post sobre testes [aprovar]");
    await second.log.waitForTask(task.id, "waiting_approval");
    expect((await itemFor(second.log, task.id)).id).toBe("A-0002");
  });
});

describe("Para você compacto: originalText só quando difere de text", () => {
  it("item novo sai sem originalText; editar guarda o rascunho; desfazer a edição volta a compactar", async () => {
    const setup = await setupApp();
    const { item: opened } = await waitingTask(setup, "Mensagem para a Bia [aprovar]");
    expect(opened.originalText).toBeUndefined();
    const draft = opened.text;

    const edited = await decideItem(setup, opened.id, { status: "aprovado", text: "Oi, Bia! Texto meu." });
    expect(edited).toMatchObject({ text: "Oi, Bia! Texto meu.", originalText: draft, editedByUser: true });
    await setup.store.flush();
    const onDisk = JSON.parse(await readFile(path.join(setup.dir, "for-you", `${new Date().toISOString().slice(0, 7)}.json`), "utf8")) as ForYouItem[];
    expect(onDisk[0]).toMatchObject({ originalText: draft, editedByUser: true });

    // "Desfazer edição": reabre e decide com o rascunho de volta.
    await decideItem(setup, opened.id, { status: "pendente" });
    const undone = await decideItem(setup, opened.id, { status: "aprovado", text: forYouOriginalText(edited) });
    expect(undone.editedByUser).toBe(false);
    expect(undone.originalText).toBeUndefined();
    const [saved] = await listItems(setup);
    expect(saved).toMatchObject({ text: draft, editedByUser: false });
    expect(saved?.originalText).toBeUndefined();
    await setup.store.flush();
    const compact = JSON.parse(await readFile(path.join(setup.dir, "for-you", `${new Date().toISOString().slice(0, 7)}.json`), "utf8")) as ForYouItem[];
    expect(compact[0]).not.toHaveProperty("originalText");
  });

  it("o agente trocar o rascunho de um item pendente não deixa originalText; a edição do dono depois guarda o novo rascunho", async () => {
    const setup = await setupApp();
    const { item: opened } = await waitingTask(setup, "Post sobre testes [aprovar]");
    const updated = await runtimeOf(setup).forYou.update(opened.id, { text: "Rascunho novo do agente" }, "agente");
    expect(updated).toMatchObject({ text: "Rascunho novo do agente", editedByUser: false });
    expect(updated.originalText).toBeUndefined();
    const decided = await decideItem(setup, opened.id, { status: "aprovado", text: "Meu texto" });
    expect(decided).toMatchObject({ text: "Meu texto", originalText: "Rascunho novo do agente", editedByUser: true });
  });

  it("no boot, itens gravados com originalText repetido são compactados e regravados uma vez", async () => {
    const dataDir = await tempDir();
    await seedDataDir(dataDir);
    const dir = principalDir(dataDir);
    await mkdir(path.join(dir, "for-you"), { recursive: true });
    const same = item("A-0001", { createdAt: "2026-11-01T10:00:00.000Z", originalText: "texto A-0001" });
    const different = item("A-0002", { createdAt: "2026-11-01T11:00:00.000Z", text: "editado", originalText: "rascunho", editedByUser: true });
    await writeFile(path.join(dir, "for-you", "2026-11.json"), JSON.stringify([same, different]), "utf8");
    const store = await OfficeStore.open(dir);
    await store.flush();
    const [a, b] = store.forYouSnapshot();
    expect(a).not.toHaveProperty("originalText");
    expect(b).toMatchObject({ text: "editado", originalText: "rascunho" });
    const disk = JSON.parse(await readFile(path.join(dir, "for-you", "2026-11.json"), "utf8")) as ForYouItem[];
    expect(disk[0]).not.toHaveProperty("originalText");
    expect(disk[1]).toMatchObject({ originalText: "rascunho" });
  });
});
