import { dayRange, HOUR_MS, MAX_GAP_MS, STATE_FLUSH_MS, STATE_TICK_MS, type ClockMs, type StateDayFile } from "@cyno/shared";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { WriteQueue } from "../../store/write-queue";
import { StateClock, type DesiredSpan } from "./state-clock";
import { currentStates } from "./states";

// 11/11/2026 em São Paulo (UTC-3).
const T = (hhmm: string, day = "2026-11-11") => Date.parse(`${day}T${hhmm}:00.000Z`);
const MIN = 60_000;
const log = { warn: () => undefined };
const tempDir = useTempDirs();

type Harness = { clock: StateClock; dir: string; set: (spans: DesiredSpan[]) => void; at: (ms: number) => void; go: (ms: number) => void; queue: WriteQueue };

async function harness(options: { dir?: string; now?: number; spans?: DesiredSpan[]; names?: boolean } = {}): Promise<Harness> {
  const dir = options.dir ?? path.join(await tempDir(), "day-stats");
  let spans = options.spans ?? [];
  let now = options.now ?? T("12:00");
  const queue = new WriteQueue();
  const clock = new StateClock({
    dir,
    queue,
    states: () => spans,
    names: options.names === false ? undefined : () => ({ agents: new Map([["eco", "Eco"], ["ana", "Ana"]]), projects: new Map([["site", "Site novo"]]), sprints: new Map([["site:S1", "Sprint 1"]]) }),
    now: () => now,
    log,
  });
  return {
    clock,
    dir,
    queue,
    set: (next) => (spans = next),
    at: (ms) => (now = ms),
    // Anda até `ms` como o servidor anda: um batimento a cada STATE_TICK_MS (sem batimento, o buraco seria uma lacuna).
    go: (ms) => {
      while (now < ms) {
        now = Math.min(ms, now + STATE_TICK_MS);
        clock.tick();
      }
    },
  };
}

const span = (over: Partial<DesiredSpan> = {}): DesiredSpan => ({ taskId: "t1", state: "working", agentId: "eco", ...over });
const fileOf = (dir: string, day = "2026-11-11"): StateDayFile => JSON.parse(readFileSync(path.join(dir, `${day}.json`), "utf8")) as StateDayFile;
const totalOf = (file: StateDayFile, key: keyof ClockMs) => file.buckets.reduce((sum, bucket) => sum + bucket.ms[key], 0);

