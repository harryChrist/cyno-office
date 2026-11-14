import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Escrita atômica: grava num arquivo temporário na mesma pasta, faz fsync e
 * renomeia por cima do destino. Quem lê nunca vê um arquivo pela metade.
 */
export async function writeFileAtomic(file: string, content: string, mode?: number): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    // `mode`: permissões do arquivo novo (ex.: 0o600 para arquivos com segredos).
    const handle = await open(tmp, "w", mode);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export function writeJsonAtomic(file: string, data: unknown, mode?: number): Promise<void> {
  return writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, mode);
}
