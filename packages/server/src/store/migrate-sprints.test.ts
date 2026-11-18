import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AVULSAS_ID, findMaestroAgent, projectSchema, type Project, type ProjectTask } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { principalDir } from "../dev/test-app";
import { useTempDirs } from "../dev/test-utils";
import { buildSeedOffice, seedDataDir } from "../workspace/office/seed";
import { readProjectsDir } from "./files";
import { migrateToSprints, planFold, remapForYouItem, remapRoutines, remapWork, SprintsMigrationError, whyNotFolded } from "./migrate-sprints";
import { OfficeStore } from "./office-store";
import { dataPaths } from "./paths";

const tempDir = useTempDirs();
const NOW = new Date("2026-11-11T15:00:00.000Z");
const day = (d: string, time = "10:00") => `${d}T${time}:00.000Z`;

const office = buildSeedOffice();
const maestro = findMaestroAgent(office)!;
const workers = office.agents.filter((agent) => agent.id !== maestro.id);
const [eco, crivo] = workers as [(typeof workers)[number], (typeof workers)[number]];
const teamOf = (agentId: string) => office.agents.find((agent) => agent.id === agentId)!.teamId;
const roomOf = (agentId: string) => office.teams.find((team) => team.id === teamOf(agentId))!.roomId;

function task(ref: string, agentId: string, status: ProjectTask["status"], extra: Partial<ProjectTask> = {}, subtaskId?: string): ProjectTask {
  const finished = status === "concluida" || status === "cancelada";
  return {
    ref,
    title: `Tarefa ${ref}`,
    briefing: "Faça isto",
    ownerId: agentId,
    steps: [{ agentId, what: "faz", status: finished ? "feita" : status === "em_andamento" ? "em_andamento" : "pendente", ...(subtaskId ? { taskId: subtaskId } : {}) }],
    current: 0,
    dependsOn: [],
    priority: "normal",
    doneWhen: [],
    status,
    rework: { count: 0 },
    updatedAt: day("2026-11-09"),
    ...extra,
  };
}

function project(id: string, kind: Project["kind"], status: Project["status"], tasks: ProjectTask[], extra: Partial<Project> = {}): Project {
  return { id, kind, title: `Projeto ${id}`, origin: "usuario", status, version: 1, priority: "normal", mode: { kind: "pede-ok" }, worked: {}, tasks, createdAt: day("2026-11-01"), updatedAt: day("2026-11-09"), ...extra } as Project;
}

