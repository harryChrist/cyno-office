import { nextForYouId } from "@cyno/shared";
import path from "node:path";
import { emptyRoutinesData, type Agent, type ForYouItem, type OfficeState, type ServerEvent, type Task } from "@cyno/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import type { ApprovalDraft } from "../../engines/runner/types";
import type { StateManager } from "../../store/state-manager";
import { WriteQueue } from "../../store/write-queue";
import { MetaTracker } from "../routines/meta-tracker";
import { RoutineService } from "../routines/routine-service";
import { DISMISSED_REASON, ForYouService, type AutoVerdict } from "./service";

const tempDir = useTempDirs();
const queues: WriteQueue[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.idle()));
});

const CLARA = { id: "clara", name: "Clara", teamId: "time" } as Agent;
/** Quarta 2026-11-11 11:00 em São Paulo (semana W46). */
const NOW = new Date("2026-11-11T14:00:00Z");
const draft = (text: string): { question: string; draft: ApprovalDraft } => ({ question: `Pode publicar ${text}?`, draft: { type: "post", text, where: "Feed" } });

/**
 * Meta com preparo ligada ao Para você: uma Meta de `target` por semana com fator 2, a tarefa dela
 * esperando aprovação e o ForYouService real com o MetaTracker real (a mesma ligação do runtime).
 */
async function setup(options: { target: number; auto?: boolean; stopOnHit?: boolean }) {
  const dir = await tempDir();
  const queue = new WriteQueue();
  queues.push(queue);
  let items: ForYouItem[] = [];
  const task = { id: "t1", roomId: "r", teamId: "time", agentId: "clara", routineId: "R-0001", status: "waiting_approval", work: { projectId: "t1", step: 0, ref: "T1" } } as unknown as Task;
  const office = { rooms: [], teams: [], agents: [CLARA], tasks: [task] } as unknown as OfficeState;
  const state = {
    // Sem arquivo em disco nestes testes: nenhum id arquivado.
    forYouArchive: { has: () => false, nextId: (live: readonly { id: string }[]) => nextForYouId(live) },
    read: () => office,
    readForYou: () => items,
    commit: async (change: { forYou?: ForYouItem[]; events?: ServerEvent[] }) => {
      if (change.forYou) items = change.forYou;
    },
  } as unknown as StateManager;
  const routines = new RoutineService(emptyRoutinesData(), {
    file: path.join(dir, "routines.json"),
    queue,
    publish: () => undefined,
    owners: { agent: (id) => (id === "clara" ? CLARA : undefined), team: () => undefined },
    openCard: () => undefined,
    log: { warn: () => undefined, error: () => undefined },
    now: () => NOW,
  });
  routines.create({ title: "Frases", unit: "frase", kind: "other", site: "example.com", agentId: "clara", needsApproval: true, goal: { target: options.target, period: "week", stopOnHit: options.stopOnHit ?? true, prepareFactor: 2 } });
  // eslint-disable-next-line prefer-const -- atribuído depois (o MetaTracker precisa da referência antes)
  let service!: ForYouService;
  const meta = new MetaTracker({ routines, state: { read: () => office, readForYou: () => items }, forYou: { cancel: (id, input) => service.cancel(id, input) }, now: () => NOW, log: { warn: () => undefined } });
  const decideTask = vi.fn(async (_taskId: string, decision: unknown) => {
    void decision;
    return task;
  });
  service = new ForYouService({
    state,
    log: { error: vi.fn() },
    now: () => NOW,
    types: { ensure: (type?: string) => type ?? "outro", resolve: (type?: string) => type ?? "outro", list: () => [] },
    decideTask,
    ...(options.auto ? { autoReserve: (): AutoVerdict => ({ ok: true, projectId: "t1", label: "ok" }) } : {}),
    routineMeta: { standing: (t) => meta.standing(t), opened: (t, list) => meta.opened(t, list), counted: (t, delta) => meta.counted(t, delta) },
  });
  const stats = () => routines.statsFor("R-0001", "2026-W46");
  return { service, items: () => items, task, decideTask, stats, routines, meta };
}

