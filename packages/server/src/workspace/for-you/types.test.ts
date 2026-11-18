import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  builtinForYouTypes,
  legacyForYouTypes,
  type ForYouItem,
  type ForYouTypeDef,
  type ServerEvent,
} from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { approvalTypeTool, describeForYouTypes } from "../../mcp/approval-type-tool";
import { ForYouArchive } from "../../store/for-you-archive";
import { WriteQueue } from "../../store/write-queue";
import { call, createTask, createWorkspace, soloTeam, wsApi } from "../../dev/test-api";
import { EventLog, useTestApp, type TestApp } from "../../dev/test-app";
import { readDiskForYou, useTempDirs } from "../../dev/test-utils";
import { ForYouTypesService, migrateForYouTypes } from "./types-service";

const AT = "2026-11-08T12:00:00.000Z";
const setupApp = useTestApp();
const tempDir = useTempDirs();
/** Filas dos serviços em memória: a pasta temporária só sai depois das gravações. */
const queues: WriteQueue[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.idle()));
});

type App = TestApp["app"];
const listTypes = (app: App, ws?: string) => call<ForYouTypeDef[]>(app, "GET", `${wsApi(ws)}/for-you/types`);
const listItems = (app: App, ws?: string) => call<ForYouItem[]>(app, "GET", `${wsApi(ws)}/for-you`);

function item(id: string, type: string): ForYouItem {
  return { id, agentId: "lia", roomId: "projetox", type, status: "pendente", meta: {}, text: "x", originalText: "x", editedByUser: false, createdAt: AT };
}

/** Serviço com estado em memória (itens e eventos) e o arquivo numa pasta temporária. */
async function memoryService(types: ForYouTypeDef[], items: ForYouItem[] = []) {
  const dir = await tempDir();
  const events: ServerEvent[] = [];
  const state = {
    items,
    readForYou: () => structuredClone(state.items),
    commit: async (change: { forYou?: ForYouItem[]; events: ServerEvent[] }) => {
      if (change.forYou) state.items = change.forYou;
      events.push(...change.events);
    },
    publish: (event: ServerEvent) => void events.push(event),
    forYouArchive: undefined as unknown as ForYouArchive,
  };
  const file = path.join(dir, "for-you-types.json");
  const queue = new WriteQueue();
  queues.push(queue);
  state.forYouArchive = await ForYouArchive.open(path.join(dir, "archive"), queue);
  const service = new ForYouTypesService(types, { file, queue, state, log: { error: () => undefined }, now: () => new Date(AT) });
  const saved = async () => {
    await queue.idle();
    return JSON.parse(await readFile(file, "utf8")) as ForYouTypeDef[];
  };
  return { service, events, state, saved };
}

