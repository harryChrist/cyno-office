import { emptyFrame, keyframeOf, type SceneAgent, type SceneFrame, type TimelineRecord } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { Reproducao, contar, hourTicks } from "./reproducao";

const MIN = 60_000;
const T0 = Date.parse("2026-11-11T11:00:00.000Z"); // 08:00 em São Paulo
const avatar = { skin: "tone3", hair: "bun", hairColor: "ink", shirt: "mint", pants: "denim" };
const agent = (id: string, teamId: string, extra: Partial<SceneAgent> = {}): SceneAgent => ({ id, name: id, role: "Dev", teamId, avatar, status: "idle", ...extra });

function frame(agents: SceneAgent[]): SceneFrame {
  const f = emptyFrame();
  f.rooms.set("m", { id: "m", name: "Maestro", kind: "maestro", gx: 0, gy: 0 });
  f.rooms.set("r", { id: "r", name: "Sala", kind: "team", gx: 1, gy: 0 });
  f.teams.set("tm", { id: "tm", roomId: "m", name: "Gerência" });
  f.teams.set("t", { id: "t", roomId: "r", name: "Time" });
  for (const a of agents) f.agents.set(a.id, a);
  return f;
}
const k = (at: number, agents: SceneAgent[], boot = false): TimelineRecord => keyframeOf(frame(agents), at, 300_000, boot);
const d = (at: number, agents: [string, Record<string, unknown> | null][]): TimelineRecord => ({ t: "d", at, agents: agents as never });

/** Uma manhã: 3 agentes, trabalho, uma espera pelo dono, um pico, a gravação para. */
function manha(): TimelineRecord[] {
  return [
    k(T0, [agent("mae", "tm"), agent("ana", "t"), agent("bia", "t")], true),
    d(T0 + 10 * MIN, [["ana", { status: "working" }], ["bia", { status: "working" }]]),
    d(T0 + 20 * MIN, [["bia", { status: "waiting_approval", asking: "aprovar o post" }]]),
    k(T0 + 30 * MIN, [agent("mae", "tm"), agent("ana", "t", { status: "working" }), agent("bia", "t", { status: "waiting_approval", asking: "aprovar o post" })]),
    d(T0 + 40 * MIN, [["bia", { status: "idle", asking: null }], ["ana", { status: "idle" }]]),
    { t: "end", at: T0 + 50 * MIN, reason: "stop" },
  ];
}

const plain = (r: Reproducao) => JSON.parse(JSON.stringify([...r.quadro().agents]));

describe("Reproducao: buscar um instante", () => {
  it("buscar em qualquer ordem dá o mesmo que tocar em sequência", () => {
    const instantes = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50].map((m) => T0 + m * MIN + 1);
    const sequencial = new Reproducao("2026-11-11", manha());
    const esperado = instantes.map((t) => {
      sequencial.moveTo(t);
      return plain(sequencial);
    });
    const embaralhado = new Reproducao("2026-11-11", manha());
    const ordem = [7, 2, 9, 0, 10, 4, 8, 1, 6, 3, 5];
    for (const i of ordem) {
      embaralhado.moveTo(instantes[i]!);
      expect(plain(embaralhado)).toEqual(esperado[i]);
    }
    // e de novo, de trás para a frente
    for (const i of [...ordem].reverse()) {
      embaralhado.moveTo(instantes[i]!);
      expect(plain(embaralhado)).toEqual(esperado[i]);
    }
  });

  it("antes da gravação e depois do fim marcado não há dados; o silêncio longo também", () => {
    const r = new Reproducao("2026-11-11", manha());
    r.moveTo(T0 - MIN);
    expect(r.isOff(T0 - MIN)).toBe(true);
    r.moveTo(T0 + 5 * MIN);
    expect(r.isOff(T0 + 5 * MIN)).toBe(false);
    r.moveTo(T0 + 50 * MIN);
    expect(r.isOff(T0 + 50 * MIN)).toBe(true);
    const buraco = new Reproducao("2026-11-11", [k(T0, [agent("ana", "t")], true), k(T0 + 3 * 3_600_000, [agent("ana", "t")], true)]);
    buraco.moveTo(T0 + 3_600_000);
    expect(buraco.isOff(T0 + 3_600_000)).toBe(true);
    buraco.moveTo(T0 + 3 * 3_600_000);
    expect(buraco.isOff(T0 + 3 * 3_600_000)).toBe(false);
  });

  it("o limite do dia é reconhecido", () => {
    const r = new Reproducao("2026-11-11", [k(T0, [agent("ana", "t")], true), { t: "end", at: T0 + MIN, reason: "limit" }]);
    r.moveTo(T0 + MIN);
    expect(r.limited).toBe(true);
    expect(r.isOff(T0 + MIN)).toBe(true);
  });
});

