// A planta: salas na ordem do prédio, agentes nas mesas pela ordem dos times. Criar, apagar, renomear e mover agente
// não muda a vaga das outras salas nem a identidade (id, semente, aparência) de ninguém.
import type { Agent, OfficeState, Room, Team } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { makeAgent, makeRoom } from "../../test-fixtures";
import { memoriaDeJson, memoriaInicial, memoriaParaJson, montarRetrato, ordenarSalas, type EntradaDoRetrato, type MemoriaDaCena } from "@cyno/shared/cena";

const AGORA = Date.parse("2026-11-12T12:00:00.000Z");

const sala = (id: string, x: number, y: number, extra: Partial<Room> = {}): Room => makeRoom(id, { name: id, gridPosition: { x, y }, ...extra });
const time = (id: string, roomId: string): Team => ({ id, roomId, name: id, focus: "" });

function predio(extra: { rooms?: Room[]; teams?: Team[]; agents?: Agent[] } = {}): OfficeState {
  return {
    rooms: extra.rooms ?? [sala("maestro", 5, 5, { kind: "maestro", name: "Sala do Maestro" }), sala("balcao", 0, -1), sala("redacao", 0, 1)],
    teams: extra.teams ?? [time("ger", "maestro"), time("atendimento", "balcao"), time("conteudo", "redacao"), time("video", "redacao")],
    agents: extra.agents ?? [makeAgent("maestro-1", "ger"), makeAgent("ana", "conteudo"), makeAgent("beto", "video"), makeAgent("caio", "atendimento")],
    tasks: [],
  };
}

const entrada = (office: OfficeState, agora = AGORA): EntradaDoRetrato => ({ workspaceId: "ws", workspaceName: "WS", office, progress: {}, forYou: [], projects: [], terminals: {}, logs: {}, indisponiveis: {}, agora });
const passo = (office: OfficeState, memoria: MemoriaDaCena, agora = AGORA) => montarRetrato(entrada(office, agora), memoria);
const ordemDeSalas = (retrato: ReturnType<typeof passo>) => retrato.snapshot.rooms.map((r) => r.id);

describe("ordem das salas", () => {
  it("na primeira carga: Maestro primeiro, depois linha e coluna do mapa antigo", () => {
    const salas = ordenarSalas([sala("z", 0, 1), sala("maestro", 9, 9, { kind: "maestro" }), sala("a", 0, -1), sala("b", -1, 0)]);
    expect(salas.map((s) => s.id)).toEqual(["maestro", "a", "b", "z"]);
  });

  it("criar uma sala: ela entra no fim e as outras mantêm a vaga, mesmo que o mapa antigo a pusesse no meio", () => {
    const antes = passo(predio(), memoriaInicial(AGORA));
    const comNova = predio({ rooms: [...predio().rooms, sala("lab", -1, 0)], teams: [...predio().teams, time("pesquisa", "lab")] });
    const depois = passo(comNova, antes.memoria, AGORA + 1_000);
    expect(ordemDeSalas(antes)).toEqual(["maestro", "balcao", "redacao"]);
    expect(ordemDeSalas(depois)).toEqual(["maestro", "balcao", "redacao", "lab"]);
    expect(depois.snapshot.rooms.map((r) => r.slot)).toEqual([0, 1, 2, 3]);
  });

  it("recarregar a página (memória do JSON) mantém a mesma ordem", () => {
    const comNova = predio({ rooms: [...predio().rooms, sala("lab", -1, 0)], teams: [...predio().teams, time("pesquisa", "lab")] });
    const a = passo(predio(), memoriaInicial(AGORA));
    const b = passo(comNova, a.memoria, AGORA + 1);
    const recarregada = memoriaDeJson(memoriaParaJson(b.memoria), AGORA + 5);
    expect(ordemDeSalas(passo(comNova, recarregada, AGORA + 10))).toEqual(ordemDeSalas(b));
  });

  it("apagar uma sala não muda a ordem relativa das outras; recriar com o mesmo id volta para o fim", () => {
    const completo = predio({ rooms: [...predio().rooms, sala("lab", -1, 0)], teams: [...predio().teams, time("pesquisa", "lab")] });
    const a = passo(completo, passo(predio(), memoriaInicial(AGORA)).memoria, AGORA + 1);
    const semBalcao = predio({ rooms: completo.rooms.filter((r) => r.id !== "balcao"), teams: completo.teams.filter((t) => t.roomId !== "balcao"), agents: completo.agents.filter((x) => x.id !== "caio") });
    const b = passo(semBalcao, a.memoria, AGORA + 2);
    expect(ordemDeSalas(b)).toEqual(["maestro", "redacao", "lab"]);
    const c = passo(completo, b.memoria, AGORA + 3);
    expect(ordemDeSalas(c)).toEqual(["maestro", "redacao", "lab", "balcao"]);
  });

  it("renomear a sala: mesma id e mesma vaga, só o nome muda", () => {
    const a = passo(predio(), memoriaInicial(AGORA));
    const renomeada = predio({ rooms: predio().rooms.map((r) => (r.id === "redacao" ? { ...r, name: "Redação 2" } : r)) });
    const b = passo(renomeada, a.memoria, AGORA + 1);
    const antes = a.snapshot.rooms.find((r) => r.id === "redacao")!;
    const depois = b.snapshot.rooms.find((r) => r.id === "redacao")!;
    expect(depois).toMatchObject({ id: "redacao", name: "Redação 2", slot: antes.slot, seed: antes.seed });
  });
});