describe("migração dos tipos", () => {
  it("principal sem arquivo ganha os 9 tipos de antes (do sistema)", () => {
    const { types, changed } = migrateForYouTypes(null, [], "principal", AT);
    expect(changed).toBe(true);
    expect(types.map((type) => type.id)).toEqual(["pergunta", "perfil", "convite", "boas-vindas", "mensagem", "resposta", "comentario", "post", "outro"]);
    expect(types.every((type) => type.createdBy === "system")).toBe(true);
  });

  it("workspace novo nasce só com pergunta e outro; um com itens de tipos antigos ganha os 9", () => {
    expect(migrateForYouTypes(null, [item("A-0001", "pergunta")], "instagram", AT).types.map((type) => type.id)).toEqual(["pergunta", "outro"]);
    expect(migrateForYouTypes(null, [item("A-0001", "convite")], "instagram", AT).types).toHaveLength(9);
  });

  it("arquivo sem os embutidos ou sem o tipo de um item: completa (e marca para gravar)", () => {
    const stored = legacyForYouTypes(AT).filter((type) => type.id !== "outro" && type.id !== "post");
    const { types, changed } = migrateForYouTypes(stored, [item("A-0001", "post"), item("A-0002", "reels")], "principal", AT);
    expect(changed).toBe(true);
    expect(types.find((type) => type.id === "outro")).toMatchObject({ createdBy: "system", color: "cinza" });
    expect(types.find((type) => type.id === "post")).toMatchObject({ name: "Post", icon: "pagina", createdBy: "system" });
    expect(types.find((type) => type.id === "reels")).toMatchObject({ icon: "video", behavior: "texto", createdBy: "system" });
    expect(migrateForYouTypes(types, [], "principal", AT).changed).toBe(false);
  });

  it("no boot: principal grava for-you-types.json com os 9; um workspace novo, com 2", async () => {
    const setup = await setupApp();
    expect((await listTypes(setup.app)).map((type) => type.name)).toEqual(["Pergunta", "Perfil", "Convite", "Boas-vindas", "Mensagem", "Resposta", "Comentário", "Post", "Outro"]);
    await setup.store.flush();
    const saved = JSON.parse(await readFile(path.join(setup.dir, "for-you-types.json"), "utf8")) as ForYouTypeDef[];
    expect(saved).toHaveLength(9);
    const other = await createWorkspace(setup.app, "Instagram");
    expect((await listTypes(setup.app, other.id)).map((type) => type.id)).toEqual(["pergunta", "outro"]);
  });

  it("depois de reiniciar, os tipos editados continuam (o arquivo manda)", async () => {
    const setup = await setupApp();
    await call(setup.app, "PATCH", `${wsApi()}/for-you/types/post`, { name: "Publicação" });
    await setup.store.flush();
    await setup.app.close();
    const again = await setupApp({ dataDir: setup.dataDir });
    expect((await listTypes(again.app)).find((type) => type.id === "post")?.name).toBe("Publicação");
  });

  it("for-you-types.json inválido impede o boot com uma mensagem clara", async () => {
    const setup = await setupApp();
    await setup.app.close();
    await writeFile(path.join(setup.dir, "for-you-types.json"), JSON.stringify([{ id: "X!" }]));
    await expect(setupApp({ dataDir: setup.dataDir })).rejects.toThrow(/for-you-types\.json/);
    await rm(path.join(setup.dir, "for-you-types.json"));
  });
});

describe("tipo desconhecido no pedido de aprovação: nasce na hora", () => {
  it("ensure cria com ícone por palavra e a próxima cor livre, avisa e grava; o mesmo nome reaproveita", async () => {
    const { service, events, saved } = await memoryService(builtinForYouTypes(AT));
    expect(service.ensure("Reels")).toBe("reels");
    expect(service.ensure("reels")).toBe("reels");
    expect(service.ensure("REELS")).toBe("reels");
    expect(service.ensure("Newsletter")).toBe("newsletter");
    expect(service.ensure(undefined)).toBe("outro");
    expect(service.find("reels")).toMatchObject({ name: "Reels", icon: "video", color: "azul", behavior: "texto", createdBy: "maestro" });
    expect(service.find("newsletter")).toMatchObject({ icon: "email", color: "ciano" });
    expect(events.filter((event) => event.type === "foryou-types:upserted").map((event) => event.type === "foryou-types:upserted" && [event.forYouType.id, event.created])).toEqual([
      ["reels", true],
      ["newsletter", true],
    ]);
    expect((await saved()).map((type) => type.id)).toEqual(["pergunta", "outro", "reels", "newsletter"]);
  });

  it("MockRunner num workspace novo: o rascunho de convite cria o tipo Convite (modelo de antes)", async () => {
    const setup = await setupApp();
    const ws = (await createWorkspace(setup.app, "Instagram")).id;
    const log = new EventLog(setup.workspaces.get(ws).hub);
    const { room, team } = await soloTeam(setup.app, "Solo", ws);
    const task = await createTask(setup.app, room.id, team.id, "Escrever convite para Ana Souza [aprovar]", ws);
    const created = await log.waitFor((event) => event.type === "foryou-types:upserted" && event.forYouType.id === "convite");
    expect(created).toMatchObject({ created: true, forYouType: { name: "Convite", createdBy: "maestro", limits: { default: 200 }, icon: "pessoa-mais" } });
    await log.waitForTask(task.id, "waiting_approval");
    expect((await listItems(setup.app, ws))[0]).toMatchObject({ type: "convite" });
    expect((await listTypes(setup.app, ws)).map((type) => type.id)).toEqual(["pergunta", "outro", "convite"]);
  });
});

