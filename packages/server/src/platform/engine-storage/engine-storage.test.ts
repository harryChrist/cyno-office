import { lstat, mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_ENGINE_STORAGE,
  ENGINE_STORAGE_CLEANUP_PATH,
  ENGINE_STORAGE_PATH,
  ENGINE_STORAGE_PREVIEW_PATH,
  type EngineStorageCleanupResult,
  type EngineStoragePreview,
  type EngineStorageResponse,
} from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { useTestApp } from "../../dev/test-app";
import { useTempDirs } from "../../dev/test-utils";
import { freebuffFolderName } from "../../engines/freebuff/files";
import { claudeProjectDirName } from "../retention/retention";
import { EngineStorage, formatBytes } from "./engine-storage";

const tempDir = useTempDirs();
const setupApp = useTestApp();

const NOW = new Date("2026-11-20T12:00:00.000Z");
const DAY = 86_400_000;
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function file(target: string, content: string, ageDays: number): Promise<string> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  const when = new Date(NOW.getTime() - ageDays * DAY);
  await utimes(target, when, when);
  return target;
}

async function age(target: string, ageDays: number): Promise<void> {
  const when = new Date(NOW.getTime() - ageDays * DAY);
  await utimes(target, when, when);
}

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    () => false,
  );
}

const chatName = (ageDays: number) => new Date(NOW.getTime() - ageDays * DAY).toISOString().replace(/:/g, "-");

