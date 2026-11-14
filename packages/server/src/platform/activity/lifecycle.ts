import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SystemPreviousStop } from "@cyno/shared";
import { writeJsonAtomic } from "../../store/atomic-write";
import type { ActivityLog } from "../../workspace/activity/log";
import { cleanString } from "../../workspace/activity/sanitize";
import { durationLabel } from "../../workspace/activity/recorder";

/**
 * Batimento do server (`heartbeat.json` em DATA_DIR/activity), regravado a cada minuto. No
 * desligamento limpo ganha a marca `clean`; num erro não tratado, `crash`. No boot seguinte, o
 * arquivo diz como o processo anterior parou: sem marca e na mesma subida da máquina = morto
 * (OOM killer, kill -9, pm2) ou caiu sem avisar.
 */
export type Heartbeat = {
  pid: number;
  startedAt: string;
  at: string;
  /** /proc/sys/kernel/random/boot_id: muda a cada boot da máquina. */
  bootId?: string;
  /** Contador `oom_kill` do /proc/vmstat (processos mortos por falta de memória desde o boot). */
  oomKills?: number;
  /** Última amostra de memória antes deste batimento (o estado da máquina quando o processo morreu). */
  lastSample?: HeartbeatSample;
  clean?: { at: string; signal?: string };
  /** Pedido de parada recebido (sinal): se o processo for morto à força antes do fim, ainda conta como parada pedida. */
  stopping?: { at: string; signal?: string };
  crash?: { at: string; origin: string; message: string };
};

export type HeartbeatSample = { memAvailableMb: number; memAvailablePct: number; swapUsedMb: number; serverRssMb: number; terminalsRssMb: number; browserRssMb: number; psiFull10?: number };

/** Fatos do sistema lidos do /proc (ausentes fora do Linux). */
export type SystemFacts = { bootId?: string; oomKills?: number };