describe("rotas dos tipos", () => {
  it("criar (201; id do nome; 409 se repetir), editar e validar", async () => {
    const setup = await setupApp();
    const created = await call<ForYouTypeDef>(setup.app, "POST", `${wsApi()}/for-you/types`, {
      name: "Reels",
      description: "Roteiro e legenda de reels",
      limits: { default: 2200, byWhere: [{ match: "título", max: 60, name: "título" }] },
      fields: { where: true },
    });
    expect(created).toMatchObject({ id: "reels", createdBy: "user", behavior: "texto", icon: "video", color: "coral" });
    await call(setup.app, "POST", `${wsApi()}/for-you/types`, { name: "reels" }, 409);
    await call(setup.app, "POST", `${wsApi()}/for-you/types`, { name: "X", color: "roxo" }, 400);
    const edited = await call<ForYouTypeDef>(setup.app, "PATCH", `${wsApi()}/for-you/types/reels`, { icon: "imagem", color: "azul", limits: null });
    expect(edited).toMatchObject({ icon: "imagem", color: "azul" });
    expect(edited.limits).toBeUndefined();
    await call(setup.app, "PATCH", `${wsApi()}/for-you/types/pergunta`, { behavior: "texto" }, 409);
    await call(setup.app, "PATCH", `${wsApi()}/for-you/types/pergunta`, { name: "Dúvida" }, 200);
    await call(setup.app, "PATCH", `${wsApi()}/for-you/types/nao-existe`, { name: "X" }, 404);
    expect(setup.log.events.some((event) => event.type === "foryou-types:upserted" && event.forYouType.id === "reels" && event.created)).toBe(true);
  });

  it("excluir move os itens para outro (os embutidos não saem)", async () => {
    const setup = await setupApp();
    const { room, team } = await soloTeam(setup.app);
    const task = await createTask(setup.app, room.id, team.id, "Escrever convite para Ana Souza [aprovar]");
    await setup.log.waitForTask(task.id, "waiting_approval");
    const [before] = await listItems(setup.app);
    expect(before!.type).toBe("convite");
    await call(setup.app, "DELETE", `${wsApi()}/for-you/types/convite`);
    expect((await listItems(setup.app))[0]!.type).toBe("outro");
    expect((await listTypes(setup.app)).some((type) => type.id === "convite")).toBe(false);
    expect(setup.log.events).toContainEqual({ type: "foryou-types:deleted", id: "convite", movedTo: "outro" });
    expect(setup.log.events.some((event) => event.type === "foryou:upserted" && event.item.id === before!.id && event.item.type === "outro")).toBe(true);
    await call(setup.app, "DELETE", `${wsApi()}/for-you/types/outro`, undefined, 409);
    await call(setup.app, "DELETE", `${wsApi()}/for-you/types/pergunta`, undefined, 409);
    await setup.store.flush();
    const saved = await readDiskForYou<ForYouItem>(setup.dir);
    expect(saved[0]!.type).toBe("outro");
  });

  it("juntar: os itens vão para o destino e o tipo some", async () => {
    const { service, state, events } = await memoryService(legacyForYouTypes(AT), [item("A-0001", "post"), item("A-0002", "comentario"), item("A-0003", "post")]);
    const target = await service.merge("post", "comentario");
    expect(target.id).toBe("comentario");
    expect(state.items.map((current) => current.type)).toEqual(["comentario", "comentario", "comentario"]);
    expect(service.find("post")).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "foryou-types:deleted", id: "post", movedTo: "comentario" });
    await expect(service.merge("comentario", "comentario")).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.merge("outro", "comentario")).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.merge("comentario", "nao-existe")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("juntar também troca o tipo dos itens que já foram para o arquivo", async () => {
    const { service, state } = await memoryService(legacyForYouTypes(AT), [item("A-0001", "post")]);
    await state.forYouArchive.append([{ ...item("A-0002", "post"), status: "aprovado", decidedAt: AT }, { ...item("A-0003", "comentario"), status: "aprovado", decidedAt: AT }]);
    await service.merge("post", "comentario");
    const archived = await state.forYouArchive.find({ id: "A-0002" });
    expect(archived.map((current) => current.type)).toEqual(["comentario"]);
    expect((await state.forYouArchive.find({ id: "A-0003" }))[0]?.type).toBe("comentario");
  });

  it("juntar pela rota devolve o destino", async () => {
    const setup = await setupApp();
    const target = await call<ForYouTypeDef>(setup.app, "POST", `${wsApi()}/for-you/types/boas-vindas/merge`, { into: "mensagem" }, 200);
    expect(target.id).toBe("mensagem");
    expect((await listTypes(setup.app)).some((type) => type.id === "boas-vindas")).toBe(false);
  });
});

