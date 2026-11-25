import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { userHomeDir } from "../../platform/os";

/**
 * O que o Cyno LÊ da pasta de dados do Freebuff (`~/.config/manicode`): os arquivos de chat, o arquivo
 * da sessão viva e o `settings.json`. Nunca lê credenciais nem chave do dispositivo, e nunca grava.
 */

/** A pasta de dados do Freebuff (`FREEBUFF_HOME` só nos testes). */
export function manicodeDirOf(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return env.FREEBUFF_HOME?.trim() || path.join(userHomeDir(env, platform), ".config", "manicode");
}

const slug = (text: string, max: number) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);

/**
 * Nome da pasta de trabalho de um agente no Freebuff. O Freebuff guarda os chats por ÚLTIMO trecho do
 * caminho (duas pastas com o mesmo nome colidem), e as pastas dos agentes ficam em `.../agents/<id>`:
 * o mesmo id pode existir em dois workspaces. Por isso o nome leva o workspace, o agente e um resumo
 * dos dois ids inteiros: nunca colide, mesmo com ids que só diferem depois do corte.
 */
export function freebuffFolderName(workspaceId: string, agentId: string): string {
  const hash = createHash("sha256").update(`${workspaceId}\n${agentId}`).digest("hex").slice(0, 6);
  return `fb-${slug(workspaceId, 14) || "ws"}-${slug(agentId, 18) || "agent"}-${hash}`;
}

/** A pasta dos chats desta pasta de trabalho no Freebuff. */
export function chatsDirOf(manicodeDir: string, folderName: string): string {
  return path.join(manicodeDir, "projects", folderName, "chats");
}

/** Os chats da pasta (nome = data, então a ordem de nome é a ordem de criação), do mais antigo ao mais novo. */
export async function listChats(manicodeDir: string, folderName: string): Promise<string[]> {
  try {
    const names = await readdir(chatsDirOf(manicodeDir, folderName));
    return names.filter((name) => /^[0-9A-Za-z._-]+$/.test(name)).sort();
  } catch {
    return [];
  }
}

export type LiveSession = { pid: number; expiresAt: number; instanceId?: string };

/**
 * O arquivo da sessão viva (`freebuff-live-<pid>.json`): existe enquanto há processo com hora aberta e
 * diz o fim real da hora (`expiresAt`, em ms). `pids`: os processos do terminal (o lançador e os filhos);
 * só vale o arquivo de um deles. Sem arquivo, o Cyno usa o relógio (abertura + 60 min).
 */
export async function findLiveSession(manicodeDir: string, pids: readonly number[]): Promise<LiveSession | undefined> {
  let names: string[];
  try {
    names = await readdir(manicodeDir);
  } catch {
    return undefined;
  }
  let best: LiveSession | undefined;
  for (const name of names) {
    if (!/^freebuff-live-\d+\.json$/.test(name)) continue;
    try {
      const data = JSON.parse(await readFile(path.join(manicodeDir, name), "utf8")) as { ownerPid?: unknown; expiresAt?: unknown; instanceId?: unknown };
      const pid = typeof data.ownerPid === "number" ? data.ownerPid : Number(/\d+/.exec(name)?.[0]);
      if (!pids.includes(pid) || typeof data.expiresAt !== "number" || !Number.isFinite(data.expiresAt)) continue;
      if (!best || data.expiresAt > best.expiresAt) best = { pid, expiresAt: data.expiresAt, ...(typeof data.instanceId === "string" ? { instanceId: data.instanceId } : {}) };
    } catch {
      // arquivo sendo gravado ou apagado: tenta na próxima leitura
    }
  }
  return best;
}

/** O processo e os descendentes dele (Linux: /proc). Sem /proc, só o próprio. */
export async function processTree(root: number): Promise<number[]> {
  const found = new Set<number>([root]);
  try {
    const entries = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
    const parents = new Map<number, number>();
    await Promise.all(
      entries.map(async (name) => {
        try {
          const text = await readFile(`/proc/${name}/stat`, "utf8");
          // "pid (comm) S ppid ...": o comando pode ter espaços e parênteses
          const rest = text.slice(text.lastIndexOf(")") + 2).split(" ");
          const ppid = Number(rest[1]);
          if (Number.isFinite(ppid)) parents.set(Number(name), ppid);
        } catch {
          // processo que sumiu no meio
        }
      }),
    );
    let grew = true;
    while (grew) {
      grew = false;
      for (const [pid, ppid] of parents) {
        if (found.has(ppid) && !found.has(pid)) {
          found.add(pid);
          grew = true;
        }
      }
    }
  } catch {
    // sem /proc
  }
  return [...found];
}

/** O modelo e o esforço que o Freebuff tem salvos (`settings.json`); só leitura. */
export async function readSavedModelKey(manicodeDir: string): Promise<string | undefined> {
  try {
    const data = JSON.parse(await readFile(path.join(manicodeDir, "settings.json"), "utf8")) as { freebuffModelKey?: unknown };
    return typeof data.freebuffModelKey === "string" ? data.freebuffModelKey : undefined;
  } catch {
    return undefined;
  }
}

export async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}
