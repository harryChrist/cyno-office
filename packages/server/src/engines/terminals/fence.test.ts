import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectFence, enclosingNodeModules, FENCE_LAUNCHER, fenceArgs, fencedCommand, fencePolicy, hermesInstallWritables, interpretCheck, probeLandlock, resolveExecutable, setFenceSupportForTests } from "./fence";
import { HermesAdapter, hermesAgentHomeOf, hermesAgentTmpOf, hermesFencedHomeOf, hermesUserHome } from "./hermes-adapter";
import { OneShotTerminal, type OneShotAdapter } from "./one-shot-terminal";
import { OpenClawAdapter, openclawAgentConfigPath, openclawAgentTmpOf, openclawPaths } from "./openclaw-adapter";
import type { TerminalSpec } from "./types";

const SUPPORT = { available: true, abi: 8, python: "/usr/bin/python3" };
const NO_SUPPORT = { available: false, abi: 0, reason: "sem Landlock" };

let root = "";
beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "cyno-fence-test-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const spec = (cwd: string): TerminalSpec => ({ agentId: "a1", cwd, systemPrompt: "x", mcpConfigFile: path.join(cwd, "mcp.json"), tools: [] });

describe("a leitura do `--check` do lançador", () => {
  it("há cerca quando o kernel responde com uma ABI e o Python é novo o bastante", () => {
    expect(interpretCheck('{"available": true, "abi": 8, "lsm": "landlock", "python": "3.14.4"}', 0, "/usr/bin/python3")).toMatchObject({ available: true, abi: 8, python: "/usr/bin/python3", pythonVersion: "3.14.4" });
  });

  it("sem Landlock (kernel antigo ou módulo desligado) a cerca não existe e o motivo vai para a tela", () => {
    const none = interpretCheck('{"available": false, "abi": 0, "lsm": "apparmor", "python": "3.12.1"}', 3, "/usr/bin/python3");
    expect(none).toMatchObject({ available: false, abi: 0 });
    expect(none.reason).toMatch(/Landlock/);
  });

  it("Python mais velho que o 3.8 e resposta que não é JSON também desligam a cerca", () => {
    expect(interpretCheck('{"available": true, "abi": 3, "python": "3.6.9"}', 0, "/usr/bin/python3")).toMatchObject({ available: false });
    expect(interpretCheck("Traceback...", 1, "/usr/bin/python3")).toMatchObject({ available: false });
  });
});