/** DATA_DIR e as pastas de motor falsas (Antigravity, Freebuff, Claude), com o que pode e o que NUNCA pode sair. */
async function setup() {
  const root = await tempDir();
  const dataDir = path.join(root, "data");
  const agyHome = path.join(root, "agy");
  const fbHome = path.join(root, "manicode");
  const claudeProjects = path.join(root, "claude", "projects");
  const outside = path.join(root, "fora");
  const recorded: { auto: boolean; summary: string; data: Record<string, unknown> }[] = [];

  // ----- Antigravity -----
  const log = path.join(agyHome, "log");
  const agy = {
    oldLog: await file(path.join(log, "cli-20260101_100000.log"), "x".repeat(100), 40),
    oldLog2: await file(path.join(log, "cli-20260102_100000.log"), "y".repeat(50), 20),
    recentLog: await file(path.join(log, "cli-20261119_100000.log"), "recente", 1),
    halfDayLog: await file(path.join(log, "cli-20261120_000000.log"), "meio dia", 0.5),
    // Nomes que não casam EXATAMENTE: nunca.
    badName1: await file(path.join(log, "cli-20260101_100000.log.bak"), "bak", 400),
    badName2: await file(path.join(log, "cli-2026_1.log"), "curto", 400),
    badName3: await file(path.join(log, "xcli-20260101_100000.log"), "prefixo", 400),
    otherFile: await file(path.join(log, "notas.txt"), "notas", 400),
    // Fora de log/: nunca.
    conversation: await file(path.join(agyHome, "conversations", "abc.pb"), "conversa pessoal", 400),
    brain: await file(path.join(agyHome, "brain", "x", "transcript.jsonl"), "{}", 400),
    settings: await file(path.join(agyHome, "settings.json"), "{}", 400),
    outsideTarget: await file(path.join(outside, "cli-20250101_000000.log"), "de fora", 400),
  };
  // `cli.log` é um link para o log atual (velho aqui de propósito); um link com nome de log para fora; uma pasta com nome de log.
  await symlink(agy.oldLog2, path.join(log, "cli.log"));
  await symlink(agy.outsideTarget, path.join(log, "cli-20250101_000000.log"));
  await mkdir(path.join(log, "cli-20250202_000000.log"));
  await age(path.join(log, "cli-20250202_000000.log"), 400);

  // ----- Freebuff -----
  const folder = freebuffFolderName("lab", "redator");
  const chats = path.join(fbHome, "projects", folder, "chats");
  const current = chatName(60);
  const fb = {
    oldChat: await file(path.join(chats, chatName(40), "log.jsonl"), "z".repeat(30), 40),
    oldChat2: await file(path.join(chats, chatName(20), "chat-messages.json"), "w".repeat(10), 20),
    currentChat: await file(path.join(chats, current, "log.jsonl"), "sessão atual (velha, mas em uso)", 60),
    recentChat: await file(path.join(chats, chatName(1), "log.jsonl"), "recente", 1),
    // Pasta velha com um arquivo novo dentro: o mais novo conta.
    busyChat: await file(path.join(chats, chatName(50), "log.jsonl"), "novo dentro", 0.2),
    // Nome fora do formato de data, arquivo solto: nunca.
    oddDir: await file(path.join(chats, "importante", "log.jsonl"), "x", 400),
    looseFile: await file(path.join(chats, "2020-01-01T00-00-00.000Z"), "arquivo, não pasta", 400),
    // Outro projeto do usuário: nunca (nem o que parece parecido).
    otherProject: await file(path.join(fbHome, "projects", "meu-projeto", "chats", chatName(300), "log.jsonl"), "do dono", 300),
    fbUpper: await file(path.join(fbHome, "projects", "fb-Maiuscula", "chats", chatName(300), "log.jsonl"), "x", 300),
    // Arquivos do Freebuff fora de projects/*/chats: nunca.
    settings: await file(path.join(fbHome, "settings.json"), "{}", 400),
    projectFile: await file(path.join(fbHome, "projects", folder, "outro.json"), "{}", 400),
    outsideChat: await file(path.join(outside, "freebuff", chatName(300), "log.jsonl"), "fora", 300),
  };
  await age(path.join(chats, chatName(50)), 50);
  await age(path.join(chats, chatName(40)), 40);
  await age(path.join(chats, chatName(20)), 20);
  await age(path.join(chats, current), 60);
  // Projeto fb- que é link para fora, e `chats` que é link para fora: nunca seguidos.
  await symlink(path.join(outside, "freebuff"), path.join(fbHome, "projects", "fb-link"));
  await mkdir(path.join(fbHome, "projects", "fb-chatslink"), { recursive: true });
  await symlink(path.join(outside, "freebuff"), path.join(fbHome, "projects", "fb-chatslink", "chats"));
  // O agente do Cyno cuja sessão atual é o chat velho.
  const agentDir = path.join(dataDir, "workspaces", "lab", "agents", "redator");
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "session.json"), JSON.stringify({ provider: "freebuff", sessionId: current, started: true }));

  // ----- Claude Code (só medido) -----
  const claudeFile = await file(path.join(claudeProjects, claudeProjectDirName(agentDir)!, "11111111-1111-4111-8111-111111111111.jsonl"), "c".repeat(25), 12);
  await file(path.join(claudeProjects, "-home-outro", "x.jsonl"), "do dono", 12);

  const make = (extra: Partial<ConstructorParameters<typeof EngineStorage>[0]> = {}) =>
    new EngineStorage({ dataDir, claudeProjectsDir: claudeProjects, antigravityHome: agyHome, freebuffHome: fbHome, now: () => NOW, log: silent, record: (entry) => recorded.push(entry), ...extra });
  return { root, dataDir, agyHome, fbHome, agy, fb, folder, chats, current, claudeFile, outside, make, recorded, log, agentDir };
}

