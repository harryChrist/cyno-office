import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TrackedItem } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { readRoutinesFile } from "../../store/files";
import { WriteQueue } from "../../store/write-queue";
import { nextItemId, RoutineItemsStore } from "./routine-items";

const tempDir = useTempDirs();
const queues: WriteQueue[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.idle()));
});

const item = (id: string): TrackedItem => ({ id, routineId: "R-0001", values: { empresa: "Acme" }, status: "Inscrito", state: "ativo", createdAt: "2026-11-11T11:00:00.000Z", history: [] });

describe("itens acompanhados (arquivo próprio)", () => {
  it("fica em routines/<id>/items.json, vazio quando não existe, e dá ids sequenciais", async () => {
    const dir = await tempDir();
    const queue = new WriteQueue();
    queues.push(queue);
    const file = path.join(dir, "routines", "R-0001", "items.json");
    const store = new RoutineItemsStore({ fileOf: () => file, queue, log: { error: () => undefined } });
    expect(await store.list("R-0001")).toEqual([]);
    await store.save("R-0001", [item("I-0001"), item("I-0002")]);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1, items: [{ id: "I-0001" }, { id: "I-0002" }] });
    expect((await store.list("R-0001")).map((i) => i.id)).toEqual(["I-0001", "I-0002"]);
    expect(nextItemId(await store.list("R-0001"))).toBe("I-0003");
    expect(nextItemId([])).toBe("I-0001");
  });

  it("arquivo estragado sobe o erro (não é apagado)", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "items.json");
    await mkdir(dir, { recursive: true });
    await writeFile(file, '{"items":[{"id":1}]}');
    const store = new RoutineItemsStore({ fileOf: () => file, queue: new WriteQueue(), log: { error: () => undefined } });
    await expect(store.list("R-0001")).rejects.toThrow();
    expect(await readFile(file, "utf8")).toContain('"id":1');
  });
});

describe("routines.json v1 no disco", () => {
  it("lê o formato antigo com padrões novos e regravar não muda mais nada", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "routines.json");
    const v1 = {
      routines: [
        { id: "R-0001", title: "Posts", unit: "post", kind: "post", site: "linkedin.com", target: 2, period: "week", agentId: "clara", instruction: "", status: "ativa", needsApproval: false, skipPeriods: [], createdBy: "usuario", createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z" },
        { id: "R-0002", title: "Velha", unit: "x", kind: "other", site: "a.com", target: 1, period: "week", teamId: "t", instruction: "", status: "arquivada", needsApproval: true, skipPeriods: [], createdBy: "maestro", createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z" },
      ],
      entries: [],
      executions: [],
      decisions: {},
      results: [],
      closedPeriod: "2026-W45",
    };
    await writeFile(file, JSON.stringify(v1));
    const data = await readRoutinesFile(file);
    expect(data.version).toBe(2);
    expect(data.routines[0]).toMatchObject({ type: "meta", needsApproval: false, mode: { kind: "automatico", grant: { actions: ["publicar", "postar", "post"], sites: ["linkedin.com"] } }, goal: { target: 2, period: "week", stopOnHit: true, prepareFactor: 1 }, schedules: [], lastRuns: [] });
    expect(data.routines[1]).toMatchObject({ status: "encerrada", mode: { kind: "pede-ok" } });
    await writeFile(file, JSON.stringify(data));
    expect(await readRoutinesFile(file)).toEqual(data);
  });
});
