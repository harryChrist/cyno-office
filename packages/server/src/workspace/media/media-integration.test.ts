import type { ForYouItem, MediaItem } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, createTask, soloTeam, wsApi } from "../../dev/test-api";
import { useTestApp } from "../../dev/test-app";
import { fakePng } from "./test-files";

const setupApp = useTestApp();

describe("mídia + Para você", () => {
  it("o pedido com mediaIds e sources liga a mídia ao item, guarda as fontes (cortadas) e aprovar vira 'aprovado'", async () => {
    const { app, workspaces, log } = await setupApp();
    const runtime = workspaces.get("principal");
    const { room, team } = await soloTeam(app);
    const task = await createTask(app, room.id, team.id, "Comentar o post");
    await log.waitForTask(task.id, "done");
    const media = await runtime.media.addBuffer(fakePng(1200, 630), "image/png", { title: "Capa", createdBy: "agente", origin: "html", taskId: task.id });
    const original = await runtime.media.addBuffer(fakePng(800, 600), "image/png", { title: "Post original", createdBy: "agente", origin: "screenshot", taskId: task.id });

    const item = runtime.forYou.open(runtime.state.read().tasks.find((candidate) => candidate.id === task.id)!, {
      question: "Posso comentar?",
      draft: {
        type: "outro",
        text: "Ótimo post!",
        mediaIds: [media.id],
        sources: [{ kind: "post", author: "Mayk Brito", url: "https://lnkd.in/p/x", content: "texto ".repeat(3000), summary: "resumo", mediaIds: [original.id] }],
      },
    });
    expect(item.mediaIds).toEqual([media.id]);
    expect(item.sources).toHaveLength(1);
    expect(item.sources![0]!.content!.length).toBe(6000);
    expect(runtime.media.get(media.id).forYouIds).toEqual([item.id]);
    expect(runtime.media.get(original.id).forYouIds).toBeUndefined();

    // O item sai pela API com os campos novos.
    const listed = await call<ForYouItem[]>(app, "GET", `${wsApi()}/for-you`);
    expect(listed.find((entry) => entry.id === item.id)).toMatchObject({ mediaIds: [media.id], sources: [{ author: "Mayk Brito" }] });

    // Rejeitar não aprova a mídia; reabrir e aprovar, sim (só a que estava em rascunho).
    runtime.media.update(original.id, { status: "publicado" });
    await call(app, "POST", `${wsApi()}/for-you/${item.id}/decision`, { status: "rejeitado" }, 200);
    expect(runtime.media.get(media.id).status).toBe("rascunho");
    await call(app, "POST", `${wsApi()}/for-you/${item.id}/decision`, { status: "pendente" }, 200);
    await call(app, "POST", `${wsApi()}/for-you/${item.id}/decision`, { status: "aprovado" }, 200);
    expect(runtime.media.get(media.id).status).toBe("aprovado");
    expect(runtime.media.get(original.id).status).toBe("publicado");
    expect((await call<MediaItem>(app, "GET", `${wsApi()}/media/${media.id}`)).status).toBe("aprovado");
  });

  it("update com sources troca (e [] limpa) num item pendente", async () => {
    const { app, workspaces, log } = await setupApp();
    const runtime = workspaces.get("principal");
    const { room, team } = await soloTeam(app);
    const task = await createTask(app, room.id, team.id, "Comentar");
    await log.waitForTask(task.id, "done");
    const item = runtime.forYou.open(runtime.state.read().tasks.find((candidate) => candidate.id === task.id)!, { question: "?", draft: { type: "outro", text: "t" } });
    const updated = await runtime.forYou.update(item.id, { sources: [{ kind: "profile", content: "Dev Go" }], reason: "contexto" }, "agente");
    expect(updated.sources).toEqual([{ kind: "profile", content: "Dev Go" }]);
    const cleared = await runtime.forYou.update(item.id, { sources: [] }, "agente");
    expect(cleared.sources).toBeUndefined();
  });
});
