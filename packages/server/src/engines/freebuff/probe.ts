import { mkdir } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../../util/text";
import type { PtyProcess, PtySpawnFn } from "../terminals/pty-terminal";
import { readModelList, waitScreen, type ModelListReading, type PickerOptions, type TuiDriver } from "./model-select";
import { ScreenBuffer } from "./screen";
import { isReadyScreen, isSettledScreen, parseHours } from "./screen-reader";
import { FREEBUFF_PTY_SIZE } from "./terminal";

/**
 * Sondagem do Freebuff: abre um processo numa pasta temporária (nome fixo, para não encher a pasta de
 * chats dele), digita `/model`, lê a lista (nome, multiplicador, esforços) e o saldo de horas do rodapé
 * e fecha SEM mandar mensagem: abrir e olhar não abre hora nem gasta nada (medido em 12/11). É a única
 * forma de ler o catálogo (ele muda toda semana e vem do servidor da Codebuff, só com login).
 */

export const PROBE_FOLDER = "cyno-probe";

export type ProbeOptions = {
  command: string;
  prefixArgs?: string[];
  /** Pasta onde criar a pasta de sondagem (ex.: DATA_DIR/platform/freebuff). */
  workDir: string;
  env: NodeJS.ProcessEnv;
  spawn?: PtySpawnFn;
  /** Lê também os níveis de esforço de cada modelo (mais lento: uma Tab por modelo). Padrão: sim. */
  efforts?: boolean;
  /** Espera máxima pela caixa de pedido ao subir. Padrão 60 s. */
  readyTimeoutMs?: number;
  settleMs?: number;
  waitMs?: number;
  settleCatalogMs?: number;
};

export type ProbeResult = { ok: true; reading: ModelListReading } | { ok: false; error: string };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function probeFreebuffModels(options: ProbeOptions): Promise<ProbeResult> {
  const cwd = path.join(options.workDir, PROBE_FOLDER);
  let pty: PtyProcess | undefined;
  try {
    await mkdir(cwd, { recursive: true });
    const spawn = options.spawn ?? (await loadNodePty());
    const screen = new ScreenBuffer(FREEBUFF_PTY_SIZE.cols, FREEBUFF_PTY_SIZE.rows);
    let alive = true;
    const process_ = spawn(options.command, [...(options.prefixArgs ?? []), "--trust-agents"], { cwd, env: options.env, cols: FREEBUFF_PTY_SIZE.cols, rows: FREEBUFF_PTY_SIZE.rows, name: "xterm-256color" });
    pty = process_;
    process_.onData((data) => {
      for (const reply of screen.write(data)) {
        try {
          process_.write(reply);
        } catch {
          // saiu no meio
        }
      }
    });
    process_.onExit(() => {
      alive = false;
    });
    const driver: TuiDriver = { text: () => screen.text(), write: (keys) => process_.write(keys), sleep, alive: () => alive };
    const ready = await waitScreen(driver, isReadyScreen, options.readyTimeoutMs ?? 60_000);
    if (!ready) return { ok: false, error: alive ? "A tela do Freebuff não mostrou a caixa de pedido a tempo (login pendente?)." : "O Freebuff saiu ao abrir." };
    // A caixa aparece antes de o catálogo carregar: espera o banner de horas (até 10 s) para o `/model` abrir com a lista de verdade.
    const settled = (await waitScreen(driver, isSettledScreen, options.settleCatalogMs ?? 10_000)) ?? ready;
    const hoursOnOpen = parseHours(settled);
    const picker: PickerOptions & { efforts: boolean } = { efforts: options.efforts !== false, settleMs: options.settleMs ?? 300, ...(options.waitMs ? { waitMs: options.waitMs } : {}) };
    const reading = await readModelList(driver, picker);
    return { ok: true, reading: { ...reading, ...(reading.hours ? {} : hoursOnOpen ? { hours: hoursOnOpen } : {}) } };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  } finally {
    if (pty) {
      try {
        pty.kill("SIGHUP");
      } catch {
        // já saiu
      }
      await sleep(150);
      try {
        pty.kill("SIGKILL");
      } catch {
        // já saiu
      }
    }
  }
}

async function loadNodePty(): Promise<PtySpawnFn> {
  const pty = await import("@lydell/node-pty");
  return (file, args, spawnOptions) => pty.spawn(file, args, spawnOptions);
}
