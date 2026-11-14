import type { AttentionAlert, ForYouItem, Task, UsageRecord } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { AwayService, renderAway } from "./away-service";
import { OwnerStore } from "./owner-store";

const T0 = Date.parse("2026-11-12T12:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const task = (id: string, change: Partial<Task> = {}): Task => ({ id, roomId: "r", teamId: "t", agentId: "eco", prompt: `Fazer ${id}`, status: "done", createdAt: at(0), updatedAt: at(60), ...change }) as Task;
const usage = (when: string, extra: Partial<UsageRecord> = {}): UsageRecord => ({ v: 1, id: `u${when}`, at: when, agentId: "eco", provider: "claude", model: "claude-sonnet-5-5", source: "live", measured: true, tokens: { input: 1000, output: 100, cacheRead: 0, cacheCreation: 0 }, costUsd: 0, priceVersion: "x", ...extra });

function setup(options: { tasks?: Task[]; items?: ForYouItem[]; records?: UsageRecord[]; alerts?: AttentionAlert[] } = {}) {
  const owner = OwnerStore.inMemory();
  owner.presence(T0);
  owner.presence(T0 + 3 * 3_600_000);
  const service = new AwayService({
    owner,
    now: () => new Date(T0 + 3 * 3_600_000),
    usdBrl: () => 5,
    alerts: () => options.alerts ?? [],
    sources: () => [
      {
        id: "ws",
        name: "Site novo",
        read: () => ({ tasks: options.tasks ?? [], items: options.items ?? [], agents: [{ id: "eco", name: "Eco" }] }),
        usage: async (from, to) => (options.records ?? []).filter((record) => Date.parse(record.at) >= from && Date.parse(record.at) < to),
      },
    ],
  });
  return { owner, service };
}

describe("AwayService", () => {
  it("sem nada acontecido: não há resumo pendente", async () => {
    const { service } = setup();
    expect(await service.pending()).toEqual({ pending: false });
    expect((await service.last()).summary!.empty).toBe(true);
  });

  it("junta tarefas, gasto (sem as linhas suspeitas) e limites da ausência", async () => {
    const { service } = setup({
      tasks: [task("a"), task("b", { status: "failed" })],
      records: [usage(at(30)), usage(at(40), { suspect: "output" }), usage(at(-10))],
      alerts: [{ kind: "budget", level: "alert", text: "Orçamento hoje estourado", at: at(90), target: { page: "gestao", ref: "gastos" } } as AttentionAlert],
    });
    const response = await service.pending();
    expect(response.pending).toBe(true);
    const summary = response.summary!;
    expect(summary.totals).toMatchObject({ done: 1, failed: 1, turns: 1, tokens: 1100 });
    expect(summary.totals.costUsd).toBeGreaterThan(0);
    expect(summary.limits.map((limit) => limit.text)).toEqual(["Orçamento hoje estourado"]);
  });

  it("depois do \"Ok, vi\": nada pendente para o cartão, mas o Cyno ainda lê a última ausência", async () => {
    const { service, owner } = setup({ tasks: [task("a")] });
    owner.markSeen(T0 + 3 * 3_600_000 + 1000);
    expect(await service.pending()).toEqual({ pending: false });
    const last = await service.last();
    expect(last.seen).toBe(true);
    expect(last.summary!.totals.done).toBe(1);
  });

  it("renderAway: texto em inglês com as mesmas contas do cartão", async () => {
    const { service } = setup({ tasks: [task("a", { result: "Pronto" }), task("b", { status: "failed" })] });
    const text = renderAway(await service.last(), T0 + 3 * 3_600_000 + 5 * 60_000);
    expect(text).toContain("While the owner was away");
    expect(text).toContain("1 tasks done, 1 failed");
    expect(text).toContain('Workspace ws "Site novo"');
    expect(text).toContain("- done: Fazer a (Eco): Pronto");
    expect(text).toContain("- failed: Fazer b (Eco)");
    expect(text).toContain("Card text (pt-BR): 1 tarefa concluída · 1 tarefa falhou");
    expect(renderAway({ seen: false }, T0)).toContain("No absence recorded yet");
    expect(renderAway({ summary: { ...(await service.last()).summary!, empty: true }, seen: false }, T0 + 3 * 3_600_000)).toContain("Nothing happened");
  });
});
