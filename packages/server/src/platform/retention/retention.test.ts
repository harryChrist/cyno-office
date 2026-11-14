import { lstat, mkdir, readdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_RETENTION, RETENTION_CLEANUP_PATH, RETENTION_PATH, type RetentionResponse } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { useTestApp } from "../../dev/test-app";
import { useTempDirs } from "../../dev/test-utils";
import { claudeProjectDirName, RetentionService } from "./retention";

const tempDir = useTempDirs();
const setupApp = useTestApp();

const NOW = new Date("2026-11-08T12:00:00.000Z");
const DAY = 86_400_000;
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

const ACTIVE = "11111111-1111-4111-8111-111111111111";
const OLD = "22222222-2222-4222-8222-222222222222";
const RECENT = "33333333-3333-4333-8333-333333333333";
const OLD_DIR = "44444444-4444-4444-8444-444444444444";

async function file(target: string, content: string, ageDays: number): Promise<string> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  const when = new Date(NOW.getTime() - ageDays * DAY);
  await utimes(target, when, when);
  return target;
}

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    () => false,
  );
}

/** DATA_DIR e uma pasta ~/.claude/projects falsas, com coisas que podem e que NUNCA podem ser apagadas. */
async function setup() {
  const root = await tempDir();
  const dataDir = path.join(root, "data");
  const projects = path.join(root, "claude", "projects");
  const agentDir = path.join(dataDir, "workspaces", "lab", "agents", "redator");
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "session.json"), JSON.stringify({ provider: "claude", sessionId: ACTIVE, started: true }));
  const ours = path.join(projects, claudeProjectDirName(agentDir)!);
  const paths = {
    oldSession: await file(path.join(ours, `${OLD}.jsonl`), "velha", 30),
    activeSession: await file(path.join(ours, `${ACTIVE}.jsonl`), "atual (velha, mas em uso)", 30),
    recentSession: await file(path.join(ours, `${RECENT}.jsonl`), "recente", 1),
    oldSessionDir: await file(path.join(ours, OLD_DIR, "subagents", "a.jsonl"), "sub", 30),
    activeDir: await file(path.join(ours, ACTIVE, "subagents", "b.jsonl"), "sub atual", 30),
    notSession: await file(path.join(ours, "memory", "MEMORY.md"), "não é conversa", 30),
    // Outro projeto do usuário (inclusive com o mesmo começo de nome): nunca.
    otherProject: await file(path.join(projects, "-home-usuario-cyno", `${OLD}.jsonl`), "do usuário", 400),
    samePrefix: await file(path.join(projects, `${claudeProjectDirName(agentDir)}-2`, `${OLD}.jsonl`), "parecido", 400),
    // Logs de tarefa: velho (sai), novo (fica), de tarefa ativa (fica), outro arquivo (fica).
    oldLog: await file(path.join(dataDir, "workspaces", "lab", "logs", "t-velha.jsonl"), "{}", 120),
    newLog: await file(path.join(dataDir, "workspaces", "lab", "logs", "t-nova.jsonl"), "{}", 10),
    activeLog: await file(path.join(dataDir, "workspaces", "lab", "logs", "t-ativa.jsonl"), "{}", 120),
    strayLog: await file(path.join(dataDir, "workspaces", "lab", "logs", "LEIA.txt"), "x", 400),
    brainNote: await file(path.join(dataDir, "workspaces", "lab", "brains", "global", "historico", "2020-01-01-000000-x.md"), "# x", 2000),
  };
  // Outro agente cuja pasta de conversas é um link simbólico para fora: nunca é seguido.
  const outside = path.join(root, "fora");
  const outsideFile = await file(path.join(outside, `${OLD}.jsonl`), "fora", 400);
  const linkedAgent = path.join(dataDir, "workspaces", "lab", "agents", "ligado");
  await mkdir(linkedAgent, { recursive: true });
  await symlink(outside, path.join(projects, claudeProjectDirName(linkedAgent)!));
  const forgotten: string[] = [];
  // A pasta da conversa velha (subagentes) também é velha (o mtime da pasta conta).
  for (const dir of [path.join(ours, OLD_DIR, "subagents"), path.join(ours, OLD_DIR)]) {
    const when = new Date(NOW.getTime() - 30 * DAY);
    await utimes(dir, when, when);
  }
  const make = (claudeProjectsDir: string | null = projects) =>
    new RetentionService({
      dataDir,
      claudeProjectsDir: claudeProjectsDir ?? undefined,
      activeTaskIds: (ws) => new Set(ws === "lab" ? ["t-ativa"] : []),
      forgetLogs: (_ws, ids) => forgotten.push(...ids),
      now: () => NOW,
      log: silent,
    });
  return { root, dataDir, projects, ours, paths, outsideFile, make, forgotten };
}

