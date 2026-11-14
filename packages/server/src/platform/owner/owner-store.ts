import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { AWAY_MIN_MS, ownerFileSchema, type OwnerFile } from "@cyno/shared";
import { writeJsonAtomic } from "../../store/atomic-write";
import { WriteQueue } from "../../store/write-queue";

/** A presença só é regravada em disco se passou isto (ou se a ausência mudou): um aviso por minuto não precisa de uma escrita por minuto. */
const PERSIST_EVERY_MS = 20_000;

export type OwnerEpisode = NonNullable<OwnerFile["episode"]>;

/**
 * A presença do dono (`data/platform/owner.json`), uma só para todos os navegadores: "a última vez em
 * que ele esteve com o app aberto e ativo" e a ausência (o "enquanto você estava fora"). Nada invasivo:
 * só o instante da última presença, mandado pelo navegador com a aba visível e entrada recente.
 *
 * Uma ausência começa quando chega uma presença 30 minutos ou mais depois da anterior: guarda de
 * quando (`since`) a quando (`returnedAt`) e fica pendente até o "Ok, vi" (`seenAt`, vale para todos os
 * navegadores). A primeira presença da instalação não abre ausência nenhuma. Uma ausência nova com a
 * anterior ainda não confirmada junta as duas (o resumo cobre desde a mais antiga).
 */
export class OwnerStore {
  private readonly queue = new WriteQueue();
  private persistedAt = 0;

  private constructor(
    private readonly file: string | undefined,
    private state: OwnerFile,
  ) {}

  static async load(file: string): Promise<OwnerStore> {
    try {
      const parsed = ownerFileSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
      if (parsed.success) return new OwnerStore(file, parsed.data);
    } catch {
      // Sem arquivo (ou quebrado): primeira vez, sem ausência.
    }
    return new OwnerStore(file, {});
  }

  /** Só em memória (testes). */
  static inMemory(state: OwnerFile = {}): OwnerStore {
    return new OwnerStore(undefined, state);
  }

  lastActiveAt(): string | undefined {
    return this.state.lastActiveAt;
  }

  /** O dono mandou a presença há menos que `ms`? (o navegador só a manda com o site aberto, visível e com entrada recente) */
  activeWithin(nowMs: number, ms: number): boolean {
    const last = this.state.lastActiveAt ? Date.parse(this.state.lastActiveAt) : Number.NaN;
    return Number.isFinite(last) && nowMs - last >= 0 && nowMs - last < ms;
  }

  /** A ausência em andamento ou a última (confirmada ou não). */
  episode(): OwnerEpisode | undefined {
    return this.state.episode ? { ...this.state.episode } : undefined;
  }

  /** Há ausência que o dono ainda não confirmou. */
  pending(): OwnerEpisode | undefined {
    const episode = this.state.episode;
    return episode && !episode.seenAt ? { ...episode } : undefined;
  }

  /** O dono está aqui (agora). Devolve se há ausência pendente. */
  presence(nowMs: number): boolean {
    const last = this.state.lastActiveAt ? Date.parse(this.state.lastActiveAt) : Number.NaN;
    let changed = false;
    if (Number.isFinite(last) && nowMs - last >= AWAY_MIN_MS) {
      const open = this.pending();
      this.state.episode = { since: open?.since ?? new Date(last).toISOString(), returnedAt: new Date(nowMs).toISOString() };
      changed = true;
    }
    this.state.lastActiveAt = new Date(nowMs).toISOString();
    if (changed || nowMs - this.persistedAt >= PERSIST_EVERY_MS || nowMs < this.persistedAt) this.persist(nowMs);
    return this.pending() !== undefined;
  }

  /** "Ok, vi": vale para todos os navegadores. Sem ausência pendente, não faz nada. */
  markSeen(nowMs: number): boolean {
    const episode = this.state.episode;
    if (!episode || episode.seenAt) return false;
    episode.seenAt = new Date(nowMs).toISOString();
    this.persist(nowMs);
    return true;
  }

  flush(): Promise<void> {
    return this.queue.idle();
  }

  private persist(nowMs: number): void {
    this.persistedAt = nowMs;
    const file = this.file;
    if (!file) return;
    const data = structuredClone(this.state);
    void this.queue
      .enqueue(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        await writeJsonAtomic(file, data);
      })
      .catch(() => undefined);
  }
}
