import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { hermesAgentHomeOf, stopGateway } from "./hermes-adapter";
import { openclawAgentConfigPath, openclawAgentTmpOf } from "./openclaw-adapter";

/**
 * As pastas de motor por agente (revisão 2, M4): `hermes/agent-homes/<hash>` (config.yaml com o token do MCP, a cópia da configuração-base,
 * o banco de sessões e os registros do Hermes) e `openclaw/agent-configs/<hash>` (o openclaw.json com o token). Nenhuma era apagada.
 * Cada uma leva um marcador `.cyno-cwd` com a pasta de trabalho do agente, que é o que liga a pasta de motor ao agente.
 */
export const CWD_MARKER = ".cyno-cwd";

/** Apaga as pastas de motor DESTE agente (o gateway do Hermes sai antes). O token que estava nelas deixa de existir em disco. */
export async function removeAgentEngineData(roots: { hermes?: string | undefined; openclaw?: string | undefined }, cwd: string): Promise<void> {
  if (roots.hermes) {
    const home = hermesAgentHomeOf(roots.hermes, cwd);
    await stopGateway(home).catch(() => undefined);
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
  if (roots.openclaw) {
    await rm(path.dirname(openclawAgentConfigPath(roots.openclaw, cwd)), { recursive: true, force: true }).catch(() => undefined);
    // O temporário do agente (só existe com a cerca de arquivos).
    await rm(openclawAgentTmpOf(roots.openclaw, cwd), { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Varredura (no início do servidor): pasta de motor cuja pasta de trabalho do agente não existe mais (agente, sala, time ou workspace
 * removidos, inclusive quando o servidor estava fora) é apagada. Sem marcador, não se mexe (não é nossa ou é de uma versão antiga).
 * Devolve o que apagou.
 */
export async function sweepEngineHomes(roots: { hermes?: string | undefined; openclaw?: string | undefined }): Promise<string[]> {
  const removed: string[] = [];
  const folders = [roots.hermes ? path.join(roots.hermes, "agent-homes") : undefined, roots.openclaw ? path.join(roots.openclaw, "agent-configs") : undefined];
  for (const folder of folders) {
    if (!folder) continue;
    const names = await readdir(folder, { withFileTypes: true }).then(
      (entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      () => undefined,
    );
    if (!names) continue;
    for (const name of names) {
      const dir = path.join(folder, name);
      const cwd = await readFile(path.join(dir, CWD_MARKER), "utf8").then(
        (text) => text.trim(),
        () => undefined,
      );
      if (!cwd || !path.isAbsolute(cwd) || existsSync(cwd)) continue;
      if (folder.endsWith("agent-homes")) await stopGateway(dir).catch(() => undefined);
      else if (roots.openclaw) await rm(path.join(roots.openclaw, "tmp", name), { recursive: true, force: true }).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      removed.push(dir);
    }
  }
  return removed;
}
