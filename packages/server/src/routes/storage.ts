import { STORAGE_PART_IDS, STORAGE_PART_LABELS, storagePartOf, type StorageFolder, type StoragePartId, type StorageResponse } from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import type { DiskMeter, DiskSnapshot } from "../platform/storage/disk-meter";
import type { WorkspaceManager } from "../platform/workspaces/manager";
import type { RuntimeOf } from "./media";

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());

/**
 * Espaço em disco, dentro de /api/w/:ws:
 * - GET  /storage          -> { workspace, folders } com o que já foi medido (e dispara o que faltar, em segundo plano)
 * - POST /storage/refresh  -> recalcula tudo e responde na hora (as pastas voltam como "computing")
 */
export function registerStorageRoutes(scope: FastifyInstance, runtimeOf: RuntimeOf, manager: WorkspaceManager, meter: DiskMeter): void {
  const body = (workspaceId: string, root: string, read: (dir: string) => DiskSnapshot): StorageResponse => {
    const data = read(root);
    const sums = Object.fromEntries(STORAGE_PART_IDS.map((id) => [id, 0])) as Record<StoragePartId, number>;
    for (const [name, bytes] of Object.entries(data.byTop)) sums[storagePartOf(name)] += bytes;
    // Arquivos soltos na raiz do workspace já entram em byTop (pelo nome do arquivo) e caem em "Outros".
    const folders: StorageFolder[] = (manager.list().find((workspace) => workspace.id === workspaceId)?.folders ?? []).map((folder) => {
      const info = read(folder.path);
      return { id: folder.id, bytes: info.bytes, files: info.files, state: info.state, computedAt: iso(info.computedAt) };
    });
    return {
      workspace: { bytes: data.bytes, files: data.files, state: data.state, computedAt: iso(data.computedAt), parts: STORAGE_PART_IDS.map((id) => ({ id, label: STORAGE_PART_LABELS[id], bytes: sums[id] })) },
      folders,
    };
  };

  scope.get("/storage", async (request) => {
    const runtime = runtimeOf(request);
    return body(runtime.id, runtime.store.paths.root, (dir) => meter.get(dir));
  });

  scope.post("/storage/refresh", async (request) => {
    const runtime = runtimeOf(request);
    const dirs = [runtime.store.paths.root, ...(manager.list().find((workspace) => workspace.id === runtime.id)?.folders ?? []).map((folder) => folder.path)];
    for (const dir of dirs) void meter.refresh(dir);
    return body(runtime.id, runtime.store.paths.root, (dir) => meter.get(dir));
  });
}
