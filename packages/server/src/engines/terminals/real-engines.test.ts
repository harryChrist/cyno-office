import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeLandlock } from "./fence";
import { HermesAdapter, hermesAgentHomeOf } from "./hermes-adapter";
import { OpenClawAdapter, openclawAgentConfigPath, readOpenclawBase } from "./openclaw-adapter";
import { ensureAdapterDirs, OneShotTerminal, type OneShotAdapter } from "./one-shot-terminal";
import type { TerminalEvent, TerminalSpec } from "./types";

/**
 * OPCIONAL: roda os programas de VERDADE (OpenClaw e Hermes) contra um provedor de IA falso local
 * (`src/dev/fake-openai-provider.mjs`), sem conta, sem chave e sem rede externa. Nunca roda no CI comum:
 *   CYNO_REAL_ENGINES=1 npx vitest run src/engines/terminals/real-engines.test.ts
 * - OpenClaw: precisa de `openclaw` no PATH (ou OPENCLAW_BIN).
 * - Hermes: precisa de `hermes` no PATH (ou HERMES_BIN) E de uma pasta com o ambiente Python já preparado (o `hermes pm repair`
 *   baixa ~400 MB): CYNO_REAL_HERMES_HOME=<pasta com `installs/`>. Sem ela, o Hermes é pulado.
 * Cada turno sobe o programa de verdade (o OpenClaw leva ~15 s só para iniciar), então o arquivo todo leva alguns minutos (~10).
 * O Hermes prepara ~1 GB dentro da pasta temporária: com um /tmp pequeno ou com cota (visto: erro -122, "Disk quota exceeded"), use CYNO_REAL_TMP=/var/tmp.
 * As provas da segunda revisão: o alcance das ferramentas de arquivo (as iscas) e o corte de um turno no meio de uma sequência de ferramentas. Com
 * CYNO_REACH_LOG=<arquivo> a tabela das iscas e os números do corte vão para esse arquivo (o vitest engole o console).
 */
const ENABLED = process.env.CYNO_REAL_ENGINES === "1";
/** O executável no PATH (e em ~/.local/bin, onde o instalador do Cyno os publica), ou undefined. */
function findExecutableSync(name: string): string | undefined {
  for (const dir of [...(process.env.PATH ?? "").split(path.delimiter), path.join(os.homedir(), ".local", "bin")]) {
    const candidate = path.join(dir, name);
    if (dir && existsSync(candidate)) return candidate;
  }
  return undefined;
}
const openclawBin = process.env.OPENCLAW_BIN ?? findExecutableSync("openclaw");
const hermesBin = process.env.HERMES_BIN ?? findExecutableSync("hermes");
const hermesInstalls = process.env.CYNO_REAL_HERMES_HOME ?? "";
const fakeScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dev/fake-openai-provider.mjs");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

const ACCESS_OFF = { internet: false, browser: false, terminal: false, allowLocalNetwork: false, allowedDomains: [] as string[], blockedDomains: [] as string[] };

type Turn = { events: TerminalEvent[]; end?: Extract<TerminalEvent, { type: "turn_end" }>; dropped?: string };

function runTurn(adapter: OneShotAdapter, spec: TerminalSpec, text: string, options: { timeoutMs: number; interruptAfterMs?: number; terminal?: OneShotTerminal } = { timeoutMs: 120_000 }): Promise<{ turn: Turn; terminal: OneShotTerminal }> {
  const terminal = options.terminal ?? new OneShotTerminal({ adapter, spec, env: process.env, turnTimeoutMs: options.timeoutMs, stopGraceMs: 1500 });
  return new Promise((resolve) => {
    const turn: Turn = { events: [] };
    const off = terminal.onEvent((event) => {
      turn.events.push(event);
      if (event.type === "turn_end") {
        turn.end = event;
        off();
        resolve({ turn, terminal });
      }
      if (event.type === "dropped") {
        turn.dropped = event.reason;
        off();
        resolve({ turn, terminal });
      }
    });
    terminal.send(text, "t1");
    if (options.interruptAfterMs) setTimeout(() => terminal.interrupt(), options.interruptAfterMs);
  });
}

