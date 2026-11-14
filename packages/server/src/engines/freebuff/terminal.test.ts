import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { sanitizeChildEnv } from "../terminals/env";
import type { TerminalEvent, TerminalSpec } from "../terminals/types";
import { freebuffEnv } from "./adapter";
import { freebuffFolderName } from "./files";
import { FreebuffService } from "./service";
import { FreebuffTerminal, type FreebuffTerminalOptions } from "./terminal";

export const FAKE_FREEBUFF = fileURLToPath(new URL("./fake-freebuff.mjs", import.meta.url));

const tempDir = useTempDirs();
const terminals: FreebuffTerminal[] = [];
const services: FreebuffService[] = [];
afterEach(async () => {
  await Promise.all(terminals.splice(0).map((terminal) => terminal.dispose()));
  for (const service of services.splice(0)) service.close();
});

export type Setup = {
  terminal: FreebuffTerminal;
  service: FreebuffService;
  events: TerminalEvent[];
  root: string;
  home: string;
  cwd: string;
  stateFile: string;
  spawnLog: string;
};

const ANA = { workspaceId: "ws1", agentId: "ana" };

type SetupOptions = Partial<Omit<FreebuffTerminalOptions, "env">> & { root?: string; agentId?: string; workspaceId?: string; env?: Record<string, string>; service?: FreebuffService; now?: () => Date };

export async function setup(options: SetupOptions = {}): Promise<Setup> {
  const root = options.root ?? (await tempDir());
  const agentId = options.agentId ?? "ana";
  const workspaceId = options.workspaceId ?? "ws1";
  const home = path.join(root, "manicode");
  const folderName = freebuffFolderName(workspaceId, agentId);
  const stateDir = path.join(root, "workspaces", workspaceId, "agents", agentId);
  const cwd = path.join(stateDir, folderName);
  const stateFile = path.join(root, "engine-sessions.json");
  const spawnLog = path.join(root, "spawns.jsonl");
  await mkdir(cwd, { recursive: true });
  const service = options.service ?? (await FreebuffService.open(stateFile, { now: options.now ?? (() => new Date()), ...(options.env?.FAKE_FB_HOUR_MS ? { hourMs: Number(options.env.FAKE_FB_HOUR_MS) } : {}) }));
  if (!options.service) services.push(service);
  const spec: TerminalSpec = { agentId, cwd, systemPrompt: "Você é a Ana.", mcpConfigFile: path.join(cwd, ".agents", "mcp.json"), tools: [] };
  const fakeEnv = { FAKE_FB_HOME: home, FAKE_FB_LOG: spawnLog, FAKE_FB_STATE: path.join(root, "fake-state"), ...options.env };
  const { env: _env, root: _root, agentId: _agentId, workspaceId: _workspaceId, service: _service, ...rest } = options;
  const terminal = new FreebuffTerminal({
    spec,
    stateDir,
    service,
    workspaceId,
    agentName: () => "Ana",
    folderName,
    command: { command: process.execPath, prefixArgs: [FAKE_FREEBUFF] },
    env: (base, s) => ({ ...freebuffEnv(sanitizeChildEnv(base), s), ...fakeEnv }),
    manicodeDir: home,
    idleMs: 0,
    maxRetries: 2,
    backoffMs: () => 20,
    stopGraceMs: 1000,
    pollMs: 20,
    readyTimeoutMs: 4000,
    deliveryTimeoutMs: 700,
    submitDelayMs: 40,
    hangMs: 1200,
    settleMs: 30,
    ...rest,
  });
  terminals.push(terminal);
  const events: TerminalEvent[] = [];
  terminal.onEvent((event) => events.push(event));
  return { terminal, service, events, root, home, cwd, stateFile, spawnLog };
}

