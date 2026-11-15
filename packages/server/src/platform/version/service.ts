import type { RunMode, VersionResponse } from "@cyno/shared";
import { UpdateChecker, type UpdateConfig } from "./checker";
import { locateRoot, readLocalVersion, type LocalVersion } from "./local";
import { detectRunModeFromProcess } from "./run-mode";
import { UpdateManager, type NpmRunner } from "./updater";

export type VersionServiceOptions = {
  /** Raiz do repositório; padrão: sobe a partir de `startDir`. */
  rootDir?: string;
  startDir: string;
  config: UpdateConfig;
  fetch?: typeof fetch;
  lsRemoteTimeoutMs?: number;
  /** O botão "Baixar atualização" está ligado (`CYNO_UPDATE_APPLY`). Padrão: desligado (o index.ts liga). */
  applyEnabled?: boolean;
  /** Força o jeito de rodar (os testes); o padrão olha o ambiente do processo. */
  runMode?: RunMode;
  /** Executor do `npm install` (os testes passam um falso). */
  npm?: NpmRunner;
  /** Validade do cache do estado do disco, em ms (os testes usam 0). */
  liveTtlMs?: number;
};

/** A versão instalada (lida uma vez, sem rede) e a verificação de atualização. */
export class VersionService {
  private localPromise: Promise<LocalVersion> | null = null;
  readonly checker: UpdateChecker;
  readonly updater: UpdateManager;
  private readonly rootDir: string;

  constructor(options: VersionServiceOptions) {
    this.rootDir = options.rootDir ?? locateRoot(options.startDir);
    this.updater = new UpdateManager({
      rootDir: this.rootDir,
      local: () => this.local(),
      checker: { snapshot: () => this.checker.snapshot(), check: () => this.checker.check() },
      branch: options.config.branch,
      enabled: options.applyEnabled === true,
      runMode: (local) => options.runMode ?? detectRunModeFromProcess(this.rootDir, local.gitCwd !== null),
      ...(options.npm ? { npm: options.npm } : {}),
      ...(options.liveTtlMs !== undefined ? { liveTtlMs: options.liveTtlMs } : {}),
    });
    this.checker = new UpdateChecker({
      local: () => this.updater.checkerLocal(),
      config: options.config,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.lsRemoteTimeoutMs ? { lsRemoteTimeoutMs: options.lsRemoteTimeoutMs } : {}),
    });
    // A versão com que o processo sobe (usada para saber se falta reiniciar) é lida já na criação.
    this.local().catch(() => undefined);
  }

  local(): Promise<LocalVersion> {
    return (this.localPromise ??= readLocalVersion(this.rootDir));
  }

  async view(): Promise<VersionResponse> {
    const update = await this.updater.state();
    const live = await this.updater.live();
    return { version: (await this.local()).info, check: this.updater.adjustCheck(this.checker.snapshot(), live), update };
  }

  /** Começa a baixar a atualização (em segundo plano); ver `UpdateManager.start`. */
  startUpdate() {
    return this.updater.start();
  }

  /** Lê a versão (sem rede) e liga a verificação automática. */
  start(): void {
    void this.local();
    this.checker.start();
  }

  stop(): void {
    this.checker.stop();
  }
}