describe("armazenamento dos motores: padrões e arquivo", () => {
  it("tudo desligado por padrão, com arquivo ausente ou inválido; limpar com tudo desligado não apaga nada", async () => {
    const { dataDir, make, agy, fb } = await setup();
    const service = make();
    await service.load();
    expect(service.settings()).toEqual({ antigravityLogsDays: 0, freebuffChatsDays: 0 });
    expect(DEFAULT_ENGINE_STORAGE).toEqual({ antigravityLogsDays: 0, freebuffChatsDays: 0 });
    expect(await service.preview()).toEqual({ antigravityLogs: { files: 0, bytes: 0 }, freebuffChats: { files: 0, bytes: 0 } });
    expect(await service.cleanup()).toMatchObject({ antigravityLogs: { files: 0 }, freebuffChats: { files: 0 } });
    for (const kept of [agy.oldLog, agy.oldLog2, fb.oldChat, fb.oldChat2]) expect(await exists(kept)).toBe(true);
    expect((await service.snapshot()).lastCleanup).toBeNull();

    const settingsFile = path.join(dataDir, "platform", "engine-storage.json");
    for (const bad of ["{ isso não é json", JSON.stringify({ settings: { antigravityLogsDays: 5 } }), JSON.stringify({ settings: { freebuffChatsDays: "30" } }), JSON.stringify([1, 2])]) {
      await mkdir(path.dirname(settingsFile), { recursive: true });
      await writeFile(settingsFile, bad);
      const again = make();
      await again.load();
      expect(again.settings()).toEqual({ antigravityLogsDays: 0, freebuffChatsDays: 0 });
    }
  });

  it("grava em platform/engine-storage.json, aceita só 0, 7, 14, 30 e 90 e sobrevive a reiniciar", async () => {
    const { dataDir, make } = await setup();
    const service = make();
    await service.load();
    await expect(service.update({ antigravityLogsDays: 5 })).rejects.toThrow();
    await expect(service.update({ freebuffChatsDays: -1 })).rejects.toThrow();
    await expect(service.update({ freebuffChatsDays: 7.5 })).rejects.toThrow();
    expect(service.settings()).toEqual({ antigravityLogsDays: 0, freebuffChatsDays: 0 });
    for (const days of [7, 14, 30, 90, 0]) expect(await service.update({ antigravityLogsDays: days })).toMatchObject({ antigravityLogsDays: days });
    await service.update({ antigravityLogsDays: 14 });
    await service.update({ freebuffChatsDays: 30 });
    const saved = JSON.parse(await readFile(path.join(dataDir, "platform", "engine-storage.json"), "utf8")) as { settings: unknown };
    expect(saved.settings).toEqual({ antigravityLogsDays: 14, freebuffChatsDays: 30 });
    const again = make();
    await again.load();
    expect(again.settings()).toEqual({ antigravityLogsDays: 14, freebuffChatsDays: 30 });
  });
});

describe("armazenamento dos motores: logs do Antigravity", () => {
  it("apaga só cli-AAAAMMDD_HHMMSS.log comum e velho; nunca o cli.log, links, pastas, outros nomes ou nada fora de log/", async () => {
    const { make, agy, agyHome, outside, log } = await setup();
    const service = make();
    await service.load();
    await service.update({ antigravityLogsDays: 7 });
    const result = await service.cleanup();
    expect(result.antigravityLogs).toEqual({ files: 2, bytes: 150 });
    expect(result.freebuffChats).toEqual({ files: 0, bytes: 0 });
    expect(await exists(agy.oldLog)).toBe(false);
    expect(await exists(agy.oldLog2)).toBe(false);
    for (const kept of [agy.recentLog, agy.halfDayLog, agy.badName1, agy.badName2, agy.badName3, agy.otherFile, agy.conversation, agy.brain, agy.settings, agy.outsideTarget]) {
      expect(await exists(kept)).toBe(true);
    }
    // O link `cli.log` (que apontava para um log apagado) fica; o link com nome de log e a pasta com nome de log também.
    expect((await lstat(path.join(log, "cli.log"))).isSymbolicLink()).toBe(true);
    expect((await lstat(path.join(log, "cli-20250101_000000.log"))).isSymbolicLink()).toBe(true);
    expect((await lstat(path.join(log, "cli-20250202_000000.log"))).isDirectory()).toBe(true);
    expect(await exists(path.join(outside, "cli-20250101_000000.log"))).toBe(true);
    expect(await exists(path.join(agyHome, "conversations"))).toBe(true);
  });

  it("respeita o prazo escolhido e nunca apaga o que mudou nas últimas 24 h (mesmo com prazo menor)", async () => {
    const { make, agy } = await setup();
    const service = make();
    await service.load();
    await service.update({ antigravityLogsDays: 30 });
    expect((await service.preview()).antigravityLogs).toEqual({ files: 1, bytes: 100 });
    await service.cleanup();
    expect(await exists(agy.oldLog)).toBe(false);
    expect(await exists(agy.oldLog2)).toBe(true);
    // Um prazo de 1 dia (fora do que a tela oferece) ainda deixa o log de 12 h e o de 24 h para trás.
    const tiny = (await service.preview({ antigravityLogsDays: 1 as never })).antigravityLogs;
    expect(tiny.files).toBe(1);
    expect(await exists(agy.halfDayLog)).toBe(true);
    expect(await exists(agy.recentLog)).toBe(true);
  });

  it("sem a pasta do Antigravity configurada ou ausente: nada a apagar e nada quebra", async () => {
    const { make, root } = await setup();
    for (const service of [make({ antigravityHome: undefined }), make({ antigravityHome: path.join(root, "nao-existe") })]) {
      await service.load();
      await service.update({ antigravityLogsDays: 7 });
      expect((await service.cleanup()).antigravityLogs).toEqual({ files: 0, bytes: 0 });
    }
  });
});