describe("a sala do Maestro no retrato", () => {
  it("só a sala do Maestro leva o tipo `maestro` (o motor desenha a planta própria dela); o Maestro tem o papel dele", () => {
    const retrato = passo(predio(), memoriaInicial(AGORA));
    expect(retrato.snapshot.rooms.map((r) => [r.id, r.kind ?? null])).toEqual([["maestro", "maestro"], ["balcao", null], ["redacao", null]]);
    expect(retrato.snapshot.agents.find((a) => a.id === "maestro-1")!.role).toBe("Maestro");
    expect(retrato.snapshot.agents.filter((a) => a.role === "Maestro")).toHaveLength(1);
  });

  it("o tipo vale mesmo com agentes de time na sala do Maestro (caso raro): eles continuam na mesma sala", () => {
    const office = predio({ agents: [...predio().agents, makeAgent("extra", "ger")] });
    const retrato = passo(office, memoriaInicial(AGORA));
    expect(retrato.snapshot.agents.filter((a) => a.roomId === "maestro").map((a) => a.id).sort()).toEqual(["extra", "maestro-1"]);
    expect(retrato.snapshot.rooms[0]!.kind).toBe("maestro");
  });
});

describe("mesas: a ordem dos agentes", () => {
  it("a sala do time vem primeiro por time (ordem dos times), líder antes, depois a chegada", () => {
    const office = predio({ teams: [time("ger", "maestro"), time("atendimento", "balcao"), { ...time("conteudo", "redacao"), leadAgentId: "dora" }, time("video", "redacao")], agents: [makeAgent("maestro-1", "ger"), makeAgent("beto", "video"), makeAgent("ana", "conteudo"), makeAgent("dora", "conteudo")] });
    const ids = passo(office, memoriaInicial(AGORA)).snapshot.agents.map((a) => a.id);
    expect(ids).toEqual(["maestro-1", "dora", "ana", "beto"]);
  });

  it("agente novo não muda a identidade (id, semente, aparência) nem a ordem relativa de quem já estava", () => {
    const a = passo(predio(), memoriaInicial(AGORA));
    const comNovo = predio({ agents: [...predio().agents, makeAgent("eva", "conteudo")] });
    const b = passo(comNovo, a.memoria, AGORA + 1_000);
    const ids = (r: typeof a) => r.snapshot.agents.map((x) => x.id);
    expect(ids(b).filter((id) => id !== "eva")).toEqual(ids(a));
    for (const ant of a.snapshot.agents) {
      const dep = b.snapshot.agents.find((x) => x.id === ant.id)!;
      expect({ seed: dep.seed, parts: dep.parts, look: dep.look, startedAt: dep.startedAt, roomId: dep.roomId }).toEqual({ seed: ant.seed, parts: ant.parts, look: ant.look, startedAt: ant.startedAt, roomId: ant.roomId });
    }
    expect(b.snapshot.agents.find((x) => x.id === "eva")!.startedAt).toBe(AGORA + 1_000);
  });

  it("mover o agente de time: só a sala dele muda (o motor o leva andando); identidade e a mesa dos outros ficam", () => {
    const a = passo(predio(), memoriaInicial(AGORA));
    const movido = predio({ agents: predio().agents.map((x) => (x.id === "ana" ? { ...x, teamId: "atendimento" } : x)) });
    const b = passo(movido, a.memoria, AGORA + 1_000);
    const ana0 = a.snapshot.agents.find((x) => x.id === "ana")!;
    const ana1 = b.snapshot.agents.find((x) => x.id === "ana")!;
    expect(ana0.roomId).toBe("redacao");
    expect(ana1.roomId).toBe("balcao");
    expect({ seed: ana1.seed, parts: ana1.parts, startedAt: ana1.startedAt }).toEqual({ seed: ana0.seed, parts: ana0.parts, startedAt: ana0.startedAt });
    // Quem não saiu de lugar continua na mesma sala e com a mesma ordem relativa.
    for (const id of ["beto", "caio", "maestro-1"]) expect(b.snapshot.agents.find((x) => x.id === id)!.roomId).toBe(a.snapshot.agents.find((x) => x.id === id)!.roomId);
    expect(b.snapshot.agents.filter((x) => x.roomId === "balcao").map((x) => x.id)).toEqual(["ana", "caio"]);
  });
});