describe("retenção do histórico", () => {
  it("nome da pasta do Claude Code: o caminho com tudo que não é letra/dígito trocado por '-'", () => {
    expect(claudeProjectDirName("/home/usuario/cyno/data/workspaces/laboratorio/agents/maestro")).toBe("-home-usuario-cyno-data-workspaces-laboratorio-agents-maestro");
    expect(claudeProjectDirName("/a/b.c_d e")).toBe("-a-b-c-d-e");
    expect(claudeProjectDirName(`/${"x".repeat(300)}`)).toBeUndefined();
  });

  it("apaga só conversas velhas das pastas dos nossos agentes (nunca a sessão atual) e logs velhos de tarefas inativas", async () => {
    const { paths, outsideFile, make, forgotten } = await setup();
    const service = make();
    await service.load();
    const result = await service.cleanup();

    expect(await exists(paths.oldSession)).toBe(false);
    expect(await exists(path.dirname(path.dirname(paths.oldSessionDir)))).toBe(false);
    expect(await exists(paths.oldLog)).toBe(false);
    for (const kept of [paths.activeSession, paths.recentSession, paths.activeDir, paths.notSession, paths.otherProject, paths.samePrefix, paths.newLog, paths.activeLog, paths.strayLog, paths.brainNote, outsideFile]) {
      expect(await exists(kept)).toBe(true);
    }
    expect(result.transcripts).toEqual({ files: 2, bytes: "velha".length + "sub".length });
    expect(result.logs).toEqual({ files: 1, bytes: 2 });
    expect(forgotten).toEqual(["t-velha"]);

    // Rodar de novo não acha mais nada.
    expect(await service.cleanup()).toMatchObject({ transcripts: { files: 0 }, logs: { files: 0 } });
  });

  it("Atividade: 180 dias nos arquivos do dia, 60 nas métricas por hora; nunca apaga heartbeat nem marcador", async () => {
    const { dataDir, make } = await setup();
    const day = (ago: number) => new Date(NOW.getTime() - ago * DAY).toISOString().slice(0, 10);
    const wsDir = path.join(dataDir, "workspaces", "lab", "activity");
    const sysDir = path.join(dataDir, "activity");
    const oldWs = await file(path.join(wsDir, `${day(200)}.jsonl`), "{}", 0);
    const keptWs = await file(path.join(wsDir, `${day(170)}.jsonl`), "{}", 0);
    const oldSys = await file(path.join(sysDir, `${day(181)}.jsonl`), "{}", 0);
    const heartbeat = await file(path.join(sysDir, "heartbeat.json"), "{}", 999);
    const marker = await file(path.join(sysDir, ".migrated.json"), "{}", 999);
    await file(path.join(sysDir, "metrics-2026-06.jsonl"), "{}\n", 0);
    const lines = [90, 70, 10].map((ago) => JSON.stringify({ hour: new Date(NOW.getTime() - ago * DAY).toISOString() }));
    // Os dois meses do corte: o mais velho some inteiro; o do corte só perde as linhas com mais de 60 dias.
    await file(path.join(sysDir, `metrics-${day(60).slice(0, 7)}.jsonl`), `${lines.join("\n")}\n`, 0);
    const service = make(null);
    await service.load();
    const removed = await service.cleanActivity(NOW.getTime());
    expect(removed.files).toBe(3);
    expect(await exists(oldWs)).toBe(false);
    expect(await exists(oldSys)).toBe(false);
    expect(await exists(path.join(sysDir, "metrics-2026-06.jsonl"))).toBe(false);
    for (const kept of [keptWs, heartbeat, marker]) expect(await exists(kept)).toBe(true);
    const metrics = (await readFile(path.join(sysDir, `metrics-${day(60).slice(0, 7)}.jsonl`), "utf8")).trim().split("\n");
    // 90 e 70 dias atrás saem se caírem no mesmo arquivo do corte; o de 10 dias sobra.
    expect(metrics.every((line) => Date.parse((JSON.parse(line) as { hour: string }).hour) >= NOW.getTime() - 60 * DAY)).toBe(true);
  });

  it("0 dias = nunca apagar; sem a pasta de projetos do Claude, as conversas não são gerenciadas", async () => {
    const { paths, make } = await setup();
    const keepAll = make();
    await keepAll.update({ transcriptsDays: 0, logsDays: 0 });
    await keepAll.cleanup();
    expect(await exists(paths.oldSession)).toBe(true);
    expect(await exists(paths.oldLog)).toBe(true);

    const unmanaged = make(null);
    await unmanaged.load();
    await unmanaged.update({ transcriptsDays: 1, logsDays: 365 });
    const snapshot = await unmanaged.snapshot();
    expect(snapshot.transcriptsManaged).toBe(false);
    expect(snapshot.usage.transcripts).toEqual({ bytes: 0, files: 0 });
    await unmanaged.cleanup();
    expect(await exists(paths.oldSession)).toBe(true);
  });

  it("guarda a configuração em settings.json e mostra o uso de disco por categoria", async () => {
    const { dataDir, make } = await setup();
    const service = make();
    await service.load();
    expect(service.settings()).toEqual(DEFAULT_RETENTION);
    await service.update({ logsDays: 30 });
    const saved = JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8")) as { retention: unknown };
    expect(saved.retention).toEqual({ transcriptsDays: 7, logsDays: 30 });
    const reloaded = make();
    await reloaded.load();
    expect(reloaded.settings()).toEqual({ transcriptsDays: 7, logsDays: 30 });
    await expect(reloaded.update({ logsDays: -1 })).rejects.toThrow();

    const snapshot = await reloaded.snapshot();
    expect(snapshot.usage.transcripts.files).toBe(6);
    expect(snapshot.usage.logs.files).toBe(4);
    expect(snapshot.usage.brains.files).toBe(1);
    expect(snapshot.transcriptsManaged).toBe(true);
  });
});