describe("armazenamento dos motores: chats do Freebuff", () => {
  it("apaga só chats velhos de projects/fb-*/chats; nunca a sessão atual do agente, chat com arquivo novo, outro projeto, links, nomes fora do formato ou nada fora de chats", async () => {
    const { make, fb, fbHome, chats, outside } = await setup();
    const service = make();
    await service.load();
    await service.update({ freebuffChatsDays: 7 });
    const result = await service.cleanup();
    expect(result.freebuffChats).toEqual({ files: 2, bytes: 40 });
    expect(result.antigravityLogs).toEqual({ files: 0, bytes: 0 });
    expect(await exists(path.dirname(fb.oldChat))).toBe(false);
    expect(await exists(path.dirname(fb.oldChat2))).toBe(false);
    for (const kept of [fb.currentChat, fb.recentChat, fb.busyChat, fb.oddDir, fb.looseFile, fb.otherProject, fb.fbUpper, fb.settings, fb.projectFile, fb.outsideChat]) {
      expect(await exists(kept)).toBe(true);
    }
    expect(await exists(chats)).toBe(true);
    expect((await lstat(path.join(fbHome, "projects", "fb-link"))).isSymbolicLink()).toBe(true);
    expect((await lstat(path.join(fbHome, "projects", "fb-chatslink", "chats"))).isSymbolicLink()).toBe(true);
    expect(await exists(path.join(outside, "freebuff", chatName(300), "log.jsonl"))).toBe(true);
  });

  it("a sessão atual só é protegida para o agente certo: depois que ela deixa de ser a atual, o chat velho sai", async () => {
    const { make, fb, agentDir } = await setup();
    const service = make();
    await service.load();
    await service.update({ freebuffChatsDays: 7 });
    // O agente passou para outra sessão: o chat de antes deixa de ser a atual.
    await writeFile(path.join(agentDir, "session.json"), JSON.stringify({ provider: "freebuff", sessionId: chatName(1), started: true }));
    await service.cleanup();
    expect(await exists(fb.currentChat)).toBe(false);
    expect(await exists(fb.recentChat)).toBe(true);
  });

  it("session.json de outro motor não protege nada, e o de outro agente não protege o chat deste", async () => {
    const { make, fb, dataDir, current } = await setup();
    const other = path.join(dataDir, "workspaces", "lab", "agents", "outro");
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, "session.json"), JSON.stringify({ provider: "freebuff", sessionId: chatName(40) }));
    const service = make();
    await service.load();
    await service.update({ freebuffChatsDays: 7 });
    expect((await service.preview()).freebuffChats.files).toBe(2);
    await service.cleanup();
    // O chat velho "chatName(40)" pertence à pasta do agente `redator`, não a `outro`: sai.
    expect(await exists(path.dirname(fb.oldChat))).toBe(false);
    expect(await exists(fb.currentChat)).toBe(true);
    expect(current).toBeTruthy();
  });

  it("sem a pasta do Freebuff configurada ou ausente: nada a apagar", async () => {
    const { make, root } = await setup();
    for (const service of [make({ freebuffHome: undefined }), make({ freebuffHome: path.join(root, "nao-existe") })]) {
      await service.load();
      await service.update({ freebuffChatsDays: 7 });
      expect((await service.cleanup()).freebuffChats).toEqual({ files: 0, bytes: 0 });
    }
  });
});

