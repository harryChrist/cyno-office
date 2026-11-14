import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AVULSAS_ID, emptyAvulsas, GLOBAL_BRAIN_ID } from "@cyno/shared";
import { writeJsonAtomic } from "../../store/atomic-write";
import { toOfficeFile, type OfficeStructure } from "../../store/files";
import { SPRINTS_DATA_VERSION } from "../../store/migrate-sprints";
import { dataPaths } from "../../store/paths";

/** Notas iniciais do lobby (Cérebro global) de um workspace novo. */
export function welcomeNotes(workspaceName: string): Record<string, string> {
  return {
    "sobre-o-workspace.md": `# Sobre o workspace ${workspaceName}

Cérebro global do workspace ${workspaceName}. Tudo o que estiver aqui vale para as salas
com porta para o lobby (e só deste workspace).

- Objetivo:
- Público:
- Tom e preferências:
`,
  };
}

/** Grava as notas sem sobrescrever as que já existem. */
export async function writeNotes(dir: string, notes: Record<string, string>, overwrite = false): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [fileName, content] of Object.entries(notes)) {
    try {
      await writeFile(path.join(dir, fileName), content, { flag: overwrite ? "w" : "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/**
 * Cria a pasta de dados de um workspace: Cérebros (`brains`: { idDoCérebro: notas }),
 * o projeto fixo "Avulsas" (`projects/avulsas.json`), schema.json (layout atual, sem nada a migrar) e office.json por último (se algo falhar antes, a pasta não conta como pronta).
 */
export async function writeWorkspaceData(
  dir: string,
  office: OfficeStructure,
  brains: Record<string, Record<string, string>>,
  { overwrite = false }: { overwrite?: boolean } = {},
): Promise<void> {
  const paths = dataPaths(dir);
  await mkdir(dir, { recursive: true });
  await mkdir(paths.brainDir(GLOBAL_BRAIN_ID), { recursive: true });
  for (const [brainId, notes] of Object.entries(brains)) await writeNotes(paths.brainDir(brainId), notes, overwrite);
  await mkdir(paths.projectsDir, { recursive: true });
  // Só cria se faltar (reescrever com `overwrite` não apaga as tarefas avulsas que já existem).
  await writeFile(path.join(paths.projectsDir, `${AVULSAS_ID}.json`), `${JSON.stringify(emptyAvulsas(new Date().toISOString()), null, 2)}\n`, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await writeJsonAtomic(paths.schemaFile, { dataVersion: SPRINTS_DATA_VERSION });
  await writeJsonAtomic(paths.officeFile, toOfficeFile(office));
}

/** Escritório de um workspace novo: só o lobby (que não é um quarto), sem quartos nem agentes. */
export function emptyOffice(): OfficeStructure {
  return { rooms: [], teams: [], agents: [] };
}
