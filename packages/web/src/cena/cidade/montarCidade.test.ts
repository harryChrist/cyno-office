import { cardSummarySchema, type Card } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { atribuirLotes, guardarLotes, lerLotes, loteDoIndice } from "./lotes";
import { montarCidade, resumirWorkspace, temaDaEpoca } from "./montarCidade";

const AGORA = new Date("2026-06-10T15:00:00Z");

const ficha = (workspace: string, mudar: Partial<Card> = {}): Card => ({
  workspace,
  name: workspace.toUpperCase(),
  summary: cardSummarySchema.parse({ summary: "Faz coisas." }),
  team: { rooms: [{ id: "r1", name: "Sala" }], agents: [], maestro: { engine: "claude", status: "ocioso" } },
  engines: [],
  sites: [],
  connectors: [],
  routines: [],
  projects: { active: [], counts: {} },
  deliveries: [],
  waitingForYou: 0,
  waitingIds: [],
  usage: { turns5h: 0 },
  updatedAt: "2026-06-10T15:00:00.000Z",
  ...mudar,
});
const agente = (id: string, terminal: Card["team"]["agents"][number]["terminal"]) => ({ id, name: id, engine: "claude", terminal });
const comTime = (terminais: Card["team"]["agents"][number]["terminal"][], maestro: Card["team"]["maestro"]["status"] = "ocioso", mais: Partial<Card> = {}): Card =>
  ficha("w", { team: { rooms: [{ id: "r1", name: "Sala" }], agents: terminais.map((t, i) => agente(`a${i}`, t)), maestro: { engine: "claude", status: maestro } }, ...mais });

describe("os lotes da espiral", () => {
  it("os 12 primeiros lotes são os do Habblaud", () => {
    const lotes = Array.from({ length: 12 }, (_, i) => loteDoIndice(i));
    expect(lotes.map((l) => `${l.x},${l.y}`)).toEqual(["3,0", "4,0", "5,0", "3,1", "4,1", "5,1", "3,2", "4,2", "5,2", "3,3", "4,3", "5,3"]);
  });

  it("o lote 13 em diante vai para o quarteirão seguinte da espiral (a oeste da praça não é o 13º)", () => {
    // depois de (1,0) e (1,1) a espiral vai para oeste: o quarteirão (0,1) fica abaixo da praça, lotes x 0..2, y 2..3
    expect(loteDoIndice(12)).toEqual({ x: 0, y: 2 });
  });

  it("quem já tem lote o mantém, o novo pega o menor livre e quem some libera", () => {
    const a = atribuirLotes(["a", "b", "c"], {});
    expect(a).toEqual({ a: 0, b: 1, c: 2 });
    const semB = atribuirLotes(["a", "c"], a);
    expect(semB).toEqual({ a: 0, c: 2 });
    const novo = atribuirLotes(["a", "c", "d"], semB);
    expect(novo).toEqual({ a: 0, c: 2, d: 1 });
    // um quarto: segue a fila
    expect(atribuirLotes(["a", "c", "d", "e"], novo).e).toBe(3);
  });

  it("dois ids com o mesmo índice guardado: o segundo é realocado", () => {
    expect(atribuirLotes(["a", "b"], { a: 4, b: 4 })).toEqual({ a: 4, b: 0 });
  });

  it("lê e guarda no armazenamento, e ignora lixo", () => {
    const mem = new Map<string, string>();
    const armazem = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(lerLotes(armazem)).toEqual({});
    guardarLotes({ a: 2, b: 5 }, armazem);
    expect(lerLotes(armazem)).toEqual({ a: 2, b: 5 });
    mem.set("cyno.cidade.lotes", '{"a":-1,"b":"x","c":3}');
    expect(lerLotes(armazem)).toEqual({ c: 3 });
    mem.set("cyno.cidade.lotes", "não é json");
    expect(lerLotes(armazem)).toEqual({});
    expect(lerLotes(null)).toEqual({});
  });
});

