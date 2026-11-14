import type { PtySpawnFn } from "../terminals/pty-terminal";
import type { FreebuffService } from "./service";

/**
 * O Freebuff neste servidor (vai em `TerminalsConfig.freebuff`): as horas abertas (uma só para todos os
 * workspaces: a hora é da conta), o executável e a pasta de dados dele. Sem isto o motor "freebuff" não
 * sobe terminais. Os campos de tempo são só para os testes (as CLIs falsas são rápidas).
 */
export type FreebuffRuntime = {
  service: FreebuffService;
  /** Executável (padrão: `freebuff` no PATH ou em ~/.local/bin). */
  command: string;
  prefixArgs?: string[];
  /** `~/.config/manicode` (só leitura). */
  manicodeDir: string;
  /** Acrescenta o token na URL do MCP (`?t=`): só se algum dia o Freebuff deixar de mandar o cabeçalho Authorization (hoje manda: medido em 12/11). */
  tokenInUrl?: boolean;
  /** Ambiente base (padrão: process.env sem chaves de API). */
  env?: NodeJS.ProcessEnv;
  spawn?: PtySpawnFn;
  pollMs?: number;
  readyTimeoutMs?: number;
  deliveryTimeoutMs?: number;
  submitDelayMs?: number;
  hangMs?: number;
  settleMs?: number;
  settleCatalogMs?: number;
  stableMs?: number;
};
