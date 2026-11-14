import { readdir } from "node:fs/promises";
import path from "node:path";
import { type ProjectTask } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../dev/test-utils";
import { AvulsasArchive } from "./avulsas-archive";

const tempDir = useTempDirs();
const at = "2026-09-01T10:00:00.000Z";

function leaf(ref: string, requestId: string, finishedAt: string): ProjectTask {
  return {
    ref,
    title: `Pedido ${requestId}`,
    briefing: "faça",
    ownerId: "eco",
    steps: [{ agentId: "eco", what: "faz", status: "feita" }],
    current: 0,
    dependsOn: [],
    priority: "normal",
    doneWhen: [],
    status: "concluida",
    rework: { count: 0 },
    finishedAt,
    updatedAt: finishedAt,
    meta: { requestId, origin: "usuario" },
  };
}

describe("AvulsasArchive", () => {
  it("acrescenta por mês de término, acha por ref e por pedido, e não repete", async () => {
    const dir = path.join(await tempDir(), "projects", "avulsas.archive");
    const archive = new AvulsasArchive(dir);
    expect(await archive.find("A1")).toBeUndefined();
    await archive.append([leaf("A1", "r1", at), leaf("A2", "r2", "2026-10-03T10:00:00.000Z"), leaf("A3", "r1", at)]);
    expect((await readdir(dir)).sort()).toEqual(["2026-09.json", "2026-10.json"]);
    await archive.append([leaf("A1", "r1", at), leaf("A4", "r4", at)]);
    expect((await archive.find("A1"))?.ref).toBe("A1");
    expect((await archive.find("A2"))?.finishedAt).toBe("2026-10-03T10:00:00.000Z");
    expect(await archive.find("A9")).toBeUndefined();
    expect((await archive.ofRequest("r1")).map((task) => task.ref)).toEqual(["A1", "A3"]);
    expect((await archive.ofRequest("r4")).map((task) => task.ref)).toEqual(["A4"]);
  });
});
