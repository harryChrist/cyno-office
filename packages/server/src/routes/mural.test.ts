import type { MuralEntry, MuralResponse, MuralUseResponse } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, createWorkspace, wsApi } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";
import { writeAuthFile } from "../platform/auth/store";
import { fakePng } from "../workspace/media/test-files";

const setupApp = useTestApp();

describe("API: mural da plataforma", () => {
  it("fica atrás da senha", async () => {
    const test = await setupApp();
    await writeAuthFile(test.dataDir, "senha-de-teste-1");
    for (const [method, url] of [
      ["GET", "/api/mural"],
      ["POST", "/api/mural/share"],
      ["POST", "/api/mural/N-0001/use"],
      ["DELETE", "/api/mural/N-0001"],
    ] as const) {
      const response = await test.app.inject({ method, url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("o dono compartilha pela tela, o outro workspace traz, e retirar tira a marca", async () => {
    const { app, workspaces } = await setupApp();
    const design = await createWorkspace(app, "Design");
    const posts = await createWorkspace(app, "Posts");
    const art = await workspaces.get(design.id).media.addBuffer(fakePng(1200, 627), "image/png", { title: "Arte do café", createdBy: "ana", origin: "html" });

    const entry = await call<MuralEntry>(app, "POST", "/api/mural/share", { workspace: design.id, mediaId: art.id, note: "capa" });
    expect(entry).toMatchObject({ id: "N-0001", kind: "media", by: "dono", workspace: design.id });
    expect(workspaces.get(design.id).media.find(art.id)!.shared?.note).toBe("capa");
    // A mídia compartilhada vem com a marca pela API da mídia.
    expect((await call<{ shared?: object }>(app, "GET", `${wsApi(design.id)}/media/${art.id}`)).shared).toBeDefined();

    const mural = await call<MuralResponse>(app, "GET", "/api/mural");
    expect(mural.entries.map((item) => item.id)).toEqual(["N-0001"]);
    // O Posts nunca viu (1 novidade); o Design é o autor (0).
    expect(mural.news).toMatchObject({ [posts.id]: 1, [design.id]: 0 });

    const used = await call<MuralUseResponse>(app, "POST", "/api/mural/N-0001/use", { workspace: posts.id }, 200);
    expect(used.mediaId).toBe("M-0001");
    expect(workspaces.get(posts.id).media.find("M-0001")).toMatchObject({ origin: "mural", status: "rascunho" });
    expect((await call<MuralResponse>(app, "GET", "/api/mural")).entries[0]!.usedBy).toEqual([posts.id]);
    await call(app, "POST", "/api/mural/N-0001/use", { workspace: design.id }, 409);

    await call(app, "DELETE", "/api/mural/N-0001", undefined, 200);
    expect((await call<MuralResponse>(app, "GET", "/api/mural")).entries).toEqual([]);
    expect(workspaces.get(design.id).media.find(art.id)!.shared).toBeUndefined();
    await call(app, "POST", "/api/mural/share", { workspace: design.id }, 400);
    await call(app, "POST", "/api/mural/share", { workspace: "nada", text: "oi", title: "x" }, 404);
  });
});