describe("StateClock", () => {
  it("fecha o trecho na troca de estado e soma na hora certa, por agente, projeto e sprint", async () => {
    const h = await harness();
    h.clock.start({ timers: false });
    h.set([span({ projectId: "site", sprintId: "S1" })]);
    h.clock.observe();
    h.go(T("12:30"));
    h.set([span({ state: "waiting_maestro", projectId: "site", sprintId: "S1" })]);
    h.clock.observe();
    h.go(T("12:45"));
    h.set([]);
    h.clock.observe();
    await h.clock.stop();
    const file = fileOf(h.dir);
    expect(file.buckets).toHaveLength(1);
    expect(file.buckets[0]!.t).toBe(T("12:00"));
    expect(file.buckets[0]!.ms).toMatchObject({ working: 30 * MIN, waiting_maestro: 15 * MIN, queued: 0 });
    expect(file.buckets[0]!.byAgent).toEqual([["eco", expect.objectContaining({ working: 30 * MIN, waiting_maestro: 15 * MIN })]]);
    expect(file.buckets[0]!.byProject[0]).toEqual(["site", expect.objectContaining({ working: 30 * MIN })]);
    expect(file.buckets[0]!.bySprint[0]).toEqual(["site:S1", expect.objectContaining({ waiting_maestro: 15 * MIN })]);
    expect(file.names.agents).toEqual([["eco", "Eco"]]);
    expect(file.names.sprints).toEqual([["site:S1", "Sprint 1"]]);
  });

  it("um trecho atravessa a virada de hora e a meia-noite (dois dias, dois arquivos)", async () => {
    const h = await harness({ now: T("02:30", "2026-11-12"), spans: [span()] });
    h.clock.start({ timers: false });
    h.go(T("03:30", "2026-11-12"));
    h.set([]);
    h.clock.observe();
    await h.clock.stop();
    // 23:30 de 11/11 até 00:30 de 12/11 em São Paulo.
    expect(fileOf(h.dir, "2026-11-11").buckets.map((bucket) => [bucket.t, bucket.ms.working])).toEqual([[T("02:00", "2026-11-12"), 30 * MIN]]);
    expect(fileOf(h.dir, "2026-11-12").buckets.map((bucket) => [bucket.t, bucket.ms.working])).toEqual([[T("03:00", "2026-11-12"), 30 * MIN]]);
  });

  it("o tick soma o parcial sem fechar o trecho e o arquivo só sai a cada 30 s", async () => {
    const h = await harness({ spans: [span()] });
    h.clock.start({ timers: false });
    h.go(T("12:00") + STATE_TICK_MS);
    expect(h.clock.read("2026-11-11")!.buckets[0]!.ms.working).toBe(STATE_TICK_MS);
    expect(h.clock.openCount()).toBe(1);
    // O primeiro batimento gravou; o seguinte só grava 30 s depois.
    h.go(T("12:00") + 2 * STATE_TICK_MS + 1);
    await h.queue.idle();
    expect(totalOf(fileOf(h.dir), "working")).toBe(STATE_TICK_MS);
    h.go(T("12:00") + STATE_TICK_MS + STATE_FLUSH_MS);
    await h.queue.idle();
    expect(totalOf(fileOf(h.dir), "working")).toBe(STATE_TICK_MS + STATE_FLUSH_MS);
    expect(fileOf(h.dir).liveAt).toBe(T("12:00") + STATE_TICK_MS + STATE_FLUSH_MS);
  });

  it("transições fora de ordem e relógio andando para trás não somam tempo negativo nem em dobro", async () => {
    const h = await harness({ spans: [span()] });
    h.clock.start({ timers: false });
    h.go(T("12:10"));
    h.at(T("12:05"));
    h.clock.tick();
    h.go(T("12:20"));
    h.set([]);
    h.clock.observe();
    await h.clock.stop();
    // 12:00-12:10 (primeiro tick) + 12:10-12:20 (a volta não soma e o trecho segue de onde estava).
    expect(totalOf(fileOf(h.dir), "working")).toBe(20 * MIN);
    // Dois estados na mesma tarefa em sequência rápida: cada um fica com o seu tempo.
    const second = await harness({ spans: [span({ state: "queued" })] });
    second.clock.start({ timers: false });
    second.go(T("12:10"));
    second.set([span({ state: "working" })]);
    second.clock.observe();
    second.go(T("12:25"));
    second.set([span({ state: "queued" })]);
    second.clock.observe();
    second.go(T("12:30"));
    await second.clock.stop();
    expect(fileOf(second.dir).buckets[0]!.ms).toMatchObject({ queued: 10 * MIN + 5 * MIN, working: 15 * MIN });
  });

  it("agente trocado ou projeto trocado na mesma tarefa fecha o trecho e abre outro", async () => {
    const h = await harness({ spans: [span({ projectId: "site" })] });
    h.clock.start({ timers: false });
    h.go(T("12:10"));
    h.set([span({ projectId: "outro" })]);
    h.clock.observe();
    h.go(T("12:20"));
    await h.clock.stop();
    const bucket = fileOf(h.dir).buckets[0]!;
    expect(Object.fromEntries(bucket.byProject.map(([id, ms]) => [id, ms.working]))).toEqual({ site: 10 * MIN, outro: 10 * MIN });
  });

  it("reinício no meio de um trecho: o que já foi somado fica, o tempo parado não vira trabalho", async () => {
    const first = await harness({ spans: [span()] });
    first.clock.start({ timers: false });
    first.go(T("12:00") + STATE_TICK_MS);
    await first.clock.flush();
    await first.queue.idle();
    // O servidor cai; volta 2 h depois e a tarefa ainda está "em andamento".
    const second = await harness({ dir: first.dir, now: T("14:00"), spans: [span()] });
    second.clock.start({ timers: false });
    expect(second.clock.read("2026-11-11")!.liveAt).toBe(T("12:00") + STATE_TICK_MS);
    second.go(T("14:10"));
    await second.clock.stop();
    const file = fileOf(first.dir);
    expect(totalOf(file, "working")).toBe(STATE_TICK_MS + 10 * MIN);
    expect(file.buckets.map((bucket) => bucket.t)).toEqual([T("12:00"), T("14:00")]);
  });

  it("lacuna maior que 120 s entre batimentos (a máquina dormiu) não é integrada", async () => {
    const h = await harness({ spans: [span()] });
    h.clock.start({ timers: false });
    h.go(T("12:00") + STATE_TICK_MS);
    // Dorme por 1 h e acorda: o trecho só conta até o último batimento.
    h.at(T("13:00") + STATE_TICK_MS);
    h.clock.tick();
    h.go(T("13:00") + 2 * STATE_TICK_MS);
    await h.clock.stop();
    expect(totalOf(fileOf(h.dir), "working")).toBe(STATE_TICK_MS + STATE_TICK_MS);
    expect(MAX_GAP_MS).toBe(120_000);
  });

  it("parar fecha os trechos abertos em agora e uma segunda parada não faz nada", async () => {
    const h = await harness({ spans: [span({ state: "engine_blocked" })] });
    h.clock.start({ timers: false });
    h.go(T("12:07"));
    await h.clock.stop();
    await h.clock.stop();
    expect(fileOf(h.dir).buckets[0]!.ms.engine_blocked).toBe(7 * MIN);
    expect(h.clock.openCount()).toBe(0);
  });

  it("dois workspaces: pastas separadas, sem misturar", async () => {
    const a = await harness({ spans: [span({ agentId: "eco" })] });
    const b = await harness({ spans: [span({ agentId: "ana", state: "queued" })] });
    for (const h of [a, b]) {
      h.clock.start({ timers: false });
      h.go(T("12:10"));
      await h.clock.stop();
    }
    expect(a.dir).not.toBe(b.dir);
    expect(fileOf(a.dir).buckets[0]!.byAgent.map(([id]) => id)).toEqual(["eco"]);
    expect(fileOf(b.dir).buckets[0]!.byAgent.map(([id]) => id)).toEqual(["ana"]);
    expect(totalOf(fileOf(b.dir), "queued")).toBe(10 * MIN);
    expect(totalOf(fileOf(b.dir), "working")).toBe(0);
  });

  it("a data de início do registro fica gravada e sobrevive ao reinício", async () => {
    const first = await harness({ now: T("12:00") });
    first.clock.start({ timers: false });
    expect(first.clock.since()).toBe(T("12:00"));
    await first.clock.stop();
    const second = await harness({ dir: first.dir, now: T("18:00", "2026-11-12") });
    second.clock.start({ timers: false });
    expect(second.clock.since()).toBe(T("12:00"));
    await second.clock.stop();
  });

  it("retenção: apaga os dias com mais de 90 dias ao abrir; os recentes ficam", async () => {
    const dir = path.join(await tempDir(), "day-stats");
    mkdirSync(dir, { recursive: true });
    const stub = (day: string) => JSON.stringify({ v: 1, day, names: { agents: [], projects: [], sprints: [] }, buckets: [], liveAt: 1 });
    for (const day of ["2026-01-01", "2026-08-12", "2026-08-13", "2026-11-10"]) writeFileSync(path.join(dir, `${day}.json`), stub(day));
    const h = await harness({ dir });
    h.clock.start({ timers: false });
    // Hoje é 11/11: o corte é 13/08 (90 dias antes).
    expect(readdirSync(dir).filter((name) => name.endsWith(".json") && name !== "meta.json")).toEqual(["2026-08-13.json", "2026-11-10.json"]);
    expect(h.clock.days()).toEqual(["2026-08-13", "2026-11-10"]);
    await h.clock.stop();
  });

  it("arquivo corrompido vira .corrupt e o dia recomeça sem derrubar nada", async () => {
    const dir = path.join(await tempDir(), "day-stats");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "2026-11-11.json"), "{ isso nao é json");
    writeFileSync(path.join(dir, "2026-11-10.json"), JSON.stringify({ v: 9, lixo: true }));
    const h = await harness({ dir, spans: [span()] });
    h.clock.start({ timers: false });
    h.go(T("12:10"));
    await h.clock.stop();
    // Os dois arquivos ruins (JSON quebrado e versão errada) foram separados ao abrir.
    expect(readdirSync(dir).filter((name) => name.endsWith(".corrupt"))).toHaveLength(2);
    expect(totalOf(fileOf(dir), "working")).toBe(10 * MIN);
    expect(h.clock.read("2026-11-10")).toBeUndefined();
  });

  it("lê de volta o que gravou (ida e volta), com os baldes ordenados", async () => {
    const h = await harness({ spans: [span()] });
    h.clock.start({ timers: false });
    h.go(T("14:20"));
    await h.clock.stop();
    const again = await harness({ dir: h.dir, now: T("20:00") });
    again.clock.start({ timers: false });
    const read = again.clock.read("2026-11-11")!;
    expect(read.buckets.map((bucket) => bucket.t)).toEqual([T("12:00"), T("13:00"), T("14:00")]);
    expect(read.buckets.map((bucket) => bucket.ms.working)).toEqual([HOUR_MS, HOUR_MS, 20 * MIN]);
    expect(read.buckets[0]!.t).toBeGreaterThanOrEqual(dayRange("2026-11-11").start);
    await again.clock.stop();
  });
});

