import type { ForYouItem, OfficeState, Task } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { MaestroForYou } from "./maestro-for-you";

const at = "2026-11-11T12:00:00.000Z";

/** Núcleo mínimo do Maestro: um pedido, a lista do "Para você" e o que o Maestro recebeu. */
function setup() {
  const request: Task = { id: "pedido-1", roomId: "r", teamId: "t", agentId: "maestro", prompt: "Comentários", status: "in_progress", createdAt: at, updatedAt: at };
  const state = { tasks: [request], agents: [], teams: [], rooms: [] } as unknown as OfficeState;
  const items: ForYouItem[] = [];
  const pushed: string[] = [];
  const holds = vi.fn(() => false);
  const core = {
    deps: {
      state: { read: () => state, readForYou: () => items },
      approvals: {
        open: (task: Task, input: { question: string }) => {
          const item = { id: `A-000${items.length + 1}`, taskId: task.id, agentId: "maestro", roomId: "r", type: "comentario", status: "pendente", why: input.question, meta: {}, text: input.question, originalText: input.question, editedByUser: false, createdAt: at } as ForYouItem;
          items.push(item);
          return item;
        },
      },
      refreshStatus: () => undefined,
      plans: () => ({ holds }),
    },
    request: () => request,
    owns: () => true,
    setTask: (_state: OfficeState, task: Task, change: Partial<Task>) => {
      Object.assign(task, change);
      return Promise.resolve();
    },
    logEntry: () => undefined,
    setProgress: () => undefined,
    push: (_id: string, message: string) => pushed.push(message),
    chatEntry: () => undefined,
  };
  const forYou = new MaestroForYou(core as never, { addNotice: () => undefined } as never);
  return { forYou, request, items, pushed };
}

describe("MaestroForYou: várias aprovações abertas no mesmo pedido", () => {
  it("abre 3 aprovações no mesmo pedido; decididas fora de ordem, o Maestro recebe UMA mensagem só quando a última sai", async () => {
    const { forYou, request, items, pushed } = setup();
    for (const question of ["Comentário 1?", "Comentário 2?", "Comentário 3?"]) forYou.requestApproval({ question, text: `Texto ${question}` });
    expect(items.map((item) => item.id)).toEqual(["A-0001", "A-0002", "A-0003"]);
    expect(request.status).toBe("waiting_approval");
    expect(forYou.hasPending(request.id)).toBe(true);

    await forYou.decide(request.id, { approved: true, text: "Final 2", itemId: "A-0002" });
    await forYou.decide(request.id, { approved: false, reason: "tom errado", response: "tom errado", itemId: "A-0003" });
    expect(pushed).toHaveLength(0);
    expect(request.status).toBe("waiting_approval");
    expect(forYou.hasPending(request.id)).toBe(true);

    const done = await forYou.decide(request.id, { approved: true, itemId: "A-0001" });
    expect(done.status).toBe("in_progress");
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toContain('"Comentário 2?" (A-0002): APROVADO');
    expect(pushed[0]).toContain("Texto final:\nFinal 2");
    expect(pushed[0]).toContain('"Comentário 3?" (A-0003): RECUSADO');
    expect(pushed[0]).toContain("Motivo da recusa: tom errado");
    expect(pushed[0]).toContain('"Comentário 1?" (A-0001): APROVADO');
    expect(forYou.hasPending(request.id)).toBe(false);
    await expect(forYou.decide(request.id, { approved: true, itemId: "A-0001" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("sem itemId, decide a aprovação mais antiga; o hook de aprovação roda só para a aprovada; restaurar no boot devolve as pendentes", async () => {
    const { forYou, request, pushed } = setup();
    const hook = vi.fn();
    forYou.requestApproval({ question: "A?", onApproved: hook });
    forYou.requestApproval({ question: "B?" });
    await forYou.decide(request.id, { approved: true });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(pushed).toHaveLength(0);
    expect(forYou.holdsItem("A-0002")).toBe(true);
    expect(forYou.holdsItem("A-0001")).toBe(false);

    const rebooted = setup();
    rebooted.forYou.restorePending("pedido-1", "A-0001", "A?");
    rebooted.forYou.restorePending("pedido-1", "A-0002", "B?");
    expect(rebooted.forYou.hasPending("pedido-1")).toBe(true);
    rebooted.forYou.clear("pedido-1");
    expect(rebooted.forYou.hasPending("pedido-1")).toBe(false);
    expect(request.id).toBe("pedido-1");
  });
});