describe.skipIf(!ENABLED || !openclawBin && !hermesBin)("motores de verdade contra o provedor falso (opcional)", () => {
  let root = "";
  let port = 0;
  let fake: ChildProcess | undefined;
  const requests = (): { url: string; headers: Record<string, string>; body: { tools?: { function: { name: string } }[]; messages?: { role: string; content?: unknown; tool_calls?: { function: { name: string } }[] }[] } }[] =>
    readFileSync(path.join(root, "fake", "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as never);
  const chats = () => requests().filter((request) => request.url.includes("/chat/completions"));
  const toolNames = (index = -1) => (chats().at(index)?.body.tools ?? []).map((tool) => tool.function.name);


  // ---------- Alcance das ferramentas de arquivo (revisão 2, G1) ----------
  const BAIT = "ISCA-SEGREDO-12345";
  /** Isca fora da pasta do agente + links dentro da pasta apontando para fora. Devolve o que cada caso pede ao modelo. */
  const setupBait = (cwd: string) => {
    const decoy = path.join(root, "decoy");
    mkdirSync(decoy, { recursive: true });
    writeFileSync(path.join(decoy, "segredo-isca.txt"), BAIT);
    try {
      symlinkSync(path.join(decoy, "segredo-isca.txt"), path.join(cwd, "link-arquivo"));
      symlinkSync(decoy, path.join(cwd, "link-fora"));
    } catch {
      // já existem
    }
    return decoy;
  };
  /** Um turno com o roteiro do provedor falso; devolve o texto final (o que a ferramenta devolveu) e o status. */
  const probeTurn = async (a: OneShotAdapter, s: TerminalSpec, script: string) => {
    // Cada caso é uma conversa nova: sem isto o turno seguinte leva o trecho do anterior (o repasse do OpenClaw) e o roteiro do provedor falso leria o alvo velho.
    for (const stale of ["session.json", "turn-context.json"]) rmSync(path.join(s.cwd, stale), { force: true });
    const { turn, terminal } = await runTurn(a, s, script, { timeoutMs: 150_000 });
    // O fim do turno chega antes de o terminal gravar o repasse da conversa: espera ele acabar de vez, senão o repasse cai depois da limpeza acima.
    await terminal.stop();
    await terminal.flushSession();
    for (const stale of ["session.json", "turn-context.json"]) rmSync(path.join(s.cwd, stale), { force: true });
    const result = turn.end?.result ?? turn.dropped ?? "";
    return { ok: turn.end?.ok === true, result };
  };
  const record = (engine: string, label: string, outcome: string, detail: string) => {
    // O vitest engole o console: a tabela vai para o arquivo de CYNO_REACH_LOG (quando dado).
    if (process.env.CYNO_REACH_LOG) appendFileSync(process.env.CYNO_REACH_LOG, `${engine} | ${label} | ${outcome} | ${detail.replace(/\s+/g, " ").slice(0, 400)}\n`);
    return outcome;
  };

  /** O que cada caso pede ao modelo e como reconhecer que a ferramenta deixou passar. */
  const reachCases = (engine: string, prepared: (name: string) => Promise<{ a: OneShotAdapter; s: TerminalSpec }>, own: { label: string; target: (s: TerminalSpec, a: OneShotAdapter) => string; secret: string }[], confined: boolean, tag = "") => {
    it(`alcance das ferramentas de arquivo (${engine}${tag})`, async () => {
      const { a, s } = await prepared(`${engine}${tag.replace(/\W+/g, "-")}-reach`);
      const decoy = setupBait(s.cwd);
      // Um DATA_DIR de teste: a isca que faz o papel da chave do OpenRouter e o token de OUTRO agente (nunca os de verdade).
      const data = path.join(root, "data");
      mkdirSync(path.join(data, "platform"), { recursive: true });
      mkdirSync(path.join(data, "workspaces", "ws", "agents", "outro"), { recursive: true });
      writeFileSync(path.join(data, "platform", "openrouter-key.json"), '{"key":"ISCA-CHAVE-OPENROUTER"}');
      writeFileSync(path.join(data, "workspaces", "ws", "agents", "outro", "token.txt"), "ISCA-TOKEN-OUTRO");
      // O programa leva a chave do OpenRouter no AMBIENTE (o gateway do Hermes a guarda em /proc/<pid>/environ): a isca de ambiente prova o /proc.
      const envBait = "ISCA-CHAVE-NO-AMBIENTE";
      const plainEnv = a.env.bind(a);
      a.env = (base, spec) => ({ ...plainEnv(base, spec), OPENROUTER_API_KEY: envBait });
      const inside = path.join(s.cwd, "dentro.txt");
      writeFileSync(inside, "CONTEUDO-DENTRO");
      const outcomes: Record<string, string> = {};
      const reads: [string, string, string][] = [
        ["controle: ler dentro da pasta", inside, "CONTEUDO-DENTRO"],
        ["ler isca fora (absoluto)", path.join(decoy, "segredo-isca.txt"), BAIT],
        ["ler /proc/self/environ", "/proc/self/environ", "PATH="],
        ["ler com ..", path.relative(s.cwd, path.join(decoy, "segredo-isca.txt")), BAIT],
        ["ler link simbolico de arquivo (dentro -> fora)", "link-arquivo", BAIT],
        ["ler arquivo via link simbolico de pasta", "link-fora/segredo-isca.txt", BAIT],
        ["ler a isca da chave do OpenRouter (DATA_DIR de teste)", path.join(data, "platform", "openrouter-key.json"), "ISCA-CHAVE-OPENROUTER"],
        ["ler o token de outro agente (DATA_DIR de teste)", path.join(data, "workspaces", "ws", "agents", "outro", "token.txt"), "ISCA-TOKEN-OUTRO"],
        ["ler /etc/hostname (fora da lista)", "/etc/hostname", os.hostname()],
        ...own.map((item): [string, string, string] => [item.label, item.target(s, a), item.secret]),
      ];
      for (const [label, target, mark] of reads) {
        const { result } = await probeTurn(a, s, `[[ler:${target}]]`);
        outcomes[label] = record(engine + tag, label, result.includes(mark) ? "LEU" : "recusado", result);
      }
      // O /proc do processo que está de fato rodando o agente: o gateway do Hermes (achado pelo HERMES_HOME dele; o teste não está dentro da cerca) ou, no OpenClaw, o
      // processo do turno. Com um turno comprido ainda no ar, tenta ler /proc/<pid>/environ dele.
      let holder: number | undefined;
      if (engine === "hermes") {
        // Sobe o gateway (um turno comum, sem encerrá-lo) e acha o PID dele pelo HERMES_HOME do agente.
        await runTurn(a, s, "aquecer o gateway", { timeoutMs: 150_000 });
        const home = (a as HermesAdapter).agentHome(s);
        holder = readdirSync("/proc")
          .filter((entry) => /^\d+$/.test(entry))
          .map(Number)
          .find((pid) => {
            try {
              return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`HERMES_HOME=${home}`);
            } catch {
              return false;
            }
          });
        expect(holder, "o gateway do Hermes tem de estar no ar para esta prova").toBeDefined();
      }
      if (holder) {
        const { result } = await probeTurn(a, s, `[[ler:/proc/${holder}/environ]]`);
        outcomes["ler /proc/<pid do gateway>/environ"] = record(engine + tag, "ler /proc/<pid do gateway>/environ", result.includes(envBait) || result.includes("PATH=") ? "LEU" : "recusado", result);
      }
      const writes: [string, string][] = [
        ["escrever fora (absoluto)", path.join(decoy, "escrito-fora.txt")],
        ["escrever via link simbolico de pasta", "link-fora/escrito-link.txt"],
        ["escrever dentro (controle)", "escrito-dentro.txt"],
        ["escrever em /var/tmp (fora da lista)", path.join("/var/tmp", `cyno-isca-escrita-${process.pid}.txt`)],
      ];
      for (const [label, target] of writes) {
        // Apaga o que um caso anterior (ou a passada "sem cerca") deixou: senão a prova de "não gravou" enxergaria o arquivo velho.
        for (const old of [path.join(decoy, path.basename(target)), path.resolve(s.cwd, target)]) rmSync(old, { force: true });
        const { result } = await probeTurn(a, s, `[[escrever:${target}]]`);
        const wrote = [path.join(decoy, path.basename(target)), path.resolve(s.cwd, target)].some((file) => existsSync(file) && readFileSync(file, "utf8") === "ISCA-ESCRITA");
        outcomes[label] = record(engine + tag, label, wrote ? "ESCREVEU" : "recusado", result);
      }
      // O que o Cyno afirma na tela: OpenClaw confina tudo que sai da pasta; o Hermes NÃO confina (o aviso de alcance existe por isso), só recusa as próprias
      // credenciais e /proc/*/environ. Se um dia o Hermes passar a confinar, este teste falha e o aviso na tela deve sair.
      expect(outcomes["controle: ler dentro da pasta"]).toBe("LEU");
      expect(outcomes["escrever dentro (controle)"]).toBe("ESCREVEU");
      const outside = ["ler isca fora (absoluto)", "ler com ..", "ler link simbolico de arquivo (dentro -> fora)", "ler arquivo via link simbolico de pasta", "escrever fora (absoluto)", "escrever via link simbolico de pasta", "ler a isca da chave do OpenRouter (DATA_DIR de teste)", "ler o token de outro agente (DATA_DIR de teste)", "ler /etc/hostname (fora da lista)", "escrever em /var/tmp (fora da lista)"];
      for (const label of outside) expect(outcomes[label], label).toBe(confined ? "recusado" : label.startsWith("escrever") ? "ESCREVEU" : "LEU");
      expect(outcomes["ler /proc/self/environ"]).toBe("recusado");
      if (confined && outcomes["ler /proc/<pid do gateway>/environ"]) expect(outcomes["ler /proc/<pid do gateway>/environ"]).toBe("recusado");
      rmSync(path.join("/var/tmp", `cyno-isca-escrita-${process.pid}.txt`), { force: true });
      for (const [label, outcome] of Object.entries(outcomes)) if (/\.env|auth\.json|token do MCP/.test(label)) expect(outcome, label).toBe(confined ? "recusado" : /\.env|auth\.json/.test(label) ? "recusado" : "LEU");
    }, 900_000);
  };

  /**
   * Com o acesso a TERMINAL ligado: os comandos do agente são filhos do processo cercado e herdam a cerca. Aqui o `/proc/self/environ` e o `/proc/<gateway>/environ` são lidos por
   * `cat` de verdade (a recusa não vem mais do próprio programa, que bloqueia esses nomes nas ferramentas de arquivo), e o ambiente do shell mostra se a chave chega a ele.
   */
  const terminalCases = (engine: string, prepare: () => Promise<{ a: OneShotAdapter; s: TerminalSpec }>, confined: boolean, tag: string) => {
    it(`terminal do agente (${engine}${tag})`, async () => {
      const { a, s } = await prepare();
      const decoy = setupBait(s.cwd);
      const envBait = "ISCA-CHAVE-NO-AMBIENTE";
      const plainEnv = a.env.bind(a);
      a.env = (base, spec2) => ({ ...plainEnv(base, spec2), OPENROUTER_API_KEY: envBait });
      const wrote = path.join(decoy, "terminal-escreveu.txt");
      const cases: [string, string, (result: string) => boolean][] = [
        ["terminal: ler isca fora (cat)", `cat ${path.join(decoy, "segredo-isca.txt")}`, (r) => r.includes(BAIT)],
        ["terminal: ler /proc/self/environ", "cat /proc/self/environ | tr '\\0' '\\n' | grep ISCA-CHAVE-NO-AMBIENT.", (r) => r.includes(envBait)],
        // O ambiente de TODOS os processos do usuário (o do gateway do Hermes, o do processo do OpenClaw, o do servidor...): é por aqui que a chave do OpenRouter se alcança sem a cerca.
        ["terminal: ler o environ de TODOS os processos (/proc/*/environ)", "{ for f in /proc/*/environ; do cat $f; done; } 2>/dev/null | tr '\\0' '\\n' | grep ISCA-CHAVE-NO-AMBIENT.; echo fim", (r) => r.includes(envBait)],
        ["terminal: a chave no ambiente do shell (env)", "env | grep ISCA-CHAVE-NO-AMBIENT. || echo ausente", (r) => r.includes(envBait)],
        ["terminal: ler /etc/hostname", "cat /etc/hostname", (r) => r.includes(os.hostname())],
        ["terminal: listar a pasta pessoal do dono", `ls ${os.homedir()}`, (r) => /\.ssh|\.claude|\.config|maestri|\.local/.test(r)],
        ["terminal: gravar fora (echo >)", `echo ISCA-ESCRITA > ${wrote}`, () => existsSync(wrote) && readFileSync(wrote, "utf8").includes("ISCA-ESCRITA")],
        ["terminal: dentro da pasta (controle)", "echo ola-terminal > terminal-dentro.txt && cat terminal-dentro.txt", (r) => r.includes("ola-terminal")],
      ];
      const outcomes: Record<string, string> = {};
      for (const [label, command, leaked] of cases) {
        rmSync(wrote, { force: true });
        const { result } = await probeTurn(a, s, `[[terminal:${command}]]`);
        outcomes[label] = record(engine + tag, label, leaked(result) ? "LEU" : "recusado", result);
      }
      expect(outcomes["terminal: dentro da pasta (controle)"]).toBe("LEU");
      if (confined) {
        for (const label of ["terminal: ler isca fora (cat)", "terminal: ler /proc/self/environ", "terminal: ler /etc/hostname", "terminal: listar a pasta pessoal do dono", "terminal: gravar fora (echo >)", "terminal: ler o environ de TODOS os processos (/proc/*/environ)"]) {
          if (outcomes[label]) expect(outcomes[label], label).toBe("recusado");
        }
      }
    }, 900_000);
  };

  // ---------- Interromper de verdade (revisão 2, G2) ----------
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Os processos cujo ambiente tem `<nome>=<algo dentro da pasta temporária>`: o que sobrou de um turno cortado. */
  const survivors = (name: "HERMES_HOME" | "OPENCLAW_STATE_DIR"): number[] => {
    const found: number[] = [];
    for (const pid of readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
      try {
        if (readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").some((entry) => entry.startsWith(`${name}=${root}`))) found.push(Number(pid));
      } catch {
        // de outro usuário ou já saiu
      }
    }
    return found;
  };
  /**
   * Corta um turno que faz uma sequência longa de ferramentas e olha, pelas requisições que continuam chegando ao provedor falso e pelos
   * processos, se o agente seguiu trabalhando depois do corte.
   */
  const cutInTheMiddle = async (a: OneShotAdapter, s: TerminalSpec, how: "interrupt" | "timeout", env: "HERMES_HOME" | "OPENCLAW_STATE_DIR", warmMs = 25_000) => {
    // O primeiro turno de um HERMES_HOME novo prepara o ambiente (dezenas de segundos): aquece com um turno comum, depois corta.
    await runTurn(a, s, "aquecer", { timeoutMs: 170_000 });
    const before = chats().length;
    const cut = await runTurn(a, s, "[[sequencia:40]]", how === "interrupt" ? { timeoutMs: 180_000, interruptAfterMs: warmMs } : { timeoutMs: warmMs });
    const atCut = chats().length;
    if (process.env.CYNO_REACH_DEBUG) appendFileSync(process.env.CYNO_REACH_DEBUG, `debug ${how}: eventos=${cut.turn.events.map((event) => (event.type === "raw" ? `raw:${event.text.slice(0, 200)}` : event.type)).join(" | ")} urls=${requests().map((request) => request.url).join(",")}\n`);
    await wait(12_000);
    return { cut, requestsDuringTurn: atCut - before, requestsAfterCut: chats().length - atCut, processes: survivors(env) };
  };

  beforeAll(async () => {
    // O Hermes prepara ~1 GB por execução dentro desta pasta: em um /tmp pequeno (ou com cota) use CYNO_REAL_TMP=/var/tmp.
    root = mkdtempSync(path.join(process.env.CYNO_REAL_TMP ?? os.tmpdir(), "cyno-real-engines-"));
    port = await freePort();
    mkdirSync(path.join(root, "fake"), { recursive: true });
    fake = spawn(process.execPath, [fakeScript, "--port", String(port), "--log-dir", path.join(root, "fake"), "--slow-ms", "60000"], { stdio: "ignore" });
    for (let i = 0; i < 40; i += 1) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/__health`)).ok) return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error("o provedor falso não subiu");
  }, 20_000);

  afterAll(() => {
    fake?.kill();
    if (process.env.CYNO_REACH_DEBUG && root) appendFileSync(process.env.CYNO_REACH_DEBUG, `tamanho de ${root}: ${spawnSync("du", ["-sh", ...readdirSync(root).map((name) => path.join(root, name)), ...(existsSync(path.join(root, "hermes", "agent-homes")) ? readdirSync(path.join(root, "hermes", "agent-homes")).map((name) => path.join(root, "hermes", "agent-homes", name)) : [])]).stdout?.toString() ?? ""}\n`);
    // Para investigar: guarda o registro do provedor falso antes de apagar a pasta temporária.
    if (process.env.CYNO_KEEP_FAKE_LOG && root && existsSync(path.join(root, "fake", "requests.jsonl"))) writeFileSync(process.env.CYNO_KEEP_FAKE_LOG, readFileSync(path.join(root, "fake", "requests.jsonl")));
    // O Hermes sobe um gateway (daemon destacado) por HERMES_HOME e ele sobrevive ao turno interrompido: encerra os desta pasta temporária.
    if (root) {
      for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
        try {
          if (readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").some((entry) => entry.startsWith(`HERMES_HOME=${root}`))) process.kill(Number(pid), "SIGTERM");
        } catch {
          // processo de outro usuário ou que já saiu
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  const spec = (name: string, access: TerminalSpec["access"] = { ...ACCESS_OFF }): TerminalSpec => {
    const cwd = path.join(root, "work", name);
    mkdirSync(cwd, { recursive: true });
    return { agentId: name, cwd, systemPrompt: "Você faz um teste.", mcpConfigFile: path.join(cwd, "mcp.json"), tools: [], access };
  };

  describe.skipIf(!openclawBin)("OpenClaw", () => {
    const home = () => path.join(root, "openclaw");
    /** `fenced`: a cerca de arquivos (Landlock) ligada, como no Cyno de verdade (o padrão). */
    const adapter = (fenced = true) => {
      mkdirSync(home(), { recursive: true });
      writeFileSync(
        path.join(home(), "openclaw.json"),
        JSON.stringify({ models: { providers: { fakeai: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "sk-fake", api: "openai-completions", models: [{ id: "fake/model", name: "Fake", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] } } } }),
      );
      return new OpenClawAdapter({ homeDir: home(), command: openclawBin!, defaultModel: "fakeai/fake/model", account: () => ({ mode: "program", location: "cyno" }), fence: () => fenced, fenceSupport: probeLandlock }, () => readOpenclawBase(home()));
    };
    const prepared = async (name: string, access?: TerminalSpec["access"], fenced = true) => {
      const a = adapter(fenced);
      const s = spec(name, access);
      await ensureAdapterDirs(a, s);
      for (const file of a.agentFiles({ spec: s, mcpUrl: "", token: "" })) {
        mkdirSync(path.dirname(file.path), { recursive: true });
        writeFileSync(file.path, file.content);
      }
      return { a, s };
    };

    // O OpenClaw já confina as ferramentas de arquivo (tools.fs.workspaceOnly): com e sem a cerca o resultado é o mesmo. O `exec` (terminal) é que não tem essa trava.
    const ocOwn = [{ label: "ler a configuracao do agente (token do MCP)", target: (s: TerminalSpec) => openclawAgentConfigPath(home(), s.cwd), secret: "providers" }];
    reachCases("openclaw", (name) => prepared(name, undefined, false), ocOwn, true, " sem cerca");
    reachCases("openclaw", (name) => prepared(name, undefined, true), ocOwn, true, " com cerca");
    terminalCases("openclaw", () => prepared("oc-term-livre", { ...ACCESS_OFF, terminal: true }, false), false, " sem cerca");
    // Com terminal ligado o OpenClaw roda SEM cerca por desenho (o exec dele precisa do /proc dos filhos): o adaptador não embrulha o comando.
    it("OpenClaw com terminal ligado roda sem cerca e o turno funciona (a cerca derrubava o exec)", async () => {
      const { a, s } = await prepared("oc-term-sem-cerca-por-desenho", { ...ACCESS_OFF, terminal: true }, true);
      expect(a.fence?.(s)).toBeUndefined();
      const { turn } = await runTurn(a, s, "[[terminal:echo oi-do-terminal]]");
      expect(turn.end?.ok).toBe(true);
      expect(turn.end?.result).toContain("oi-do-terminal");
    }, 180_000);

    it("turno que dá certo: envelope com tokens, sem custo, modelo provedor/modelo", async () => {
      const { a, s } = await prepared("oc-ok");
      const { turn } = await runTurn(a, s, "Responda só com a palavra: ok");
      expect(turn.end?.ok).toBe(true);
      expect(turn.end?.result).toContain("ECO:");
      expect(turn.end?.usage?.inputTokens).toBeGreaterThan(0);
      expect(turn.events.find((event) => event.type === "session")).toMatchObject({ model: "fakeai/fake/model" });
    }, 120_000);

    it("tarefa de arquivo: a ferramenta `write` grava o arquivo e o turno acaba; sem terminal e sem internet exec/process/web_* não vão ao modelo", async () => {
      const { a, s } = await prepared("oc-file");
      const { turn } = await runTurn(a, s, "Crie o arquivo ola.txt com a palavra olá.");
      expect(turn.end?.ok).toBe(true);
      expect(readFileSync(path.join(s.cwd, "ola.txt"), "utf8")).toBe("olá");
      expect(turn.events.filter((event) => event.type === "tool_use").map((event) => (event as { name: string }).name)).toContain("write");
      const names = toolNames();
      for (const denied of ["exec", "process", "terminal", "web_fetch", "web_search", "browser", "message", "cron", "sessions_spawn"]) expect(names).not.toContain(denied);
      for (const kept of ["read", "write", "edit"]) expect(names).toContain(kept);
    }, 180_000);

    it("com terminal e internet liberados as ferramentas voltam", async () => {
      const { a, s } = await prepared("oc-open", { ...ACCESS_OFF, internet: true, terminal: true });
      const { turn } = await runTurn(a, s, "Responda só com a palavra: ok");
      expect(turn.end?.ok).toBe(true);
      expect(toolNames()).toEqual(expect.arrayContaining(["exec", "process", "web_fetch"]));
    }, 120_000);

    it("G2: interromper e estourar o tempo no meio de uma sequência de ferramentas não deixa processo nem requisições para trás (openclaw)", async () => {
      for (const how of ["interrupt", "timeout"] as const) {
        const { a, s } = await prepared(`oc-cut-${how}`);
        const result = await cutInTheMiddle(a, s, how, "OPENCLAW_STATE_DIR");
        if (process.env.CYNO_REACH_LOG) appendFileSync(process.env.CYNO_REACH_LOG, `G2 openclaw ${how}: ${JSON.stringify({ requestsDuringTurn: result.requestsDuringTurn, requestsAfterCut: result.requestsAfterCut, processes: result.processes.length, end: result.cut.turn.dropped ?? result.cut.turn.end?.result?.slice(0, 80) })}\n`);
        expect(result.requestsDuringTurn).toBeGreaterThanOrEqual(2);
        expect(result.requestsAfterCut).toBe(0);
        expect(result.processes).toEqual([]);
      }
    }, 300_000);

    it("tempo estourado vira falha clara (e interrupção corta o processo)", async () => {
      const { a, s } = await prepared("oc-slow");
      const { turn } = await runTurn(a, s, "faça [[lento]]", { timeoutMs: 25_000 });
      expect(turn.end?.ok).toBe(false);
      expect(turn.end?.result).toMatch(/tempo máximo/);
      const interrupted = await runTurn(a, s, "faça [[lento]]", { timeoutMs: 120_000, interruptAfterMs: 20_000 });
      expect(interrupted.turn.dropped).toBe("Interrompido");
    }, 180_000);
  });

  describe.skipIf(!hermesBin || !hermesInstalls || !existsSync(path.join(hermesInstalls, "installs")))("Hermes", () => {
    const home = () => path.join(root, "hermes");
    /** `fenced`: a cerca de arquivos (Landlock) ligada, como no Cyno de verdade (o padrão). Sem ela: o Hermes como era antes (o caso "LEU"). */
    const adapter = (fenced = true) => {
      const source = path.join(home(), "home");
      mkdirSync(source, { recursive: true });
      if (!existsSync(path.join(source, "installs"))) symlinkSync(path.join(hermesInstalls, "installs"), path.join(source, "installs"));
      writeFileSync(path.join(source, ".env"), "OPENROUTER_API_KEY=ISCA-ENV\n");
      writeFileSync(path.join(source, "auth.json"), '{"token":"ISCA-AUTH"}');
      writeFileSync(path.join(source, "config.yaml"), `model:\n  provider: fakeai\n  default: fake-model\nproviders:\n  fakeai:\n    base_url: http://127.0.0.1:${port}/v1\n    api_key: sk-fake\n`);
      const adapter = new HermesAdapter({ homeDir: home(), command: hermesBin!, defaultModel: "fakeai/fake-model", account: () => ({ mode: "program", location: "cyno" }), fence: () => fenced, fenceSupport: probeLandlock });
      // Só para medir o "antes" da correção do G2: sem encerrar o gateway depois do corte.
      if (process.env.CYNO_G2_BEFORE === "1") (adapter as { afterCut?: unknown }).afterCut = undefined;
      return adapter;
    };
    const prepared = async (name: string, access?: TerminalSpec["access"], fenced = true) => {
      const a = adapter(fenced);
      const s = spec(name, access);
      await ensureAdapterDirs(a, s);
      for (const file of a.agentFiles({ spec: s, mcpUrl: "", token: "" })) writeFileSync(file.path, file.content);
      return { a, s };
    };
    const hermesOwn = [
      { label: "ler config.yaml do HERMES_HOME do agente", target: (s: TerminalSpec, a: OneShotAdapter) => path.join((a as HermesAdapter).agentHome(s), "config.yaml"), secret: "model" },
      { label: "ler .env do HERMES_HOME (link para o do dono)", target: (s: TerminalSpec, a: OneShotAdapter) => path.join((a as HermesAdapter).agentHome(s), ".env"), secret: "ISCA-ENV" },
      { label: "ler auth.json do HERMES_HOME (link para o do dono)", target: (s: TerminalSpec, a: OneShotAdapter) => path.join((a as HermesAdapter).agentHome(s), "auth.json"), secret: "ISCA-AUTH" },
      // O modo "configuração do programa" tem de deixar o programa ler as credenciais do dono: isto registra o que fica ao alcance do agente (não é afirmado em teste).
      { label: "ler credencial do dono (caminho real, modo programa)", target: () => path.join(home(), "home", ".env"), secret: "ISCA-ENV" },
    ];

    // SEM a cerca (o caso de antes, e o de um computador sem Landlock): o Hermes lê e grava fora da pasta. COM a cerca: tudo fora da lista é recusado.
    reachCases("hermes", (name) => prepared(name, undefined, false), hermesOwn, false, " sem cerca");
    reachCases("hermes", (name) => prepared(name, undefined, true), hermesOwn, true, " com cerca");
    terminalCases("hermes", () => prepared("hm-term-livre", { ...ACCESS_OFF, terminal: true }, false), false, " sem cerca");
    terminalCases("hermes", () => prepared("hm-term-cerca", { ...ACCESS_OFF, terminal: true }, true), true, " com cerca");

    it("custo de tempo por turno, com e sem a cerca (gateway frio e gateway já no ar)", async () => {
      // Aquecimento (o primeiro turno de um HERMES_HOME novo prepara o ambiente do programa e não vale como medida).
      const warmup = await prepared("hm-time-warmup", undefined, false);
      await runTurn(warmup.a, warmup.s, "aquecer", { timeoutMs: 170_000 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      for (const fenced of [false, true, false, true]) {
        const { a, s } = await prepared("hm-time-" + (fenced ? "cerca" : "livre"), undefined, fenced);
        const started = Date.now();
        const cold = await runTurn(a, s, "cronometro frio", { timeoutMs: 170_000 });
        const coldMs = Date.now() - started;
        const second = Date.now();
        await runTurn(a, s, "cronometro quente", { timeoutMs: 170_000, terminal: cold.terminal });
        const hotMs = Date.now() - second;
        expect(cold.turn.end?.ok, "o turno com" + (fenced ? "" : "out") + " a cerca precisa dar certo").toBe(true);
        record("hermes", fenced ? "tempo COM cerca" : "tempo SEM cerca", "ms", "gateway frio: " + coldMs + " ms; gateway no ar: " + hotMs + " ms");
        await cold.terminal.stop();
      }
    }, 900_000);

    it("turno que dá certo e a retomada: o id vem do `result` e o --resume continua a conversa", async () => {
      const { a, s } = await prepared("hm-resume");
      const first = await runTurn(a, s, "primeira pergunta");
      expect(first.turn.end?.ok).toBe(true);
      expect(first.turn.end?.usage?.inputTokens).toBeGreaterThan(0);
      // O id é gravado logo depois do fim do turno.
      for (let i = 0; i < 50 && !first.terminal.sessionId()?.startsWith("local-"); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(first.terminal.sessionId()).toMatch(/^local-/);
      await first.terminal.flushSession();
      const second = await runTurn(a, s, "segunda pergunta", { timeoutMs: 120_000, terminal: first.terminal });
      expect(second.turn.end?.ok).toBe(true);
      expect(second.turn.end?.result).toContain("HISTORICO: 2");
    }, 240_000);

    it("tarefa de arquivo: `write_file`; sem terminal e internet o modelo só recebe as ferramentas de arquivo", async () => {
      const { a, s } = await prepared("hm-file");
      const { turn } = await runTurn(a, s, "Crie o arquivo ola.txt com a palavra olá.");
      expect(turn.end?.ok).toBe(true);
      expect(readFileSync(path.join(s.cwd, "ola.txt"), "utf8")).toBe("olá");
      expect(toolNames().sort()).toEqual(["patch", "read_file", "search_files", "write_file"]);
    }, 180_000);

    it("o HERMES_HOME do agente não adota logins do dono e fecha a adoção no config.yaml", async () => {
      const { a, s } = await prepared("hm-home");
      const config = readFileSync(path.join(hermesAgentHomeOf(home(), s.cwd), "config.yaml"), "utf8");
      expect(config).toContain("adopt_external_logins: false");
      const env = a.env({ PATH: process.env.PATH, HOME: "/home/dono", CLAUDE_CONFIG_DIR: "/x", XAI_API_KEY: "k" }, s);
      // Com a cerca o HOME é do agente (vazio, dentro do HERMES_HOME dele); sem ela, o HOME vazio compartilhado de sempre.
      expect(env.HOME).toBe(path.join(hermesAgentHomeOf(home(), s.cwd), "userhome"));
      expect(adapter(false).env({ PATH: process.env.PATH }, s).HOME).toBe(path.join(home(), "userhome"));
      expect(env.XAI_API_KEY).toBeUndefined();
      expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    }, 20_000);

    it("G2: interromper e estourar o tempo no meio de uma sequência de ferramentas não deixa processo nem requisições para trás (hermes)", async () => {
      for (const how of ["interrupt", "timeout"] as const) {
        const { a, s } = await prepared(`hm-cut-${how}`);
                const result = await cutInTheMiddle(a, s, how, "HERMES_HOME", 25_000);
        if (process.env.CYNO_REACH_DEBUG && result.requestsDuringTurn < 2) {
          const logs = path.join(hermesAgentHomeOf(home(), s.cwd), "logs");
          const tail = existsSync(logs) ? readdirSync(logs).map((name) => `${name}: ${readFileSync(path.join(logs, name), "utf8").slice(-1500)}`).join("\n") : "(sem logs)";
          appendFileSync(process.env.CYNO_REACH_DEBUG, `falha do gateway (${how}): ${result.cut.turn.end?.result ?? result.cut.turn.dropped}\n${tail}\n`);
        }
        if (process.env.CYNO_REACH_LOG) appendFileSync(process.env.CYNO_REACH_LOG, `G2 hermes ${how}: ${JSON.stringify({ requestsDuringTurn: result.requestsDuringTurn, requestsAfterCut: result.requestsAfterCut, processes: result.processes.length, end: result.cut.turn.dropped ?? result.cut.turn.end?.result?.slice(0, 80) })}\n`);
        expect(result.requestsDuringTurn).toBeGreaterThanOrEqual(2);
        expect(result.requestsAfterCut).toBe(0);
        expect(result.processes).toEqual([]);
      }
    }, 300_000);

    it("tempo estourado e interrupção", async () => {
      const { a, s } = await prepared("hm-slow");
      const { turn } = await runTurn(a, s, "faça [[lento]]", { timeoutMs: 20_000 });
      expect(turn.end?.ok).toBe(false);
      expect(turn.end?.result).toMatch(/tempo máximo/);
      const interrupted = await runTurn(a, s, "faça [[lento]]", { timeoutMs: 120_000, interruptAfterMs: 12_000 });
      expect(interrupted.turn.dropped).toBe("Interrompido");
    }, 240_000);
  });
});
