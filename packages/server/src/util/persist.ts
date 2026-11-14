import type { ServerEvent } from "@cyno/shared";

/** Esperas (ms) entre as tentativas: 1 tentativa + 2 novas. */
export const PERSIST_RETRY_DELAYS_MS: readonly number[] = [250, 1000];

export type PersistOptions = {
  /** O que está sendo gravado (vai no log e no aviso). */
  label: string;
  log: { error(object: object, message: string): void };
  /** Publica o aviso visível quando a última tentativa falha (`system:warning`). */
  publish?: (event: ServerEvent) => void;
  now?: () => Date;
  /** Esperas entre as tentativas (os testes passam zeros). */
  delaysMs?: readonly number[];
};

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/**
 * Grava com novas tentativas (espera crescente). `write(attempt)` recebe 0, 1, 2…: quem publica
 * eventos junto da gravação só deve fazê-lo na tentativa 0. Devolve true se gravou; se esgotar, loga,
 * publica um `system:warning` e devolve false (nunca lança): é o caminho dos disparos do servidor.
 */
export async function persist(write: (attempt: number) => Promise<void>, options: PersistOptions): Promise<boolean> {
  const delays = options.delaysMs ?? PERSIST_RETRY_DELAYS_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (attempt > 0) await sleep(delays[attempt - 1]!);
    try {
      await write(attempt);
      return true;
    } catch (error) {
      lastError = error;
      options.log.error({ err: error, attempt: attempt + 1 }, `falha ao gravar: ${options.label}`);
    }
  }
  options.publish?.({
    type: "system:warning",
    message: `Não consegui gravar ${options.label} no disco (${lastError instanceof Error ? lastError.message : String(lastError)}). A alteração vale até reiniciar o servidor; confira o espaço em disco.`,
    at: (options.now?.() ?? new Date()).toISOString(),
  });
  return false;
}

/** Como `persist`, mas lança o último erro (caminhos disparados pelo usuário: o erro de verdade volta ao cliente). */
export async function persistOrThrow(write: (attempt: number) => Promise<void>, options: PersistOptions & { fail: (error: unknown) => Error }): Promise<void> {
  let captured: unknown;
  const ok = await persist(
    async (attempt) => {
      try {
        await write(attempt);
      } catch (error) {
        captured = error;
        throw error;
      }
    },
    options,
  );
  if (!ok) throw options.fail(captured);
}