describe("montagem da lista e do comando final", () => {
  it("a lista une o sistema ao que o motor pede, sem repetir e com caminhos absolutos", () => {
    const policy = fencePolicy({ readOnly: ["/opt/hermes", "/opt/hermes", undefined], readWrite: ["/dados/w/agentes/a1", "/dados/w/agentes/a1"], listOnly: [] });
    expect(policy.readOnly.filter((item) => item === "/opt/hermes")).toHaveLength(1);
    expect(policy.readOnly).toEqual(expect.arrayContaining(["/usr", "/etc/ssl", "/proc/meminfo"]));
    expect(policy.readWrite).toEqual(expect.arrayContaining(["/dados/w/agentes/a1", "/dev/null"]));
    expect(policy.readWrite.filter((item) => item === "/dados/w/agentes/a1")).toHaveLength(1);
    expect(policy.listOnly).toEqual(["/proc"]);
    // O que NÃO entra: o /tmp inteiro, o HOME, o /proc inteiro, o /etc inteiro.
    for (const forbidden of ["/tmp", "/var/tmp", "/home", "/proc", "/etc", "/root"]) {
      expect(policy.readOnly, forbidden).not.toContain(forbidden);
      expect(policy.readWrite, forbidden).not.toContain(forbidden);
    }
  });

  it("o comando final é `python3 lançador <regras> -- programa args`", () => {
    const policy = fencePolicy({ readOnly: ["/opt/x"], readWrite: ["/dados/a1"] });
    const { command, args } = fencedCommand(policy, "/usr/bin/python3", "hermes", ["chat", "--oneshot"]);
    expect(command).toBe("/usr/bin/python3");
    expect(args[0]).toBe(FENCE_LAUNCHER);
    const dash = args.indexOf("--");
    expect(args.slice(dash)).toEqual(["--", "hermes", "chat", "--oneshot"]);
    expect(args.slice(1, dash)).toEqual(fenceArgs(policy));
    expect(args).toContain("--rw");
    expect(args.slice(args.indexOf("--rw"), args.indexOf("--rw") + 2).at(1)).toMatch(/^\//);
  });

  it("acha o executável e o caminho de verdade dele (segue o link), e a node_modules onde ele está", () => {
    const lib = path.join(root, "lib", "node_modules", "prog");
    mkdirSync(lib, { recursive: true });
    mkdirSync(path.join(root, "bin"), { recursive: true });
    writeFileSync(path.join(lib, "prog.mjs"), "#!/usr/bin/env node\n");
    symlinkSync(path.join(lib, "prog.mjs"), path.join(root, "bin", "prog"));
    const found = resolveExecutable("prog", path.join(root, "bin"));
    expect(found).toEqual([path.join(root, "bin", "prog"), path.join(lib, "prog.mjs")]);
    expect(enclosingNodeModules(path.join(root, "bin", "prog"))).toBe(path.join(root, "lib", "node_modules"));
    expect(resolveExecutable("nao-existe", path.join(root, "bin"))).toEqual([]);
  });

  it("as escritas do Hermes dentro da instalação: só travas, .leases e a pm-runtime (nunca o venv)", () => {
    const installs = path.join(root, "installs");
    for (const dir of ["i1/environments/e1/.leases", "i1/environments/e1/venv/lib", "i1/pm-runtime/generations/g1/.leases"]) mkdirSync(path.join(installs, dir), { recursive: true });
    writeFileSync(path.join(installs, "i1", ".install.lock"), "");
    const writable = hermesInstallWritables(installs);
    expect(writable.files).toEqual([path.join(installs, "i1", ".install.lock")]);
    expect(writable.dirs.sort()).toEqual([path.join(installs, "i1", "environments", "e1", ".leases"), path.join(installs, "i1", "pm-runtime")].sort());
  });
});

describe("Hermes: a cerca por agente e por forma de conta", () => {
  const home = () => path.join(root, "hermes-cyno");
  const make = (options: { program?: boolean; personal?: boolean; fence?: boolean; support?: typeof SUPPORT | typeof NO_SUPPORT } = {}) => {
    const source = path.join(home(), "home");
    mkdirSync(path.join(source, "installs", "i1", "pm-runtime"), { recursive: true });
    mkdirSync(path.join(source, "hermes-agent"), { recursive: true });
    mkdirSync(path.join(source, "tools"), { recursive: true });
    writeFileSync(path.join(source, ".env"), "OPENROUTER_API_KEY=x\n");
    writeFileSync(path.join(source, "auth.json"), "{}");
    return new HermesAdapter({ homeDir: home(), command: "hermes", account: () => ({ mode: options.program ? "program" : "openrouter", location: options.personal ? "personal" : "cyno" }), personalHome: path.join(root, "pessoal-hermes"), fence: () => options.fence ?? true, fenceSupport: () => options.support ?? SUPPORT, openrouterKey: () => "CHAVE-SECRETA" });
  };

  it("com a chave do painel: pasta de trabalho, HERMES_HOME do agente e instalação só leitura; nenhuma credencial do dono", () => {
    const a = make();
    const cwd = path.join(root, "w1", "agents", "a1");
    const policy = a.fencePolicy(spec(cwd));
    const source = path.join(home(), "home");
    expect(policy.readWrite).toEqual(expect.arrayContaining([cwd, hermesAgentHomeOf(home(), cwd), path.join(source, "installs", "i1", "pm-runtime")]));
    expect(policy.readOnly).toEqual(expect.arrayContaining([path.join(source, "hermes-agent"), path.join(source, "tools"), path.join(source, "installs")]));
    expect(policy.readOnly).not.toContain(path.join(source, ".env"));
    expect(policy.readOnly).not.toContain(path.join(source, "auth.json"));
    expect(policy.readWrite).not.toContain(home());
    expect(policy.readWrite).not.toContain(source);
  });

  it("na conta 'configuração do programa' o .env e o auth.json do dono entram só para leitura, e mais nada da pasta dele", () => {
    const policy = make({ program: true }).fencePolicy(spec(path.join(root, "w1", "agents", "a1")));
    const source = path.join(home(), "home");
    expect(policy.readOnly).toEqual(expect.arrayContaining([path.join(source, ".env"), path.join(source, "auth.json")]));
    expect(policy.readWrite).not.toContain(path.join(source, ".env"));
    expect(policy.readOnly).not.toContain(path.join(source, "config.yaml"));
    expect(policy.readOnly).not.toContain(source);
  });

  it("no local pessoal a instalação vem do ~/.hermes do dono (código, ambiente, credenciais), nunca a pasta inteira", () => {
    const personal = path.join(root, "pessoal-hermes");
    for (const dir of ["hermes-agent", "tools", "installs", "sessions", "memories"]) mkdirSync(path.join(personal, dir), { recursive: true });
    writeFileSync(path.join(personal, ".env"), "k");
    writeFileSync(path.join(personal, "auth.json"), "{}");
    const a = make({ program: true, personal: true });
    const policy = a.fencePolicy(spec(path.join(root, "w1", "agents", "a1")));
    expect(policy.readOnly).toEqual(expect.arrayContaining([path.join(personal, "hermes-agent"), path.join(personal, "tools"), path.join(personal, "installs"), path.join(personal, ".env")]));
    for (const closed of ["sessions", "memories"]) expect([...policy.readOnly, ...policy.readWrite]).not.toContain(path.join(personal, closed));
    expect([...policy.readOnly, ...policy.readWrite]).not.toContain(personal);
  });

  it("o ambiente leva TMPDIR e HOME próprios do agente (dentro do HERMES_HOME dele) só com a cerca", () => {
    const cwd = path.join(root, "w1", "agents", "a1");
    const agentHome = hermesAgentHomeOf(home(), cwd);
    const fenced = make().env({ PATH: "/usr/bin", TMPDIR: "/tmp", HOME: "/home/dono" }, spec(cwd));
    expect(fenced.TMPDIR).toBe(hermesAgentTmpOf(agentHome));
    expect(fenced.HOME).toBe(hermesFencedHomeOf(agentHome));
    expect(fenced.HERMES_HOME).toBe(agentHome);
    const plain = make({ fence: false }).env({ PATH: "/usr/bin", TMPDIR: "/tmp" }, spec(cwd));
    expect(plain.HOME).toBe(hermesUserHome(home()));
    expect(plain.TMPDIR).toBe("/tmp");
  });

  it("cria as pastas do agente que a cerca usa (tmp e HOME)", () => {
    const cwd = path.join(root, "w1", "agents", "a1");
    const dirs = make().requiredDirs(spec(cwd));
    expect(dirs).toEqual(expect.arrayContaining([hermesAgentTmpOf(hermesAgentHomeOf(home(), cwd)), hermesFencedHomeOf(hermesAgentHomeOf(home(), cwd))]));
  });

  it("desligada pelo dono, ou sem Landlock neste computador, não há cerca (o comando não é embrulhado)", () => {
    const cwd = path.join(root, "w1", "agents", "a1");
    expect(make().fence(spec(cwd))).toMatchObject({ python: "/usr/bin/python3" });
    expect(make({ fence: false }).fence(spec(cwd))).toBeUndefined();
    expect(make({ support: NO_SUPPORT }).fence(spec(cwd))).toBeUndefined();
    // Sem a opção nenhuma (como nos testes antigos) também não há cerca.
    expect(new HermesAdapter({ homeDir: home() }).fence(spec(cwd))).toBeUndefined();
  });
});

describe("OpenClaw: a cerca por agente", () => {
  const home = () => path.join(root, "openclaw-cyno");
  const make = (options: { program?: boolean; personal?: boolean; support?: typeof SUPPORT | typeof NO_SUPPORT } = {}) =>
    new OpenClawAdapter({ homeDir: home(), command: "openclaw", account: () => ({ mode: options.program ? "program" : "openrouter", location: options.personal ? "personal" : "cyno" }), fence: () => true, fenceSupport: () => options.support ?? SUPPORT });

  it("leitura e escrita: pasta de trabalho, estado e HOME do OpenClaw no Cyno e o temporário do agente; a configuração do agente só leitura", () => {
    const cwd = path.join(root, "w1", "agents", "a2");
    const policy = make().fencePolicy(spec(cwd));
    const paths = openclawPaths(home());
    expect(policy.readWrite).toEqual(expect.arrayContaining([cwd, paths.home, paths.stateDir, openclawAgentTmpOf(home(), cwd)]));
    const configDir = path.dirname(openclawAgentConfigPath(home(), cwd));
    expect(policy.readOnly).toContain(configDir);
    expect(policy.readWrite).not.toContain(configDir);
    expect(policy.readWrite).not.toContain(home());
  });

  it("com o acesso a terminal ligado o OpenClaw roda sem cerca (o exec dele precisa do /proc dos filhos), e o ambiente também não muda", () => {
    const cwd = path.join(root, "w1", "agents", "a2");
    const withTerminal: TerminalSpec = { ...spec(cwd), access: { internet: false, browser: false, terminal: true, allowLocalNetwork: false, allowedDomains: [], blockedDomains: [] } };
    expect(make().fence(withTerminal)).toBeUndefined();
    expect(make().env({ PATH: "/usr/bin", TMPDIR: "/tmp" }, withTerminal)).toMatchObject({ TMPDIR: "/tmp" });
    expect(make().requiredDirs(withTerminal)).not.toContain(openclawAgentTmpOf(home(), cwd));
    expect(make().fence({ ...withTerminal, access: { ...withTerminal.access!, terminal: false } })).toMatchObject({ python: "/usr/bin/python3" });
  });

  it("no local pessoal (~/.openclaw) não há cerca; sem Landlock também não", () => {
    const cwd = path.join(root, "w1", "agents", "a2");
    expect(make({ program: true, personal: true }).fence(spec(cwd))).toBeUndefined();
    expect(make({ support: NO_SUPPORT }).fence(spec(cwd))).toBeUndefined();
    expect(make().fence(spec(cwd))).toMatchObject({ python: "/usr/bin/python3" });
  });

  it("o TMPDIR do agente e o `OPENCLAW_NO_RESPAWN` só existem com a cerca", () => {
    const cwd = path.join(root, "w1", "agents", "a2");
    const fenced = make().env({ PATH: "/usr/bin", TMPDIR: "/tmp" }, spec(cwd));
    expect(fenced.TMPDIR).toBe(openclawAgentTmpOf(home(), cwd));
    expect(fenced.OPENCLAW_NO_RESPAWN).toBe("1");
    const plain = make({ support: NO_SUPPORT }).env({ PATH: "/usr/bin", TMPDIR: "/tmp" }, spec(cwd));
    expect(plain.TMPDIR).toBe("/tmp");
    expect(plain.OPENCLAW_NO_RESPAWN).toBeUndefined();
  });

  it("do /proc só entram os arquivos do PRÓPRIO processo (stat, statm, status), nunca o environ", () => {
    const policy = make().fencePolicy(spec(path.join(root, "w1", "agents", "a2")));
    expect(policy.readOnly).toEqual(expect.arrayContaining(["/proc/{pid}/stat", "/proc/{pid}/statm", "/proc/{pid}/status"]));
    expect(policy.readOnly.some((item) => /environ/.test(item))).toBe(false);
    expect(policy.listOnly).toEqual(["/proc"]);
  });
});

describe("o terminal embrulha o comando do motor com o lançador", () => {
  const adapterWith = (fence: OneShotAdapter["fence"]): OneShotAdapter => ({
    provider: "hermes",
    resumable: false,
    command: () => ({ command: "hermes", args: ["chat", "-q"] }),
    composeMessage: (_spec, input) => input.text,
    agentFiles: () => [],
    env: () => ({ PATH: "/usr/bin" }),
    createParser: () => ({ parse: () => [], takePartialUsage: () => undefined, finish: () => [{ type: "turn_end", ok: true, result: "ok" }] }),
    newSessionId: () => "s1",
    ...(fence ? { fence } : {}),
  });

  /** Roda um turno com um `spawn` que só anota o comando e sobe um processo vazio; devolve o que o terminal mandou subir. */
  const spawned = async (adapter: OneShotAdapter): Promise<{ command: string; args: string[] }> => {
    const cwd = mkdtempSync(path.join(root, "term-"));
    let seen: { command: string; args: string[] } | undefined;
    const terminal = new OneShotTerminal({
      adapter,
      spec: spec(cwd),
      turnTimeoutMs: 10_000,
      spawn: (command, args) => {
        seen = { command, args };
        return nodeSpawn(process.execPath, ["-e", ""], { stdio: ["ignore", "pipe", "pipe"] });
      },
    });
    await new Promise<void>((resolve) => {
      terminal.onEvent((event) => {
        if (event.type === "turn_end") resolve();
      });
      terminal.send("oi", "t1");
    });
    await terminal.dispose();
    return seen!;
  };

  it("sem cerca o comando vai como o adaptador montou", async () => {
    expect(await spawned(adapterWith(undefined))).toEqual({ command: "hermes", args: ["chat", "-q"] });
  });

  it("com cerca vai embrulhado: python, lançador, a lista, `--` e o comando de sempre", async () => {
    const policy = fencePolicy({ readWrite: ["/dados/a1"], readOnly: ["/opt/hermes"] });
    const result = await spawned(adapterWith(() => ({ policy, python: "/usr/bin/python3" })));
    expect(result.command).toBe("/usr/bin/python3");
    expect(result.args[0]).toBe(FENCE_LAUNCHER);
    expect(result.args.slice(result.args.indexOf("--"))).toEqual(["--", "hermes", "chat", "-q"]);
    expect(result.args).toEqual(expect.arrayContaining(["--rw", "/dados/a1", "--ro", "/opt/hermes", "--ls", "/proc"]));
  });
});

describe("a detecção", () => {
  it("o ambiente dos testes desliga a cerca (CYNO_FENCE=off) e diz por quê", () => {
    setFenceSupportForTests(undefined);
    expect(detectFence({ refresh: true })).toMatchObject({ available: false, reason: expect.stringContaining("CYNO_FENCE=off") });
    setFenceSupportForTests(undefined);
  });

  it("no Windows (win32), devolve available: false com motivo claro em pt-BR sem tentar python3 ou /proc", () => {
    expect(detectFence({ platform: "win32" })).toMatchObject({
      available: false,
      abi: 0,
      reason: expect.stringMatching(/Não existe no Windows/i),
    });
    expect(probeLandlock("win32")).toMatchObject({
      available: false,
      abi: 0,
      reason: expect.stringMatching(/Não existe no Windows/i),
    });
  });
});

// O lançador de verdade: só onde o computador tem Landlock (o resto pula).
const real = probeLandlock();
describe.skipIf(!real.available)("o lançador com Landlock de verdade", () => {
  let allowed = "";
  let outside = "";
  beforeAll(() => {
    allowed = path.join(root, "permitida");
    outside = path.join(root, "fora");
    mkdirSync(allowed, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "segredo.txt"), "ISCA");
    writeFileSync(path.join(allowed, "ola.txt"), "ola");
    mkdirSync(path.join(allowed, "tmp"), { recursive: true });
    symlinkSync(path.join(outside, "segredo.txt"), path.join(allowed, "atalho"));
  });

  const sh = (script: string, extra: string[] = []) => {
    const policy = fencePolicy({ readWrite: [allowed], readOnly: extra });
    const { command, args } = fencedCommand(policy, real.python!, "/bin/sh", ["-c", script]);
    return spawnSync(command, args, { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  };

  it("lê e grava dentro da pasta permitida", () => {
    const result = sh(`cat '${allowed}/ola.txt' && echo novo > '${allowed}/novo.txt' && cat '${allowed}/novo.txt' && mkdir '${allowed}/sub' && rm '${allowed}/novo.txt'`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("olanovo\n");
  });

  it("recusa ler e gravar fora, por caminho absoluto, `..` e link simbólico", () => {
    const secret = path.join(outside, "segredo.txt");
    expect(sh(`cat '${secret}'`).status).not.toBe(0);
    expect(sh(`cat '${allowed}/../fora/segredo.txt'`).status).not.toBe(0);
    expect(sh(`cat '${allowed}/atalho'`).status).not.toBe(0);
    expect(sh(`echo x > '${outside}/novo.txt'`).status).not.toBe(0);
    expect(sh(`echo x > '${allowed}/atalho'`).status).not.toBe(0);
    expect(sh(`rm '${secret}'`).status).not.toBe(0);
    expect(sh(`ls '${outside}'`).status).not.toBe(0);
  });

  it("o /proc só lista: o ambiente do próprio processo e o de outro ficam fechados", () => {
    const result = sh(`ls /proc | head -c 1 >/dev/null && echo lista-ok; cat /proc/self/environ; cat /proc/$$/environ; cat /proc/1/environ; cat /proc/meminfo | head -1`);
    expect(result.stdout).toContain("lista-ok");
    expect(result.stdout).toContain("MemTotal");
    expect(result.stdout).not.toMatch(/PATH=/);
    expect(result.stderr).toMatch(/Permission denied/);
  });

  it("os filhos herdam a cerca (um processo que o comando abre em segundo plano)", () => {
    const secret = path.join(outside, "segredo.txt");
    const result = sh(`/bin/sh -c "cat '${secret}'" ; echo "codigo=$?"`);
    expect(result.stdout).toContain("codigo=1");
    expect(result.stdout).not.toContain("ISCA");
  });

  it("o lançador ignora o que não existe na lista e recusa argumentos incompletos (código 2)", () => {
    const result = spawnSync(real.python!, [FENCE_LAUNCHER, "--ro", "/usr", "--", "/bin/sh", "-c", "echo rodou"], { encoding: "utf8" });
    // Com uma regra boa o comando roda; o que não existe na lista é ignorado em silêncio.
    expect(result.stdout).toBe("rodou\n");
    const bad = spawnSync(real.python!, [FENCE_LAUNCHER, "--ro"], { encoding: "utf8" });
    expect(bad.status).toBe(2);
    expect(spawnSync(real.python!, [FENCE_LAUNCHER, "--ro", "/usr"], { encoding: "utf8" }).status).toBe(2);
  });

  it("--check diz a versão da ABI", () => {
    const check = spawnSync(real.python!, [FENCE_LAUNCHER, "--check"], { encoding: "utf8" });
    expect(check.status).toBe(0);
    expect(JSON.parse(check.stdout)).toMatchObject({ available: true, abi: expect.any(Number) });
    expect(real.abi).toBeGreaterThanOrEqual(1);
  });
});