describe("set_approval_type (ferramenta MCP do Maestro)", () => {
  it("cria o tipo com limites e campos; ícone e cor fora da galeria viram dica", async () => {
    const { service, events } = await memoryService(builtinForYouTypes(AT));
    const tool = approvalTypeTool(service);
    expect(tool.description).toContain("- pergunta (Pergunta)");
    const result = await tool.call(
      tool.input.parse({ name: "Reels", description: "Roteiro curto para vídeo vertical", limit: 150, limits_by_where: [{ match: "legenda", max: 2200, name: "legenda" }], uses_where: true, icon: "foguete", color: "roxo" }),
    );
    expect(result.text).toContain('Type "Reels" created (id "reels")');
    expect(service.find("reels")).toMatchObject({
      behavior: "texto",
      limits: { default: 150, byWhere: [{ match: "legenda", max: 2200, name: "legenda" }] },
      fields: { where: true },
      icon: "video",
      color: "azul",
      createdBy: "maestro",
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "foryou-types:upserted", created: true }));
  });

  it("de novo: refina o tipo dele; um tipo do usuário fica como está", async () => {
    const { service } = await memoryService(builtinForYouTypes(AT));
    const tool = approvalTypeTool(service);
    await tool.call(tool.input.parse({ name: "Reels", description: "v1" }));
    const again = await tool.call(tool.input.parse({ name: "reels", description: "v2", icon: "imagem", color: "rosa" }));
    expect(again.text).toContain("already existed");
    expect(service.find("reels")).toMatchObject({ description: "v2", icon: "imagem", color: "rosa" });
    await service.create({ name: "Thread", description: "do usuário" });
    const kept = await tool.call(tool.input.parse({ name: "Thread", description: "outra coisa" }));
    expect(kept.text).toContain("created by the user");
    expect(service.find("thread")?.description).toBe("do usuário");
    expect(tool.input.safeParse({ name: "", description: "x" }).success).toBe(false);
  });

  it("a lista dos tipos (vai no `approval_type` do request_approval) traz limites e campos", () => {
    const text = describeForYouTypes(legacyForYouTypes(AT));
    expect(text).toContain("- convite (Convite):");
    expect(text).toContain("limit 200");
    expect(text).toContain('limits by "where": headline=220');
    expect(text).toContain("the user answers");
  });
});

describe("tipo do pedido de aprovação: casa com um tipo que existe", () => {
  it('"outro", ausente ou desconhecido casam por onde/para quem/título antes de aceitar "outro"', async () => {
    const { service } = await memoryService(legacyForYouTypes(AT));
    const hints = ["Comentário no post de Fulano"];
    expect(service.resolve("outro", hints, "faça algo")).toBe("comentario");
    expect(service.resolve(undefined, ["Convite de conexão"], "faça algo")).toBe("convite");
    expect(service.resolve("comentario-linkedin", hints, "x")).toBe("comentario");
    expect(service.resolve("convite", hints, "x")).toBe("convite");
    expect(service.resolve("outro", ["nada a ver"], "x")).toBe("outro");
    expect(service.resolve("reels", ["Legenda"], "x")).toBe("reels");
    expect(service.find("reels")).toBeDefined();
  });

  it('workspace só com os tipos embutidos: "outro" num comentário cria o tipo Comentário (o de sempre) em vez de aceitar "outro"', async () => {
    const { service, events } = await memoryService(builtinForYouTypes(AT));
    expect(service.resolve("outro", ["Comentário no post de Fulano"], "x")).toBe("comentario");
    expect(service.find("comentario")).toMatchObject({ name: "Comentário", createdBy: "maestro" });
    expect(events.some((event) => event.type === "foryou-types:upserted" && event.forYouType.id === "comentario")).toBe(true);
    expect(service.resolve("outro", ["Convite de conexão"], "x")).toBe("convite");
    expect(service.resolve("outro", ["texto qualquer"], "x")).toBe("outro");
  });
});
