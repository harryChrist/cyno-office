import { nextForYouId, type BrainOrganizePlan, type ForYouItem, type OfficeState, type ServerEvent, type Task } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import type { StateManager } from "../../store/state-manager";
import { dueForArchive, ForYouService, type AutoVerdict } from "./service";

const AT = "2026-11-12T15:00:00.000Z";
const OFFICE = { rooms: [], teams: [], agents: [{ id: "maestro", name: "Maestro" }], tasks: [] } as unknown as OfficeState;
const task = () => ({ id: "t1", roomId: "r", agentId: "maestro", work: { projectId: "p1", step: 0, ref: "T1" } }) as unknown as Task;

const PLAN: BrainOrganizePlan = {
  brainId: "sala-a",
  brainName: "Sala A",
  summary: "Mover relatórios para o histórico.",
  actions: [{ type: "archive", file: "relatorio.md", title: "Relatório" }],
  before: { notes: 3, chars: 900, rules: 1 },
  after: { notes: 2, chars: 600, rules: 1 },
};

function setup(options: { withDecide?: boolean } = {}) {
  let items: ForYouItem[] = [];
  const state = {
    forYouArchive: { has: () => false, nextId: (live: readonly { id: string }[]) => nextForYouId(live) },
    read: () => OFFICE,
    readForYou: () => items,
    commit: async (change: { forYou?: ForYouItem[]; events?: ServerEvent[] }) => {
      if (change.forYou) items = change.forYou;
    },
  } as unknown as StateManager;
  const autoReserve = vi.fn((): AutoVerdict => ({ ok: true, projectId: "p1", label: "1 de 99 hoje" }));
  const decideOrganize = vi.fn(async () => undefined);
  const service = new ForYouService({
    state,
    log: { error: vi.fn() },
    now: () => new Date(AT),
    types: { ensure: (type?: string) => type ?? "outro", resolve: (type?: string) => type ?? "outro", list: () => [] },
    decideTask: vi.fn(),
    autoReserve,
    ...(options.withDecide === false ? {} : { decideOrganize }),
  });
  const open = () => service.openSpecial({ kind: "organizacao", agentId: "maestro", roomId: "sala-a", title: "Organizar o Cérebro de Sala A", text: PLAN.summary, organize: PLAN });
  return { service, items: () => items, autoReserve, decideOrganize, open };
}

describe("cartão de organização do Cérebro (kind organizacao) do Para você", () => {
  it("nasce pendente com a proposta guardada; nenhum modo automático o decide e o lote o recusa", async () => {
    const { service, open, autoReserve, items } = setup();
    const card = open();
    expect(card).toMatchObject({ kind: "organizacao", status: "pendente", organize: PLAN, type: "outro" });
    expect(autoReserve).not.toHaveBeenCalled();
    expect(service.autoDecision(task(), [card])).toBeUndefined();
    await expect(service.decideBatch([card.id])).rejects.toMatchObject({ statusCode: 400 });
    expect(items()[0]!.status).toBe("pendente");
  });

  it("aprovar chama a decisão com o `skip` do dono uma vez, fecha como decidido pelo dono e não decide duas vezes nem reabre", async () => {
    const { service, open, decideOrganize } = setup();
    const card = open();
    const done = await service.decide(card.id, { status: "aprovado", organize: { skip: [2] } });
    expect(decideOrganize).toHaveBeenCalledWith(expect.objectContaining({ id: card.id }), { status: "aprovado", organize: { skip: [2] } });
    expect(done).toMatchObject({ status: "aprovado", decidedBy: "usuario", decidedAt: AT });
    await expect(service.decide(card.id, { status: "aprovado" })).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.decide(card.id, { status: "pendente" })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("já foi decidida") });
    expect(decideOrganize).toHaveBeenCalledOnce();
  });

  it("se a decisão falha (Cérebro apagado), o item continua pendente; recusar fecha com o motivo", async () => {
    const { service, open, decideOrganize, items } = setup();
    const card = open();
    decideOrganize.mockRejectedValueOnce(Object.assign(new Error("O Cérebro não existe mais"), { statusCode: 409 }));
    await expect(service.decide(card.id, { status: "aprovado" })).rejects.toMatchObject({ statusCode: 409 });
    expect(items()[0]!.status).toBe("pendente");
    const done = await service.decide(card.id, { status: "rejeitado", reason: "Agora não" });
    expect(done).toMatchObject({ status: "rejeitado", rejection: { reason: "Agora não" } });
  });

  it("não se responde nem se altera por fora, mas o dono pode cancelar; o cancelamento em massa de um pedido não o toca", async () => {
    const { service, open } = setup();
    const card = open();
    await expect(service.decide(card.id, { status: "respondido", response: "ok" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.update(card.id, { title: "outro" }, "maestro")).rejects.toMatchObject({ statusCode: 409 });
    expect(await service.cancelAllFor(new Set(["t1", "p1"]), { by: "maestro" })).toEqual([]);
    const cancelled = await service.cancel(card.id, { by: "usuario" });
    expect(cancelled.status).toBe("cancelado");
  });

  it("updateOrganize grava o que valeu no cartão; sem decideOrganize a decisão é 409", async () => {
    const { service, open, items } = setup();
    const card = open();
    await service.updateOrganize(card.id, { ...PLAN, skipped: [0] });
    expect(items()[0]!.organize).toMatchObject({ skipped: [0] });
    const off = setup({ withDecide: false });
    const other = off.open();
    await expect(off.service.decide(other.id, { status: "aprovado" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("decidido, vai para o arquivo como qualquer item (a varredura não o segura)", async () => {
    const { service, open, items } = setup();
    const card = open();
    await service.decide(card.id, { status: "aprovado" });
    const later = Date.parse(AT) + 40 * 86_400_000;
    expect(dueForArchive(items(), later, 7).map((item) => item.id)).toEqual([card.id]);
  });
});
