import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isWindows } from "../../platform/os";

/**
 * A CERCA DE ARQUIVOS (Landlock). Os agentes de OpenClaw e Hermes rodam como o mesmo usuário Unix do servidor, e o Hermes não tem opção para prender as
 * ferramentas de arquivo a uma pasta (revisão 2, G1: provado com o programa, lê e grava por caminho absoluto, `..` e link simbólico). Quem faz isso por
 * ele é o sistema operacional: o Landlock (kernel 5.13+) deixa um processo comum restringir o PRÓPRIO acesso a arquivos, vale para todos os filhos
 * (inclusive o gateway que o Hermes sobe em segundo plano) e não pede sudo, contêiner nem biblioteca.
 *
 * O lançador é `landlock-fence.py` (Python 3.8+, só a biblioteca padrão): recebe as pastas permitidas e o comando, aplica a regra e troca por ele.
 * A política é uma LISTA DO QUE PODE (nada além dela é alcançável). Sem Landlock neste computador a cerca NÃO existe, e a tela diz isso.
 */

export const FENCE_LAUNCHER = path.join(path.dirname(fileURLToPath(import.meta.url)), "landlock-fence.py");

/** O Python 3 mínimo que o lançador pede. */
export const FENCE_MIN_PYTHON = "3.8";

export type FenceSupport = {
  /** Há Landlock e Python 3 para montar a cerca neste computador. */
  available: boolean;
  /** A versão da ABI do Landlock do kernel (0 = sem). */
  abi: number;
  /** O `python3` achado (caminho completo). */
  python?: string;
  pythonVersion?: string;
  /** Quando não há cerca: o motivo, em português simples. */
  reason?: string;
};

const UNAVAILABLE = (reason: string): FenceSupport => ({ available: false, abi: 0, reason });

const versionAtLeast = (version: string, minimum: string): boolean => {
  const parse = (text: string) => text.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parse(version), parse(minimum)];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
};