/** Fixture no formato v3 (antes do Avulsas): projeto com etapas, tarefas simples abertas e antigas, rotina, Cyno e as exceções. */
function v3Fixture() {
  const plan = project("p-plan", "projeto", "ativo", [task("T1", eco.id, "concluida", { finishedAt: day("2026-11-05") }, "s-plan-1"), task("T2", crivo.id, "a_fazer")], { approvedAt: day("2026-11-01"), createdAt: day("2026-10-30") });
  const old = project("r-old", "tarefa", "concluido", [task("T1", eco.id, "concluida", { finishedAt: day("2026-09-01"), result: "pronto" }, "s-old")], { createdAt: day("2026-09-01"), finishedAt: day("2026-09-01") });
  const recent = project("r-recent", "tarefa", "concluido", [task("T1", eco.id, "concluida", { finishedAt: day("2026-11-09") }, "s-recent")], { createdAt: day("2026-11-09"), finishedAt: day("2026-11-09") });
  const open = project("r-open", "tarefa", "ativo", [task("T1", crivo.id, "em_andamento", { startedAt: day("2026-11-10") }, "s-open")], { createdAt: day("2026-11-10"), worked: { "2026-11-10": 5000 } });
  const routine = project("r-routine", "tarefa", "concluido", [task("T1", eco.id, "concluida", { finishedAt: day("2026-11-10", "08:30") }, "s-routine")], { origin: "rotina", routineRef: { routineId: "R-0001", scheduleId: "h1", slot: "2026-11-10T08:00" }, createdAt: day("2026-11-10", "08:00"), finishedAt: day("2026-11-10", "08:30") });
  const cyno = project("r-cyno", "tarefa", "ativo", [task("T1", crivo.id, "a_fazer")], { origin: "cyno", brief: "Briefing completo do Cyno", priority: "alta", dueAt: day("2026-11-20"), startAt: day("2026-11-11"), doneWhen: [{ id: "d1", text: "Entregar a arte" }], createdAt: day("2026-11-11", "09:00") });
  const auto = project("r-auto", "tarefa", "ativo", [task("T1", eco.id, "a_fazer", {}, undefined)], { mode: { kind: "automatico", grant: { actions: ["post"], approvedAt: day("2026-11-10") } } });
  const pace = project("r-pace", "tarefa", "ativo", [task("T1", eco.id, "a_fazer")], { pace: { hoursPerDay: 2 } });
  const joint = project("r-joint", "tarefa", "ativo", [task("T1", eco.id, "a_fazer")], { joint: { id: "J-0001", part: "p1", dependsOn: [] } });
  const empty = project("r-empty", "tarefa", "cancelado", [], { summary: "Pedido cancelado" });
  const paused = project("r-paused", "tarefa", "pausado", [task("T1", eco.id, "a_fazer")]);
  const projects = [plan, old, recent, open, routine, cyno, auto, pace, joint, empty, paused];

  const runner = (id: string, agentId: string, status: string, extra: Record<string, unknown> = {}) => ({ id, roomId: roomOf(agentId), teamId: teamOf(agentId), agentId, prompt: `Prompt de ${id}`, status, createdAt: day("2026-11-09"), updatedAt: day("2026-11-09"), ...extra });
  const tasks = [
    runner("r-old", maestro.id, "done", { role: "request", result: "ok" }),
    runner("r-open", maestro.id, "in_progress", { role: "request" }),
    runner("s-plan-1", eco.id, "done", { projectId: "p-plan", work: { projectId: "p-plan", ref: "T1", step: 0 } }),
    runner("s-old", eco.id, "done", { projectId: "r-old", work: { projectId: "r-old", ref: "T1", step: 0 } }),
    runner("s-recent", eco.id, "done", { projectId: "r-recent", work: { projectId: "r-recent", ref: "T1", step: 0 } }),
    runner("s-open", crivo.id, "in_progress", { projectId: "r-open", work: { projectId: "r-open", ref: "T1", step: 0 } }),
    runner("s-routine", eco.id, "done", { routineId: "R-0001", work: { projectId: "r-routine", ref: "T1", step: 0 } }),
    runner("s-auto", eco.id, "queued", { projectId: "r-auto", work: { projectId: "r-auto", ref: "T1", step: 0 } }),
  ];
  const item = (id: string, extra: Record<string, unknown>) => ({ id, agentId: eco.id, roomId: roomOf(eco.id), type: "post", status: "pendente", meta: {}, text: "t", originalText: "t", editedByUser: false, createdAt: day("2026-11-09"), ...extra });
  const forYou = [
    item("A-0001", { taskId: "s-old", projectId: "r-old", taskRef: "T1", status: "aprovado" }),
    item("A-0002", { taskId: "s-routine", taskRef: "T1" }),
    item("A-0003", { taskId: "r-open", projectId: "r-open" }),
    item("A-0004", { taskId: "r-open", projectId: "p-plan", kind: "plano" }),
    item("A-0005", { taskId: "s-auto", projectId: "r-auto", taskRef: "T1" }),
    item("A-0006", { taskId: "s-plan-1", projectId: "p-plan", taskRef: "T1" }),
    item("A-0007", { projectId: "orfao-que-nunca-existiu" }),
  ];
  const routines = { version: 2, routines: [{ id: "R-0001", lastRuns: [{ id: "run1", projectId: "r-routine", taskId: "s-routine", startedAt: day("2026-11-10", "08:00"), outcome: "ok" }] }], entries: [], executions: [{ id: "x", taskId: "s-routine" }], decisions: {}, results: [] };
  return { projects, tasks, forYou, routines };
}

