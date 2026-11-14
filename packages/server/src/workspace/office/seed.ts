import { access, rm } from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "@cyno/shared";
import type { OfficeStructure } from "../../store/files";
import { LEGACY_WORKSPACE, migrateLegacyLayout } from "../../store/legacy-layout";
import { dataPaths, rootPaths } from "../../store/paths";
import { writeWorkspaceList } from "../../store/workspace-registry";
import { SEED_AGENTS, SEED_TEAMS, SEED_ROOMS } from "./seed-data/office";
import { SEED_BRAIN_NOTES } from "./seed-data/notes";
import { writeWorkspaceData } from "../../platform/workspaces/init";
import { ensureMaestro } from "./maestro";

/** Workspace criado pelo seed (e o destino da migração do layout antigo). */
export const SEED_WORKSPACE = LEGACY_WORKSPACE;

/** Escritório do seed: os quartos de exemplo e a Sala do Maestro (com a Gerência e o Maestro). */
export function buildSeedOffice(): OfficeStructure {
  return ensureMaestro({ office: { rooms: SEED_ROOMS, teams: SEED_TEAMS, agents: SEED_AGENTS } }).office;
}

export async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cria os dados iniciais em `dataDir` se workspaces.json ainda não existir: o workspace
 * "Principal" (data/workspaces/principal/) com o escritório e as notas de exemplo.
 * Com `force`, apaga workspaces.json e workspaces/ (e o layout antigo, se sobrou) e recria tudo.
 */
export async function seedDataDir(
  dataDir: string,
  { force = false, now = () => new Date() }: { force?: boolean; now?: () => Date } = {},
): Promise<{ created: boolean }> {
  const paths = rootPaths(dataDir);
  // Nunca semeia por cima do layout antigo: ele vira o workspace "Principal" primeiro.
  if (!force) await migrateLegacyLayout(dataDir, { now });
  if (!force && (await exists(paths.workspacesFile))) return { created: false };

  if (force) {
    await rm(paths.workspacesFile, { force: true });
    await rm(paths.workspacesDir, { recursive: true, force: true });
    for (const legacy of ["office.json", "tasks.json", "brains"]) {
      await rm(path.join(dataDir, legacy), { recursive: true, force: true });
    }
  }
  const dir = paths.workspaceDir(SEED_WORKSPACE.id);
  // Pasta do Principal já pronta sem o registro (ex.: queda no meio da migração): só registra.
  if (force || !(await exists(dataPaths(dir).officeFile))) {
    await writeWorkspaceData(dir, buildSeedOffice(), SEED_BRAIN_NOTES, { overwrite: force });
  }
  const workspace: Workspace = { ...SEED_WORKSPACE, createdAt: now().toISOString() };
  // workspaces.json por último: se algo falhar antes, o próximo boot refaz o seed.
  await writeWorkspaceList(paths.workspacesFile, [workspace]);
  return { created: true };
}
