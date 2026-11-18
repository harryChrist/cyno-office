import { nextForYouId } from "@cyno/shared";
import type { ForYouItem, ForYouRule, OfficeState, ServerEvent, Task } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import type { StateManager } from "../../store/state-manager";
import { ForYouService, type AutoVerdict } from "./service";

const AT = "2026-11-12T15:00:00.000Z";
const OFFICE = { rooms: [], teams: [], agents: [{ id: "eco", name: "Eco" }], tasks: [] } as unknown as OfficeState;
const task = () => ({ id: "t1", roomId: "r", agentId: "eco", work: { projectId: "p1", step: 0, ref: "T1" } }) as unknown as Task;

const RULE: ForYouRule = { text: "Não usar emojis em comentários.", scope: { agentId: "eco", roomId: "r" }, evidence: { itemIds: ["A-0001"], count: 3, days: 2 }, source: "molde", retro: "2026-W46", groupId: "g-1" };

/** Serviço com o Modo Automático LIBERADO para tudo e um `decideRule` espião. */
function setup(options: { withDecideRule?: boolean } = {}) {
  let items: ForYouItem[] = [];
  const state = {
    // Sem arquivo em disco nestes testes: nenhum id arquivado.
    forYouArchive: { has: () => false, nextId: (live: readonly { id: string }[]) => nextForYouId(live) },
    read: () => OFFICE,
    readForYou: () => items,
    commit: async (change: { forYou?: ForYouItem[]; events?: ServerEvent[] }) => {
      if (change.forYou) items = change.forYou;
    },
  } as unknown as StateManager;
  const autoReserve = vi.fn((): AutoVerdict => ({ ok: true, projectId: "p1", label: "1 de 99 hoje" }));
  const decideRule = vi.fn(async () => undefined);
  const service = new ForYouService({
    state,
    log: { error: vi.fn() },
    now: () => new Date(AT),
    types: { ensure: (type?: string) => type ?? "outro", resolve: (type?: string) => type ?? "outro", list: () => [] },
    decideTask: vi.fn(),
    autoReserve,
    ...(options.withDecideRule === false ? {} : { decideRule }),
  });
  const open = () => service.openSpecial({ kind: "regra", agentId: "eco", roomId: "r", title: "Regra proposta", text: RULE.text, rule: RULE });
  return { service, items: () => items, autoReserve, decideRule, open };
}

describe("cartão de regra (kind regra) do Para você", () => {
  it("nasce pendente e nenhum modo automático o decide, mesmo com tudo liberado", async () => {
    const { service, open, autoReserve, items } = setup();
    const card = open();
    expect(card).toMatchObject({ kind: "regra", status: "pendente", rule: RULE });
    expect(autoReserve).not.toHaveBeenCalled();
    expect(service.autoDecision(task(), [card])).toBeUndefined();
    expect(items()[0]!.status).toBe("pendente");
    expect(items()[0]!.decidedBy).toBeUndefined();
  });

  it("não entra no aprovar em lote: o lote recusa (400) e diz que não é aprovação de texto", async () => {
    const { service, open } = setup();
    const card = open();
    await expect(service.decideBatch([card.id])).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("não é uma aprovação de texto") });
    expect(service.list()[0]!.status).toBe("pendente");
  });

  it("aprovar chama a decisão da regra (que grava no Cérebro) uma vez e fecha o item como decidido pelo dono", async () => {
    const { service, open, decideRule } = setup();
    const card = open();
    const done = await service.decide(card.id, { status: "aprovado", rule: { text: "Sem emojis, nunca." } });
    expect(decideRule).toHaveBeenCalledOnce();
    expect(decideRule).toHaveBeenCalledWith(expect.objectContaining({ id: card.id }), { status: "aprovado", rule: { text: "Sem emojis, nunca." } });
    expect(done).toMatchObject({ status: "aprovado", decidedBy: "usuario", decidedAt: AT });
    // Já decidido: outra tentativa é 409 e a regra não é gravada de novo.
    await expect(service.decide(card.id, { status: "aprovado" })).rejects.toMatchObject({ statusCode: 409 });
    expect(decideRule).toHaveBeenCalledOnce();
  });

  it("recusar fecha como recusado (com o motivo) e a decisão da regra recebe a recusa", async () => {
    const { service, open, decideRule } = setup();
    const card = open();
    const done = await service.decide(card.id, { status: "rejeitado" });
    expect(decideRule).toHaveBeenCalledWith(expect.objectContaining({ id: card.id }), { status: "rejeitado" });
    expect(done).toMatchObject({ status: "rejeitado", rejection: { reason: "Regra recusada" } });
  });

  it("não se responde, não se reabre, não se altera e não se cancela por fora (só o dono aprova ou recusa)", async () => {
    const { service, open } = setup();
    const card = open();
    await expect(service.decide(card.id, { status: "respondido", response: "ok" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.update(card.id, { title: "outro" }, "maestro")).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.cancel(card.id, { by: "maestro" })).rejects.toMatchObject({ statusCode: 409 });
    expect(await service.cancelAllFor(new Set(["t1", "p1"]), { by: "maestro" })).toEqual([]);
    await service.decide(card.id, { status: "aprovado" });
    await expect(service.decide(card.id, { status: "pendente" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("sem a retrospectiva ligada (sem decideRule) a decisão é 409 e o item continua pendente", async () => {
    const { service, open, items } = setup({ withDecideRule: false });
    const card = open();
    await expect(service.decide(card.id, { status: "aprovado" })).rejects.toMatchObject({ statusCode: 409 });
    expect(items()[0]!.status).toBe("pendente");
  });
});