async function v3Workspace(fixture = v3Fixture()) {
  const dataDir = await tempDir();
  await seedDataDir(dataDir);
  const dir = principalDir(dataDir);
  const paths = dataPaths(dir);
  await rm(path.join(paths.projectsDir, "avulsas.json"), { force: true });
  await writeFile(paths.schemaFile, JSON.stringify({ dataVersion: 3 }));
  await rm(paths.projectsDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  await mkdir(paths.projectsDir, { recursive: true });
  for (const item of fixture.projects) await writeFile(path.join(paths.projectsDir, `${item.id}.json`), JSON.stringify(item, null, 2));
  await rm(paths.tasksDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  await mkdir(paths.tasksDir, { recursive: true });
  await writeFile(path.join(paths.tasksDir, "2026-11.json"), JSON.stringify(fixture.tasks, null, 2));
  await rm(paths.forYouDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  await mkdir(paths.forYouDir, { recursive: true });
  await writeFile(path.join(paths.forYouDir, "2026-11.json"), JSON.stringify(fixture.forYou, null, 2));
  await writeFile(paths.routinesFile, JSON.stringify(fixture.routines, null, 2));
  return { dir, paths, fixture };
}

const migrate = (paths: ReturnType<typeof dataPaths>, extra: Parameters<typeof migrateToSprints>[1] = {}) => migrateToSprints(paths, { now: () => NOW, ...extra });

const snapshotDir = async (root: string) => {
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "backup") continue;
        await walk(file);
      } else if (entry.name !== "schema.json" && entry.name !== "migration-report-sprints.json") out[path.relative(root, file)] = await readFile(file, "utf8");
    }
  };
  await walk(root);
  return out;
};

describe("planFold (parte pura)", () => {
  it("só dobra o pedido simples comum; as exceções ficam como projeto", () => {
    const { projects } = v3Fixture();
    const reasons = Object.fromEntries(projects.map((candidate) => [candidate.id, whyNotFolded(candidate)]));
    expect(reasons).toMatchObject({
      "p-plan": undefined,
      "r-old": undefined,
      "r-auto": "modo automático próprio",
      "r-pace": "ritmo próprio",
      "r-joint": "parte de projeto conjunto",
      "r-empty": "sem tarefas (só o registro do pedido)",
      "r-paused": "pausado",
    });
    const fold = planFold(projects, NOW);
    expect([...fold.folded.keys()].sort()).toEqual(["r-cyno", "r-old", "r-open", "r-recent", "r-routine"]);
    expect(fold.kept.map((candidate) => candidate.id).sort()).toEqual(["p-plan", "r-auto", "r-empty", "r-joint", "r-pace", "r-paused"]);
  });

  it("a folha guarda o que era do projeto (prioridade, prazos, briefing, origem) e o arquivo só pega o que passou de 14 dias", () => {
    const fold = planFold(v3Fixture().projects, NOW);
    const live = new Map(fold.avulsas.tasks.map((leaf) => [leaf.meta!.requestId, leaf]));
    expect([...live.keys()].sort()).toEqual(["r-cyno", "r-open", "r-recent", "r-routine"]);
    expect([...fold.archive.keys()]).toEqual(["2026-09"]);
    expect(fold.archive.get("2026-09")!.map((leaf) => leaf.meta!.requestId)).toEqual(["r-old"]);
    const cyno = live.get("r-cyno")!;
    expect(cyno).toMatchObject({ priority: "alta", dueAt: day("2026-11-20"), startAt: day("2026-11-11"), title: "Projeto r-cyno", meta: { origin: "cyno", brief: "Briefing completo do Cyno" } });
    expect(cyno.doneWhen).toEqual([{ id: "d1", text: "Entregar a arte" }]);
    expect(live.get("r-routine")!.meta).toMatchObject({ origin: "rotina", routineRef: { routineId: "R-0001", scheduleId: "h1" } });
    expect(fold.avulsas).toMatchObject({ id: AVULSAS_ID, system: "avulsas", status: "ativo", worked: { "2026-11-10": 5000 } });
    expect(fold.avulsas.nextRef).toBe(6);
    expect(projectSchema.safeParse(fold.avulsas).success).toBe(true);
  });

  it("projeto cancelado com tarefa aberta vira folha cancelada; concluído, concluída", () => {
    const cancelled = project("c", "tarefa", "cancelado", [task("T1", eco.id, "em_andamento", { note: "x" })], { finishedAt: day("2026-11-10"), summary: "Pedido cancelado" });
    const done = project("d", "tarefa", "concluido", [task("T1", eco.id, "a_fazer")], { finishedAt: day("2026-11-10") });
    const fold = planFold([cancelled, done], NOW);
    const [a, b] = fold.avulsas.tasks;
    expect(a).toMatchObject({ status: "cancelada", failure: "Pedido cancelado", finishedAt: day("2026-11-10") });
    expect(a!.note).toBeUndefined();
    expect(b).toMatchObject({ status: "concluida", finishedAt: day("2026-11-10") });
  });

  it("remapWork, remapForYouItem e remapRoutines", () => {
    const fold = planFold(v3Fixture().projects, NOW);
    const ref = fold.folded.get("r-open")!.refs.get("T1")!;
    const work: Record<string, any> = { work: { projectId: "r-open", ref: "T1", step: 0 } }; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(remapWork(work, fold)).toBe(true);
    expect(work.work).toEqual({ projectId: AVULSAS_ID, ref, step: 0 });
    expect(remapWork(work, fold)).toBe(false);
    const item: Record<string, any> = { projectId: "r-open" }; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(remapForYouItem(item, fold, new Map())).toBe(true);
    expect(item).toEqual({ projectId: AVULSAS_ID, taskRef: ref });
    const routines = { routines: [{ lastRuns: [{ projectId: "r-open" }, { projectId: "p-plan" }] }] };
    expect(remapRoutines(routines, fold)).toBe(1);
    expect(routines.routines[0]!.lastRuns.map((run) => run.projectId)).toEqual([AVULSAS_ID, "p-plan"]);
  });
});

