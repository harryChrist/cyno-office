import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../../store/atomic-write";

/**
 * Escolhas do dono que valem para a plataforma inteira e que sobrepõem o `.env`
 * (`data/platform/settings/connectors.json`). Hoje: os conectores locais (stdio) ligados ou desligados.
 * Sem escolha, vale o que o `.env` diz (`CONNECTORS_STDIO`).
 */
const fileSchema = z.object({ stdioEnabled: z.boolean().optional() });

export class PlatformSettings {
  private stdio: boolean | undefined;

  private constructor(private readonly file: string) {}

  static async open(dataDir: string): Promise<PlatformSettings> {
    const settings = new PlatformSettings(path.join(dataDir, "platform", "settings", "connectors.json"));
    try {
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(settings.file, "utf8")));
      if (parsed.success) settings.stdio = parsed.data.stdioEnabled;
    } catch {
      // Sem arquivo (ou quebrado): vale o `.env`.
    }
    return settings;
  }

  /** O que o dono escolheu (undefined = nada: vale o `.env`). */
  stdioChoice(): boolean | undefined {
    return this.stdio;
  }

  async setStdio(enabled: boolean | undefined): Promise<void> {
    this.stdio = enabled;
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeJsonAtomic(this.file, enabled === undefined ? {} : { stdioEnabled: enabled });
  }
}