/** O `python3` do sistema: o primeiro do PATH (caminho completo), ou undefined. */
export function findPython(pathEnv = process.env.PATH ?? ""): string | undefined {
  for (const dir of pathEnv.split(path.delimiter)) {
    const candidate = path.join(dir, "python3");
    if (dir && existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Lê o resultado de `landlock-fence.py --check` (JSON) e decide se a cerca existe. Separado para os testes. */
export function interpretCheck(output: string, status: number | null, python: string): FenceSupport {
  let info: { available?: unknown; abi?: unknown; python?: unknown } = {};
  try {
    info = JSON.parse(output.trim().split("\n").at(-1) ?? "") as typeof info;
  } catch {
    return UNAVAILABLE("O lançador da cerca não respondeu como esperado.");
  }
  const abi = typeof info.abi === "number" ? info.abi : 0;
  const pythonVersion = typeof info.python === "string" ? info.python : undefined;
  if (pythonVersion && !versionAtLeast(pythonVersion, FENCE_MIN_PYTHON)) return { ...UNAVAILABLE(`O Python 3 deste computador (${pythonVersion}) é mais velho que o ${FENCE_MIN_PYTHON}, que a cerca pede.`), python };
  if (status !== 0 || info.available !== true || abi < 1) return { ...UNAVAILABLE("Este computador não tem Landlock ligado (kernel mais velho que o 5.13 ou o módulo desligado em /sys/kernel/security/lsm)."), python, ...(pythonVersion ? { pythonVersion } : {}) };
  return { available: true, abi, python, ...(pythonVersion ? { pythonVersion } : {}) };
}

let cached: FenceSupport | undefined;

/** Pergunta ao lançador (uma vez por processo; o resultado não muda sem reiniciar o servidor). `CYNO_FENCE=off` força "sem cerca" (testes e quem quiser desligar de vez). */
export function detectFence(options: { refresh?: boolean; platform?: NodeJS.Platform } = {}): FenceSupport {
  if (cached && !options.refresh && options.platform === undefined) return cached;
  const result = probeFence(options.platform);
  if (options.platform === undefined) cached = result;
  return result;
}

function probeFence(platform: NodeJS.Platform = process.platform): FenceSupport {
  if (isWindows(platform)) return UNAVAILABLE("Não existe no Windows: a cerca de arquivos usa o Landlock, recurso exclusivo do Linux.");
  if (process.env.CYNO_FENCE === "off") return UNAVAILABLE("A cerca foi desligada neste computador (CYNO_FENCE=off).");
  return probeLandlock(platform);
}

/** Pergunta de verdade ao kernel (pelo lançador), sem olhar `CYNO_FENCE`: os testes com os programas de verdade usam esta. */
export function probeLandlock(platform: NodeJS.Platform = process.platform): FenceSupport {
  if (isWindows(platform)) return UNAVAILABLE("Não existe no Windows: a cerca de arquivos usa o Landlock, recurso exclusivo do Linux.");
  if (platform !== "linux") return UNAVAILABLE("A cerca de arquivos usa o Landlock, que só existe no Linux.");
  const python = findPython();
  if (!python) return UNAVAILABLE(`Falta o python3 (${FENCE_MIN_PYTHON} ou mais novo), que monta a cerca.`);
  const run = spawnSync(python, [FENCE_LAUNCHER, "--check"], { encoding: "utf8", timeout: 10_000 });
  if (run.error) return UNAVAILABLE("Não consegui rodar o lançador da cerca.");
  return interpretCheck(run.stdout ?? "", run.status, python);
}

/** Só para os testes: troca o que a detecção devolve (undefined volta a detectar de verdade). */
export function setFenceSupportForTests(value: FenceSupport | undefined): void {
  cached = value;
}

/** A lista do que pode. Nada fora dela é alcançável pelo processo nem pelos filhos. */
export type FencePolicy = {
  /** Pastas ou arquivos só para leitura e execução. */
  readOnly: string[];
  /** Pastas ou arquivos para leitura e escrita. */
  readWrite: string[];
  /** Só LISTAR (os nomes, nunca o conteúdo dos arquivos): é o que o `/proc` recebe, para o Hermes enxergar PIDs sem abrir `/proc/<pid>/environ`. */
  listOnly: string[];
};

/**
 * O que qualquer programa precisa para rodar: o sistema (`/usr`, bibliotecas, o que o `/etc` tem de resolução de nomes, certificados, fuso e usuários),
 * os dispositivos de sempre e do `/proc` só o que é global (nenhum `/proc/<pid>/...`: é por ele que se chega à chave do OpenRouter no ambiente de um processo).
 * Provado com o Hermes de verdade: com isto o turno roda; o resto do `/proc` o programa pede, é recusado e ele segue sem.
 */
export const FENCE_SYSTEM_READ_ONLY = [
  "/usr",
  "/lib",
  "/lib32",
  "/lib64",
  "/bin",
  "/sbin",
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/alternatives",
  "/etc/hosts",
  "/etc/host.conf",
  "/etc/resolv.conf",
  "/run/systemd/resolve",
  "/etc/nsswitch.conf",
  "/etc/gai.conf",
  "/etc/protocols",
  "/etc/services",
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/ca-certificates.conf",
  "/etc/localtime",
  "/etc/timezone",
  "/etc/passwd",
  "/etc/group",
  "/etc/os-release",
  "/etc/mime.types",
  "/dev/urandom",
  "/dev/random",
  "/proc/meminfo",
  "/proc/cpuinfo",
  "/proc/stat",
  "/proc/version",
  "/proc/uptime",
  "/proc/loadavg",
  "/proc/filesystems",
  "/proc/sys/kernel/random/boot_id",
  "/proc/sys/vm/overcommit_memory",
];
/** Dispositivos que o programa também grava (descartar saída, terminal). */
export const FENCE_DEVICES_READ_WRITE = ["/dev/null", "/dev/zero", "/dev/full", "/dev/tty"];
/** Só listar: o `/proc` (os nomes dos PIDs; o conteúdo de `/proc/<pid>/...` continua fechado). */
export const FENCE_LIST_ONLY = ["/proc"];

/** Une as partes de uma política sem repetir caminho e sem pastas vazias. */
export function fencePolicy(parts: { readOnly?: (string | undefined)[]; readWrite?: (string | undefined)[]; listOnly?: (string | undefined)[] }): FencePolicy {
  const clean = (items: (string | undefined)[] = []) => [...new Set(items.filter((item): item is string => Boolean(item)).map((item) => path.resolve(item)))];
  return { readOnly: clean([...FENCE_SYSTEM_READ_ONLY, ...(parts.readOnly ?? [])]), readWrite: clean([...FENCE_DEVICES_READ_WRITE, ...(parts.readWrite ?? [])]), listOnly: clean([...FENCE_LIST_ONLY, ...(parts.listOnly ?? [])]) };
}

/** Pastas de trabalho com escrita (entram em `readWrite` da cerca). */
export function writableFolders(spec: { folders?: readonly { path: string; write: boolean }[] }): string[] {
  return (spec.folders ?? []).filter((folder) => folder.write).map((folder) => folder.path);
}

/** Pastas de trabalho SÓ LEITURA (entram em `readOnly` da cerca: aqui "só leitura" é trava do sistema, vale até para comandos do terminal). */
export function readOnlyFolders(spec: { folders?: readonly { path: string; write: boolean }[] }): string[] {
  return (spec.folders ?? []).filter((folder) => !folder.write).map((folder) => folder.path);
}

/** Os argumentos do lançador (sem o comando). */
export function fenceArgs(policy: FencePolicy): string[] {
  return [...policy.readOnly.flatMap((item) => ["--ro", item]), ...policy.readWrite.flatMap((item) => ["--rw", item]), ...policy.listOnly.flatMap((item) => ["--ls", item])];
}

/** O comando final: `python3 landlock-fence.py <regras> -- <comando> <args>`. */
export function fencedCommand(policy: FencePolicy, python: string, command: string, args: string[]): { command: string; args: string[] } {
  return { command: python, args: [FENCE_LAUNCHER, ...fenceArgs(policy), "--", command, ...args] };
}

/** O caminho de verdade do executável (segue os links simbólicos); o que não existe fica como veio. */
export function realPathOf(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

/** Acha o executável (caminho absoluto ou nome no PATH dado) e devolve o caminho dele e o de verdade (os dois entram na lista: o link e o alvo). */
export function resolveExecutable(command: string, pathEnv: string | undefined): string[] {
  const candidates = path.isAbsolute(command) || command.includes("/") ? [command] : (pathEnv ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command));
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ? [...new Set([found, realPathOf(found)])] : [];
}

/** A pasta `node_modules` que contém o arquivo (a instalação global de um programa de Node); undefined se não há. */
export function enclosingNodeModules(file: string): string | undefined {
  let dir = path.dirname(realPathOf(file));
  for (let i = 0; i < 12; i += 1) {
    if (path.basename(dir) === "node_modules") return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

const isDir = (target: string) => {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
};

/**
 * O que o Hermes grava dentro da instalação dele (e que, por ser compartilhada entre os agentes, não vai inteira para leitura e escrita):
 * os arquivos de trava (`.install.lock`), as pastas `.leases` (um arquivo por execução, dizendo "este ambiente está em uso") e a `pm-runtime` (~3 MB do
 * gerenciador de pacotes do programa: o primeiro turno de cada HERMES_HOME novo monta uma geração nova ali, provado; o código `hermes-agent` e o ambiente
 * Python `venv` NÃO entram).
 * Achados na pasta `installs` (procura rasa, só o que existe).
 */
export function hermesInstallWritables(installs: string): { files: string[]; dirs: string[] } {
  const files: string[] = [];
  const dirs: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 5) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && (entry.name === ".leases" || entry.name === "pm-runtime")) dirs.push(full);
      else if (entry.isFile() && /^\.[\w-]*\.lock$/.test(entry.name)) files.push(full);
      else if (entry.isDirectory() && !["venv", "workspace", "node_modules", "site-packages"].includes(entry.name)) walk(full, depth + 1);
    }
  };
  if (isDir(installs)) walk(realPathOf(installs), 0);
  return { files, dirs };
}