describe("armazenamento dos motores: pré-visualização, limpeza única e Atividade", () => {
  it("a pré-visualização é exatamente o que a limpeza apaga, e não apaga nada", async () => {
    const { make, agy, fb } = await setup();
    const service = make();
    await service.load();
    await service.update({ antigravityLogsDays: 7, freebuffChatsDays: 14 });
    const preview = await service.preview();
    expect(preview).toEqual({ antigravityLogs: { files: 2, bytes: 150 }, freebuffChats: { files: 2, bytes: 40 } });
    expect(await exists(agy.oldLog)).toBe(true);
    expect(await exists(fb.oldChat)).toBe(true);
    const { at, ...done } = await service.cleanup();
    expect(Date.parse(at)).toBe(NOW.getTime());
    expect(done).toEqual(preview);
    // Prazos de teste na pré-visualização não mudam o que está salvo.
    expect((await service.preview({ freebuffChatsDays: 30 })).freebuffChats).toEqual({ files: 0, bytes: 0 });
    expect(service.settings()).toEqual({ antigravityLogsDays: 7, freebuffChatsDays: 14 });
  });

  it("uma limpeza por vez: chamadas no meio esperam a que está rodando", async () => {
    const { make, agy } = await setup();
    const service = make();
    await service.load();
    await service.update({ antigravityLogsDays: 7 });
    const first = service.cleanup();
    const second = service.cleanup();
    expect(second).toBe(first);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(a.antigravityLogs.files).toBe(2);
    expect(await exists(agy.oldLog)).toBe(false);
    // Terminou: a próxima chamada é uma limpeza nova (e já não acha nada).
    const third = service.cleanup();
    expect(third).not.toBe(first);
    expect((await third).antigravityLogs.files).toBe(0);
  });

  it("registra na Atividade só quando apagou algo (manual e automático), grava a última limpeza e ela sobrevive a reiniciar", async () => {
    const { make, recorded } = await setup();
    const service = make();
    await service.load();
    await service.update({ antigravityLogsDays: 7, freebuffChatsDays: 7 });
    await service.cleanup();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ auto: false, data: { antigravityLogs: { files: 2, bytes: 150 }, freebuffChats: { files: 2, bytes: 40 } } });
    expect(recorded[0]!.summary).toContain("4 arquivos apagados");
    await service.cleanup(true);
    expect(recorded).toHaveLength(1);
    const again = make();
    await again.load();
    expect((await again.snapshot()).lastCleanup).toMatchObject({ antigravityLogs: { files: 0 }, freebuffChats: { files: 0 } });
  });

  it("formatBytes", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(30 * 1024 * 1024 * 1024)).toBe("30 GB");
  });
});

describe("armazenamento dos motores: medição", () => {
  it("mede cada motor só de leitura, com a data do arquivo mais velho, e não segue links", async () => {
    const { make, dataDir, claudeFile } = await setup();
    // Hermes (com cache) e OpenClaw: as pastas de estado do Cyno.
    await file(path.join(dataDir, "platform", "engines", "hermes", "home", "cache", "a.bin"), "a".repeat(10), 3);
    await file(path.join(dataDir, "platform", "engines", "hermes", "home", ".cache", "b.bin"), "b".repeat(5), 9);
    await file(path.join(dataDir, "platform", "engines", "hermes", "home", "hermes-agent", "lib.py"), "l".repeat(100), 20);
    await file(path.join(dataDir, "platform", "engines", "openclaw", "state", "s.json"), "s".repeat(40), 4);
    // Um link dentro da pasta não é seguido.
    await symlink(path.join(dataDir, "platform"), path.join(dataDir, "platform", "engines", "openclaw", "state", "laco"));
    const snapshot = await make().snapshot();
    const usage = snapshot.usage;
    expect(usage.claude).toEqual({ bytes: 25, files: 1, oldestAt: new Date(NOW.getTime() - 12 * DAY).toISOString() });
    expect(claudeFile).toBeTruthy();
    expect(usage.antigravity.logs).toMatchObject({ files: 8, bytes: 100 + 50 + 7 + 8 + 3 + 5 + 7 + 5 });
    expect(usage.antigravity.logs.oldestAt).toBe(new Date(NOW.getTime() - 400 * DAY).toISOString());
    expect(usage.antigravity.conversations).toMatchObject({ files: 2, bytes: "conversa pessoal".length + 2 });
    expect(usage.freebuff.chats.files).toBeGreaterThanOrEqual(6);
    expect(usage.hermes.total).toMatchObject({ files: 3, bytes: 115 });
    expect(usage.hermes.total.oldestAt).toBe(new Date(NOW.getTime() - 20 * DAY).toISOString());
    expect(usage.hermes.cache).toMatchObject({ files: 2, bytes: 15 });
    expect(usage.openclaw).toMatchObject({ files: 1, bytes: 40 });
  });

  it("pasta de motor ausente (ou não configurada) mede zero, sem erro", async () => {
    const root = await tempDir();
    const service = new EngineStorage({ dataDir: path.join(root, "data"), now: () => NOW, log: silent });
    const empty = { bytes: 0, files: 0, oldestAt: null };
    expect((await service.snapshot()).usage).toEqual({
      claude: empty,
      antigravity: { logs: empty, conversations: empty },
      freebuff: { chats: empty },
      hermes: { total: empty, cache: empty },
      openclaw: empty,
    });
  });
});