export function heartbeatFile(dir: string): string {
  return path.join(dir, "heartbeat.json");
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Contador oom_kill do /proc/vmstat. */
export function parseOomKills(vmstat: string | undefined): number | undefined {
  const match = vmstat ? /^oom_kill\s+(\d+)/m.exec(vmstat) : null;
  return match ? Number(match[1]) : undefined;
}

export function readSystemFacts(procDir = "/proc"): SystemFacts {
  const bootId = readText(path.join(procDir, "sys/kernel/random/boot_id"))?.trim();
  const oomKills = parseOomKills(readText(path.join(procDir, "vmstat")));
  return { ...(bootId ? { bootId } : {}), ...(oomKills !== undefined ? { oomKills } : {}) };
}

export type PreviousStop = {
  previousStop: SystemPreviousStop;
  lastHeartbeatAt?: string;
  /** Quanto tempo antes deste boot foi o último batimento. */
  heartbeatAgeMs?: number;
  previousPid?: number;
  previousStartedAt?: string;
  /** Mortes por falta de memória na máquina depois do último batimento (mesmo boot). */
  oomKills?: number;
  /** Parada pedida (sinal), mas o processo foi morto antes de terminar de fechar. */
  killedDuringShutdown?: boolean;
  previousError?: string;
  signal?: string;
  lastSample?: HeartbeatSample;
};

/** Como o processo anterior parou, a partir do último batimento e dos fatos de agora. */
export function previousStopOf(previous: Heartbeat | undefined, facts: SystemFacts, now: Date): PreviousStop {
  if (!previous || typeof previous.at !== "string") return { previousStop: "unknown" };
  const base: PreviousStop = {
    previousStop: "unknown",
    lastHeartbeatAt: previous.at,
    ...(Number.isFinite(Date.parse(previous.at)) ? { heartbeatAgeMs: Math.max(0, now.getTime() - Date.parse(previous.at)) } : {}),
    ...(typeof previous.pid === "number" ? { previousPid: previous.pid } : {}),
    ...(typeof previous.startedAt === "string" ? { previousStartedAt: previous.startedAt } : {}),
    ...(previous.lastSample && typeof previous.lastSample === "object" ? { lastSample: previous.lastSample } : {}),
  };
  if (previous.clean) return { ...base, previousStop: "clean", ...(previous.clean.signal ? { signal: previous.clean.signal } : {}) };
  if (previous.stopping) return { ...base, previousStop: "clean", ...(previous.stopping.signal ? { signal: previous.stopping.signal } : {}), killedDuringShutdown: true };
  if (previous.crash) return { ...base, previousStop: "crash", previousError: `${previous.crash.origin}: ${previous.crash.message}` };
  if (previous.bootId && facts.bootId && previous.bootId !== facts.bootId) return { ...base, previousStop: "system_reboot" };
  const ooms = previous.oomKills !== undefined && facts.oomKills !== undefined ? facts.oomKills - previous.oomKills : undefined;
  return { ...base, previousStop: "crash_or_kill", ...(ooms !== undefined && ooms > 0 ? { oomKills: ooms } : {}) };
}

export type ServerLifecycleOptions = {
  log: ActivityLog;
  /** Pasta da Atividade do servidor (o heartbeat.json fica nela). */
  dir: string;
  intervalMs?: number;
  now?: () => Date;
  procDir?: string;
  /** Registra os ouvintes de erro não tratado do processo (padrão: sim). */
  processHooks?: boolean;
};

/**
 * Ciclo de vida do server na Atividade: o boot (com o palpite de como o anterior parou), o batimento a
 * cada minuto, o desligamento limpo e os erros não tratados (só observa: o processo continua
 * morrendo como antes, mas antes grava a Atividade e a marca no batimento).
 */
export class ServerLifecycle {
  private readonly file: string;
  private readonly now: () => Date;
  private readonly startedAt: Date;
  private timer: NodeJS.Timeout | undefined;
  private current: Heartbeat | undefined;
  private lastSample: HeartbeatSample | undefined;
  private readonly listeners: [string, (...args: never[]) => void][] = [];

  constructor(private readonly options: ServerLifecycleOptions) {
    this.file = heartbeatFile(options.dir);
    this.now = options.now ?? (() => new Date());
    this.startedAt = this.now();
  }

  /** Boot: lê o batimento anterior, registra `server.start` e começa a bater. Nunca rejeita. */
  async start(extra: Record<string, unknown> = {}): Promise<PreviousStop> {
    let previous: Heartbeat | undefined;
    try {
      previous = JSON.parse(await readFile(this.file, "utf8")) as Heartbeat;
    } catch {
      previous = undefined;
    }
    const facts = readSystemFacts(this.options.procDir);
    const stop = previousStopOf(previous, facts, this.startedAt);
    this.options.log.record({
      at: this.startedAt,
      category: "sistema",
      action: "iniciado",
      actor: "sistema",
      summary: startSummary(stop),
      data: { pid: process.pid, node: process.version, ...stop, ...extra },
    });
    await this.beat();
    if (this.options.processHooks !== false) this.installProcessHooks();
    const interval = this.options.intervalMs ?? 60_000;
    if (interval > 0) {
      this.timer = setInterval(() => void this.beat(), interval);
      this.timer.unref?.();
    }
    return stop;
  }

  /** Guarda a última amostra de memória (vai no próximo batimento). */
  noteSample(sample: HeartbeatSample): void {
    this.lastSample = { ...sample };
  }

  /** Regrava o batimento (agora, com o contador de OOM do sistema). Nunca rejeita. */
  async beat(): Promise<void> {
    const facts = readSystemFacts(this.options.procDir);
    this.current = { pid: process.pid, startedAt: this.startedAt.toISOString(), at: this.now().toISOString(), ...facts, ...(this.lastSample ? { lastSample: this.lastSample } : {}) };
    try {
      await mkdir(this.options.dir, { recursive: true });
      await writeJsonAtomic(this.file, this.current);
    } catch {
      // Sem disco: o próximo boot só não vai saber como este parou.
    }
  }

  /** Sinal de parada recebido: marca o batimento na hora (síncrono), antes de fechar terminais e navegador. */
  markStopping(signal?: string): void {
    this.stopTimer();
    const heartbeat: Heartbeat = { ...(this.current ?? { pid: process.pid, startedAt: this.startedAt.toISOString() }), at: this.now().toISOString(), stopping: { at: this.now().toISOString(), ...(signal ? { signal } : {}) } };
    try {
      writeFileSync(this.file, `${JSON.stringify(heartbeat, null, 2)}\n`);
    } catch {
      // nada
    }
  }

  /** Desligamento limpo: registra e marca o batimento (o próximo boot vê "clean"). */
  async markClean(signal?: string): Promise<void> {
    this.stopTimer();
    this.removeProcessHooks();
    const uptimeMs = this.now().getTime() - this.startedAt.getTime();
    this.options.log.record({ category: "sistema", action: "desligado", actor: "sistema", summary: `Servidor desligado normalmente${signal ? ` (${signal})` : ""} depois de ${durationLabel(uptimeMs)} no ar`, data: { ...(signal ? { signal } : {}), pid: process.pid, uptimeMs } });
    const heartbeat: Heartbeat = { ...(this.current ?? { pid: process.pid, startedAt: this.startedAt.toISOString() }), at: this.now().toISOString(), clean: { at: this.now().toISOString(), ...(signal ? { signal } : {}) } };
    try {
      await mkdir(this.options.dir, { recursive: true });
      await writeJsonAtomic(this.file, heartbeat);
    } catch {
      // nada
    }
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Erro não tratado (o processo vai morrer): grava o diário e a marca de queda de forma síncrona. */
  onFatal(error: unknown, origin: string): void {
    try {
      const message = cleanString(error instanceof Error ? error.message : String(error), 300);
      const stack = error instanceof Error && error.stack ? error.stack.split("\n").slice(1, 6).map((line) => line.trim()).join(" | ") : undefined;
      this.options.log.record({
        category: "sistema",
        action: "erro_fatal",
        actor: "sistema",
        summary: `Um erro inesperado derrubou o servidor: ${message}`,
        data: { origin, message, ...(stack ? { stack } : {}), pid: process.pid, uptimeMs: this.now().getTime() - this.startedAt.getTime() },
      });
      this.options.log.flushSync();
      const heartbeat: Heartbeat = { ...(this.current ?? { pid: process.pid, startedAt: this.startedAt.toISOString() }), at: this.now().toISOString(), crash: { at: this.now().toISOString(), origin, message } };
      writeFileSync(this.file, `${JSON.stringify(heartbeat, null, 2)}\n`);
    } catch {
      // Morrendo de qualquer jeito.
    }
  }

  private installProcessHooks(): void {
    // "Monitor": só observa; não muda o comportamento padrão (o processo ainda cai no erro não tratado).
    const fatal = (error: unknown, origin: string) => this.onFatal(error, origin);
    process.on("uncaughtExceptionMonitor", fatal);
    this.listeners.push(["uncaughtExceptionMonitor", fatal as never]);
  }

  private removeProcessHooks(): void {
    for (const [event, listener] of this.listeners.splice(0)) process.off(event, listener as (...args: unknown[]) => void);
  }
}

/** A frase do boot: como o processo anterior parou. */
export function startSummary(stop: PreviousStop): string {
  switch (stop.previousStop) {
    case "clean":
      return stop.killedDuringShutdown ? "Servidor iniciado (a parada anterior foi pedida, mas o processo foi encerrado antes de terminar)" : "Servidor iniciado (a parada anterior foi normal)";
    case "crash":
      return `Servidor iniciado depois de uma queda${stop.previousError ? `: ${cleanString(stop.previousError, 160)}` : ""}`;
    case "crash_or_kill": {
      const ooms = stop.oomKills ? `; o sistema matou ${stop.oomKills} ${stop.oomKills === 1 ? "processo" : "processos"} por falta de memória` : "";
      return `Servidor iniciado: o processo anterior foi encerrado sem aviso (queda ou kill${ooms})`;
    }
    case "system_reboot":
      return "Servidor iniciado depois de a máquina reiniciar";
    default:
      return "Servidor iniciado";
  }
}
