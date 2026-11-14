import { HARD_LIMIT_BYTES, KEYFRAME_MS, SOFT_LIMIT_BYTES, applyChanges, cloneFrame, emptyFrame, frameOf, parseTimeline, type SceneAgent, type SceneFrame } from "@cyno/shared";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RETRY_AFTER_FAILURE_MS, TimelineRecorder, timelineFile } from "./recorder";
import { TimelineService } from "./service";

const avatar = { skin: "tone3", hair: "bun", hairColor: "ink", shirt: "mint", pants: "denim" };
const agent = (id: string, extra: Partial<SceneAgent> = {}): SceneAgent => ({ id, name: id, role: "Dev", teamId: "t1", avatar, status: "idle", ...extra });
const DAY = "2026-11-11";
const T0 = Date.parse("2026-11-11T15:00:00.000Z");

let dir: string;
let now: number;
let current: SceneFrame;
const warnings: unknown[] = [];
const log = { warn: (o: unknown) => void warnings.push(o) };

function frame(agents: SceneAgent[]): SceneFrame {
  const f = emptyFrame();
  f.rooms.set("r1", { id: "r1", name: "Sala", kind: "team", gx: 0, gy: 0 });
  f.teams.set("t1", { id: "t1", roomId: "r1", name: "Time" });
  for (const a of agents) f.agents.set(a.id, a);
  return f;
}
const make = () => new TimelineRecorder({ dir, now: () => now, log, sample: () => cloneFrame(current) });
const records = (day = DAY) => parseTimeline(readFileSync(timelineFile(dir, day), "utf8"));
const plain = (f: SceneFrame) => JSON.parse(JSON.stringify([[...f.rooms], [...f.teams], [...f.agents]]));

/** Reconstrói o estado em `at` tocando em sequência. */
function stateAt(list: ReturnType<typeof records>, at: number): SceneFrame {
  let f = emptyFrame();
  for (const r of list) {
    if (r.at > at) break;
    if (r.t === "k") f = frameOf(r);
    else if (r.t === "d") applyChanges(f, r);
  }
  return f;
}

beforeEach(() => {
  dir = path.join(mkdtempSync(path.join(tmpdir(), "cyno-tl-test-")), "timeline");
  now = T0;
  current = frame([agent("ana")]);
  warnings.length = 0;
});
afterEach(() => rmSync(path.dirname(dir), { recursive: true, force: true }));