describe("currentStates (tarefas -> o que o relógio observa)", () => {
  const task = (over: Record<string, unknown>) => ({ id: "t1", roomId: "r", teamId: "tm", agentId: "eco", prompt: "x", status: "in_progress", createdAt: "", updatedAt: "", ...over }) as never;
  const project = (over: Record<string, unknown> = {}) =>
    ({ id: "site", title: "Site", status: "ativo", tasks: [{ ref: "T1", status: "em_andamento", sprintId: "S1" }], ...over }) as never;

  it("tarefa de projeto leva projeto e sprint; terminal parado tira o trabalho; pausado não conta", () => {
    const base = { tasks: [task({ work: { projectId: "site", ref: "T1", step: 0 } })], projects: [project()], terminals: {} };
    expect(currentStates(base)).toEqual([{ taskId: "t1", state: "working", agentId: "eco", projectId: "site", sprintId: "S1" }]);
    expect(currentStates({ ...base, terminals: { eco: { agentId: "eco", status: "busy" } as never } })).toHaveLength(1);
    expect(currentStates({ ...base, terminals: { eco: { agentId: "eco", status: "stopped" } as never } })).toEqual([]);
    expect(currentStates({ ...base, projects: [project({ status: "pausado" })] })).toEqual([]);
    expect(currentStates({ tasks: [task({ agentId: undefined })], projects: [], terminals: {} })).toEqual([]);
    expect(currentStates({ tasks: [task({ status: "queued" }), task({ id: "t2", status: "waiting_approval" }), task({ id: "t3", role: "request" })], projects: [], terminals: {} })).toEqual([{ taskId: "t1", state: "queued", agentId: "eco" }]);
  });
});

describe("StateClock parado", () => {
  it("sem trecho aberto nem balde alterado, uma hora de relógio não grava nada; com trecho aberto grava no ritmo de antes", async () => {
    const h = await harness();
    h.clock.start({ timers: false });
    h.go(T("13:00"));
    await h.queue.idle();
    expect(readdirSync(h.dir).filter((name) => name.endsWith(".json") && name !== "meta.json")).toEqual([]);
    h.set([span()]);
    h.clock.observe();
    h.go(T("13:00") + STATE_TICK_MS);
    await h.queue.idle();
    expect(fileOf(h.dir).liveAt).toBe(T("13:00") + STATE_TICK_MS);
    h.go(T("13:00") + STATE_TICK_MS + STATE_FLUSH_MS);
    await h.queue.idle();
    expect(totalOf(fileOf(h.dir), "working")).toBe(STATE_TICK_MS + STATE_FLUSH_MS);
    h.go(T("13:05"));
    await h.clock.stop();
    expect(totalOf(fileOf(h.dir), "working")).toBe(5 * MIN);
  });
});
