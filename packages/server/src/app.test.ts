import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ApiErrorBody, EnginesResponse, OfficeState, ServerEvent, Workspace } from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { MAESTRO, MAESTRO_AVATAR } from "@cyno/shared";
import { buildApp } from "./app";
import { seedDataDir } from "./workspace/office/seed";
import { migrateLegacyLayout } from "./store/legacy-layout";
import { call, createWorkspace, getOffice, soloTeam } from "./dev/test-api";
import { TEST_MODEL_DEFAULTS, testRunner, useTestApp } from "./dev/test-app";
import { useTempDirs } from "./dev/test-utils";

const setupApp = useTestApp();
const tempDir = useTempDirs();

/** Conecta no /ws (com a query dada) guardando as mensagens desde o primeiro byte. */
async function connectWs(app: FastifyInstance, query = "") {
  const received: ServerEvent[] = [];
  const waiters: Array<() => void> = [];
  let closeCode: number | undefined;
  const socket = await app.injectWS(`/ws${query}`, {}, {
    onInit: (ws) => {
      ws.on("message", (data) => {
        received.push(JSON.parse(data.toString()) as ServerEvent);
        waiters.splice(0).forEach((wake) => wake());
      });
      ws.on("close", (code) => {
        closeCode = code;
        waiters.splice(0).forEach((wake) => wake());
      });
    },
  });
  const nextMessage = async (index: number): Promise<ServerEvent> => {
    while (received.length <= index) await new Promise<void>((resolve) => waiters.push(resolve));
    return received[index]!;
  };
  const closed = async (): Promise<number> => {
    while (closeCode === undefined) await new Promise<void>((resolve) => waiters.push(resolve));
    return closeCode;
  };
  return { socket, received, nextMessage, closed };
}

