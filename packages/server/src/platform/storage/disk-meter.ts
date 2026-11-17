import { opendir, lstat } from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { StorageState } from "@cyno/shared";

/** O que a medição de uma pasta devolve: bytes em disco, arquivos e os bytes de cada entrada de primeiro nível. */
export type DiskMeasure = { bytes: number; files: number; byTop: Record<string, number> };

/** O que o medidor sabe de uma pasta agora (números da última medição pronta, mesmo enquanto recalcula). */
export type DiskSnapshot = DiskMeasure & { state: StorageState; computedAt: number | null };

export type DiskMeterOptions = {
  /** Validade de uma medição pronta (padrão 10 minutos). */
  ttlMs?: number;
  /** Quantas pastas medem ao mesmo tempo (padrão 2). */
  concurrency?: number;
  /** A cada quantos arquivos o laço cede a vez ao servidor (padrão 200). */
  yieldEvery?: number;
  now?: () => number;
};

const EMPTY: DiskMeasure = { bytes: 0, files: 0, byTop: {} };

/** `failedAt`: quando a última medição falhou (null = não falhou); o erro fica visível um tempo antes de tentar de novo. */
type Entry = { last: (DiskMeasure & { computedAt: number }) | null; failedAt: number | null; running: Promise<void> | null };

/** Depois de um erro, só tenta de novo a partir deste prazo (senão cada consulta da tela reiniciaria a medição). */
export const ERROR_RETRY_MS = 30_000;

/** Espaço real em disco de um arquivo: blocos de 512 bytes quando o sistema informa, senão o tamanho lógico. */
export function sizeOnDisk(info: { size: number; blocks?: number }): number {
  return typeof info.blocks === "number" && info.blocks > 0 ? info.blocks * 512 : info.size;
}

/**
 * Soma o tamanho de uma pasta percorrendo-a sem travar o servidor: `opendir`/`lstat` assíncronos, sem seguir
 * links simbólicos, cedendo o laço de eventos de tempos em tempos e ignorando o que não pode ser lido ou some no meio.
 * Só falha se a própria pasta raiz não abrir.
 */
export async function measureTree(root: string, yieldEvery = 200): Promise<DiskMeasure> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) return { bytes: sizeOnDisk(rootInfo), files: 1, byTop: {} };
  const byTop: Record<string, number> = {};
  const seenLinks = new Set<string>();
  let bytes = 0;
  let files = 0;
  let sinceYield = 0;
  const stack: { dir: string; top: string | null }[] = [{ dir: root, top: null }];
  let first = true;
  while (stack.length > 0) {
    const { dir, top } = stack.pop()!;
    let handle;
    try {
      handle = await opendir(dir);
    } catch (error) {
      if (first) throw error;
      continue;
    } finally {
      first = false;
    }
    try {
      for await (const entry of handle) {
        const full = path.join(dir, entry.name);
        const owner = top ?? entry.name;
        let info;
        try {
          info = await lstat(full);
        } catch {
          continue;
        }
        if (++sinceYield >= yieldEvery) {
          sinceYield = 0;
          await yieldTurn();
        }
        // Arquivo com vários links duros só conta uma vez (como o du).
        if (!info.isDirectory() && info.nlink > 1) {
          const key = `${info.dev}:${info.ino}`;
          if (seenLinks.has(key)) continue;
          seenLinks.add(key);
        }
        const own = sizeOnDisk(info);
        bytes += own;
        byTop[owner] = (byTop[owner] ?? 0) + own;
        if (info.isDirectory()) stack.push({ dir: full, top: owner });
        else files += 1;
      }
    } catch {
      // pasta que parou de ser legível no meio: fica o que já foi somado
    }
  }
  return { bytes, files, byTop };
}

/**
 * Medidor de pastas com cache em memória por caminho. Nunca mede sozinho: só quando alguém pede (`get`/`refresh`).
 * Uma medição por caminho de cada vez (pedidos repetidos reaproveitam a em andamento) e no máximo `concurrency`
 * pastas medindo ao mesmo tempo; as demais esperam na fila.
 */
export class DiskMeter {
  private readonly entries = new Map<string, Entry>();
  private readonly queue: (() => void)[] = [];
  private active = 0;
  private readonly ttlMs: number;
  private readonly concurrency: number;
  private readonly yieldEvery: number;
  private readonly now: () => number;

  constructor(options: DiskMeterOptions = {}, private readonly measure: (dir: string, yieldEvery: number) => Promise<DiskMeasure> = measureTree) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.yieldEvery = options.yieldEvery ?? 200;
    this.now = options.now ?? Date.now;
  }

  /** Responde na hora com o que tem e começa a medir se faltar ou tiver vencido. */
  get(dir: string): DiskSnapshot {
    const entry = this.entries.get(dir);
    if (!entry || (!entry.running && this.expired(entry))) this.start(dir);
    return this.snapshot(dir);
  }

  /** Recalcula (se já houver uma medição rodando, reaproveita) e devolve quando terminar. */
  refresh(dir: string): Promise<DiskSnapshot> {
    return this.start(dir).then(() => this.snapshot(dir));
  }

  /** Espera a medição em andamento (ou nenhuma). Útil em testes. */
  async settled(dir: string): Promise<DiskSnapshot> {
    await this.entries.get(dir)?.running;
    return this.snapshot(dir);
  }

  private expired(entry: Entry): boolean {
    if (entry.failedAt !== null) return this.now() - entry.failedAt > Math.min(ERROR_RETRY_MS, this.ttlMs);
    return !entry.last || this.now() - entry.last.computedAt > this.ttlMs;
  }

  private snapshot(dir: string): DiskSnapshot {
    const entry = this.entries.get(dir);
    const last = entry?.last;
    const base = last ?? EMPTY;
    const state: StorageState = entry?.running ? "computing" : entry?.failedAt != null ? "error" : last ? "ready" : "computing";
    return { bytes: base.bytes, files: base.files, byTop: base.byTop, state, computedAt: last?.computedAt ?? null };
  }

  private start(dir: string): Promise<void> {
    let entry = this.entries.get(dir);
    if (!entry) this.entries.set(dir, (entry = { last: null, failedAt: null, running: null }));
    if (entry.running) return entry.running;
    const target = entry;
    target.running = this.slot()
      .then(async (release) => {
        try {
          const result = await this.measure(dir, this.yieldEvery);
          target.last = { ...result, computedAt: this.now() };
          target.failedAt = null;
        } catch {
          target.failedAt = this.now();
        } finally {
          release();
        }
      })
      .finally(() => {
        target.running = null;
      });
    return target.running;
  }

  private slot(): Promise<() => void> {
    const release = () => {
      this.active -= 1;
      this.queue.shift()?.();
    };
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve(release);
    }
    return new Promise((resolve) =>
      this.queue.push(() => {
        this.active += 1;
        resolve(release);
      }),
    );
  }
}
