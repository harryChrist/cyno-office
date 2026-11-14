import { findOfficeRuleViolations, type ApiErrorBody, type ServerEvent, type Room } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, createRoom, getOffice } from "../../dev/test-api";
import { useTestApp } from "../../dev/test-app";

const setupApp = useTestApp();

const setSharing = (app: Parameters<typeof call>[0], id: string, body: object, status = 200) =>
  call<Room>(app, "PATCH", `/api/w/principal/rooms/${id}/brain-sharing`, body, status);

async function setup() {
  const testApp = await setupApp();
  const [a, b, c] = [
    await createRoom(testApp.app, "A"),
    await createRoom(testApp.app, "B"),
    await createRoom(testApp.app, "C"),
  ];
  return { ...testApp, a, b, c };
}

async function readsById(app: Parameters<typeof call>[0]): Promise<Record<string, string[]>> {
  const office = await getOffice(app);
  expect(findOfficeRuleViolations(office)).toEqual([]);
  return Object.fromEntries(office.rooms.map((ws) => [ws.id, [...ws.readsBrainsOf].sort()]));
}

describe("compartilhamento do Cérebro entre quartos", () => {
  it("não é simétrico: A lendo B e C não faz B nem C lerem A (repetidos somem)", async () => {
    const { app, a, b, c } = await setup();
    const updated = await setSharing(app, a.id, { readsBrainsOf: [b.id, c.id, b.id] });
    expect(updated.readsBrainsOf).toEqual([b.id, c.id]);
    const all = await readsById(app);
    expect(all[a.id]).toEqual([b.id, c.id]);
    expect(all[b.id]).toEqual([]);
    expect(all[c.id]).toEqual([]);
  });

  it("a lista é completa e só o próprio quarto muda (um room:upserted)", async () => {
    const { app, log, a, b, c } = await setup();
    await setSharing(app, a.id, { readsBrainsOf: [b.id, c.id] });
    const from = log.events.length;
    await setSharing(app, a.id, { readsBrainsOf: [c.id] });
    expect((await readsById(app))[a.id]).toEqual([c.id]);
    const changed = log.events
      .slice(from)
      .filter((event): event is Extract<ServerEvent, { type: "room:upserted" }> => event.type === "room:upserted")
      .map((event) => event.room.id);
    expect(changed).toEqual([a.id]);
  });

  it("vale para qualquer quarto, vizinho ou não no grid", async () => {
    const { app, a, c } = await setup();
    await setSharing(app, c.id, { readsBrainsOf: [a.id] });
    expect((await readsById(app))[c.id]).toEqual([a.id]);
  });

  it("rejeita o próprio quarto (400), ids inexistentes (404), reservados (400) e campos antigos (400) sem mudar nada", async () => {
    const { app, a, b } = await setup();
    await setSharing(app, a.id, { readsBrainsOf: [b.id] });
    const before = await readsById(app);
    const self = await setSharing(app, a.id, { readsBrainsOf: [a.id] }, 400);
    expect(self).toEqual({ error: "Uma sala já lê o próprio Cérebro: não o liste" } satisfies ApiErrorBody);
    await setSharing(app, a.id, { readsBrainsOf: ["nao-existe"] }, 404);
    await setSharing(app, a.id, { readsBrainsOf: ["lobby"] }, 400);
    await setSharing(app, a.id, { connections: [] }, 400);
    await setSharing(app, a.id, { hasLobbyDoor: true }, 400);
    await setSharing(app, "nao-existe", { readsBrainsOf: [] }, 404);
    expect(await readsById(app)).toEqual(before);
  });

  it("liga e desliga a leitura do Cérebro global sem mexer na lista", async () => {
    const { app, a, b } = await setup();
    await setSharing(app, a.id, { readsBrainsOf: [b.id] });
    const on = await setSharing(app, a.id, { readsGlobalBrain: true });
    expect(on).toMatchObject({ readsGlobalBrain: true, readsBrainsOf: [b.id] });
    const off = await setSharing(app, a.id, { readsGlobalBrain: false });
    expect(off.readsGlobalBrain).toBe(false);
  });

  it("excluir um quarto o tira da lista de quem lia o Cérebro dele", async () => {
    const { app, a, b } = await setup();
    await setSharing(app, a.id, { readsBrainsOf: [b.id] });
    await call(app, "DELETE", `/api/w/principal/rooms/${b.id}`);
    expect((await readsById(app))[a.id]).toEqual([]);
  });
});
