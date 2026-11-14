import { readFile } from "node:fs/promises";
import { cleanModelDefaults, cloneModelDefaults, modelDefaultsSchema, type ModelDefaults } from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { writeJsonAtomic } from "../../store/atomic-write";
import { WriteQueue } from "../../store/write-queue";

/**
 * Modelos padrão GLOBAIS (Configurações › Geral › Modelos padrão), em DATA_DIR/models.json: só preenchem os padrões
 * de cada workspace novo (veja models.ts no shared). Sem arquivo (ou inválido) = os iniciais.
 */
export class ModelDefaultsStore {
  private readonly queue = new WriteQueue();

  private constructor(
    private readonly file: string | undefined,
    private current: ModelDefaults,
  ) {}

  /** Lê DATA_DIR/models.json (ausente ou inválido = `initial`). */
  static async load(file: string, initial: ModelDefaults, log?: Pick<FastifyBaseLogger, "warn">): Promise<ModelDefaultsStore> {
    let defaults = cloneModelDefaults(initial);
    try {
      const parsed = modelDefaultsSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
      if (parsed.success) defaults = parsed.data;
      else log?.warn({ file }, "models.json inválido: usando os padrões iniciais");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log?.warn({ err: error }, "models.json ilegível: usando os padrões iniciais");
    }
    return new ModelDefaultsStore(file, defaults);
  }

  /** Só em memória (testes). */
  static inMemory(initial: ModelDefaults): ModelDefaultsStore {
    return new ModelDefaultsStore(undefined, cloneModelDefaults(initial));
  }

  get(): ModelDefaults {
    return cloneModelDefaults(this.current);
  }

  /** Troca os padrões globais (não mexe em nenhum workspace existente). */
  async set(defaults: ModelDefaults): Promise<ModelDefaults> {
    // O esforço que não vale para o motor e o modelo (ex.: Gemini, em que o nível vai no nome) não é guardado.
    this.current = cleanModelDefaults(cloneModelDefaults(defaults));
    const data = this.get();
    const file = this.file;
    if (file) await this.queue.enqueue(() => writeJsonAtomic(file, data));
    return this.get();
  }

  flush(): Promise<void> {
    return this.queue.idle();
  }
}
