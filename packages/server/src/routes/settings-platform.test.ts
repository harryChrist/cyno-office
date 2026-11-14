import { workspaceAccess, type ConnectorsStdioResponse, type Workspace } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, createWorkspace } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";

const setupApp = useTestApp();
const STDIO = "/api/settings/connectors-stdio";

describe("API: conectores locais (stdio) pela tela", () => {
  it("lê o padrão do .env, o dono liga e desliga (vale na hora e sobrevive a reiniciar) e volta ao padrão", async () => {
    const test = await setupApp({ connectors: { autoTest: false, allowStdio: false } });
    expect(await call<ConnectorsStdioResponse>(test.app, "GET", STDIO)).toEqual({ enabled: false, source: "env", envDefault: false });
    // Desligado: criar um conector local é recusado.
    await call(test.app, "POST", "/api/library/connectors", { name: "Local", kind: "stdio", command: "/bin/true" }, 403);

    expect(await call<ConnectorsStdioResponse>(test.app, "PUT", STDIO, { enabled: true })).toEqual({ enabled: true, source: "owner", envDefault: false });
    await call(test.app, "POST", "/api/library/connectors", { name: "Local", kind: "stdio", command: "/bin/true" }, 201);
    await call(test.app, "PUT", STDIO, { enabled: "sim" }, 400);

    await test.app.close();
    const again = await setupApp({ dataDir: test.dataDir, connectors: { autoTest: false, allowStdio: false } });
    expect(await call<ConnectorsStdioResponse>(again.app, "GET", STDIO)).toEqual({ enabled: true, source: "owner", envDefault: false });

    expect(await call<ConnectorsStdioResponse>(again.app, "DELETE", STDIO, undefined, 200)).toEqual({ enabled: false, source: "env", envDefault: false });
    await call(again.app, "POST", "/api/library/connectors", { name: "Outro", kind: "stdio", command: "/bin/true" }, 403);
  });
});

describe("API: voltar ao padrão da plataforma num campo do workspace", () => {
  it("PATCH com reset apaga o valor próprio de dispatch, Maestro e acesso", async () => {
    const test = await setupApp();
    const ws = (await createWorkspace(test.app, "Padrao")).id;
    await call(test.app, "PATCH", `/api/workspaces/${ws}`, { dispatch: { maxRunning: 2, perAgent: 1 }, maestro: { keepAlive: true } });
    await call(test.app, "PUT", `/api/workspaces/${ws}/access`, { internet: false, allowedDomains: ["a.com"] });
    let current = (await call<Workspace[]>(test.app, "GET", "/api/workspaces")).find((item) => item.id === ws)!;
    expect(current.dispatch).toEqual({ maxRunning: 2, perAgent: 1 });
    expect(current.maestro).toEqual({ keepAlive: true });
    expect(current.access).toMatchObject({ internet: false, allowedDomains: ["a.com"] });

    await call(test.app, "PATCH", `/api/workspaces/${ws}`, { reset: ["dispatch.maxRunning", "maestro.keepAlive", "access.internet", "access.allowedDomains"] });
    current = (await call<Workspace[]>(test.app, "GET", "/api/workspaces")).find((item) => item.id === ws)!;
    expect(current.dispatch).toEqual({ perAgent: 1 });
    expect(current.maestro).toBeUndefined();
    expect((current.access as Record<string, unknown>).internet).toBeUndefined();
    expect((current.access as Record<string, unknown>).allowedDomains).toBeUndefined();
    expect(workspaceAccess(current.access)).toMatchObject({ internet: true, allowedDomains: [] });

    await call(test.app, "PATCH", `/api/workspaces/${ws}`, { reset: ["dispatch.perAgent"] });
    expect((await call<Workspace[]>(test.app, "GET", "/api/workspaces")).find((item) => item.id === ws)!.dispatch).toBeUndefined();
    await call(test.app, "PATCH", `/api/workspaces/${ws}`, { reset: ["name"] }, 400);
    await call(test.app, "PATCH", `/api/workspaces/${ws}`, { reset: [] }, 400);
  });
});
