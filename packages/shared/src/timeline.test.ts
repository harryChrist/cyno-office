import { describe, expect, it } from "vitest";
import {
  applyChanges,
  cloneFrame,
  diffFrames,
  emptyFrame,
  frameOf,
  isDayKey,
  keyframeOf,
  mergeParts,
  parseTimeline,
  sliceTimeline,
  spanOfTimeline,
  type SceneAgent,
  type SceneFrame,
  type TimelineRecord,
} from "./timeline";

const avatar = { skin: "tone3", hair: "bun", hairColor: "ink", shirt: "mint", pants: "denim" };
const agent = (id: string, extra: Partial<SceneAgent> = {}): SceneAgent => ({ id, name: id, role: "Dev", teamId: "t1", avatar, status: "idle", ...extra });

function frameWith(agents: SceneAgent[]): SceneFrame {
  const frame = emptyFrame();
  frame.rooms.set("r1", { id: "r1", name: "Sala", kind: "team", gx: 0, gy: 0 });
  frame.teams.set("t1", { id: "t1", roomId: "r1", name: "Time" });
  for (const a of agents) frame.agents.set(a.id, a);
  return frame;
}

const plain = (frame: SceneFrame) => JSON.parse(JSON.stringify({ rooms: [...frame.rooms], teams: [...frame.teams], agents: [...frame.agents] }));

describe("timeline: quadro e mudanças", () => {
  it("quadro completo gravado e relido dá o mesmo estado", () => {
    const frame = frameWith([agent("ana", { status: "working", tool: { id: "x", at: 5, icon: "📖", text: "Lendo", name: "Read" } }), agent("bia")]);
    const back = frameOf(JSON.parse(JSON.stringify(keyframeOf(frame, 1_000, 300_000, true))));
    expect(plain(back)).toEqual(plain(frame));
  });

  it("diff nulo quando nada mudou; patch só com o que mudou; null apaga o campo; agente novo vem completo e saída vira null", () => {
    const before = frameWith([agent("ana", { status: "working", asking: "aprovar X" })]);
    expect(diffFrames(before, cloneFrame(before))).toBeNull();
    const after = frameWith([agent("ana", { status: "idle" }), agent("bia")]);
    const changes = diffFrames(before, after)!;
    expect(changes.agents).toEqual([
      ["ana", { status: "idle", asking: null }],
      ["bia", agent("bia")],
    ]);
    const gone = diffFrames(after, frameWith([agent("bia")]))!;
    expect(gone.agents).toEqual([["ana", null]]);
  });

  it("aplicar as mudanças reconstrói o quadro novo sem alterar os objetos antigos", () => {
    const before = frameWith([agent("ana", { status: "working", asking: "aprovar X" })]);
    const original = before.agents.get("ana")!;
    const after = frameWith([agent("ana", { status: "idle" }), agent("bia")]);
    const frame = cloneFrame(before);
    applyChanges(frame, diffFrames(before, after)!);
    expect(plain(frame)).toEqual(plain(after));
    expect(original.status).toBe("working");
    expect(original.asking).toBe("aprovar X");
  });

  it("patch de agente desconhecido que não vem completo é ignorado", () => {
    const frame = frameWith([]);
    applyChanges(frame, { agents: [["fantasma", { status: "working" }]] });
    expect(frame.agents.size).toBe(0);
  });
});

describe("timeline: leitura defensiva", () => {
  const k = (at: number, agents: SceneAgent[] = []): TimelineRecord => keyframeOf(frameWith(agents), at, 300_000);
  const lines = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n");

  it("ignora linha cortada, vazia e inválida e segura o relógio que volta", () => {
    const text = `${lines([k(1_000)])}\n\nnão é json\n{"t":"d","at":"x"}\n${JSON.stringify({ t: "d", at: 500, agents: [["a", null]] })}\n{"t":"d","at":2000,"agents":[["a",nu`;
    const parsed = parseTimeline(text);
    expect(parsed.map((r) => [r.t, r.at])).toEqual([
      ["k", 1_000],
      ["d", 1_000],
    ]);
  });

  it("isDayKey só aceita datas do calendário", () => {
    expect(isDayKey("2026-11-12")).toBe(true);
    expect(isDayKey("2026-02-30")).toBe(false);
    expect(isDayKey("../etc/passwd")).toBe(false);
    expect(isDayKey(20261112)).toBe(false);
  });

  it("spanOfTimeline lê o primeiro e o último horário sem interpretar o arquivo", () => {
    const text = `${lines([k(1_000), { t: "d", at: 2_000 }, { t: "end", at: 3_500, reason: "stop" }])}\n{"t":"d","at":9`;
    expect(spanOfTimeline(text)).toEqual({ from: 1_000, to: 3_500 });
    expect(spanOfTimeline("")).toBeNull();
  });

  it("o recorte leva o quadro completo que vale no começo e juntar as partes devolve o dia", () => {
    const records: TimelineRecord[] = [k(1_000, [agent("a")]), { t: "d", at: 2_000, agents: [["a", { status: "working" }]] }, k(3_000, [agent("a", { status: "working" })]), { t: "d", at: 4_000, agents: [["a", { status: "idle" }]] }, { t: "end", at: 5_000 }];
    const first = sliceTimeline(records, 0, 3_000);
    const second = sliceTimeline(records, 3_000, 6_000);
    expect(first.map((r) => r.at)).toEqual([1_000, 2_000, 3_000]);
    expect(second.map((r) => r.at)).toEqual([3_000, 4_000, 5_000]);
    expect(mergeParts([{ from: 0, records: first }, { from: 3_000, records: second }]).map((r) => r.at)).toEqual([1_000, 2_000, 3_000, 4_000, 5_000]);
  });
});
