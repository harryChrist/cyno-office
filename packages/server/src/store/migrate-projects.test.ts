import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { findMaestroAgent } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { principalDir } from "../dev/test-app";
import { useTempDirs } from "../dev/test-utils";
import { buildSeedOffice, seedDataDir } from "../workspace/office/seed";
import { OfficeStore } from "./office-store";
import { buildProjectsMigration, migrateToProjects, MigrationError } from "./migrate-projects";
import { dataPaths } from "./paths";

const tempDir = useTempDirs();
const D = "2026-11-09";
const at = (time: string) => `${D}T${time}:00.000Z`;

const office = buildSeedOffice();
const maestro = findMaestroAgent(office)!;
const workers = office.agents.filter((agent) => agent.id !== maestro.id);
const [eco, crivo] = workers as [(typeof workers)[number], (typeof workers)[number]];
const roomOf = (agentId: string) => office.teams.find((team) => team.id === office.agents.find((agent) => agent.id === agentId)!.teamId)!.roomId;

/** Fixture anonimizada no formato real: tarefas, planos e itens do Para você de antes dos projetos. */
function legacyFixture() {
  const base = (id: string, agentId: string, prompt: string, status: string, time: string, extra: Record<string, unknown> = {}) => ({
    id,
    roomId: roomOf(agentId),
    teamId: office.agents.find((agent) => agent.id === agentId)!.teamId,
    agentId,
    prompt,
    status,
    createdAt: at(time),
    updatedAt: at(time.replace(/^(\d\d)/, (hour) => String(Number(hour) + 1).padStart(2, "0"))),
    ...extra,
  });
  const request = (id: string, prompt: string, status: string, time: string) => base(id, maestro.id, prompt, status, time, status === "done" ? { result: "Feito" } : status === "failed" ? { result: "Cancelado: sem cota" } : {});
  const tasks = [
    // 1) pedido com 1 filho (tarefa avulsa)
    request("r-solo", "Teste de acesso ao navegador", "done", "01:00"),
    base("c-solo", eco.id, "TESTE de acesso ao navegador. Use as ferramentas.", "done", "01:00", { projectId: undefined, parentId: "r-solo", result: "Acessou" }),
    // 2) pedido com 3 filhos (sem plano; 2 falharam)
    request("r-multi", "Reenviar os comentários", "failed", "02:00"),
    base("c-m1", eco.id, "Fase de preparo A", "done", "02:00", { parentId: "r-multi", result: "ok" }),
    base("c-m2", crivo.id, "Fase de preparo B", "failed", "02:10", { parentId: "r-multi", result: "erro" }),
    base("c-m3", eco.id, "Fase de preparo C", "failed", "02:20", { parentId: "r-multi", result: "erro" }),
    // 3) pedido com plano e etapas
    request("r-plan", "Semana 1: post e comentários", "done", "03:00"),
    base("s-1", eco.id, "POST · Post de quarta — etapa 1/2", "done", "03:10", { parentId: "r-plan", plan: { planId: "plan-uuid", ref: "T1", step: 0 }, result: "texto" }),
    base("s-2", crivo.id, "POST · Post de quarta — etapa 2/2", "done", "03:20", { parentId: "r-plan", plan: { planId: "plan-uuid", ref: "T1", step: 1 }, result: "revisado" }),
    // 4) grupo "Comentário N/3" (pedidos sem filhos, com aprovações) e um "Convite 2/5" sozinho (grupo de 1, não agrupa)
    request("r-c2", "Comentário 2/3: post de Fulano", "done", "04:00"),
    request("r-c3", "Comentário 3/3: post de Beltrano", "done", "04:01"),
    base("c-c3", eco.id, "Executar o comentário 3", "done", "04:05", { parentId: "r-c3", result: "ok" }),
    request("r-inv", "Convite 2/5: Ciclano", "done", "04:02"),
    // 5) conversa sem trabalho nenhum (só registro)
    request("r-chat", "Qual o status?", "done", "05:00"),
    // 6) pedido ainda aberto, com filho em andamento
    request("r-open", "Pedido em andamento", "in_progress", "06:00"),
    base("c-open", eco.id, "Fazendo agora", "in_progress", "06:00", { parentId: "r-open" }),
    // 7) tarefa de rotina solta
    base("routine-1", eco.id, "Rotina: comentar", "done", "07:00", { routineId: "R-1", result: "feito" }),
    // 8) tarefa direta a um time (sem pedido, sem rotina)
    base("direct-1", crivo.id, "Tarefa direta", "done", "08:00", { result: "ok" }),
  ];
  const plans = [
    {
      id: "plan-uuid",
      requestId: "r-plan",
      title: "Semana 1",
      summary: "Post e comentários",
      status: "em_execucao",
      version: 1,
      tasks: [
        {
          ref: "T1",
          title: "Post de quarta",
          briefing: "Escrever e revisar",
          ownerId: eco.id,
          steps: [
            { agentId: eco.id, what: "texto", status: "feita", taskId: "s-1", result: "texto", startedAt: at("03:10"), finishedAt: at("03:15") },
            { agentId: crivo.id, what: "revisão", status: "feita", taskId: "s-2", result: "revisado", startedAt: at("03:20"), finishedAt: at("03:25") },
          ],
          current: 1,
          dependsOn: [],
          priority: "normal",
          status: "concluida",
          result: "revisado",
          updatedAt: at("03:25"),
        },
      ],
      forYouId: "A-0001",
      createdAt: at("03:00"),
      updatedAt: at("03:25"),
      approvedAt: at("03:05"),
      doneNotified: true,
    },
  ];
  const item = (id: string, extra: Record<string, unknown>) => ({
    id,
    agentId: eco.id,
    roomId: roomOf(eco.id),
    type: "outro",
    status: "aprovado",
    meta: {},
    text: "texto",
    originalText: "texto",
    editedByUser: false,
    createdAt: at("04:30"),
    ...extra,
  });
  const forYou = [
    item("A-0001", { kind: "plano", taskId: "r-plan", requestId: "r-plan", planId: "plan-uuid", agentId: maestro.id, roomId: roomOf(maestro.id) }),
    item("A-0002", { taskId: "s-1", requestId: "r-plan", planId: "plan-uuid", planRef: "T1" }),
    item("A-0003", { taskId: "r-c2", requestId: "r-c2" }),
    item("A-0004", { taskId: "r-c3", requestId: "r-c3" }),
    item("A-0005", { taskId: "r-inv", requestId: "r-inv" }),
    item("A-0006", { taskId: "c-m1", requestId: "r-multi" }),
    item("A-0007", { kind: "questionario", status: "respondido", questions: [{ id: "q1", text: "Qual?" }], answers: {} }),
  ];
  return { tasks, plans, forYou };
}