describe("API /api/settings/engine-storage", () => {
  it("GET mostra tudo desligado e os tamanhos; PUT valida; preview mostra o que sairia; cleanup apaga e registra", async () => {
    const root = await tempDir();
    const agyHome = path.join(root, "agy");
    const fbHome = path.join(root, "manicode");
    const oldLog = await file(path.join(agyHome, "log", "cli-20200101_000000.log"), "x".repeat(64), 400);
    await file(path.join(agyHome, "conversations", "c.pb"), "conversa", 400);
    const { app, dataDir } = await setupApp({ engineStorage: { antigravityHome: agyHome, freebuffHome: fbHome } });

    const initial = (await app.inject({ method: "GET", url: ENGINE_STORAGE_PATH })).json<EngineStorageResponse>();
    expect(initial.settings).toEqual({ antigravityLogsDays: 0, freebuffChatsDays: 0 });
    expect(initial.lastCleanup).toBeNull();
    expect(initial.usage.antigravity.logs).toMatchObject({ files: 1, bytes: 64 });
    expect(initial.usage.freebuff.chats.files).toBe(0);

    for (const payload of [{ antigravityLogsDays: 5 }, { antigravityLogsDays: "7" }, { outra: 1 }]) {
      expect((await app.inject({ method: "PUT", url: ENGINE_STORAGE_PATH, payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "GET", url: `${ENGINE_STORAGE_PREVIEW_PATH}?antigravityLogsDays=5` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `${ENGINE_STORAGE_PREVIEW_PATH}?antigravityLogsDays=abc` })).statusCode).toBe(400);

    // Desligado: a pré-visualização e a limpeza não acham nada.
    expect((await app.inject({ method: "GET", url: ENGINE_STORAGE_PREVIEW_PATH })).json<EngineStoragePreview>().antigravityLogs.files).toBe(0);
    expect((await app.inject({ method: "POST", url: ENGINE_STORAGE_CLEANUP_PATH })).json<EngineStorageCleanupResult>().antigravityLogs.files).toBe(0);
    expect(await exists(oldLog)).toBe(true);

    // Com prazo na consulta: mostra o que sairia sem salvar nem apagar.
    expect((await app.inject({ method: "GET", url: `${ENGINE_STORAGE_PREVIEW_PATH}?antigravityLogsDays=7&freebuffChatsDays=0` })).json<EngineStoragePreview>()).toEqual({
      antigravityLogs: { files: 1, bytes: 64 },
      freebuffChats: { files: 0, bytes: 0 },
    });
    expect((await app.inject({ method: "GET", url: ENGINE_STORAGE_PATH })).json<EngineStorageResponse>().settings.antigravityLogsDays).toBe(0);

    const put = await app.inject({ method: "PUT", url: ENGINE_STORAGE_PATH, payload: { antigravityLogsDays: 7 } });
    expect(put.statusCode).toBe(200);
    expect(put.json<EngineStorageResponse>().settings).toEqual({ antigravityLogsDays: 7, freebuffChatsDays: 0 });
    expect((await app.inject({ method: "GET", url: ENGINE_STORAGE_PREVIEW_PATH })).json<EngineStoragePreview>().antigravityLogs).toEqual({ files: 1, bytes: 64 });

    const cleaned = (await app.inject({ method: "POST", url: ENGINE_STORAGE_CLEANUP_PATH })).json<EngineStorageCleanupResult>();
    expect(cleaned.antigravityLogs).toEqual({ files: 1, bytes: 64 });
    expect(await exists(oldLog)).toBe(false);
    expect((await app.inject({ method: "GET", url: ENGINE_STORAGE_PATH })).json<EngineStorageResponse>().lastCleanup).toMatchObject({ antigravityLogs: { files: 1, bytes: 64 } });
    expect(JSON.parse(await readFile(path.join(dataDir, "platform", "engine-storage.json"), "utf8"))).toMatchObject({ settings: { antigravityLogsDays: 7, freebuffChatsDays: 0 } });
  });
});