describe("Reproducao: o retrato passa pelo adaptador", () => {
  it("trabalhando, esperando o dono, parado e sem dados saem como no ao vivo", () => {
    const r = new Reproducao("2026-11-11", manha());
    const em = (min: number) => {
      const t = T0 + min * MIN + 1;
      r.moveTo(t);
      return r.retrato(t, "w", "Meu workspace");
    };
    const trabalhando = em(15);
    expect(trabalhando.rooms.map((s) => s.name)).toEqual(["Maestro", "Sala"]);
    expect(trabalhando.agents.find((a) => a.id === "ana")).toMatchObject({ status: "working", roomId: "r" });
    const esperando = em(25);
    expect(esperando.agents.find((a) => a.id === "bia")).toMatchObject({ status: "waiting", waitingFor: expect.stringContaining("aprovar o post") });
    const parado = em(45);
    expect(parado.agents.find((a) => a.id === "ana")?.status).toBe("idle");
    const fim = em(55);
    expect(fim.agents).toEqual([]);
  });

  it("a ferramenta gravada vira a atividade do agente e o motor sem cota vira a espera", () => {
    const quadro = [agent("ana", "t", { status: "working", engine: "claude", tool: { id: "tu1", at: T0 + 1_000, icon: "📖", text: "Lendo App.tsx", name: "Read" } }), agent("bia", "t", { engine: "claude", unavailable: "sem cota · volta às 14:30" })];
    const r = new Reproducao("2026-11-11", [k(T0, quadro, true)]);
    r.moveTo(T0 + 2_000);
    const retrato = r.retrato(T0 + 2_000, "w", "W");
    expect(retrato.agents.find((a) => a.id === "ana")?.activity).toMatchObject({ icon: "📖", text: "Lendo App.tsx", kind: "read" });
    const bia = retrato.agents.find((a) => a.id === "bia")!;
    expect(bia.status).toBe("shell");
    expect(bia.shells?.[0]?.label).toMatch(/sem cota/i);
  });
});

describe("Reproducao: o gráfico e os picos", () => {
  it("conta presentes, trabalhando e esperando o dono por minuto", () => {
    const r = new Reproducao("2026-11-11", manha());
    const buckets = r.buckets();
    const em = (min: number) => buckets.find((b) => b.at === T0 + min * MIN)!;
    expect(em(0)).toMatchObject({ present: 3, working: 0, waiting: 0 });
    expect(em(15)).toMatchObject({ present: 3, working: 2, waiting: 0 });
    expect(em(25)).toMatchObject({ present: 3, working: 1, waiting: 1 });
    expect(contar(frame([agent("a", "t", { terminal: { status: "error" } })]))).toEqual({ present: 1, working: 0, waiting: 1 });
  });

  it("os picos são os minutos com mais gente trabalhando, espaçados, em ordem de hora", () => {
    const rep = new Reproducao("2026-11-11", manha());
    const picos = rep.peaks();
    expect(picos.some((p) => p.working === 2 && p.present === 3)).toBe(true);
    for (let i = 1; i < picos.length; i++) expect(picos[i]!.at - picos[i - 1]!.at).toBeGreaterThanOrEqual(10 * MIN);
    const longo: TimelineRecord[] = [k(T0, [agent("ana", "t", { status: "working" })], true), d(T0 + 3 * 3_600_000, [["ana", { status: "idle" }]])];
    const varios = [...longo];
    for (let h = 1; h < 3; h++) varios.splice(h, 0, k(T0 + h * 3_600_000, [agent("ana", "t", { status: "working" }), agent("bia", "t", { status: "working" })]));
    const picos2 = new Reproducao("2026-11-11", varios).peaks();
    expect(picos2.length).toBeGreaterThan(1);
    expect(picos2.map((p) => p.at)).toEqual([...picos2.map((p) => p.at)].sort((a, b) => a - b));
  });

  it("as marcas de hora são horas cheias de São Paulo", () => {
    const ticks = hourTicks(T0, T0 + 5 * 3_600_000);
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) expect(t % 3_600_000).toBe(0);
    expect(ticks[0]).toBe(T0 + 3_600_000); // 09:00
  });
});