export async function until<T>(check: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 8000, label = "condição"): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Tempo esgotado esperando ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const turnEnds = (events: TerminalEvent[]) => events.filter((event): event is Extract<TerminalEvent, { type: "turn_end" }> => event.type === "turn_end");
const spawns = async (file: string): Promise<{ argv: string[]; cwd: string; pid: number }[]> =>
  existsSync(file) ? (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { argv: string[]; cwd: string; pid: number }) : [];

describe("FreebuffTerminal: turno de ponta a ponta", () => {
  it("sobe, escolhe o modelo da plataforma, manda o pedido como texto e fecha o turno pelo registro do chat", async () => {
    const { terminal, events, service, spawnLog } = await setup();
    terminal.send("Crie o arquivo ola.txt [ferramenta]", "t1");
    const end = await until(() => turnEnds(events)[0]);
    expect(end).toMatchObject({ tag: "t1", ok: true, result: expect.stringContaining("Feito: Crie o arquivo ola.txt") });
    // Subiu com --trust-agents e sem --continue (nada aberto antes).
    const [spawn] = await spawns(spawnLog);
    expect(spawn!.argv).toContain("--trust-agents");
    expect(spawn!.argv).not.toContain("--continue");
    // A ferramenta virou evento do registro de trabalho, com o nome do vocabulário do Claude Code.
    const tool = events.find((event) => event.type === "tool_use");
    expect(tool).toMatchObject({ name: "write_file", input: { path: "ola.txt" } });
    expect(events.find((event) => event.type === "tool_result")).toMatchObject({ ok: true });
    expect(events.map((event) => event.type).filter((type) => type === "turn_start")).toHaveLength(1);
    // A hora abriu na primeira mensagem, com o multiplicador do modelo (DeepSeek V4.1 Flash = 2x).
    const session = service.sessionOf(ANA);
    expect(session).toMatchObject({ agentId: "ana", multiplier: 2, model: "DeepSeek V4.1 Flash", endsAtSource: "measured" });
    expect(terminal.status()).toBe("idle");
  });

  it("a hora só abre na primeira mensagem (subir e ficar ocioso não gasta nada)", async () => {
    const { terminal, service } = await setup();
    await terminal.ensureRunning();
    await until(() => terminal.status() === "idle");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(service.sessionOf(ANA)).toBeUndefined();
    expect(service.hours().remaining).toBe(21); // lido do banner da tela
  });

  it("entrega pelo MCP: o agente chama submit_result e o servidor recebe o token (cabeçalho)", async () => {
    const received: { auth?: string; url?: string; body?: unknown }[] = [];
    const http = await import("node:http");
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        received.push({ auth: request.headers.authorization, url: request.url, body: JSON.parse(body) });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Submitted." }] } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const { terminal, events, cwd } = await setup();
      await mkdir(path.join(cwd, ".agents"), { recursive: true });
      await writeFile(path.join(cwd, ".agents", "mcp.json"), JSON.stringify({ mcpServers: { office: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer tok-ana" } } } }));
      terminal.send("Faça isto [submit]", "t1");
      await until(() => turnEnds(events)[0]);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ auth: "Bearer tok-ana", body: { method: "tools/call", params: { name: "submit_result" } } });
      const tool = events.find((event) => event.type === "tool_use" && event.name === "mcp__office__submit_result");
      expect(tool).toBeTruthy();
    } finally {
      server.close();
    }
  });

  it("as tarefas seguintes dentro da hora usam o mesmo processo e a mesma hora (sem abrir outra)", async () => {
    const { terminal, events, service, spawnLog } = await setup();
    terminal.send("primeiro", "t1");
    await until(() => turnEnds(events).length === 1);
    await until(() => service.sessionOf(ANA)?.endsAtSource === "measured", 4000, "o fim real da hora");
    const first = service.sessionOf(ANA)!;
    terminal.send("segundo", "t2", { freshSession: true });
    await until(() => turnEnds(events).length === 2);
    expect(turnEnds(events).map((event) => event.tag)).toEqual(["t1", "t2"]);
    expect(await spawns(spawnLog)).toHaveLength(1);
    expect(service.sessionOf(ANA)!.endsAt).toBe(first.endsAt);
    expect(service.hours().openedSince).toBe(2); // uma hora de 2x, não duas
  });

  it("o texto de várias linhas chega inteiro (colagem) e o Enter vai depois", async () => {
    const { terminal, events, home, cwd } = await setup();
    terminal.send("linha um\nlinha dois\n\nlinha quatro", "t1");
    await until(() => turnEnds(events)[0]);
    const chats = path.join(home, "projects", path.basename(cwd), "chats");
    const [chat] = await readdir(chats);
    const messages = JSON.parse(await readFile(path.join(chats, chat!, "chat-messages.json"), "utf8")) as { variant: string; content: string }[];
    expect(messages.find((message) => message.variant === "user")!.content).toBe("linha um\nlinha dois\n\nlinha quatro");
  });

  it("a escolha do modelo é feita pelas teclas da TUI antes da primeira mensagem (modelo e esforço)", async () => {
    const root = await tempDir();
    const { terminal, events, service, home } = await setup({ root });
    await service.setSettings({ model: "Muse Spark 1.3", effort: "low" });
    terminal.send("oi", "t1");
    await until(() => turnEnds(events)[0]);
    const saved = JSON.parse(await readFile(path.join(home, "fake-settings.json"), "utf8")) as { model: string; effort: string };
    expect(saved).toEqual({ model: "Muse Spark 1.3", effort: "low" });
    expect(service.sessionOf(ANA)).toMatchObject({ model: "Muse Spark 1.3", multiplier: 3 });
  });

  it("modelo que não existe na lista: segue com o da tela e avisa", async () => {
    const { terminal, events, service } = await setup();
    await service.setSettings({ model: "Modelo Que Nao Existe", effort: "high" });
    terminal.send("oi", "t1");
    await until(() => turnEnds(events)[0]);
    expect(events.some((event) => event.type === "raw" && /não está na lista/.test(event.text))).toBe(true);
  });
});

describe("FreebuffTerminal: a hora aberta", () => {
  it("com a hora aberta o terminal não fecha por ociosidade; sem hora fecha", async () => {
    const { terminal, events } = await setup({ idleMs: 150 });
    // Sem mensagem: sem hora, o processo para por ociosidade.
    await terminal.ensureRunning();
    await until(() => terminal.status() === "stopped" && events.some((event) => event.type === "status" && event.status === "stopped" && event.reason === "Parado por ociosidade"), 4000, "parada por ociosidade sem hora");
    // Com a primeira mensagem a hora abre: passa muito mais que o tempo ocioso e o processo continua.
    terminal.send("oi", "t1");
    await until(() => turnEnds(events).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(terminal.status()).toBe("idle");
  });

  it("no fim da hora o Cyno fecha o processo; a próxima mensagem abre uma hora nova", async () => {
    const { terminal, events, service, spawnLog } = await setup({ env: { FAKE_FB_HOUR_MS: "900" } });
    terminal.send("um", "t1");
    await until(() => turnEnds(events).length === 1);
    const firstEnd = service.sessionOf(ANA)!.endsAt;
    await until(() => terminal.status() === "stopped", 4000, "fechar no fim da hora");
    expect(service.sessionOf(ANA)).toBeUndefined();
    expect(events.some((event) => event.type === "status" && event.status === "stopped" && event.reason === "A hora do Freebuff acabou")).toBe(true);
    terminal.send("dois", "t2");
    await until(() => turnEnds(events).length === 2);
    expect(await spawns(spawnLog)).toHaveLength(2);
    expect(service.sessionOf(ANA)!.endsAt).not.toBe(firstEnd);
    expect(service.hours().openedSince).toBe(2); // medido de novo no banner: a hora nova custou 2 depois da leitura
  });

  it("um turno em andamento no fim da hora termina antes de fechar", async () => {
    const { terminal, events } = await setup({ env: { FAKE_FB_HOUR_MS: "700" }, hangMs: 20_000 });
    terminal.send("longo [muito-lento]", "t1");
    // O turno dura 4 s; a hora acaba em 0,7 s.
    await until(() => events.some((event) => event.type === "raw" && /A hora do Freebuff acabou/.test(event.text)), 4000, "aviso do fim da hora");
    expect(terminal.status()).toBe("busy");
    const end = await until(() => turnEnds(events)[0], 8000, "fim do turno");
    expect(end).toMatchObject({ tag: "t1", ok: true });
    await until(() => terminal.status() === "stopped", 4000, "fechar depois do turno");
  }, 20_000);

  it("o arquivo da sessão muda depois de medido (o Freebuff abre outra hora na primeira mensagem): o fim acompanha", async () => {
    const { terminal, events, service } = await setup({ env: { FAKE_FB_REWRITE: "1" }, liveRefreshMs: 40 });
    terminal.send("oi", "t1");
    await until(() => turnEnds(events)[0]);
    const measured = await until(() => service.sessionOf(ANA)?.endsAtSource === "measured" && service.sessionOf(ANA)!.endsAt, 4000, "o primeiro fim medido");
    const later = await until(() => service.sessionOf(ANA) && service.sessionOf(ANA)!.endsAt !== measured && service.sessionOf(ANA)!.endsAt, 4000, "o fim regravado");
    expect(Date.parse(later as string) - Date.parse(measured as string)).toBe(60_000);
  });

  it("o fim real da hora vem do arquivo da sessão do Freebuff", async () => {
    const { terminal, events, service } = await setup();
    terminal.send("oi", "t1");
    await until(() => turnEnds(events)[0]);
    await until(() => service.sessionOf(ANA)?.endsAtSource === "measured", 4000, "o fim real da hora");
    const session = service.sessionOf(ANA)!;
    // O fake escreve freebuff-live-<pid>.json com ownerPid = o processo do pty e expiresAt = abertura + 1 h.
    expect(Date.parse(session.endsAt) - Date.parse(session.openedAt)).toBeGreaterThan(59 * 60_000);
  });
});

describe("FreebuffTerminal: problemas", () => {
  it("o processo cai no meio do turno: fecha e abre de novo com --continue, na mesma hora, e entrega", async () => {
    const { terminal, events, service, spawnLog } = await setup();
    terminal.send("faça [queda]", "t1");
    const end = await until(() => turnEnds(events)[0], 10_000, "turno depois da queda");
    expect(end).toMatchObject({ tag: "t1", ok: true });
    const all = await spawns(spawnLog);
    expect(all).toHaveLength(2);
    const [, second] = all;
    expect(second!.argv).toContain("--continue");
    const chatId = second!.argv[second!.argv.indexOf("--continue") + 1]!;
    expect(chatId).toBe(service.sessionOf(ANA)!.chatId);
    // A mesma hora: o saldo caiu uma vez só (21 - 2x = 19), não duas.
    expect(service.hours().remaining).toBe(19);
    expect(events.filter((event) => event.type === "turn_start")).toHaveLength(2);
  });

  it("um turno que trava (sem sinal no registro) é reiniciado com --continue e refeito", async () => {
    const { terminal, events, spawnLog } = await setup({ hangMs: 500 });
    terminal.send("espere [trava]", "t1");
    const end = await until(() => turnEnds(events)[0], 12_000, "turno depois do travamento");
    expect(end).toMatchObject({ tag: "t1", ok: true });
    const all = await spawns(spawnLog);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[1]!.argv).toContain("--continue");
  });

  it("a mensagem que o Freebuff não leu: Enter de novo e, se continuar, reinicia", async () => {
    const { terminal, events } = await setup({ deliveryTimeoutMs: 300 });
    terminal.send("ninguém lê [sem-leitura]", "t1");
    const end = await until(() => turnEnds(events)[0], 12_000);
    expect(end).toMatchObject({ tag: "t1", ok: true });
    expect(events.some((event) => event.type === "raw" && /apertando Enter de novo|fechando e abrindo/.test(event.text))).toBe(true);
  });

  it("desiste depois de quedas seguidas demais: erro como nos outros motores, e a fila é largada com o motivo", async () => {
    const { terminal, events } = await setup({ env: { FAKE_FB_NO_READY: "1" }, readyTimeoutMs: 150, maxRetries: 1 });
    terminal.send("oi", "t1");
    const dropped = await until(() => events.find((event) => event.type === "dropped"), 10_000, "desistir");
    expect(dropped).toMatchObject({ type: "dropped", tag: "t1", reason: expect.stringContaining("caiu") });
    expect(terminal.status()).toBe("error");
  });

  it("Desligar à mão larga a fila mas a hora continua aberta (dá para reabrir nela)", async () => {
    const { terminal, events, service, spawnLog } = await setup();
    terminal.send("um", "t1");
    await until(() => turnEnds(events).length === 1);
    await terminal.stop("Parado por você");
    expect(terminal.status()).toBe("stopped");
    expect(service.sessionOf(ANA)).toBeDefined();
    terminal.send("dois", "t2");
    await until(() => turnEnds(events).length === 2);
    const all = await spawns(spawnLog);
    expect(all[1]!.argv).toContain("--continue");
    expect(service.hours().remaining).toBe(19);
  });
});

describe("pasta de trabalho", () => {
  it("o nome da pasta não colide entre workspaces nem entre ids que só diferem no fim", () => {
    const a = freebuffFolderName("ws-a", "agente-1");
    const b = freebuffFolderName("ws-b", "agente-1");
    const c = freebuffFolderName("ws-a", "agente-1-com-sufixo-muito-comprido-que-passa-do-corte-x");
    const d = freebuffFolderName("ws-a", "agente-1-com-sufixo-muito-comprido-que-passa-do-corte-y");
    expect(new Set([a, b, c, d]).size).toBe(4);
    for (const name of [a, b, c, d]) expect(name).toMatch(/^fb-[a-z0-9-]+$/);
  });

  it("dois agentes com o mesmo id em dois workspaces: chats separados e o teto de uma hora aberta vale entre eles", async () => {
    const root = await tempDir();
    const one = await setup({ root, workspaceId: "ws-um", agentId: "ana" });
    const two = await setup({ root, workspaceId: "ws-dois", agentId: "ana", service: one.service });
    one.terminal.send("a", "t1");
    await until(() => turnEnds(one.events).length === 1);
    // O teto é de 1 hora aberta: o outro "ana" (de outro workspace) espera, com o motivo visível.
    two.terminal.send("b", "t1");
    await until(() => two.events.some((event) => event.type === "raw" && /esperando a hora do Freebuff de Ana acabar/.test(event.text)), 6000, "o motivo da espera");
    expect(turnEnds(two.events)).toHaveLength(0);
    expect(two.service.blockFor({ workspaceId: "ws-dois", agentId: "ana" })).toMatchObject({ reason: "hour", holder: "Ana" });
    // A hora do primeiro acaba (aqui, dada como fechada): o segundo anda sozinho.
    await one.service.closeHour({ workspaceId: "ws-um", agentId: "ana" }, "teste");
    await until(() => turnEnds(two.events).length === 1, 8000, "o segundo agente andar");
    const folders = await readdir(path.join(one.home, "projects"));
    expect(folders).toContain(freebuffFolderName("ws-um", "ana"));
    expect(folders).toContain(freebuffFolderName("ws-dois", "ana"));
    await rm(path.join(root, "none"), { force: true });
  }, 20_000);
});