describe("migrateToSprints (disco)", () => {
  it("dobra os pedidos simples no Avulsas, remapeia Task.work, Para você e rotinas e grava o marcador por último", async () => {
    const { dir, paths, fixture } = await v3Workspace();
    const outcome = await migrate(paths);
    expect(outcome.status).toBe("migrated");
    expect(JSON.parse(await readFile(paths.schemaFile, "utf8"))).toMatchObject({ dataVersion: 4 });

    // projetos: os dobrados viram *.legacy.json; os outros ficam exatamente como estavam
    const files = await readdir(paths.projectsDir);
    expect(files).toEqual(expect.arrayContaining(["avulsas.json", "avulsas.archive", "r-old.legacy.json", "r-open.legacy.json", "p-plan.json", "r-auto.json", "r-joint.json", "r-pace.json", "r-empty.json", "r-paused.json"]));
    expect(files).not.toContain("r-old.json");
    expect(JSON.parse(await readFile(path.join(paths.projectsDir, "p-plan.json"), "utf8"))).toEqual(fixture.projects[0]);

    const store = await OfficeStore.open(dir);
    const projects = store.projectsSnapshot();
    const avulsas = projects.find((candidate) => candidate.id === AVULSAS_ID)!;
    expect(avulsas.tasks.map((leaf) => leaf.meta!.requestId).sort()).toEqual(["r-cyno", "r-open", "r-recent", "r-routine"]);
    expect(projects.filter((candidate) => candidate.kind === "tarefa" && candidate.id !== AVULSAS_ID).map((candidate) => candidate.id).sort()).toEqual(["r-auto", "r-empty", "r-joint", "r-pace", "r-paused"]);
    const archive = JSON.parse(await readFile(path.join(paths.projectsArchiveDir, "2026-09.json"), "utf8")) as ProjectTask[];
    expect(archive).toHaveLength(1);

    // nenhuma tarefa do runner sumiu e todo Task.work resolve
    const tasks = store.snapshot().tasks;
    expect(tasks).toHaveLength(fixture.tasks.length);
    const allLeaves = [...avulsas.tasks, ...archive];
    const leafOf = (id: string) => allLeaves.find((leaf) => leaf.steps[0]?.taskId === id)!;
    for (const sub of tasks.filter((candidate) => candidate.work)) {
      const { projectId, ref } = sub.work!;
      if (projectId === AVULSAS_ID) expect(allLeaves.some((leaf) => leaf.ref === ref)).toBe(true);
      else expect(projects.find((candidate) => candidate.id === projectId)?.tasks.some((candidate) => candidate.ref === ref)).toBe(true);
    }
    expect(tasks.find((candidate) => candidate.id === "s-open")!.work).toEqual({ projectId: AVULSAS_ID, ref: leafOf("s-open").ref, step: 0 });
    expect(tasks.find((candidate) => candidate.id === "s-plan-1")!.work).toEqual({ projectId: "p-plan", ref: "T1", step: 0 });
    expect(tasks.find((candidate) => candidate.id === "s-auto")!.work).toEqual({ projectId: "r-auto", ref: "T1", step: 0 });

    // Para você: mesmo total, tudo resolve
    const items = store.forYouSnapshot();
    expect(items).toHaveLength(fixture.forYou.length);
    const item = (id: string) => items.find((candidate) => candidate.id === id)!;
    expect(item("A-0001")).toMatchObject({ projectId: AVULSAS_ID, taskRef: leafOf("s-old").ref });
    expect(item("A-0002")).toMatchObject({ projectId: AVULSAS_ID, taskRef: leafOf("s-routine").ref });
    expect(item("A-0003")).toMatchObject({ projectId: AVULSAS_ID, taskRef: leafOf("s-open").ref });
    expect(item("A-0004")).toMatchObject({ projectId: "p-plan", kind: "plano" });
    expect(item("A-0005")).toMatchObject({ projectId: "r-auto", taskRef: "T1" });
    expect(item("A-0006")).toMatchObject({ projectId: "p-plan", taskRef: "T1" });
    expect(item("A-0007")).toMatchObject({ projectId: "orfao-que-nunca-existiu" });
    for (const entry of items.filter((candidate) => candidate.projectId === AVULSAS_ID)) expect(allLeaves.some((leaf) => leaf.ref === entry.taskRef)).toBe(true);

    // rotinas
    const routines = JSON.parse(await readFile(paths.routinesFile, "utf8"));
    expect(routines.routines[0].lastRuns[0]).toMatchObject({ projectId: AVULSAS_ID, taskId: "s-routine" });
    expect(routines.executions[0].taskId).toBe("s-routine");

    // relatório e backup
    const report = JSON.parse(await readFile(paths.sprintsReportFile, "utf8"));
    expect(report.counts).toMatchObject({ projectsBefore: 11, projectsFolded: 5, projectsKept: 6, leaves: 5, leavesLive: 4, leavesArchived: 1, runnerTasks: 8, forYouItems: 7 });
    expect(report.notFolded.map((entry: { projectId: string }) => entry.projectId).sort()).toEqual(["r-auto", "r-empty", "r-joint", "r-pace", "r-paused"]);
    expect(report.map).toHaveLength(5);
    const backups = (await readdir(paths.backupRoot)).filter((name) => name.startsWith("pre-sprints-"));
    expect(backups).toHaveLength(1);
    const inBackup = await readdir(path.join(paths.backupRoot, backups[0]!));
    expect(inBackup).toEqual(expect.arrayContaining(["projects", "tasks", "for-you", "routines.json", "schema.json"]));
    expect(await readdir(path.join(paths.backupRoot, backups[0]!, "projects"))).toContain("r-old.json");
  });

  it("é idempotente: rodar de novo (e abrir o store de novo) não muda nada", async () => {
    const { dir, paths } = await v3Workspace();
    await migrate(paths);
    // A primeira abertura do store compacta o `originalText` repetido dos itens antigos; dali em diante nada muda.
    await OfficeStore.open(dir);
    const first = await snapshotDir(dir);
    expect((await migrate(paths)).status).toBe("already");
    await OfficeStore.open(dir);
    await OfficeStore.open(dir);
    expect(await snapshotDir(dir)).toEqual(first);
    expect((await readdir(paths.backupRoot)).filter((name) => name.startsWith("pre-sprints-"))).toHaveLength(1);
  });

  it("queda no meio: sem marcador nada se perde, recomeça limpo e termina igual", async () => {
    const reference = await v3Workspace();
    await migrate(reference.paths);
    const expected = await snapshotDir(reference.dir);
    for (const failAt of ["backup", "archive", "avulsas", "tasks", "for-you", "routines", "report", "legacy"]) {
      const world = await v3Workspace();
      await expect(
        migrate(world.paths, {
          afterStep: (step) => {
            if (step === failAt) throw new Error("queda simulada");
          },
        }),
      ).rejects.toThrow("queda simulada");
      expect(JSON.parse(await readFile(world.paths.schemaFile, "utf8"))).toMatchObject({ dataVersion: 3 });
      const again = await migrate(world.paths);
      expect(again.status).toBe("migrated");
      expect(await snapshotDir(world.dir)).toEqual(expected);
      expect((await readdir(world.paths.backupRoot)).filter((name) => name.startsWith("pre-sprints-"))).toHaveLength(1);
    }
  });

  it("queda no meio das renomeações dos projetos dobrados também recomeça igual", async () => {
    const reference = await v3Workspace();
    await migrate(reference.paths);
    const expected = await snapshotDir(reference.dir);
    const world = await v3Workspace();
    await migrate(world.paths, { afterStep: (step) => { if (step === "legacy") throw new Error("queda simulada"); } }).catch(() => undefined);
    // simula a queda com parte dos arquivos já renomeados e o marcador ainda ausente
    await writeFile(world.paths.schemaFile, JSON.stringify({ dataVersion: 3 }));
    await rm(path.join(world.paths.projectsDir, "r-open.legacy.json"));
    await writeFile(path.join(world.paths.projectsDir, "r-open.json"), JSON.stringify(v3Fixture().projects.find((candidate) => candidate.id === "r-open"), null, 2));
    expect((await migrate(world.paths)).status).toBe("migrated");
    expect(await snapshotDir(world.dir)).toEqual(expected);
  });

  it("dado ruim: não grava nada e os arquivos antigos ficam intactos", async () => {
    const fixture = v3Fixture();
    // uma tarefa do runner aponta para uma tarefa do projeto dobrado que não existe (ref desconhecido) e um item aponta para o ref errado
    (fixture.forYou[0] as Record<string, unknown>).taskRef = "T99";
    const { dir, paths } = await v3Workspace(fixture);
    const before = await snapshotDir(dir);
    // item com ref desconhecido cai na primeira folha do projeto: isso é aceito (resolve), então quebramos de verdade um projeto
    await writeFile(path.join(paths.projectsDir, "ruim.json"), JSON.stringify({ id: "ruim", kind: "tarefa", status: "invalido" }));
    const withBad = await snapshotDir(dir);
    await expect(OfficeStore.open(dir)).rejects.toThrow(SprintsMigrationError);
    expect(await snapshotDir(dir)).toEqual(withBad);
    expect(before).not.toEqual(withBad);
    await expect(readdir(paths.projectsArchiveDir)).rejects.toThrow();
    expect(JSON.parse(await readFile(paths.schemaFile, "utf8"))).toMatchObject({ dataVersion: 3 });
  });

  it("workspace sem nenhum pedido simples só ganha o Avulsas vazio", async () => {
    const fixture = v3Fixture();
    const { dir, paths } = await v3Workspace({ projects: [fixture.projects[0]!], tasks: [], forYou: [], routines: { version: 2, routines: [], entries: [], executions: [], decisions: {}, results: [] } });
    await migrate(paths);
    const projects = await readProjectsDir(paths.projectsDir);
    expect(projects.map((candidate) => candidate.id).sort()).toEqual([AVULSAS_ID, "p-plan"]);
    expect(projects.find((candidate) => candidate.id === AVULSAS_ID)).toMatchObject({ tasks: [], nextRef: 1, status: "ativo" });
    expect(await readdir(dir)).not.toContain("avulsas.archive");
  });

  it("workspace novo já nasce com o Avulsas e no layout atual", async () => {
    const dataDir = await tempDir();
    await seedDataDir(dataDir);
    const dir = principalDir(dataDir);
    const paths = dataPaths(dir);
    expect(JSON.parse(await readFile(paths.schemaFile, "utf8"))).toEqual({ dataVersion: 4 });
    const store = await OfficeStore.open(dir);
    expect(store.projectsSnapshot().map((candidate) => candidate.id)).toEqual([AVULSAS_ID]);
    expect(store.projectsSnapshot()[0]).toMatchObject({ system: "avulsas", status: "ativo", title: "Avulsas" });
  });
});