const opts = (extra: Partial<Parameters<typeof buildProjectsMigration>[1]> = {}) => ({ group: true, workspaceId: "ws", now: () => new Date("2026-11-11T12:00:00.000Z"), ...extra });
const input = () => ({ ...legacyFixture(), maestroAgentId: maestro.id });

describe("buildProjectsMigration (formato antigo -> projetos)", () => {
  it("resultado esperado: pedidos viram registros, projetos nascem de planos, filhos e rotinas", () => {
    const { tasks, projects, forYou, report } = buildProjectsMigration(input(), opts());
    const byId = new Map(tasks.map((task) => [task.id, task]));
    // todas as tarefas continuam existindo, sem parentId/plan
    expect(tasks).toHaveLength(legacyFixture().tasks.length);
    expect(tasks.every((task) => !("parentId" in task) && !("plan" in task))).toBe(true);
    for (const id of ["r-solo", "r-multi", "r-plan", "r-c2", "r-c3", "r-inv", "r-chat", "r-open"]) expect(byId.get(id)!.role).toBe("request");
    expect(byId.get("c-solo")).toMatchObject({ projectId: "r-solo", work: { projectId: "r-solo", ref: "T1", step: 0 } });
    expect(byId.get("direct-1")!.role).toBeUndefined();
    expect(byId.get("direct-1")!.projectId).toBeUndefined();

    const project = (id: string) => projects.find((candidate) => candidate.id === id)!;
    // 1 filho = tarefa avulsa; sem pedido-conversa
    expect(project("r-solo")).toMatchObject({ kind: "tarefa", status: "concluido", origin: "usuario", priority: "normal", mode: { kind: "pede-ok" } });
    expect(project("r-solo").tasks).toHaveLength(1);
    expect(project("r-solo").tasks[0]).toMatchObject({ ref: "T1", status: "concluida", ownerId: eco.id, doneWhen: [], rework: { count: 0 } });
    expect(project("r-solo").tasks[0]!.steps[0]).toMatchObject({ taskId: "c-solo", address: `ws/${eco.id}`, status: "feita" });
    // 3 filhos sem plano = projeto; pedido que falhou = cancelado, com o resultado no resumo
    expect(project("r-multi")).toMatchObject({ kind: "projeto", status: "cancelado", summary: "Cancelado: sem cota" });
    expect(project("r-multi").tasks.map((task) => [task.ref, task.status])).toEqual([["T1", "concluida"], ["T2", "falhou"], ["T3", "falhou"]]);
    // plano: id = id do pedido, estados novos, etapas ligadas por work
    expect(project("r-plan")).toMatchObject({ kind: "projeto", status: "ativo", version: 1, forYouId: "A-0001", doneNotified: true });
    expect(byId.get("s-2")).toMatchObject({ projectId: "r-plan", work: { projectId: "r-plan", ref: "T1", step: 1 } });
    // conversa sem trabalho não vira projeto
    expect(projects.find((candidate) => candidate.id === "r-chat")).toBeUndefined();
    // pedido aberto com filho: projeto ativo
    expect(project("r-open")).toMatchObject({ kind: "tarefa", status: "ativo" });
    // rotina solta: projeto próprio de rotina, sem projectId na Task
    expect(project("routine-1")).toMatchObject({ kind: "tarefa", origin: "rotina", routineRef: { routineId: "R-1" } });
    expect(byId.get("routine-1")).toMatchObject({ routineId: "R-1", work: { projectId: "routine-1", ref: "T1", step: 0 } });
    expect(byId.get("routine-1")!.projectId).toBeUndefined();
    // nenhum projeto sem tarefas (salvo tarefa cancelada vazia)
    expect(projects.every((candidate) => candidate.tasks.length > 0 || (candidate.kind === "tarefa" && candidate.status === "cancelado"))).toBe(true);

    // Para você: mesmo total, tudo ligado ao projeto
    expect(forYou).toHaveLength(legacyFixture().forYou.length);
    const item = (id: string) => forYou.find((candidate) => candidate.id === id)!;
    expect(item("A-0001")).toMatchObject({ kind: "plano", projectId: "r-plan", taskId: "r-plan" });
    expect(item("A-0002")).toMatchObject({ projectId: "r-plan", taskRef: "T1", taskId: "s-1" });
    expect(item("A-0006")).toMatchObject({ projectId: "r-multi", taskRef: "T1", taskId: "c-m1" });
    expect(item("A-0007").projectId).toBeUndefined();
    expect(forYou.every((candidate) => !("requestId" in candidate) && !("planId" in candidate) && !("planRef" in candidate))).toBe(true);

    expect(report.counts).toMatchObject({ tasks: tasks.length, forYouItems: forYou.length, projectsFromPlans: 1 });
  });

  it("agrupa os pedidos N/M do mesmo dia, prefixo e total num projeto só (e relata)", () => {
    const { tasks, projects, forYou, report } = buildProjectsMigration(input(), opts());
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]).toMatchObject({ projectId: "r-c2", total: 3, requestIds: ["r-c2", "r-c3"] });
    const head = projects.find((project) => project.id === "r-c2")!;
    expect(head).toMatchObject({ kind: "projeto", title: "Comentário (2 de 3)", status: "concluido" });
    expect(head.tasks.map((task) => task.ref)).toEqual(["T1", "T2"]);
    expect(tasks.find((task) => task.id === "c-c3")).toMatchObject({ projectId: "r-c2", work: { projectId: "r-c2", ref: "T2", step: 0 } });
    expect(projects.find((project) => project.id === "r-c3")).toBeUndefined();
    expect(tasks.find((task) => task.id === "r-c3")).toMatchObject({ role: "request", mergedInto: "r-c2" });
    expect(tasks.find((task) => task.id === "r-c2")!.mergedInto).toBeUndefined();
    expect(forYou.find((item) => item.id === "A-0004")).toMatchObject({ projectId: "r-c2", taskId: "r-c3" });
    expect(forYou.find((item) => item.id === "A-0003")).toMatchObject({ projectId: "r-c2", taskRef: "T1", taskId: "r-c2" });
    // "Convite 2/5" sozinho não vira grupo: projeto próprio
    expect(projects.find((project) => project.id === "r-inv")).toBeDefined();
  });

  it("--no-group: cada pedido fica com o seu projeto", () => {
    const { projects, tasks, report } = buildProjectsMigration(input(), opts({ group: false }));
    expect(report.groups).toEqual([]);
    expect(projects.find((project) => project.id === "r-c2")).toMatchObject({ kind: "tarefa", title: "Comentário 2/3: post de Fulano" });
    expect(projects.find((project) => project.id === "r-c3")).toBeDefined();
    expect(tasks.some((task) => task.mergedInto)).toBe(false);
  });

  it("não agrupa quando algum pedido do grupo ainda está em andamento", () => {
    const data = input();
    data.tasks.find((task) => task.id === "c-c3")!.status = "in_progress";
    const { report, projects } = buildProjectsMigration(data, opts());
    expect(report.groups).toEqual([]);
    expect(report.skippedGroups).toHaveLength(1);
    expect(projects.find((project) => project.id === "r-c2")).toBeDefined();
  });

  it("falha na validação aborta com mensagem clara (nada é devolvido)", () => {
    const data = input();
    (data.tasks[0] as Record<string, unknown>).createdAt = "ontem";
    expect(() => buildProjectsMigration(data, opts())).toThrow(MigrationError);
  });
});

