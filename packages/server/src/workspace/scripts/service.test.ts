import { mkdir, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { SCRIPT_LIMITS, type ScriptRun, type ServerEvent } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import type { ScriptAgentContext } from "../../engines/terminals/manager";
import { ScriptsService, spawnWithPipes, type ScriptsServiceOptions } from "./service";

const silent = { info: () => undefined, warn: () => undefined } as never;
const tempDir = useTempDirs();
const services: ScriptsService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stopAll()));
});

type Setup = Partial<Pick<ScriptsServiceOptions, "spawn" | "limits" | "graceMs" | "publishMs" | "sweepMs" | "platform">> & { terminal?: boolean; sharedDir?: string };

async function setup(options: Setup = {}) {
  const root = await tempDir();
  const agentDir = path.join(root, "agents", "clara");
  const work = path.join(root, "work");
  await mkdir(agentDir, { recursive: true });
  await mkdir(work, { recursive: true });
  const events: ServerEvent[] = [];
  const contexts: Record<string, ScriptAgentContext> = {
    clara: { agentId: "clara", agentName: "Clara", cwd: agentDir, folders: [{ path: work, write: true }], terminal: options.terminal ?? true },
    bruno: { agentId: "bruno", agentName: "Bruno", cwd: path.join(root, "agents", "bruno"), folders: [], terminal: true },
  };
  const dir = options.sharedDir ?? path.join(root, "scripts");
  const create = () => {
    const service = new ScriptsService({
      dir,
      publish: (event) => events.push(event),
      agent: async (id) => contexts[id],
      graceMs: options.graceMs ?? 200,
      drainMs: 30,
      flushMs: 30,
      publishMs: options.publishMs ?? 40,
      ...(options.spawn ? { spawn: options.spawn } : {}),
      ...(options.limits ? { limits: options.limits } : {}),
      ...(options.sweepMs ? { sweepMs: options.sweepMs } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
      log: silent,
      now: () => new Date(),
    });
    services.push(service);
    return service;
  };
  return { service: create(), create, events, root, agentDir, work, dir };
}

const finished = async (service: ScriptsService, id: string): Promise<ScriptRun> => {
  for (let i = 0; i < 100; i += 1) {
    const run = await service.wait(id, 1);
    if (run.status !== "running") return run;
  }
  throw new Error(`o script ${id} não terminou`);
};

const updates = (events: ServerEvent[], id: string) => events.flatMap((event) => (event.type === "script:updated" && event.run.id === id ? [event.run] : []));

describe("ScriptsService", () => {
  it("echo: termina `done`, grava a saída, publica o início e o fim e lembra o título e a pasta", async () => {
    const { service, events, agentDir, dir } = await setup();
    const started = await service.start({ agentId: "clara", taskId: "T1", title: "Dizer oi", command: "echo oi; echo tchau" });
    expect(started).toMatchObject({ id: "s1", status: "running", agentName: "Clara", taskId: "T1", cwd: agentDir, fenced: false });
    expect(events[0]).toMatchObject({ type: "script:updated", run: { id: "s1", status: "running" } });
    const run = await finished(service, "s1");
    expect(run).toMatchObject({ status: "done", exitCode: 0, truncated: false, lastLine: "tchau" });
    const output = await service.readOutput("s1", 0);
    expect(output.data.replace(/\r/g, "")).toBe("oi\ntchau\n");
    expect(output).toMatchObject({ done: true, from: 0, next: output.size });
    expect(await readFile(path.join(dir, "s1", "output.log"), "utf8")).toContain("oi");
    expect(JSON.parse(await readFile(path.join(dir, "s1", "meta.json"), "utf8"))).toMatchObject({ id: "s1", status: "done" });
    expect(updates(events, "s1").at(-1)?.status).toBe("done");
    expect((await service.plainOutput("s1")).trim()).toBe("oi\ntchau");
  });

  it("funciona também sem PTY (pipes), juntando stdout e stderr", async () => {
    const { service } = await setup({ spawn: spawnWithPipes });
    await service.start({ agentId: "clara", title: "Pipes", command: "echo um; echo dois >&2" });
    const run = await finished(service, "s1");
    expect(run.status).toBe("done");
    expect((await service.readOutput("s1")).data).toBe("um\ndois\n");
  });

  it("laço com sleep: a saída aparece enquanto roda, `wait` só volta no prazo ou no fim (saída nova não acorda) e `lastLine` acompanha", async () => {
    const { service, events } = await setup();
    await service.start({ agentId: "clara", title: "Laço", command: "for i in 1 2 3 4; do echo passo $i; sleep 0.25; done" });
    const before = Date.now();
    const midway = await service.wait("s1", 0.5);
    expect(Date.now() - before).toBeGreaterThanOrEqual(450);
    expect(midway.status).toBe("running");
    expect(midway.bytes).toBeGreaterThan(0);
    expect(midway.lastLine).toMatch(/^passo \d$/);
    const ended = Date.now();
    const run = await service.wait("s1", 30);
    expect(Date.now() - ended).toBeLessThan(5000);
    expect(run.status).toBe("done");
    expect(run).toMatchObject({ status: "done", lastLine: "passo 4" });
    expect(updates(events, "s1").some((update) => update.status === "running" && update.bytes > 0)).toBe(true);
  });

  it("comando que falha: `failed` com o código de saída", async () => {
    const { service } = await setup();
    await service.start({ agentId: "clara", title: "Falha", command: "echo ruim; exit 3" });
    expect(await finished(service, "s1")).toMatchObject({ status: "failed", exitCode: 3 });
  });

  it("stop mata o grupo inteiro (inclusive o filho) e marca `stopped` por quem pediu", async () => {
    const { service, root } = await setup();
    const marker = path.join(root, "vivo.txt");
    await service.start({ agentId: "clara", title: "Dorminhoco", command: `(sleep 1; echo vivo > ${marker}) & sleep 30` });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const run = await service.stop("s1", "user");
    expect(run).toMatchObject({ status: "stopped", stoppedBy: "user" });
    await new Promise((resolve) => setTimeout(resolve, 1300));
    await expect(readFile(marker, "utf8")).rejects.toThrow();
    // Parar de novo (já terminado) devolve como está.
    expect((await service.stop("s1", "agent")).stoppedBy).toBe("user");
  });

  it("quem ignora o SIGTERM leva SIGKILL depois da tolerância", async () => {
    const { service } = await setup({ graceMs: 150 });
    await service.start({ agentId: "clara", title: "Teimoso", command: "trap '' TERM; while true; do sleep 0.05; done" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await service.stop("s1", "agent")).toMatchObject({ status: "stopped", stoppedBy: "agent" });
  });

  it("prazo: passou do tempo vira `timeout`", async () => {
    const { service } = await setup();
    // O mínimo do pedido é 1 minuto: o teste adianta o prazo pelo serviço com relógio de verdade curto.
    const run = await service.start({ agentId: "clara", title: "Demora", command: "sleep 30", timeoutMinutes: 1 });
    expect(Date.parse(run.deadlineAt) - Date.parse(run.startedAt)).toBe(60_000);
    const fast = await setup();
    const real = fast.service as unknown as { terminate: (live: unknown, reason: { kind: string }) => void; live: Map<string, unknown> };
    await fast.service.start({ agentId: "clara", title: "Demora", command: "sleep 30" });
    real.terminate(real.live.get("s1"), { kind: "timeout" });
    expect(await finished(fast.service, "s1")).toMatchObject({ status: "timeout" });
    await service.stop("s1", "server");
  });

  it("saída acima do limite: grava até o teto, avisa uma vez, marca `truncated` e o script segue rodando até acabar", async () => {
    const { service } = await setup({ limits: { outputBytes: 200 } });
    await service.start({ agentId: "clara", title: "Muita saída", command: "for i in $(seq 1 100); do echo linha-numero-$i; done; sleep 0.3; echo FIM" });
    const run = await finished(service, "s1");
    expect(run).toMatchObject({ status: "done", exitCode: 0, truncated: true });
    const text = (await service.readOutput("s1")).data;
    expect(text).toContain("linha-numero-1");
    expect(text).not.toContain("FIM");
    expect(text.match(/\[Cyno\] A saída passou do limite/g)).toHaveLength(1);
    expect(run.bytes).toBeLessThan(200 + 300);
  });

  it("mascara segredos na saída e no comando guardado, sem deixar o segredo cortado entre pedaços", async () => {
    const { service, dir } = await setup();
    const secret = "sk-ant-api03-TESTE-0000000000000000000000000000";
    await service.start({ agentId: "clara", title: "Segredo", command: `printf 'chave: sk-ant-api03-'; sleep 0.01; printf 'TESTE-0000000000000000000000000000\\nfim\\n'; echo ${secret}` });
    const run = await finished(service, "s1");
    expect(run.command).not.toContain(secret);
    const log = await readFile(path.join(dir, "s1", "output.log"), "utf8");
    expect(log).not.toContain("TESTE-0000");
    expect(log).toContain("sk-***");
    expect(log).toContain("fim");
  });

  it("leitura em pedaços: `next` acaba num limite de caractere e os pedaços juntos dão o texto inteiro", async () => {
    const { service } = await setup();
    await service.start({ agentId: "clara", title: "Acentos", command: "for i in $(seq 1 12000); do echo 'ação ção ñ 日本語 😀'; done" });
    await finished(service, "s1");
    const total = await service.readOutput("s1", 0);
    expect(total.size).toBeGreaterThan(SCRIPT_LIMITS.readBytes);
    let from = 0;
    let joined = "";
    let rounds = 0;
    for (;;) {
      const part = await service.readOutput("s1", from);
      expect(part.data).not.toContain("�");
      joined += part.data;
      from = part.next;
      rounds += 1;
      if (part.done) break;
      expect(rounds).toBeLessThan(20);
    }
    expect(rounds).toBeGreaterThan(1);
    expect(Buffer.byteLength(joined)).toBe(total.size);
    // `from` no meio de um caractere: pula até o próximo inteiro.
    const mid = await service.readOutput("s1", "ação".indexOf("ç") + 1 + 1);
    expect(mid.data.startsWith("�")).toBe(false);
  });

  it("pasta fora do que o agente alcança é recusada; dentro da pasta de trabalho e subpasta da dele passa; link para fora não engana", async () => {
    const { service, root, agentDir, work } = await setup();
    await expect(service.start({ agentId: "clara", title: "x", command: "pwd", cwd: "/tmp" })).rejects.toThrow(/outside your folder/);
    await expect(service.start({ agentId: "clara", title: "x", command: "pwd", cwd: ".." })).rejects.toThrow(/outside your folder/);
    await mkdir(path.join(root, "segredos"), { recursive: true });
    await symlink(path.join(root, "segredos"), path.join(agentDir, "atalho"));
    await expect(service.start({ agentId: "clara", title: "x", command: "pwd", cwd: "atalho" })).rejects.toThrow(/outside your folder/);
    await expect(service.start({ agentId: "clara", title: "x", command: "pwd", cwd: "nao-existe" })).rejects.toThrow(/does not exist/);
    await mkdir(path.join(agentDir, "sub"));
    expect(await service.start({ agentId: "clara", title: "sub", command: "pwd", cwd: "sub" })).toMatchObject({ cwd: path.join(agentDir, "sub") });
    expect(await service.start({ agentId: "clara", title: "trabalho", command: "pwd", cwd: work })).toMatchObject({ cwd: work });
  });

  it("sem o terminal ligado: recusa, e agente desconhecido também", async () => {
    const { service } = await setup({ terminal: false });
    await expect(service.start({ agentId: "clara", title: "x", command: "echo oi" })).rejects.toThrow(/terminal access is off/);
    await expect(service.start({ agentId: "fantasma", title: "x", command: "echo oi" })).rejects.toThrow(/Agent not found/);
    expect(service.list()).toEqual([]);
  });

  it("limites: 2 por agente e comando/título grandes demais", async () => {
    const { service } = await setup();
    await service.start({ agentId: "clara", title: "um", command: "sleep 5" });
    await service.start({ agentId: "clara", title: "dois", command: "sleep 5" });
    await expect(service.start({ agentId: "clara", title: "três", command: "sleep 5" })).rejects.toThrow(/already have 2 scripts running/);
    // Outro agente não é barrado pelo limite do primeiro.
    await service.start({ agentId: "bruno", title: "outro", command: "sleep 5" });
    await expect(service.start({ agentId: "bruno", title: "x", command: "x".repeat(SCRIPT_LIMITS.command + 1) })).rejects.toThrow(/too long/);
    await expect(service.start({ agentId: "bruno", title: "x".repeat(SCRIPT_LIMITS.title + 1), command: "echo" })).rejects.toThrow(/title is too long/);
  });

  it("duas chamadas ao mesmo tempo do mesmo agente não furam o teto dele", async () => {
    const { service } = await setup();
    const results = await Promise.allSettled([1, 2, 3].map((n) => service.start({ agentId: "clara", title: `t${n}`, command: "sleep 5" })).flat());
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("stopForTask para só os scripts daquela tarefa (`stoppedBy: task`)", async () => {
    const { service } = await setup();
    await service.start({ agentId: "clara", taskId: "T1", title: "da tarefa", command: "sleep 30" });
    await service.start({ agentId: "clara", taskId: "T2", title: "de outra", command: "sleep 30" });
    await service.stopForTask("T1");
    expect(service.get("s1")).toMatchObject({ status: "stopped", stoppedBy: "task" });
    expect(service.get("s2").status).toBe("running");
    await service.stopAll();
    expect(service.get("s2")).toMatchObject({ status: "stopped", stoppedBy: "server" });
  });

  it("ao reabrir: o que estava `running` vira `lost`, o grupo vivo é morto, o contador não repete ids e o histórico volta", async () => {
    const first = await setup();
    await first.service.start({ agentId: "clara", title: "feito", command: "echo ok" });
    await finished(first.service, "s1");
    const live = await first.service.start({ agentId: "clara", title: "em andamento", command: "sleep 30" });
    expect(live.id).toBe("s2");
    // Simula a queda do servidor: o processo continua vivo e o meta diz `running`.
    const pid = Number(await readFile(path.join(first.dir, "s2", "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).not.toThrow();
    const reopened = first.create();
    expect(reopened.get("s1").status).toBe("done");
    expect(reopened.get("s2")).toMatchObject({ status: "lost" });
    expect(reopened.get("s2").endedAt).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(pid, 0)).toThrow();
    const next = await reopened.start({ agentId: "clara", title: "novo", command: "echo de novo" });
    expect(next.id).toBe("s3");
    expect(reopened.list().map((run) => run.id)).toEqual(["s3", "s2", "s1"].sort((a, b) => (a === "s3" ? -1 : b === "s3" ? 1 : 0)));
  });

  it("um terminado fica o tempo de validade na lista e depois some, com a pasta, e publica script:removed", async () => {
    const { service, events, dir } = await setup({ limits: { finishedTtlMs: 400 }, sweepMs: 50 });
    await service.start({ agentId: "clara", title: "curto", command: "echo oi" });
    await finished(service, "s1");
    expect(service.list().map((run) => run.id)).toEqual(["s1"]);
    expect(events.some((event) => event.type === "script:removed")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(service.list()).toEqual([]);
    expect(events.some((event) => event.type === "script:removed" && event.id === "s1")).toBe(true);
    await expect(readFile(path.join(dir, "s1", "meta.json"), "utf8")).rejects.toThrow();
  });

  it("a validade não tira um script que ainda roda, e ao reabrir o serviço os terminados vencidos já saem", async () => {
    const first = await setup({ limits: { finishedTtlMs: 300 }, sweepMs: 50 });
    await first.service.start({ agentId: "clara", title: "curto", command: "echo oi" });
    await finished(first.service, "s1");
    await first.service.start({ agentId: "clara", title: "longo", command: "sleep 5" });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(first.service.list().map((run) => [run.id, run.status])).toEqual([["s2", "running"]]);
    await first.service.stopAll();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const reopened = first.create();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reopened.list()).toEqual([]);
    await expect(readFile(path.join(first.dir, "s2", "meta.json"), "utf8")).rejects.toThrow();
  });

  it("mantém só os `keepFinished` mais novos: os velhos saem com a pasta e publicam script:removed", async () => {
    const { service, events, dir } = await setup({ limits: { keepFinished: 2 } });
    for (const n of [1, 2, 3]) {
      await service.start({ agentId: "clara", title: `t${n}`, command: `echo ${n}` });
      await finished(service, `s${n}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.list().map((run) => run.id)).toEqual(["s3", "s2"]);
    expect(events.some((event) => event.type === "script:removed" && event.id === "s1")).toBe(true);
    await expect(readFile(path.join(dir, "s1", "meta.json"), "utf8")).rejects.toThrow();
    expect(() => service.get("s1")).toThrow(/não encontrado/);
  });

  it("list: rodando primeiro, depois os terminados do mais novo para o mais velho", async () => {
    const { service } = await setup();
    await service.start({ agentId: "clara", title: "velho", command: "echo 1" });
    await finished(service, "s1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await service.start({ agentId: "clara", title: "novo", command: "echo 2" });
    await finished(service, "s2");
    await service.start({ agentId: "clara", title: "rodando", command: "sleep 5" });
    expect(service.list().map((run) => run.id)).toEqual(["s3", "s2", "s1"]);
    expect(service.state().runs).toHaveLength(3);
  });

  it("wait devolve na hora quando já terminou e respeita o tempo limite quando nada acontece", async () => {
    const { service } = await setup();
    await service.start({ agentId: "clara", title: "quieto", command: "sleep 5" });
    const t0 = Date.now();
    const run = await service.wait("s1", 0.2);
    expect(run.status).toBe("running");
    expect(Date.now() - t0).toBeLessThan(1500);
    await service.stop("s1", "user");
    const t1 = Date.now();
    expect((await service.wait("s1", 30)).status).toBe("stopped");
    expect(Date.now() - t1).toBeLessThan(500);
  });

  it("`HOME` e o ambiente do agente não carregam chaves do servidor; PYTHONUNBUFFERED fica ligado", async () => {
    const { service } = await setup();
    process.env.ANTHROPIC_API_KEY = "chave-que-nao-pode-vazar";
    try {
      await service.start({ agentId: "clara", title: "env", command: 'echo "k=[$ANTHROPIC_API_KEY] u=[$PYTHONUNBUFFERED]"' });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
    await finished(service, "s1");
    expect((await service.readOutput("s1")).data).toContain("k=[] u=[1]");
  });

  it("no Windows (win32), dispara o script com powershell.exe -NoLogo -NoProfile -Command", async () => {
    let seen: { file: string; args: string[] } | undefined;
    const { service } = await setup({
      platform: "win32",
      spawn: (file, args) => {
        seen = { file, args };
        return {
          pid: 99999,
          onData: () => undefined,
          onExit: (listener) => queueMicrotask(() => listener({ code: 0 })),
          killGroup: () => undefined,
        };
      },
    });
    await service.start({ agentId: "clara", title: "Win", command: "Write-Output oi" });
    await finished(service, "s1");
    expect(seen).toEqual({
      file: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-Command", "Write-Output oi"],
    });
  });
});