describe("Meta com preparo: o servidor não passa do alvo", () => {
  it("Pede OK: 6 opções para fechar 3; ao aprovar a 3ª, as outras 3 são dispensadas e o agente recebe UMA decisão", async () => {
    const { service, items, task, decideTask, stats } = await setup({ target: 3 });
    const created = service.openMany(task, { question: "Lote", items: ["a", "b", "c", "d", "e", "f"].map(draft) });
    expect(stats()).toMatchObject({ prepared: 6, approved: 0, dismissed: 0 });
    await service.decide(created[0]!.id, { status: "aprovado" });
    await service.decide(created[1]!.id, { status: "aprovado" });
    expect(decideTask).not.toHaveBeenCalled();
    expect(items().filter((item) => item.status === "pendente")).toHaveLength(4);
    await service.decide(created[2]!.id, { status: "aprovado" });
    expect(decideTask).toHaveBeenCalledTimes(1);
    const decision = decideTask.mock.calls[0]![1] as { approved: boolean; items: { status: string }[] };
    expect(decision.approved).toBe(true);
    expect(decision.items.map((entry) => entry.status)).toEqual(["approved", "approved", "approved", "cancelled", "cancelled", "cancelled"]);
    const dismissed = items().filter((item) => item.status === "cancelado");
    expect(dismissed).toHaveLength(3);
    expect(dismissed.every((item) => item.cancelledBy === "servidor" && item.cancelReason === DISMISSED_REASON)).toBe(true);
    expect(stats()).toEqual({ prepared: 6, approved: 3, dismissed: 3 });
  });

  it("o dono que dispensa ou cancela uma opção à mão também conta como dispensada (o servidor e o agente não contam em dobro)", async () => {
    const { service, task, stats } = await setup({ target: 3 });
    const created = service.openMany(task, { question: "Lote", items: ["a", "b", "c", "d", "e", "f"].map(draft) });
    await service.cancel(created[0]!.id, { by: "usuario", reason: "Dispensado" });
    await service.cancel(created[1]!.id, { by: "usuario" });
    expect(stats().dismissed).toBe(2);
    await service.cancel(created[2]!.id, { by: "agente", reason: "refiz" });
    await service.cancel(created[3]!.id, { by: "servidor", reason: DISMISSED_REASON });
    expect(stats().dismissed).toBe(2);
  });

  it("item recusado não conta: com 2 aprovadas e 1 recusada de 3, as outras continuam esperando", async () => {
    const { service, items, task, decideTask, stats } = await setup({ target: 3 });
    const created = service.openMany(task, { question: "Lote", items: ["a", "b", "c", "d", "e", "f"].map(draft) });
    await service.decide(created[0]!.id, { status: "aprovado" });
    await service.decide(created[1]!.id, { status: "rejeitado", reason: "fraca" });
    await service.decide(created[2]!.id, { status: "aprovado" });
    expect(items().filter((item) => item.status === "pendente")).toHaveLength(3);
    expect(decideTask).not.toHaveBeenCalled();
    expect(stats().dismissed).toBe(0);
  });

  it("stopOnHit desligado: nada é dispensado ao bater", async () => {
    const { service, items, task, decideTask } = await setup({ target: 1, stopOnHit: false });
    const created = service.openMany(task, { question: "Lote", items: ["a", "b"].map(draft) });
    await service.decide(created[0]!.id, { status: "aprovado" });
    expect(items().filter((item) => item.status === "pendente")).toHaveLength(1);
    expect(decideTask).not.toHaveBeenCalled();
  });

  it("Automático: o servidor conta e bloqueia além do alvo (2 de 5 passam), dispensa as outras e o agente segue na hora", async () => {
    const { service, items, task, stats } = await setup({ target: 2, auto: true });
    const created = service.openMany(task, { question: "Lote", items: ["a", "b", "c", "d", "e"].map(draft) });
    expect(created.map((item) => item.status)).toEqual(["aprovado", "aprovado", "pendente", "pendente", "pendente"]);
    expect(created[2]!.meta.Meta).toContain("Meta batida (2/2)");
    const decision = service.autoDecision(task, created);
    expect(decision?.approved).toBe(true);
    expect(decision?.items?.map((entry) => entry.status)).toEqual(["approved", "approved", "cancelled", "cancelled", "cancelled"]);
    expect(items().filter((item) => item.cancelledBy === "servidor")).toHaveLength(3);
    expect(stats()).toEqual({ prepared: 5, approved: 2, dismissed: 3 });
  });

  it("varredura do vigia: opções que sobraram depois de a meta fechar são dispensadas sem decidir a tarefa por conta própria", async () => {
    const { service, items, task, meta, routines } = await setup({ target: 2 });
    const created = service.openMany(task, { question: "Lote", items: ["a", "b", "c"].map(draft) });
    // Duas entregas por fora (routine_record) fecham a meta sem passar pelas aprovações.
    for (const url of ["https://example.com/1", "https://example.com/2"]) routines.record({ task: { ...task, status: "in_progress" }, agentId: "clara", routineId: "R-0001", url });
    expect(meta.flight(routines.get("R-0001"), NOW).pending).toBe(3);
    expect(await meta.dismissLeftovers(routines.get("R-0001"))).toBe(3);
    expect(items().filter((item) => item.id === created[0]!.id)[0]).toMatchObject({ status: "cancelado", cancelledBy: "servidor", cancelReason: DISMISSED_REASON });
    expect(routines.statsFor("R-0001", "2026-W46").dismissed).toBe(3);
  });
});