describe("migrateToProjects (disco)", () => {
  async function legacyWorkspace() {
    const dataDir = await tempDir();
    await seedDataDir(dataDir);
    const dir = principalDir(dataDir);
    const paths = dataPaths(dir);
    const fx = legacyFixture();
    await rm(paths.schemaFile);
    await writeFile(paths.legacy.tasks, JSON.stringify(fx.tasks, null, 2));
    await writeFile(paths.legacy.plans, JSON.stringify(fx.plans, null, 2));
    await writeFile(paths.legacy.forYou, JSON.stringify(fx.forYou, null, 2));
    return { dir, paths, fx };
  }
  const snapshotDir = async (root: string) => {
    const out: Record<string, string> = {};
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "backup") continue;
          await walk(file);
        } else if (entry.name !== "schema.json" && entry.name !== "migration-report.json") out[path.relative(root, file)] = await readFile(file, "utf8");
      }
    };
    await walk(root);
    return out;
  };

  it("grava o layout novo, backup, *.legacy.json, relatório e o marcador", async () => {
    const { dir, paths, fx } = await legacyWorkspace();
    const outcome = await migrateToProjects(paths, { group: true, workspaceId: "ws" });
    expect(outcome.status).toBe("migrated");
    const files = await readdir(dir);
    expect(files).toEqual(expect.arrayContaining(["schema.json", "tasks", "projects", "for-you", "migration-report.json", "tasks.legacy.json", "plans.legacy.json", "for-you.legacy.json", "backup"]));
    expect(files).not.toContain("tasks.json");
    expect(JSON.parse(await readFile(paths.schemaFile, "utf8"))).toMatchObject({ dataVersion: 3 });
    const backups = await readdir(paths.backupRoot);
    expect(backups).toHaveLength(1);
    expect((await readdir(path.join(paths.backupRoot, backups[0]!))).sort()).toEqual(["for-you.json", "office.json", "plans.json", "tasks.json"]);
    expect(await readdir(paths.tasksDir)).toEqual(["2026-11.json"]);
    const store = await OfficeStore.open(dir);
    expect(store.snapshot().tasks).toHaveLength(fx.tasks.length);
    expect(store.forYouSnapshot()).toHaveLength(fx.forYou.length);
    expect(store.projectsSnapshot().length).toBeGreaterThan(3);
  });

  it("é idempotente: rodar de novo não muda nada", async () => {
    const { dir, paths } = await legacyWorkspace();
    await migrateToProjects(paths, { group: true, workspaceId: "ws" });
    const first = await snapshotDir(dir);
    const again = await migrateToProjects(paths, { group: true, workspaceId: "ws" });
    expect(again.status).toBe("already");
    expect(await snapshotDir(dir)).toEqual(first);
    // abrir o store (que também leva ao layout do Avulsas) uma vez muda o que a migração seguinte muda; as próximas aberturas não mudam nada
    await OfficeStore.open(dir);
    const opened = await snapshotDir(dir);
    await OfficeStore.open(dir);
    await OfficeStore.open(dir);
    expect(await snapshotDir(dir)).toEqual(opened);
    expect((await readdir(paths.backupRoot)).filter((name) => name.startsWith("pre-projetos-"))).toHaveLength(1);
  });

  it("queda no meio: sem marcador nada se perde e rodar de novo termina igual", async () => {
    const { dir, paths } = await legacyWorkspace();
    const reference = await legacyWorkspace();
    await migrateToProjects(reference.paths, { group: true, workspaceId: "ws" });
    const expected = await snapshotDir(reference.dir);
    for (const failAt of ["backup", "tasks", "for-you", "projects", "report", "legacy"]) {
      const world = await legacyWorkspace();
      await expect(
        migrateToProjects(world.paths, {
          group: true,
          workspaceId: "ws",
          afterStep: (step) => {
            if (step === failAt) throw new Error("queda simulada");
          },
        }),
      ).rejects.toThrow("queda simulada");
      // sem marcador; os dados antigos continuam recuperáveis (no lugar ou como *.legacy.json)
      await expect(readFile(world.paths.schemaFile, "utf8")).rejects.toThrow();
      const present = await readdir(world.dir);
      expect(present.includes("tasks.json") || present.includes("tasks.legacy.json")).toBe(true);
      const again = await migrateToProjects(world.paths, { group: true, workspaceId: "ws" });
      expect(again.status).toBe("migrated");
      expect(await snapshotDir(world.dir)).toEqual(expected);
      expect(await readdir(world.paths.backupRoot)).toHaveLength(1);
    }
    expect(dir).toBeTruthy();
    expect(paths).toBeTruthy();
  });

  it("dado ruim: o boot falha com mensagem clara e os arquivos antigos ficam intactos", async () => {
    const { dir, paths, fx } = await legacyWorkspace();
    const broken = structuredClone(fx.tasks);
    (broken[0] as Record<string, unknown>).status = "inexistente";
    await writeFile(paths.legacy.tasks, JSON.stringify(broken));
    const before = await readFile(paths.legacy.tasks, "utf8");
    await expect(OfficeStore.open(dir)).rejects.toThrow(/Migração para projetos abortada/);
    expect(await readFile(paths.legacy.tasks, "utf8")).toBe(before);
    await expect(readFile(paths.schemaFile, "utf8")).rejects.toThrow();
    await expect(readdir(paths.tasksDir)).rejects.toThrow();
  });

  it("workspace sem arquivos antigos só ganha o marcador", async () => {
    const dataDir = await tempDir();
    await seedDataDir(dataDir);
    const dir = principalDir(dataDir);
    const paths = dataPaths(dir);
    await rm(paths.schemaFile);
    expect((await migrateToProjects(paths, { group: true, workspaceId: "ws" })).status).toBe("fresh");
    expect(JSON.parse(await readFile(paths.schemaFile, "utf8"))).toMatchObject({ dataVersion: 3 });
    expect(await readdir(dir)).not.toContain("backup");
    await mkdir(path.join(dir, "x"), { recursive: true });
    await copyFile(paths.schemaFile, path.join(dir, "x", "s.json"));
  });
});