describe("API /api/settings/retention", () => {
  it("GET mostra os padrões; PATCH valida e grava; POST cleanup limpa e conta", async () => {
    const { app, dataDir } = await setupApp();
    const initial = (await app.inject({ method: "GET", url: RETENTION_PATH })).json<RetentionResponse>();
    expect(initial).toMatchObject({ settings: DEFAULT_RETENTION, transcriptsManaged: false, lastCleanup: null });
    expect(initial.usage.brains.files).toBeGreaterThan(0);

    expect((await app.inject({ method: "PATCH", url: RETENTION_PATH, payload: { logsDays: "muito" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: RETENTION_PATH, payload: { outra: 1 } })).statusCode).toBe(400);
    const patched = await app.inject({ method: "PATCH", url: RETENTION_PATH, payload: { transcriptsDays: 3 } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<RetentionResponse>().settings).toEqual({ transcriptsDays: 3, logsDays: 90 });

    const cleaned = await app.inject({ method: "POST", url: RETENTION_CLEANUP_PATH });
    expect(cleaned.statusCode).toBe(200);
    expect(cleaned.json<RetentionResponse>().lastCleanup).toMatchObject({ transcripts: { files: 0 }, logs: { files: 0 } });
    expect(await readdir(dataDir)).toContain("settings.json");
  });
});
