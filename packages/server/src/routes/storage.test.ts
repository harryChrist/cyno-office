import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StorageResponse } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, wsApi } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";

const setupApp = useTestApp();

async function settle(app: Awaited<ReturnType<typeof setupApp>>["app"], url: string): Promise<StorageResponse> {
  for (let i = 0; i < 100; i++) {
    const data = await call<StorageResponse>(app, "GET", url);
    if (data.workspace.state !== "computing" && data.folders.every((folder) => folder.state !== "computing")) return data;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("a medição não terminou");
}

describe("API: espaço em disco", () => {
  it("mede a pasta do workspace por partes e as pastas de trabalho; refresh recalcula", async () => {
    const { app } = await setupApp();
    const outside = await mkdtemp(path.join(os.tmpdir(), "cyno-storage-"));
    try {
      await mkdir(path.join(outside, "src"), { recursive: true });
      await writeFile(path.join(outside, "src", "a.ts"), Buffer.alloc(40_000, 1));
      const added = await call<{ folders?: { id: string }[] }>(app, "POST", "/api/workspaces/principal/folders", { name: "Projeto", path: outside, mode: "read" });
      const folderId = added.folders![0]!.id;

      const first = await call<StorageResponse>(app, "GET", `${wsApi()}/storage`);
      expect(first.workspace.parts.map((part) => part.id)).toEqual(["media", "agents", "logs", "brains", "boards", "other"]);
      expect(first.workspace.parts[0]).toMatchObject({ label: "Mídia" });
      expect(first.folders).toHaveLength(1);
      expect(first.folders[0]).toMatchObject({ id: folderId, state: "computing" });

      const ready = await settle(app, `${wsApi()}/storage`);
      expect(ready.workspace.state).toBe("ready");
      expect(ready.workspace.computedAt).toEqual(expect.any(String));
      expect(ready.workspace.bytes).toBeGreaterThan(0);
      // A raiz em si não entra nas partes (só o que há dentro dela).
      expect(ready.workspace.parts.reduce((sum, part) => sum + part.bytes, 0)).toBeLessThanOrEqual(ready.workspace.bytes);
      expect(ready.folders[0]).toMatchObject({ id: folderId, state: "ready", files: 1 });
      expect(ready.folders[0]!.bytes).toBeGreaterThanOrEqual(40_000);

      await writeFile(path.join(outside, "src", "b.ts"), Buffer.alloc(40_000, 1));
      expect((await call<StorageResponse>(app, "GET", `${wsApi()}/storage`)).folders[0]!.files).toBe(1); // cache
      const refreshed = await call<StorageResponse>(app, "POST", `${wsApi()}/storage/refresh`, undefined, 200);
      expect(refreshed.folders[0]!.state).toBe("computing");
      const after = await settle(app, `${wsApi()}/storage`);
      expect(after.folders[0]!.files).toBe(2);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("workspace inexistente é 404", async () => {
    const { app } = await setupApp();
    expect((await app.inject({ method: "GET", url: `${wsApi("nao-existe")}/storage` })).statusCode).toBe(404);
  });
});
