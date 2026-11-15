import { workspaceAccess, type ConnectorsStdioResponse, type Workspace } from "@cyno/shared";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { call, createAgent, createRoom, createWorkspace, wsApi } from "../dev/test-api";
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

describe("API: pastas de trabalho do workspace e ajuste por agente", () => {
  it("cadastra, valida em português, edita, tira e persiste; o ajuste do agente só reduz", async () => {
    const test = await setupApp();
    const ws = (await createWorkspace(test.app, "Pastas")).id;
    const folders = await mkdtemp(path.join(os.tmpdir(), "cyno-api-folders-"));
    const projeto = path.join(folders, "projeto");
    const vault = path.join(folders, "Meu Vault");
    await mkdir(projeto);
    await mkdir(vault);
    const list = async () => (await call<Workspace[]>(test.app, "GET", "/api/workspaces")).find((item) => item.id === ws)!.folders;
    const base = `/api/workspaces/${ws}/folders`;
    expect(await list()).toBeUndefined();

    // Erros do servidor em português (400), nada gravado.
    for (const [body, text] of [
      [{ name: "X", path: "projeto" }, "caminho completo"],
      [{ name: "X", path: path.join(folders, "nao-existe") }, "não existe"],
      [{ name: "X", path: "/" }, "raiz do computador"],
      [{ name: "X", path: test.dataDir }, "dados do próprio Cyno"],
      [{ name: "", path: projeto }, "Dê um nome"],
    ] as const) {
      const error = await call<{ error: string; details?: { message: string }[] }>(test.app, "POST", base, body, 400);
      expect(JSON.stringify(error)).toContain(text);
    }
    expect(await list()).toBeUndefined();

    const created = await call<Workspace>(test.app, "POST", base, { name: "Projeto", path: projeto, purpose: "Código do app.", mode: "write" }, 201);
    const second = await call<Workspace>(test.app, "POST", base, { name: "Vault", path: vault }, 201);
    expect(second.folders?.map((folder) => [folder.name, folder.mode])).toEqual([["Projeto", "write"], ["Vault", "read"]]);
    expect(created.folders?.[0]?.path).toBe(await realpath(projeto));
    expect(JSON.stringify(await call(test.app, "POST", base, { name: "Outra", path: projeto }, 400))).toContain('já está cadastrada (como \\"Projeto\\")');

    const [p, v] = second.folders!;
    const edited = await call<Workspace>(test.app, "PATCH", `${base}/${v!.id}`, { mode: "write", purpose: "Notas do Obsidian." });
    expect(edited.folders?.[1]).toMatchObject({ mode: "write", purpose: "Notas do Obsidian." });
    expect((await call<Workspace>(test.app, "PATCH", `${base}/${v!.id}`, { purpose: "" })).folders?.[1]?.purpose).toBeUndefined();
    await call(test.app, "PATCH", `${base}/${v!.id}`, { path: "/etc" }, 400);
    await call(test.app, "PATCH", `${base}/nao-existe`, { mode: "read" }, 404);

    // Agente: o ajuste só reduz e vale na hora; {} volta a seguir o workspace.
    const team = await call<{ id: string; roomId: string }>(test.app, "POST", `${wsApi(ws)}/teams`, { roomId: (await createRoom(test.app, "Sala", {}, ws)).id, name: "Time", focus: "x" });
    const agent = await createAgent(test.app, team.id, "Clara", ws);
    expect(agent.folders).toBeUndefined();
    const patched = await call<{ folders?: Record<string, string> }>(test.app, "PATCH", `${wsApi(ws)}/agents/${agent.id}`, { folders: { [p!.id]: "read", [v!.id]: "off" } });
    expect(patched.folders).toEqual({ [p!.id]: "read", [v!.id]: "off" });
    await call(test.app, "PATCH", `${wsApi(ws)}/agents/${agent.id}`, { folders: { [p!.id]: "write" } }, 400);
    expect((await call<{ folders?: unknown }>(test.app, "PATCH", `${wsApi(ws)}/agents/${agent.id}`, { folders: {} })).folders).toBeUndefined();

    // Persiste ao reiniciar; tirar a pasta não apaga nada do disco.
    await test.app.close();
    const again = await setupApp({ dataDir: test.dataDir });
    const reloaded = (await call<Workspace[]>(again.app, "GET", "/api/workspaces")).find((item) => item.id === ws)!;
    expect(reloaded.folders).toHaveLength(2);
    const afterRemove = await call<Workspace>(again.app, "DELETE", `/api/workspaces/${ws}/folders/${p!.id}`, undefined, 200);
    expect(afterRemove.folders?.map((folder) => folder.name)).toEqual(["Vault"]);
    expect(existsSync(projeto)).toBe(true);
    expect((await call<Workspace>(again.app, "DELETE", `/api/workspaces/${ws}/folders/${v!.id}`, undefined, 200)).folders).toBeUndefined();
    await call(again.app, "DELETE", `/api/workspaces/${ws}/folders/${v!.id}`, undefined, 404);
    await rm(folders, { recursive: true, force: true });
  });
});