describe("montarCidade em tabela", () => {
  it.each([0, 1, 3, 12])("%i workspaces viram %i prédios, cada um no seu lote", (n) => {
    const fichas = Array.from({ length: n }, (_, i) => ficha(`w${i}`));
    const cidade = montarCidade(fichas, AGORA);
    expect(cidade.predios).toHaveLength(n);
    expect(new Set(cidade.predios.map((p) => `${p.lot.x},${p.lot.y}`)).size).toBe(n);
    if (n > 0) expect(cidade.predios[0]!.lot).toEqual({ district: "cyno", x: 3, y: 0 });
    if (n === 12) expect(cidade.predios[11]!.lot).toMatchObject({ x: 5, y: 3 });
    expect(Object.keys(cidade.lotes)).toHaveLength(n);
  });

  it("a posição é estável ao criar e ao apagar workspaces", () => {
    const um = montarCidade([ficha("a"), ficha("b"), ficha("c")], AGORA);
    const semB = montarCidade([ficha("a"), ficha("c")], AGORA, um.lotes);
    expect(semB.predios.map((p) => [p.id, p.lot.x, p.lot.y])).toEqual([
      ["a", 3, 0],
      ["c", 5, 0],
    ]);
    const comD = montarCidade([ficha("a"), ficha("c"), ficha("d")], AGORA, semB.lotes);
    expect(comD.predios.find((p) => p.id === "a")!.lot).toMatchObject({ x: 3, y: 0 });
    expect(comD.predios.find((p) => p.id === "c")!.lot).toMatchObject({ x: 5, y: 0 });
    expect(comD.predios.find((p) => p.id === "d")!.lot).toMatchObject({ x: 4, y: 0 });
  });

  it("o letreiro leva o nome do workspace", () => {
    expect(montarCidade([ficha("loja", { name: "Loja do Zé" })], AGORA).predios[0]!.owner.name).toBe("Loja do Zé");
  });

  it("janela acesa é agente trabalhando; o Maestro ocupado também", () => {
    const r = resumirWorkspace(comTime(["busy", "ready", "stopped"], "ocupado"));
    expect(r.agentes).toBe(4);
    expect(r.janelas).toEqual({ acesa: 2, ambar: 0, apagada: 2 });
    const b = montarCidade([comTime(["busy", "ready", "stopped"], "ocupado")], AGORA).predios[0]!;
    expect(b.agents).toEqual({ total: 4, working: 2, waiting: 0, idle: 2 });
    expect(b.state).toBe("online");
  });

  it("âmbar é o que espera o dono; o selo leva o número", () => {
    const c = comTime(["busy", "ready", "ready"], "ocioso", { waitingForYou: 2, waitingIds: ["x", "y"] });
    const r = resumirWorkspace(c);
    expect(r.janelas).toEqual({ acesa: 1, ambar: 2, apagada: 1 });
    const b = montarCidade([c], AGORA).predios[0]!;
    expect(b.agents).toMatchObject({ working: 1, waiting: 2 });
    expect(b.likes).toBe(2);
  });

  it("se todos trabalham e algo espera, uma janela vira âmbar (o prédio nunca pisca sem janela)", () => {
    const r = resumirWorkspace(comTime(["busy", "busy"], "ocupado", { waitingForYou: 1, waitingIds: ["x"] }));
    expect(r.janelas).toEqual({ acesa: 2, ambar: 1, apagada: 0 });
  });

  it("à toa: tudo apagado mas o prédio continua aceso (online)", () => {
    const b = montarCidade([comTime(["ready", "ready"])], AGORA).predios[0]!;
    expect(b.state).toBe("online");
    expect(b.agents).toMatchObject({ working: 0, waiting: 0 });
  });

  it("workspace parado: o prédio inteiro apagado", () => {
    const parado = comTime(["stopped", "error"], "parado");
    expect(resumirWorkspace(parado).parado).toBe(true);
    expect(montarCidade([parado], AGORA).predios[0]!.state).toBe("away");
  });

  it("projeto ativo ou item esperando impede o prédio de apagar", () => {
    expect(resumirWorkspace(comTime(["stopped"], "parado", { projects: { active: [{ id: "p", title: "P", status: "ativo" }], counts: {} } })).parado).toBe(false);
    expect(resumirWorkspace(comTime(["stopped"], "parado", { waitingForYou: 1, waitingIds: ["x"] })).parado).toBe(false);
  });

  it("andares: um por sala, e mais um a cada 6 agentes", () => {
    expect(resumirWorkspace(ficha("a")).andares).toBe(1);
    const tresSalas = ficha("a", { team: { rooms: [1, 2, 3].map((n) => ({ id: `r${n}`, name: `S${n}` })), agents: [], maestro: { engine: "claude", status: "ocioso" } } });
    expect(resumirWorkspace(tresSalas).andares).toBe(3);
    expect(resumirWorkspace(comTime(Array(12).fill("ready"))).andares).toBe(3);
  });

  it("a praça soma prédios acesos, agentes trabalhando e o que espera o dono", () => {
    const cidade = montarCidade([comTime(["busy", "busy"], "ocioso", { workspace: "a" }), ficha("b"), comTime(["busy", "ready", "ready"], "ocioso", { workspace: "c", waitingForYou: 3, waitingIds: ["a", "b", "c"] })], AGORA);
    expect(cidade.acesos).toBe(2);
    expect(cidade.trabalhando).toBe(3);
    expect(cidade.esperando).toBe(3);
  });

  it("o tema de época segue o calendário do escritório", () => {
    expect(temaDaEpoca(new Date("2026-10-15T12:00:00"))).toBe("halloween");
    expect(temaDaEpoca(new Date("2026-11-12T12:00:00"))).toBe("christmas");
    expect(temaDaEpoca(new Date("2026-12-27T12:00:00"))).toBe("none");
    expect(temaDaEpoca(new Date("2026-06-10T12:00:00"))).toBe("none");
    expect(montarCidade([ficha("a")], new Date("2026-11-12T12:00:00")).predios[0]!.theme).toBe("christmas");
  });
});