describe("TimelineRecorder", () => {
  it("o primeiro registro é o quadro completo do boot; mudança vira delta, no máximo uma por segundo", () => {
    const rec = make();
    rec.start({ timers: false });
    rec.tick();
    expect(records().map((r) => [r.t, "boot" in r ? r.boot : undefined])).toEqual([["k", true]]);
    current = frame([agent("ana", { status: "working" })]);
    rec.observe();
    now += 400;
    rec.tick();
    expect(records()).toHaveLength(1); // ainda dentro do segundo
    now += 700;
    rec.tick();
    current = frame([agent("ana", { status: "idle" })]);
    rec.observe();
    now += 1_100;
    rec.tick();
    expect(records().map((r) => r.t)).toEqual(["k", "d", "d"]);
  });

  it("sem mudança não grava; quadro completo a cada 5 minutos", () => {
    const rec = make();
    rec.start({ timers: false });
    rec.tick();
    for (let i = 0; i < 20; i++) {
      now += 2_500;
      rec.tick();
    }
    expect(records()).toHaveLength(1);
    now += KEYFRAME_MS;
    rec.tick();
    expect(records().map((r) => r.t)).toEqual(["k", "k"]);
    expect((records()[1] as { boot?: boolean }).boot).toBeUndefined();
  });

  it("gravar e reler dá o mesmo estado em qualquer instante, e buscar em qualquer ordem dá o mesmo que tocar em sequência", () => {
    const rec = make();
    rec.start({ timers: false });
    const states: Array<[number, SceneFrame]> = [];
    const script: SceneAgent[][] = [[agent("ana")], [agent("ana", { status: "working", tool: { id: "t", at: 1, icon: "📖", text: "Lendo", name: "Read" } })], [agent("ana", { status: "working" }), agent("bia")], [agent("bia", { asking: "aprovar" })], [agent("bia")]];
    script.forEach((agents, i) => {
      current = frame(agents);
      rec.observe();
      now += 7_000 + i;
      rec.tick();
      states.push([now, cloneFrame(current)]);
    });
    const list = records();
    for (const [at, expected] of [...states].reverse()) expect(plain(stateAt(list, at))).toEqual(plain(expected));
    for (const [at, expected] of states) expect(plain(stateAt(list, at))).toEqual(plain(expected));
  });

  it("reinício no meio do dia: acrescenta ao arquivo, começa numa linha nova se a última ficou cortada e marca o boot", () => {
    const first = make();
    first.start({ timers: false });
    first.tick();
    writeFileSync(timelineFile(dir, DAY), `${readFileSync(timelineFile(dir, DAY), "utf8")}{"t":"d","at":${now + 5},"agents":[["a",nu`);
    now += 60_000;
    const second = make();
    second.start({ timers: false });
    second.tick();
    const list = records();
    expect(list.map((r) => r.t)).toEqual(["k", "k"]);
    expect((list[1] as { boot?: boolean }).boot).toBe(true);
  });

  it("stop marca o fim; virada do dia começa outro arquivo por um quadro completo", () => {
    const rec = make();
    rec.start({ timers: false });
    rec.tick();
    rec.stop();
    expect(records().at(-1)).toMatchObject({ t: "end", reason: "stop" });
    const other = make();
    other.start({ timers: false });
    other.tick();
    now = Date.parse("2026-11-12T15:00:00.000Z");
    other.tick();
    expect(records("2026-11-12").map((r) => r.t)).toEqual(["k"]);
    expect((records("2026-11-12")[0] as { boot?: boolean }).boot).toBeUndefined();
  });

  it("retenção de 7 dias: apaga os mais velhos e ignora nome que não é dia", async () => {
    mkdirSync(dir, { recursive: true });
    for (const name of ["2026-11-01.jsonl", "2026-11-04.jsonl", "2026-11-05.jsonl", "notas.jsonl"]) writeFileSync(path.join(dir, name), "{}\n");
    const rec = make();
    rec.start({ timers: false });
    const left = await new TimelineService({ dir, enabled: true, now: () => now, log, source: () => ({}) as never }).days();
    expect(left).toEqual([]); // arquivos sem registro válido não entram na lista
    expect(() => readFileSync(path.join(dir, "2026-11-01.jsonl"))).toThrow();
    expect(() => readFileSync(path.join(dir, "2026-11-04.jsonl"))).toThrow();
    expect(readFileSync(path.join(dir, "2026-11-05.jsonl"), "utf8")).toBe("{}\n");
    expect(readFileSync(path.join(dir, "notas.jsonl"), "utf8")).toBe("{}\n");
  });

  it("acima de 8 MB afrouxa (mudança a cada 15 s); acima de 12 MB para até a virada", () => {
    mkdirSync(dir, { recursive: true });
    const pad = (bytes: number) => `${"x".repeat(bytes - 1)}\n`;
    writeFileSync(timelineFile(dir, DAY), pad(SOFT_LIMIT_BYTES + 10));
    const rec = make();
    rec.start({ timers: false });
    rec.tick(); // quadro completo
    current = frame([agent("ana", { status: "working" })]);
    rec.observe();
    now += 2_000;
    rec.tick();
    expect(parseTimeline(readFileSync(timelineFile(dir, DAY), "utf8")).map((r) => r.t)).toEqual(["k"]);
    now += 14_000;
    rec.tick();
    expect(parseTimeline(readFileSync(timelineFile(dir, DAY), "utf8")).map((r) => r.t)).toEqual(["k", "d"]);

    writeFileSync(timelineFile(dir, DAY), pad(HARD_LIMIT_BYTES + 10));
    const hard = make();
    hard.start({ timers: false });
    hard.tick();
    expect(parseTimeline(readFileSync(timelineFile(dir, DAY), "utf8")).at(-1)).toMatchObject({ t: "end", reason: "limit" });
    const size = readFileSync(timelineFile(dir, DAY)).length;
    now += 60_000;
    hard.tick();
    expect(readFileSync(timelineFile(dir, DAY)).length).toBe(size);
  });

  it("falha de disco: avisa uma vez, tenta de novo em 1 minuto com quadro completo", () => {
    mkdirSync(path.dirname(dir), { recursive: true });
    writeFileSync(dir, "sou um arquivo, não uma pasta");
    const rec = make();
    rec.start({ timers: false });
    rec.tick();
    now += 2_000;
    rec.tick();
    expect(warnings).toHaveLength(1);
    rmSync(dir);
    mkdirSync(dir);
    now += RETRY_AFTER_FAILURE_MS;
    rec.tick();
    expect(records().map((r) => r.t)).toEqual(["k"]);
  });

  it("a leitura de um arquivo corrompido devolve o que dá e a lista de dias traz o tamanho e o intervalo", async () => {
    const rec = make();
    rec.start({ timers: false });
    rec.tick();
    current = frame([agent("ana", { status: "working" })]);
    rec.observe();
    now += 2_000;
    rec.tick();
    writeFileSync(timelineFile(dir, DAY), `lixo\n${readFileSync(timelineFile(dir, DAY), "utf8")}{"t":"d","at":1`);
    const service = new TimelineService({ dir, enabled: true, now: () => now, log, source: () => ({}) as never });
    expect((await service.readDay(DAY))?.map((r) => r.t)).toEqual(["k", "d"]);
    expect(await service.days()).toEqual([expect.objectContaining({ day: DAY, from: T0, to: T0 + 2_000 })]);
    expect(await service.readDay("../x")).toBeUndefined();
    expect((await service.readPart(DAY, T0, T0 + 5_000))?.split("\n")).toHaveLength(2); // o quadro que vale + a mudança
  });

  it("a lista de dias de um arquivo grande (com o primeiro quadro maior que a cabeça lida) traz o intervalo certo sem ler tudo", async () => {
    mkdirSync(dir, { recursive: true });
    const grande = "x".repeat(6_000);
    const linhas = [`{"t":"k","at":${T0},"v":1,"every":300000,"rooms":[],"teams":[],"agents":[],"nota":"${grande}"}`];
    for (let i = 1; i <= 400; i++) linhas.push(`{"t":"d","at":${T0 + i * 1000},"agents":[["a",{"status":"idle","x":"${"y".repeat(800)}"}]]}`);
    writeFileSync(timelineFile(dir, DAY), `${linhas.join("\n")}\n{"t":"d","at":${T0 + 999_999},"ag`);
    const service = new TimelineService({ dir, enabled: true, now: () => now, log, source: () => ({}) as never });
    expect(await service.days()).toEqual([expect.objectContaining({ day: DAY, from: T0, to: T0 + 400_000 })]);
  });
});
