import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunMode } from "@cyno/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redact, tailLines, type NpmRunner } from "./updater";
import { VersionService } from "./service";
import { commit, git, makeFixture, pushFromOther, tempDir, type Fixture } from "./test-repo";

let fixture: Fixture | undefined;
let cleanups: (() => void)[] = [];
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

const LOCK = JSON.stringify({ name: "x", lockfileVersion: 3 });

type Setup = { enabled?: boolean; runMode?: RunMode; npm?: NpmRunner };
/** Serviço de versão sobre o clone temporário; a versão do processo é lida antes de qualquer mudança no disco. */
async function serviceFor(root: string, setup: Setup = {}) {
  const npm = vi.fn<NpmRunner>(setup.npm ?? (async () => ({ ok: true, output: "added 3 packages" })));
  const service = new VersionService({
    startDir: root,
    rootDir: root,
    config: { auto: false, branch: "main" },
    applyEnabled: setup.enabled ?? true,
    runMode: setup.runMode ?? "start",
    npm,
    liveTtlMs: 0,
    lsRemoteTimeoutMs: 15_000,
  });
  await service.local();
  return { service, npm };
}

describe("baixar a atualização", () => {
  it("avanço direto: baixa, muda o HEAD, não roda npm sem mudança no package-lock e pede reinício", async () => {
    fixture = makeFixture();
    const { service, npm } = await serviceFor(fixture.clone);
    const before = git(fixture.clone, "rev-parse", "HEAD");
    const remote = pushFromOther(fixture, ["novo um", "novo dois"]);
    await service.checker.check();
    const ready = await service.view();
    expect(ready.update).toMatchObject({ canDownload: true, enabled: true, runMode: "start", restartNeeded: false, job: null });
    expect(ready.update.blockedReason).toBeUndefined();

    expect(await service.startUpdate()).toEqual({ started: true });
    await service.updater.whenIdle();
    const after = await service.view();
    expect(git(fixture.clone, "rev-parse", "HEAD")).toBe(remote);
    expect(npm).not.toHaveBeenCalled();
    expect(after.update.job).toMatchObject({ state: "done", step: null, codeUpdated: true, installRan: false, installFailed: false, from: before.slice(0, 7), to: remote.slice(0, 7), message: "Atualização baixada. Reinicie para aplicar." });
    expect(after.update.job?.log.join("\n")).toContain("Dependências sem mudança");
    expect(after.update).toMatchObject({ restartNeeded: true, canDownload: false, diskCommit: { hash: remote }, runningCommit: { hash: before } });
    // a verificação foi refeita contra o disco novo
    expect(after.check.status).toBe("up-to-date");
    // o commit instalado continua o do processo
    expect(after.version.commit?.hash).toBe(before);
  });

  it("package-lock mudou: roda o npm install (executor falso) uma vez, na raiz", async () => {
    fixture = makeFixture();
    const { service, npm } = await serviceFor(fixture.clone);
    pushFromOther(fixture, ["novo"], { "package-lock.json": LOCK });
    await service.checker.check();
    await service.startUpdate();
    await service.updater.whenIdle();
    expect(npm).toHaveBeenCalledTimes(1);
    expect(npm.mock.calls[0]?.[0]).toBe(fixture.clone);
    const job = (await service.view()).update.job;
    expect(job).toMatchObject({ state: "done", installRan: true, installFailed: false });
    expect(job?.log.join("\n")).toContain("added 3 packages");
  });

  it("o npm install falhou: o código novo fica, o resultado diz para rodar npm install à mão e o log sai sem credenciais", async () => {
    fixture = makeFixture();
    const { service } = await serviceFor(fixture.clone, { npm: async () => ({ ok: false, output: "npm ERR! algo deu errado\nnpm ERR! _authToken=abc123\nnpm ERR! https://user:segredo@registro.example/pacote" }) });
    const remote = pushFromOther(fixture, ["novo"], { "package-lock.json": LOCK });
    await service.checker.check();
    await service.startUpdate();
    await service.updater.whenIdle();
    const view = await service.view();
    expect(git(fixture.clone, "rev-parse", "HEAD")).toBe(remote);
    expect(view.update.job).toMatchObject({ state: "failed", codeUpdated: true, installRan: true, installFailed: true });
    expect(view.update.job?.message).toContain("npm install");
    const log = view.update.job?.log.join("\n") ?? "";
    expect(log).toContain("algo deu errado");
    expect(log).not.toContain("abc123");
    expect(log).not.toContain("segredo");
    expect(view.update.restartNeeded).toBe(true);
  });

  it("divergência: falha limpa, sem alterar nada", async () => {
    fixture = makeFixture();
    commit(fixture.clone, "local.txt", "só local");
    const { service, npm } = await serviceFor(fixture.clone);
    pushFromOther(fixture, ["só no origin"]);
    const head = git(fixture.clone, "rev-parse", "HEAD");
    await service.checker.check();
    expect((await service.view()).update.canDownload).toBe(true);
    await service.startUpdate();
    await service.updater.whenIdle();
    const job = (await service.view()).update.job;
    expect(job).toMatchObject({ state: "failed", codeUpdated: false, to: null });
    expect(job?.message).toContain("Nada foi alterado");
    expect(git(fixture.clone, "rev-parse", "HEAD")).toBe(head);
    expect(git(fixture.clone, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(npm).not.toHaveBeenCalled();
  });

  it("falha do fetch: nada muda e o motivo vem no resultado", async () => {
    fixture = makeFixture();
    const { service } = await serviceFor(fixture.clone);
    pushFromOther(fixture, ["novo"]);
    await service.checker.check();
    git(fixture.clone, "remote", "set-url", "origin", path.join(fixture.base, "nao-existe.git"));
    const head = git(fixture.clone, "rev-parse", "HEAD");
    await service.startUpdate();
    await service.updater.whenIdle();
    const job = (await service.view()).update.job;
    expect(job).toMatchObject({ state: "failed", codeUpdated: false });
    expect(job?.message).toContain("Nada foi alterado");
    expect(git(fixture.clone, "rev-parse", "HEAD")).toBe(head);
  });

  it("uma atualização por vez: o segundo pedido devolve o andamento, sem iniciar outra", async () => {
    fixture = makeFixture();
    let release: (result: { ok: boolean; output: string }) => void = () => undefined;
    const gate = new Promise<{ ok: boolean; output: string }>((resolve) => {
      release = resolve;
    });
    const { service, npm } = await serviceFor(fixture.clone, { npm: () => gate });
    pushFromOther(fixture, ["novo"], { "package-lock.json": LOCK });
    await service.checker.check();
    // Dois pedidos ao mesmo tempo: exatamente um começa (qual dos dois depende de quem lê o disco primeiro).
    const both = await Promise.all([service.startUpdate(), service.startUpdate()]);
    expect(both.filter((result) => result.started)).toEqual([{ started: true }]);
    expect(both.filter((result) => !result.started)).toEqual([{ started: false, running: true }]);
    await vi.waitFor(async () => expect((await service.view()).update.job?.step).toBe("installing"));
    const mid = await service.view();
    expect(mid.update).toMatchObject({ canDownload: false, blockedReason: "Uma atualização está em andamento." });
    expect(mid.update.job?.state).toBe("running");
    expect(await service.startUpdate()).toEqual({ started: false, running: true });
    release({ ok: true, output: "ok" });
    await service.updater.whenIdle();
    expect(npm).toHaveBeenCalledTimes(1);
    expect((await service.view()).update.job?.state).toBe("done");
  });
});

describe("quando o botão não pode baixar", () => {
  it("mudanças locais em arquivos versionados bloqueiam, e o pedido é recusado", async () => {
    fixture = makeFixture();
    const { service } = await serviceFor(fixture.clone);
    pushFromOther(fixture, ["novo"]);
    await service.checker.check();
    writeFileSync(path.join(fixture.clone, "a.txt"), "mexi aqui\n");
    const view = await service.view();
    expect(view.update.canDownload).toBe(false);
    expect(view.update.blockedReason).toContain("mudanças locais");
    const head = git(fixture.clone, "rev-parse", "HEAD");
    const started = await service.startUpdate();
    expect(started).toMatchObject({ started: false, running: false });
    expect(git(fixture.clone, "rev-parse", "HEAD")).toBe(head);
    expect((await service.view()).update.job).toBeNull();
  });

  it("outro ramo que não o estável bloqueia, com o nome do ramo", async () => {
    fixture = makeFixture();
    const { service } = await serviceFor(fixture.clone);
    git(fixture.clone, "checkout", "-b", "dev");
    pushFromOther(fixture, ["novo"]);
    await service.checker.check();
    const view = await service.view();
    expect(view.update.canDownload).toBe(false);
    expect(view.update.blockedReason).toBe("Esta instalação está no ramo dev; o botão só atualiza instalações no ramo main.");
    expect(await service.startUpdate()).toMatchObject({ started: false, running: false });
  });

  it("sem atualização na última verificação bloqueia", async () => {
    fixture = makeFixture();
    const { service } = await serviceFor(fixture.clone);
    expect((await service.view()).update.blockedReason).toContain("Não há atualização");
    await service.checker.check();
    expect((await service.view()).update.canDownload).toBe(false);
  });

  it("CYNO_UPDATE_APPLY=off desliga o botão por configuração", async () => {
    fixture = makeFixture();
    const { service } = await serviceFor(fixture.clone, { enabled: false });
    pushFromOther(fixture, ["novo"]);
    await service.checker.check();
    const view = await service.view();
    expect(view.update).toMatchObject({ enabled: false, canDownload: false });
    expect(view.update.blockedReason).toContain("CYNO_UPDATE_APPLY=off");
    expect(await service.startUpdate()).toMatchObject({ started: false, running: false });
  });

  it("sem repositório git (Docker): atualização no hospedeiro", async () => {
    const dir = tempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", workspaces: ["packages/*"] }));
    const { service } = await serviceFor(dir, { runMode: "docker" });
    const view = await service.view();
    expect(view.update).toMatchObject({ canDownload: false, runMode: "docker", blockedReason: "Nesta instalação a atualização é feita no computador hospedeiro.", restartNeeded: false });
    expect(await service.startUpdate()).toMatchObject({ started: false, running: false });
  });
});

describe("reinício pendente", () => {
  it("avanço feito por fora (git pull à mão) também pede reinício, e a verificação velha conta como em dia", async () => {
    fixture = makeFixture();
    const { service } = await serviceFor(fixture.clone);
    const before = git(fixture.clone, "rev-parse", "HEAD");
    const remote = pushFromOther(fixture, ["novo"]);
    await service.checker.check();
    expect((await service.view()).check.status).toBe("update-available");
    git(fixture.clone, "pull", "--ff-only", "origin", "main");
    const view = await service.view();
    expect(view.update).toMatchObject({ restartNeeded: true, diskCommit: { hash: remote }, runningCommit: { hash: before }, canDownload: false, job: null });
    expect(view.update.blockedReason).toContain("Reinicie");
    expect(view.check.status).toBe("up-to-date");
  });

  it("sem diferença entre o processo e o disco, não há reinício pendente", async () => {
    fixture = makeFixture();
    const { service } = await serviceFor(fixture.clone);
    const view = await service.view();
    expect(view.update).toMatchObject({ restartNeeded: false, diskCommit: null });
  });
});

describe("log seguro", () => {
  it("tira credenciais de URLs, tokens do GitHub e do npm", () => {
    expect(redact("fetch https://usuario:senha@exemplo.invalid/repo.git")).toBe("fetch https://exemplo.invalid/repo.git");
    expect(redact("token ghp_abcdefghijklmnop e github_pat_ABCDEFGH12345")).toBe("token [oculto] e [oculto]");
    expect(redact("//registry/:_authToken=segredo")).toContain("[oculto]");
    expect(redact("Authorization: Bearer abc.def")).toBe("Authorization: Bearer [oculto]");
  });
  it("limita a quantidade e o tamanho das linhas", () => {
    const lines = tailLines(Array.from({ length: 50 }, (_, index) => `linha ${index}`).join("\n") + `\n${"x".repeat(900)}`, 5);
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)?.length).toBeLessThanOrEqual(301);
    expect(lines[0]).toBe("linha 46");
  });
});
