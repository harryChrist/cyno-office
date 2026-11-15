import type { VersionResponse } from "@cyno/shared";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { call } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";
import { installErrorHandlers } from "../platform/http/errors";
import type { VersionService } from "../platform/version/service";
import { makeFixture, pushFromOther, type Fixture } from "../platform/version/test-repo";
import type { NpmRunner } from "../platform/version/updater";
import { registerVersionRoutes } from "./version";

const setupApp = useTestApp();
let fixture: Fixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

describe("API: versão e atualizações", () => {
  it("GET devolve a versão sem rede e a verificação ainda vazia; POST verifica e guarda o resultado", async () => {
    fixture = makeFixture({ version: "2.0.0" });
    const test = await setupApp({ version: { rootDir: fixture.clone } });
    const first = await call<VersionResponse>(test.app, "GET", "/api/version");
    expect(first.version).toMatchObject({ version: "2.0.0", build: 2, source: "git" });
    expect(first.version.label).toMatch(/^v2\.0\.0 · build 2 · [0-9a-f]{7}$/);
    expect(first.check).toMatchObject({ status: "none", checkedAt: null, auto: false, branch: "main" });

    const checked = await call<VersionResponse>(test.app, "POST", "/api/version/check", undefined, 200);
    expect(checked.check.status).toBe("up-to-date");
    expect((await call<VersionResponse>(test.app, "GET", "/api/version")).check.checkedAt).toBe(checked.check.checkedAt);
  });

  it("clique repetido em seguida devolve o resultado anterior", async () => {
    fixture = makeFixture();
    const test = await setupApp({ version: { rootDir: fixture.clone } });
    const one = await call<VersionResponse>(test.app, "POST", "/api/version/check", undefined, 200);
    pushFromOther(fixture, ["novo"]);
    const two = await call<VersionResponse>(test.app, "POST", "/api/version/check", undefined, 200);
    expect(two.check.checkedAt).toBe(one.check.checkedAt);
    expect(two.check.status).toBe("up-to-date");
  });
});

describe("API: baixar a atualização", () => {
  it("POST /api/version/update baixa em segundo plano; o GET mostra o resultado e o reinício pendente", async () => {
    fixture = makeFixture();
    const npm = vi.fn<NpmRunner>(async () => ({ ok: true, output: "ok" }));
    const test = await setupApp({ version: { rootDir: fixture.clone, applyEnabled: true, runMode: "pm2", npm } });
    const remote = pushFromOther(fixture, ["novo"]);
    const checked = await call<VersionResponse>(test.app, "POST", "/api/version/check", undefined, 200);
    expect(checked.update).toMatchObject({ canDownload: true, runMode: "pm2", restartNeeded: false });

    const started = await call<VersionResponse>(test.app, "POST", "/api/version/update", undefined, 200);
    expect(started.update.job?.state).toMatch(/running|done/);
    await vi.waitFor(async () => expect((await call<VersionResponse>(test.app, "GET", "/api/version")).update.job?.state).toBe("done"));
    const done = await call<VersionResponse>(test.app, "GET", "/api/version");
    expect(done.update).toMatchObject({ restartNeeded: true, diskCommit: { hash: remote }, canDownload: false });
    expect(npm).not.toHaveBeenCalled();
  });

  it("recusa com 409 e o motivo quando não pode (padrão do app: botão desligado)", async () => {
    fixture = makeFixture();
    const test = await setupApp({ version: { rootDir: fixture.clone } });
    pushFromOther(fixture, ["novo"]);
    await call<VersionResponse>(test.app, "POST", "/api/version/check", undefined, 200);
    const refused = await call<{ error: string }>(test.app, "POST", "/api/version/update", undefined, 409);
    expect(refused.error).toContain("CYNO_UPDATE_APPLY=off");
  });
});

describe("rota de atualização com o serviço falso", () => {
  it("devolve a visão quando começa ou quando já está rodando, e 409 com o motivo quando não pode", async () => {
    const view = { version: {}, check: {}, update: { canDownload: false } } as unknown as VersionResponse;
    const results: Awaited<ReturnType<VersionService["startUpdate"]>>[] = [{ started: true }, { started: false, running: true }, { started: false, running: false, reason: "Motivo qualquer." }];
    const fake = { view: async () => view, checker: { check: async () => view.check }, startUpdate: async () => results.shift()! };
    const app = Fastify();
    installErrorHandlers(app);
    registerVersionRoutes(app, fake as unknown as VersionService);
    expect((await app.inject({ method: "POST", url: "/api/version/update" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/version/update" })).statusCode).toBe(200);
    const refused = await app.inject({ method: "POST", url: "/api/version/update" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "Motivo qualquer." });
    await app.close();
  });
});
