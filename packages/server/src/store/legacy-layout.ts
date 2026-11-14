import { access, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "@cyno/shared";
import { dataPaths, rootPaths } from "./paths";
import { writeWorkspaceList } from "./workspace-registry";

/** Destino da migração: o workspace que recebe os dados do layout antigo. */
export const LEGACY_WORKSPACE = { id: "principal", name: "Principal" } as const;

/** O que o layout antigo guardava na raiz de DATA_DIR (office.json por último: é ele que marca a pasta como pronta). */
const LEGACY_ENTRIES = ["tasks.json", "brains", "office.json"] as const;

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Migração do layout antigo (um escritório só, direto em DATA_DIR) para workspaces:
 * se existe data/office.json e ainda não existe data/workspaces.json, move office.json,
 * tasks.json e brains/ para data/workspaces/principal/ e cria workspaces.json com
 * { id: "principal", name: "Principal" }.
 *
 * - Não apaga nem copia nada: só renomeia (atômico no mesmo disco).
 * - Idempotente e retomável: rodar de novo depois de terminar não faz nada; se o processo
 *   cair no meio, a próxima execução termina o que faltou (workspaces.json é gravado por último).
 * - Se um mesmo item existir nos dois lugares, para com erro em vez de sobrescrever.
 * O formato de dentro do office.json/tasks.json (chave `workspaces` -> `rooms` etc.) é migrado
 * depois, ao abrir o workspace (veja store/migrations.ts).
 */
export async function migrateLegacyLayout(
  dataDir: string,
  { now = () => new Date() }: { now?: () => Date } = {},
): Promise<{ migrated: boolean }> {
  const root = rootPaths(dataDir);
  if (await exists(root.workspacesFile)) return { migrated: false };

  const target = dataPaths(root.workspaceDir(LEGACY_WORKSPACE.id));
  const hasLegacy = await exists(path.join(dataDir, "office.json"));
  // Sem layout antigo e sem uma migração pela metade: nada a fazer (o seed cuida de pastas novas).
  if (!hasLegacy && !(await exists(target.officeFile))) return { migrated: false };

  await mkdir(target.root, { recursive: true });
  for (const entry of LEGACY_ENTRIES) {
    const from = path.join(dataDir, entry);
    const to = path.join(target.root, entry);
    if (!(await exists(from))) continue;
    if (await exists(to)) {
      throw new Error(
        `Migração para workspaces interrompida: ${entry} existe em ${dataDir} e em ${target.root}. ` +
          "Confira os dois e remova o que sobrar antes de reiniciar.",
      );
    }
    await rename(from, to);
  }

  const workspace: Workspace = { ...LEGACY_WORKSPACE, createdAt: now().toISOString() };
  await writeWorkspaceList(root.workspacesFile, [workspace]);
  return { migrated: true };
}
