import type { Room, Team } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, createAgent, createRoom, createTeam, getOffice, wsApi } from "../../dev/test-api";
import { useTestApp } from "../../dev/test-app";

const setupApp = useTestApp();

describe("tamanho, tipo e semente do layout da sala", () => {
  it("grava tamanho, tipo e semente; sem eles, o quarto fica sem os campos (auto/geral)", async () => {
    const { app } = await setupApp();
    const room = await createRoom(app, "Lab", { size: "p", purpose: "pesquisa", layoutSeed: 42 });
    expect(room).toMatchObject({ size: "p", purpose: "pesquisa", layoutSeed: 42 });
    const plain = await createRoom(app, "Comum");
    expect(plain).not.toHaveProperty("size");
    expect(plain).not.toHaveProperty("purpose");
    expect(plain).not.toHaveProperty("layoutSeed");

    const rerolled = await call<Room>(app, "PATCH", `${wsApi()}/rooms/${room.id}`, { layoutSeed: 7, size: "auto", purpose: "dev" });
    expect(rerolled).toMatchObject({ layoutSeed: 7, purpose: "dev", size: "auto" });
    await call(app, "PATCH", `${wsApi()}/rooms/${room.id}`, { layoutSeed: -1 }, 400);
  });

  it("o tamanho é só o piso inicial: nada é recusado por excesso de mesas ou de times", async () => {
    const { app } = await setupApp();
    const room = await createRoom(app, "Pequena", { size: "p" });
    for (let t = 0; t < 3; t++) {
      const team = await createTeam(app, room.id, `Time ${t}`);
      for (let a = 0; a < 3; a++) await createAgent(app, team.id, `Agente ${t}-${a}`);
    }
    const office = await getOffice(app);
    expect(office.agents.filter((agent) => office.teams.some((team) => team.roomId === room.id && team.id === agent.teamId))).toHaveLength(9);
    // Encolher o tamanho também nunca é recusado.
    await call(app, "PATCH", `${wsApi()}/rooms/${room.id}`, { size: "p" });
  });
});

describe("ajustes manuais dos móveis", () => {
  it("grava a lista completa (validada), volta ao gerado com lista vazia e some ao trocar a semente", async () => {
    const { app } = await setupApp();
    const room = await createRoom(app, "Oficina", { layoutSeed: 3 });
    const url = `${wsApi()}/rooms/${room.id}/furniture`;
    const edits = [
      { op: "move", key: "plant@0,0", i: 4, j: 5 },
      { op: "rotate", key: "seat:ana", facing: "SE" },
      { op: "remove", key: "lamp@2,3" },
      { op: "add", id: "add-1", kind: "sofa", i: 6, j: 6, facing: "SW", color: "denim" },
    ];
    const saved = await call<Room>(app, "PATCH", url, { edits });
    expect(saved.furnitureEdits).toEqual(edits);
    expect((await getOffice(app)).rooms.find((r) => r.id === room.id)?.furnitureEdits).toEqual(edits);

    // Corpo inválido: tipo que não se adiciona, coordenada negativa, id repetido, campo extra, lista grande.
    await call(app, "PATCH", url, { edits: [{ op: "add", id: "add-2", kind: "desk", i: 1, j: 1, facing: "SW" }] }, 400);
    await call(app, "PATCH", url, { edits: [{ op: "move", key: "plant@0,0", i: -1, j: 1 }] }, 400);
    await call(app, "PATCH", url, { edits: [edits[3], edits[3]] }, 400);
    await call(app, "PATCH", url, { edits: [{ op: "remove", key: "plant@0,0", extra: 1 }] }, 400);
    await call(app, "PATCH", url, { edits: Array.from({ length: 201 }, () => edits[0]) }, 400);
    await call(app, "PATCH", `${wsApi()}/rooms/nao-existe/furniture`, { edits: [] }, 404);

    // Mesma semente não apaga; semente nova descarta os ajustes.
    expect((await call<Room>(app, "PATCH", `${wsApi()}/rooms/${room.id}`, { layoutSeed: 3 })).furnitureEdits).toEqual(edits);
    expect(await call<Room>(app, "PATCH", `${wsApi()}/rooms/${room.id}`, { layoutSeed: 4 })).not.toHaveProperty("furnitureEdits");

    await call(app, "PATCH", url, { edits });
    expect(await call<Room>(app, "PATCH", url, { edits: [] })).not.toHaveProperty("furnitureEdits");
  });
});

describe("líder do time", () => {
  it("só aceita um agente do próprio time (400) e null tira o líder", async () => {
    const { app } = await setupApp();
    const room = await createRoom(app, "Sala");
    const team = await createTeam(app, room.id, "Time A");
    const other = await createTeam(app, room.id, "Time B");
    const lead = await createAgent(app, team.id, "Lider");
    const outsider = await createAgent(app, other.id, "De fora");

    const led = await call<Team>(app, "PATCH", `${wsApi()}/teams/${team.id}`, { leadAgentId: lead.id });
    expect(led.leadAgentId).toBe(lead.id);
    await call(app, "PATCH", `${wsApi()}/teams/${team.id}`, { leadAgentId: outsider.id }, 400);
    await call(app, "PATCH", `${wsApi()}/teams/${team.id}`, { leadAgentId: "nao-existe" }, 400);
    const cleared = await call<Team>(app, "PATCH", `${wsApi()}/teams/${team.id}`, { leadAgentId: null });
    expect(cleared).not.toHaveProperty("leadAgentId");
  });

  it("sai sozinho quando o líder é removido ou muda de time", async () => {
    const { app } = await setupApp();
    const room = await createRoom(app, "Sala");
    const team = await createTeam(app, room.id, "Time A");
    const other = await createTeam(app, room.id, "Time B");
    const first = await createAgent(app, team.id, "Primeiro");
    const second = await createAgent(app, team.id, "Segundo");

    await call(app, "PATCH", `${wsApi()}/teams/${team.id}`, { leadAgentId: first.id });
    await call(app, "DELETE", `${wsApi()}/agents/${first.id}`);
    let office = await getOffice(app);
    expect(office.teams.find((t) => t.id === team.id)).not.toHaveProperty("leadAgentId");

    await call(app, "PATCH", `${wsApi()}/teams/${team.id}`, { leadAgentId: second.id });
    await call(app, "PATCH", `${wsApi()}/agents/${second.id}`, { teamId: other.id });
    office = await getOffice(app);
    expect(office.teams.find((t) => t.id === team.id)).not.toHaveProperty("leadAgentId");
  });
});
