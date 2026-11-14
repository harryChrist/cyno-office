import { readFile } from "node:fs/promises";
import type { OpenRouterKeyInfo } from "@cyno/shared";
import { writeJsonAtomic } from "../../store/atomic-write";

/**
 * A chave do OpenRouter do dono (uma só, usada pelo OpenClaw e pelo Hermes). Fica em
 * DATA_DIR/platform/openrouter-key.json com modo 600, gravada de forma atômica. NENHUMA rota devolve a chave: a
 * tela só vê `info()` (configurada, os 4 últimos caracteres e quando foi guardada). O valor sai daqui por `get()`
 * e vai por variável de ambiente só aos processos do OpenClaw e do Hermes (e à consulta da própria chave no OpenRouter).
 */
export class OpenRouterKeyStore {
  private constructor(
    private readonly file: string | undefined,
    private data: { key: string; savedAt: string } | undefined,
  ) {}

  static async open(file: string): Promise<OpenRouterKeyStore> {
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as { key?: unknown; savedAt?: unknown };
      if (typeof raw.key === "string" && raw.key && typeof raw.savedAt === "string") return new OpenRouterKeyStore(file, { key: raw.key, savedAt: raw.savedAt });
    } catch {
      // sem arquivo (ou quebrado): sem chave
    }
    return new OpenRouterKeyStore(file, undefined);
  }

  static inMemory(key?: string, savedAt = new Date(0).toISOString()): OpenRouterKeyStore {
    return new OpenRouterKeyStore(undefined, key ? { key, savedAt } : undefined);
  }

  /** O valor da chave (só para quem monta o ambiente dos dois processos). */
  get(): string | undefined {
    return this.data?.key;
  }

  info(): OpenRouterKeyInfo {
    return this.data ? { configured: true, last4: this.data.key.slice(-4), savedAt: this.data.savedAt } : { configured: false };
  }

  async set(key: string, now: Date): Promise<void> {
    this.data = { key, savedAt: now.toISOString() };
    await this.save();
  }

  async remove(): Promise<void> {
    this.data = undefined;
    await this.save();
  }

  private async save(): Promise<void> {
    if (!this.file) return;
    await writeJsonAtomic(this.file, this.data ?? {}, 0o600);
  }
}