describe("API", () => {
  it("GET /api/health", async () => {
    const { app } = await setupApp();
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("GET /api/engines: o simulado sempre; as CLIs só se o binário existir", async () => {
    const { app } = await setupApp();
    const response = await app.inject({ method: "GET", url: "/api/engines" });
    expect(response.statusCode).toBe(200);
    const { engines } = response.json() as EnginesResponse;
    expect(engines.map((engine) => [engine.engine, engine.label, engine.available])).toEqual([
      ["mock", "Simulado", true],
      ["claude", "Claude Code", false],
      ["gemini", "Antigravity", false],
      ["freebuff", "Freebuff", false],
      ["openclaw", "OpenClaw", false],
      ["hermes", "Hermes", false],
    ]);
    expect(engines[2]!.reason).toContain("não encontrado");
    expect(engines[3]!.reason).toContain("não encontrado");
    expect(engines[4]!.reason).toBeTruthy();
    expect(engines[5]!.reason).toBeTruthy();
  });

  it("GET /api/w/principal/office devolve o estado do seed", async () => {
    const { app } = await setupApp();
    const response = await app.inject({ method: "GET", url: "/api/w/principal/office" });
    expect(response.statusCode).toBe(200);
    const office = response.json<OfficeState>();
    expect(office.rooms.map((room) => [room.id, room.kind])).toEqual([
      ["projetox", "team"],
      ["projetoy", "team"],
      ["sala-do-maestro", "maestro"],
    ]);
    expect(office.teams).toHaveLength(5);
    expect(office.agents).toHaveLength(11);
    expect(office.tasks).toEqual([]);
  });

  it("responde 404 em JSON para rotas desconhecidas", async () => {
    const { app } = await setupApp();
    const response = await app.inject({ method: "GET", url: "/api/nao-existe" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Rota não encontrada" });
  });
});

describe("boot dos workspaces", () => {
  it("bootOn 'listen': nada retoma no ready; os workspaces (e as CLIs) só sobem com a porta já aberta, uma vez", async () => {
    const dataDir = await tempDir();
    await seedDataDir(dataDir);
    const app = await buildApp({ auth: { open: true }, dataDir, runner: testRunner(), initialModelDefaults: TEST_MODEL_DEFAULTS, connectors: { autoTest: false }, bootOn: "listen" });
    try {
      const listeningAtStart: boolean[] = [];
      const original = app.workspaces.start.bind(app.workspaces);
      const start = vi.spyOn(app.workspaces, "start").mockImplementation(async () => {
        listeningAtStart.push(app.server.listening);
        await original();
      });
      await app.ready();
      expect(start).not.toHaveBeenCalled();
      await app.listen({ port: 0, host: "127.0.0.1" });
      await app.bootWorkspaces();
      expect(start).toHaveBeenCalledOnce();
      expect(listeningAtStart).toEqual([true]);
    } finally {
      await app.close();
    }
  });

  it("padrão ('ready'): retoma no ready, sem porta (testes com app.inject)", async () => {
    const dataDir = await tempDir();
    await seedDataDir(dataDir);
    const app = await buildApp({ auth: { open: true }, dataDir, runner: testRunner(), initialModelDefaults: TEST_MODEL_DEFAULTS, connectors: { autoTest: false } });
    try {
      const start = vi.spyOn(app.workspaces, "start");
      await app.ready();
      expect(start).toHaveBeenCalledOnce();
      await app.bootWorkspaces();
      expect(start).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});

describe("API: workspaces", () => {
  it("lista, cria (id = slug do nome), renomeia e exclui", async () => {
    const { app, dataDir } = await setupApp();
    expect((await call<Workspace[]>(app, "GET", "/api/workspaces")).map((ws) => ws.id)).toEqual(["principal"]);

    const linkedin = await createWorkspace(app, "LinkedIn");
    expect(linkedin).toMatchObject({ id: "linkedin", name: "LinkedIn" });
    expect((await createWorkspace(app, "linkedin")).id).toBe("linkedin-2");

    // Workspace novo: o lobby (Cérebro global com uma nota inicial) e a Sala do Maestro, com o
    // time interno "Gerência" e o Maestro; nenhum quarto de time, nenhum outro agente.
    const office = await getOffice(app, "linkedin");
    expect(office.rooms).toEqual([
      expect.objectContaining({ id: "sala-do-maestro", kind: "maestro", gridPosition: { x: 1, y: 0 }, readsGlobalBrain: true }),
    ]);
    expect(office.teams.map((team) => team.name)).toEqual(["Gerência"]);
    expect(office.agents.map((agent) => [agent.name, agent.role])).toEqual([["Maestro", "maestro"]]);
    expect(office.tasks).toEqual([]);
    const globalNotes = await readdir(path.join(dataDir, "workspaces", "linkedin", "brains", "global"));
    // A nota de boas-vindas e os fixos do Cérebro em camadas (regras, índice e briefing).
    expect(globalNotes.sort()).toEqual(["_briefing.md", "_indice.md", "_regras.md", "sobre-o-workspace.md"]);

    const renamed = await call<Workspace>(app, "PATCH", "/api/workspaces/linkedin", { name: "LinkedIn BR" });
    expect(renamed).toMatchObject({ id: "linkedin", name: "LinkedIn BR" });
    const saved = JSON.parse(await readFile(path.join(dataDir, "workspaces.json"), "utf8")) as Workspace[];
    expect(saved.map((ws) => [ws.id, ws.name])).toEqual([
      ["principal", "Principal"],
      ["linkedin", "LinkedIn BR"],
      ["linkedin-2", "linkedin"],
    ]);

    await call(app, "DELETE", "/api/workspaces/linkedin-2");
    expect((await call<Workspace[]>(app, "GET", "/api/workspaces")).map((ws) => ws.id)).toEqual(["principal", "linkedin"]);
    // A pasta não é apagada: vai para excluidos/.
    expect(await readdir(path.join(dataDir, "workspaces"))).not.toContain("linkedin-2");
    expect((await readdir(path.join(dataDir, "excluidos", "workspaces")))[0]).toMatch(/^linkedin-2-/);
    // E um workspace novo com o mesmo nome não herda nada.
    expect((await createWorkspace(app, "linkedin")).id).toBe("linkedin-2");
  });

  it("404 claro para workspace inexistente em qualquer rota", async () => {
    const { app } = await setupApp();
    const expected: ApiErrorBody = { error: 'Workspace "nada" não encontrado' };
    for (const [method, url] of [
      ["GET", "/api/w/nada/office"],
      ["POST", "/api/w/nada/rooms"],
      ["GET", "/api/w/nada/tasks"],
      ["GET", "/api/w/nada/rooms/projetox/context"],
      ["PATCH", "/api/workspaces/nada"],
      ["DELETE", "/api/workspaces/nada"],
    ] as const) {
      const response = await app.inject({ method, url, payload: method === "PATCH" ? { name: "X" } : undefined });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(response.json()).toEqual(expected);
    }
  });

  it("valida o nome e os campos do Maestro", async () => {
    const { app } = await setupApp();
    await call(app, "POST", "/api/workspaces", { name: "  " }, 400);
    await call(app, "POST", "/api/workspaces", { name: "X", extra: 1 }, 400);
    await call(app, "POST", "/api/workspaces", { name: "X", maestro: { name: "" } }, 400);
    await call(app, "POST", "/api/workspaces", { name: "X", maestro: { name: "Y".repeat(25) } }, 400);
    await call(app, "POST", "/api/workspaces", { name: "X", maestro: { avatar: { skin: "verde" } } }, 400);
    await call(app, "POST", "/api/workspaces", { name: "X", maestro: { choice: { engine: "outro" } } }, 400);
    await call(app, "POST", "/api/workspaces", { name: "X", maestro: { id: "chefe" } }, 400);
    // Nome de página da UI não vira id de workspace (o endereço #/configuracoes é das configurações gerais).
    expect((await createWorkspace(app, "Configurações")).id).toBe("configuracoes-2");
  });

  it("cria o Maestro com o nome, a aparência, o motor e as instruções escolhidos", async () => {
    const { app } = await setupApp();
    const avatar = { skin: "tone5", hair: "curly", hairColor: "lavender", shirt: "mint", pants: "charcoal", accessory: "glasses" } as const;
    const created = await call<Workspace>(app, "POST", "/api/workspaces", {
      name: "Loja",
      maestro: { name: "  Gon  ", avatar, choice: { engine: "claude", model: "opus", effort: "high" }, instructions: "Fale curto e direto." },
    });
    const [maestro] = (await getOffice(app, created.id)).agents;
    // O id é estável (não vem do nome): só o nome de exibição muda.
    expect(maestro).toMatchObject({ id: "maestro", name: "Gon", role: "maestro", avatar, engine: "claude", model: "opus", effort: "high", instructions: "Fale curto e direto." });
    // O motor escolhido vira o padrão `maestro` do workspace; o resto vem dos globais.
    expect(created.models?.maestro).toEqual({ engine: "claude", model: "opus", effort: "high" });
    expect(created.models?.agentes).toEqual({ engine: "mock" });

    // Sem os campos: os padrões de sempre.
    const plain = await createWorkspace(app, "Simples");
    const [standard] = (await getOffice(app, plain.id)).agents;
    expect(standard).toMatchObject({ id: "maestro", name: "Maestro", avatar: MAESTRO_AVATAR, instructions: MAESTRO.instructions });
    expect(standard?.engine).toBeUndefined();
    // Instruções em branco = as padrão.
    const blank = await call<Workspace>(app, "POST", "/api/workspaces", { name: "Branco", maestro: { instructions: "   " } });
    expect((await getOffice(app, blank.id)).agents[0]?.instructions).toBe(MAESTRO.instructions);
    expect(blank.maestro).toBeUndefined();

    // Nome da sessão do Remote Control escolhido na criação (em branco = o padrão, nada guardado).
    const named = await call<Workspace>(app, "POST", "/api/workspaces", { name: "Rede", maestro: { sessionName: "  Maestro da Rede  " } });
    expect(named.maestro).toEqual({ sessionName: "Maestro da Rede" });
    const unnamed = await call<Workspace>(app, "POST", "/api/workspaces", { name: "Sem nome", maestro: { sessionName: "  " } });
    expect(unnamed.maestro).toBeUndefined();
  });

  it("exclui o último workspace e o server segue (e sobe de novo) sem nenhum", async () => {
    const { app, dataDir, workspaces } = await setupApp();
    // Os terminais/CLIs do workspace param junto.
    const closeTerminals = vi.spyOn(workspaces.get("principal").terminals, "closeAll");
    await call(app, "DELETE", "/api/workspaces/principal");
    expect(closeTerminals).toHaveBeenCalledOnce();
    expect(await call<Workspace[]>(app, "GET", "/api/workspaces")).toEqual([]);
    expect(JSON.parse(await readFile(path.join(dataDir, "workspaces.json"), "utf8"))).toEqual([]);
    expect(await readdir(path.join(dataDir, "workspaces"))).toEqual([]);
    await call(app, "GET", "/api/w/principal/office", undefined, 404);
    // Configurações gerais continuam respondendo sem workspace.
    await call(app, "GET", "/api/settings/models");
    await call(app, "GET", "/api/engines");
    await app.close();

    // Reinício com a lista vazia: nada é recriado sozinho (nem pelo seed, nem pela migração).
    expect(await migrateLegacyLayout(dataDir)).toEqual({ migrated: false });
    expect(await seedDataDir(dataDir)).toEqual({ created: false });
    const again = await buildApp({ auth: { open: true }, dataDir, runner: testRunner(), initialModelDefaults: TEST_MODEL_DEFAULTS, connectors: { autoTest: false }, retention: { autoRun: true } });
    try {
      await again.ready();
      expect(await call<Workspace[]>(again, "GET", "/api/workspaces")).toEqual([]);
      await call(again, "GET", "/api/settings/retention");

      // Criar do zero.
      const fresh = await createWorkspace(again, "Do Zero");
      expect(fresh.id).toBe("do-zero");
      expect((await getOffice(again, "do-zero")).agents.map((agent) => agent.name)).toEqual(["Maestro"]);
    } finally {
      await again.close();
    }
  });

  it("não exclui workspace com tarefa ativa", async () => {
    const { app } = await setupApp({ runner: { run: () => new Promise(() => undefined) } });
    await createWorkspace(app, "Instagram");
    const { room, team } = await soloTeam(app, "Feed", "instagram");
    await call(app, "POST", "/api/w/instagram/tasks", { roomId: room.id, teamId: team.id, prompt: "Post" });
    const busy = await call<ApiErrorBody>(app, "DELETE", "/api/workspaces/instagram", undefined, 409);
    expect(busy.error).toMatch(/tarefas em andamento/);
  });

  it("isola os dados: quartos, times, agentes e tarefas não cruzam workspaces", async () => {
    const { app } = await setupApp();
    await createWorkspace(app, "Instagram");
    const { room, team, agent } = await soloTeam(app, "Feed", "instagram");
    await call(app, "POST", "/api/w/instagram/tasks", { roomId: room.id, teamId: team.id, prompt: "Post" });

    const principal = await getOffice(app);
    expect(principal.rooms.map((r) => r.id)).toEqual(["projetox", "projetoy", "sala-do-maestro"]);
    expect(principal.agents.some((a) => a.id === agent.id)).toBe(false);
    expect(principal.tasks).toEqual([]);

    // Referências a quartos/times de outro workspace não existem aqui.
    await call(app, "POST", "/api/w/principal/tasks", { roomId: room.id, teamId: team.id, prompt: "Vazar" }, 404);
    await call(app, "POST", "/api/w/instagram/teams", { roomId: "projetox", name: "Intruso", focus: "x" }, 404);
    await call(app, "PATCH", `/api/w/principal/agents/${agent.id}`, { name: "Outro" }, 404);
    expect((await getOffice(app, "instagram")).tasks).toHaveLength(1);
  });
});

describe("WebSocket /ws", () => {
  it("sem workspace nenhum: o socket fica aberto só com a lista e avisa quando um nasce", async () => {
    const { app } = await setupApp();
    await call(app, "DELETE", "/api/workspaces/principal");
    const empty = await connectWs(app);
    const list = await empty.nextMessage(0);
    expect(list).toEqual({ type: "workspaces:list", workspaces: [] });

    await createWorkspace(app, "Novo");
    const created = await empty.nextMessage(1);
    expect(created.type === "workspaces:list" && created.workspaces.map((ws) => ws.id)).toEqual(["novo"]);
    // Nunca fechou (nem mandou snapshot): a UI troca para o socket do workspace novo.
    expect(empty.received.some((event) => event.type === "office:snapshot")).toBe(false);

    // Endereço de um workspace que não existe mais: lista e 4404 (a UI cai no primeiro ou no vazio).
    const stale = await connectWs(app, "?workspace=principal");
    expect((await stale.nextMessage(0)).type).toBe("workspaces:list");
    expect(await stale.closed()).toBe(4404);
    empty.socket.terminate();
  });

  it("manda a lista e o snapshot do workspace ao conectar e repassa só os eventos dele", async () => {
    const { app, hub } = await setupApp();
    await createWorkspace(app, "Instagram");
    const principal = await connectWs(app, "?workspace=principal");
    const instagram = await connectWs(app, "?workspace=instagram");

    const list = await principal.nextMessage(0);
    expect(list.type === "workspaces:list" && list.workspaces.map((ws) => ws.id)).toEqual(["principal", "instagram"]);
    const first = await principal.nextMessage(1);
    expect(first.type === "office:snapshot" && first.office.agents).toHaveLength(11);
    const other = await instagram.nextMessage(1);
    expect(other.type === "office:snapshot" && other.office.rooms.map((room) => room.kind)).toEqual(["maestro"]);

    hub.publish({ type: "team:deleted", id: "projetoy-pesquisa" });
    // Os eventos do workspace saem numerados (o seq do hub dele: a reconexão pede o que faltou).
    expect(await principal.nextMessage(2)).toEqual({ type: "team:deleted", id: "projetoy-pesquisa", seq: hub.seq });
    expect(hub.listenerCount).toBe(6); // EventLog do teste + Maestro + agentes de CLI + cadeia de atenção + vigia do orçamento + 1 cliente do principal

    // Workspace novo: todos os sockets recebem a lista atualizada.
    await createWorkspace(app, "LinkedIn");
    const updated = await instagram.nextMessage(2);
    expect(updated.type === "workspaces:list" && updated.workspaces.map((ws) => ws.id)).toEqual([
      "principal",
      "instagram",
      "linkedin",
    ]);
    expect(instagram.received.some((event) => event.type === "team:deleted")).toBe(false);

    principal.socket.terminate();
    instagram.socket.terminate();
  });

  it("uso da assinatura: vai no snapshot e usage:updated chega aos sockets de todos os workspaces", async () => {
    const { app, workspaces } = await setupApp();
    await createWorkspace(app, "Instagram");
    const principal = await connectWs(app, "?workspace=principal");
    const instagram = await connectWs(app, "?workspace=instagram");
    const empty = await principal.nextMessage(1);
    expect(empty.type === "office:snapshot" && empty.usage).toEqual([]);
    await instagram.nextMessage(1);

    workspaces.usage.report("claude", { status: "allowed", windows: [{ id: "five_hour", utilization: 0.27 }] });
    const pushed = await principal.nextMessage(2);
    expect(pushed).toMatchObject({ type: "usage:updated", usage: { provider: "claude", status: "allowed", windows: [{ id: "five_hour", utilization: 0.27 }] } });
    expect(await instagram.nextMessage(2)).toEqual(pushed);

    const late = await connectWs(app, "?workspace=instagram");
    const snapshot = await late.nextMessage(1);
    expect(snapshot.type === "office:snapshot" && snapshot.usage?.map((usage) => usage.provider)).toEqual(["claude"]);
    for (const socket of [principal, instagram, late]) socket.socket.terminate();
  });

  it("sem ?workspace= usa o primeiro; workspace inexistente ou excluído fecha com 4404", async () => {
    const { app } = await setupApp();
    const fallback = await connectWs(app);
    const snapshot = await fallback.nextMessage(1);
    expect(snapshot.type === "office:snapshot" && snapshot.office.rooms).toHaveLength(3);

    const missing = await connectWs(app, "?workspace=nada");
    expect((await missing.nextMessage(0)).type).toBe("workspaces:list");
    expect(await missing.closed()).toBe(4404);

    await createWorkspace(app, "Temporario");
    const doomed = await connectWs(app, "?workspace=temporario");
    await doomed.nextMessage(1);
    await call(app, "DELETE", "/api/workspaces/temporario");
    expect(await doomed.closed()).toBe(4404);
    fallback.socket.terminate();
  });
});
