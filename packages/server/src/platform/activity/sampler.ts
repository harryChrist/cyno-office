import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { trackedProcesses, type TrackedProcess } from "./hooks";
import { parseOomKills } from "./lifecycle";
import type { ActivityLog } from "../../workspace/activity/log";
import { activityDay, spIso } from "../../workspace/activity/time";

/**
 * Amostra de recursos a cada minuto, lendo o /proc direto (nada de rodar `ps`): memória e swap da
 * máquina, carga, memória do server e de cada terminal de agente (a árvore de processos dele) e do
 * Chromium do navegador compartilhado. A amostra NÃO vira entrada da Atividade: ela alimenta o
 * batimento (última amostra), UMA linha por hora em `metrics-AAAA-MM.jsonl` (pico e média) e os
 * alertas, que só saem ao CRUZAR o limite (no máximo um por hora): memória baixa, pressão de
 * memória e processos mortos pelo kernel por falta de memória.
 */

const PAGE_BYTES = 4096;
const MB = 1024 * 1024;

export type ProcStat = { pid: number; ppid: number; comm: string; rssBytes: number };

/** Uma linha de /proc/<pid>/stat (o nome pode ter espaços e parênteses: vai até o último ")"). */
export function parseStat(line: string): ProcStat | undefined {
  const open = line.indexOf("(");
  const close = line.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const pid = Number(line.slice(0, open).trim());
  const fields = line.slice(close + 2).split(" ");
  // fields[0] = estado (campo 3); ppid = campo 4; rss (páginas) = campo 24.
  const ppid = Number(fields[1]);
  const rssPages = Number(fields[21]);
  if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rssPages)) return undefined;
  return { pid, ppid, comm: line.slice(open + 1, close), rssBytes: rssPages * PAGE_BYTES };
}

export type MemInfo = { totalKb: number; availableKb: number; swapTotalKb: number; swapFreeKb: number };

export function parseMeminfo(text: string): MemInfo | undefined {
  const value = (key: string) => {
    const match = new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text);
    return match ? Number(match[1]) : undefined;
  };
  const totalKb = value("MemTotal");
  const availableKb = value("MemAvailable") ?? value("MemFree");
  if (totalKb === undefined || availableKb === undefined) return undefined;
  return { totalKb, availableKb, swapTotalKb: value("SwapTotal") ?? 0, swapFreeKb: value("SwapFree") ?? 0 };
}

export type Pressure = { someAvg10: number; someAvg60: number; fullAvg10: number; fullAvg60: number };

/** /proc/pressure/memory (PSI): % do tempo com tarefas travadas esperando memória. */
export function parsePressure(text: string): Pressure | undefined {
  const avg = (kind: "some" | "full", window: "avg10" | "avg60") => {
    const match = new RegExp(`^${kind} .*\\b${window}=([\\d.]+)`, "m").exec(text);
    return match ? Number(match[1]) : undefined;
  };
  const someAvg10 = avg("some", "avg10");
  if (someAvg10 === undefined) return undefined;
  return { someAvg10, someAvg60: avg("some", "avg60") ?? 0, fullAvg10: avg("full", "avg10") ?? 0, fullAvg60: avg("full", "avg60") ?? 0 };
}

const mb = (bytes: number) => Math.round(bytes / MB);
const round1 = (value: number) => Math.round(value * 10) / 10;

export type ResourceSample = {
  memTotalMb: number;
  memAvailableMb: number;
  memAvailablePct: number;
  swapTotalMb: number;
  swapUsedMb: number;
  load1: number;
  load5: number;
  load15: number;
  serverRssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  terminals: { workspaceId?: string; agentId?: string; engine?: string; pid: number; procs: number; rssMb: number }[];
  terminalsRssMb: number;
  browserRssMb: number;
  browserProcs: number;
  oomKills?: number;
  /** Pressão de memória (PSI, %): alta = o sistema está travando por falta de memória (é o que o systemd-oomd olha). */
  psiSome10?: number;
  psiFull10?: number;
  psiFull60?: number;
};

export type ResourceSamplerOptions = {
  activity: ActivityLog;
  /** Pasta das métricas por hora (DATA_DIR/activity); ausente = sem histórico de métricas. */
  metricsDir?: string;
  intervalMs?: number;
  procDir?: string;
  /** pid do server (raiz da árvore). */
  pid?: number;
  /** Abaixo desta fração de memória disponível: aviso. Padrão 0,15. */
  lowMemoryRatio?: number;
  processes?: () => TrackedProcess[];
  memoryUsage?: () => NodeJS.MemoryUsage;
  loadavg?: () => number[];
  /** Depois de cada amostra (o batimento guarda a última). */
  onSample?: (sample: ResourceSample) => void;
  /** PSI "full" avg10 (%) a partir do qual avisa. Padrão 10. */
  pressureWarnPct?: number;
};

/** No máximo um alerta de memória por hora. */
const ALERT_EVERY_MS = 60 * 60_000;

/** Acumulador da hora corrente das métricas. */
type HourBucket = { hour: string; n: number; availMin: number; availSum: number; pctMin: number; swapMax: number; serverSum: number; serverMax: number; terminalsMax: number; browserMax: number; psiMax: number };

export class ResourceSampler {
  private readonly procDir: string;
  private readonly pid: number;
  private timer: NodeJS.Timeout | undefined;
  private lastOomKills: number | undefined;
  private low = false;
  private pressured = false;
  private bucket: HourBucket | undefined;
  private running = false;

  constructor(private readonly options: ResourceSamplerOptions) {
    this.procDir = options.procDir ?? "/proc";
    this.pid = options.pid ?? process.pid;
  }

  start(): void {
    if (this.timer) return;
    const interval = this.options.intervalMs ?? 60_000;
    if (interval <= 0) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Uma amostra (registra o evento e os avisos). Nunca rejeita. */
  async tick(): Promise<ResourceSample | undefined> {
    if (this.running) return undefined;
    this.running = true;
    try {
      const sample = await this.sample();
      if (sample) {
        this.record(sample);
        this.options.onSample?.(sample);
      }
      return sample;
    } catch {
      return undefined;
    } finally {
      this.running = false;
    }
  }

  async sample(): Promise<ResourceSample | undefined> {
    const meminfo = parseMeminfo(await this.read("meminfo"));
    if (!meminfo) return undefined;
    const memory = (this.options.memoryUsage ?? (() => process.memoryUsage()))();
    const [load1 = 0, load5 = 0, load15 = 0] = (this.options.loadavg ?? os.loadavg)();
    const oomKills = parseOomKills(await this.read("vmstat"));
    const pressure = parsePressure(await this.read("pressure/memory"));

    // Árvore de processos do server (filhos diretos via /proc/<pid>/task/<pid>/children).
    const stats = new Map<number, ProcStat>();
    const serverTree = await this.tree(this.pid, stats);
    const inTerminals = new Set<number>();
    const terminals: ResourceSample["terminals"] = [];
    for (const tracked of (this.options.processes ?? trackedProcesses)()) {
      const pids = await this.tree(tracked.pid, stats);
      if (pids.length === 0) continue;
      let rss = 0;
      for (const pid of pids) {
        inTerminals.add(pid);
        rss += stats.get(pid)?.rssBytes ?? 0;
      }
      terminals.push({
        ...(tracked.workspaceId ? { workspaceId: tracked.workspaceId } : {}),
        ...(tracked.agentId ? { agentId: tracked.agentId } : {}),
        ...(tracked.engine ? { engine: tracked.engine } : {}),
        pid: tracked.pid,
        procs: pids.length,
        rssMb: mb(rss),
      });
    }
    // Chromium: o resto da árvore do server com cara de navegador (o Playwright sobe ele como filho).
    let browserRss = 0;
    let browserProcs = 0;
    for (const pid of serverTree) {
      if (pid === this.pid || inTerminals.has(pid)) continue;
      const stat = stats.get(pid);
      if (!stat || !/chrom|headless/i.test(stat.comm)) continue;
      browserRss += stat.rssBytes;
      browserProcs += 1;
    }
    const swapUsedKb = Math.max(0, meminfo.swapTotalKb - meminfo.swapFreeKb);
    return {
      memTotalMb: Math.round(meminfo.totalKb / 1024),
      memAvailableMb: Math.round(meminfo.availableKb / 1024),
      memAvailablePct: round1((meminfo.availableKb / meminfo.totalKb) * 100),
      swapTotalMb: Math.round(meminfo.swapTotalKb / 1024),
      swapUsedMb: Math.round(swapUsedKb / 1024),
      load1: round1(load1),
      load5: round1(load5),
      load15: round1(load15),
      serverRssMb: mb(memory.rss),
      heapUsedMb: mb(memory.heapUsed),
      heapTotalMb: mb(memory.heapTotal),
      externalMb: mb(memory.external),
      terminals,
      terminalsRssMb: terminals.reduce((sum, item) => sum + item.rssMb, 0),
      browserRssMb: mb(browserRss),
      browserProcs,
      ...(oomKills !== undefined ? { oomKills } : {}),
      ...(pressure ? { psiSome10: pressure.someAvg10, psiFull10: pressure.fullAvg10, psiFull60: pressure.fullAvg60 } : {}),
    };
  }

  private record(sample: ResourceSample): void {
    const log = this.options.activity;
    const now = Date.now();
    void this.addToHour(sample, now);
    const ratio = this.options.lowMemoryRatio ?? 0.15;
    const low = sample.memAvailablePct / 100 < ratio;
    if (low && !this.low) {
      log.record(
        {
          category: "sistema",
          action: "memoria_baixa",
          actor: "sistema",
          summary: `Pouca memória livre: ${sample.memAvailableMb} MB (${sample.memAvailablePct}%) disponíveis`,
          data: { memAvailableMb: sample.memAvailableMb, memAvailablePct: sample.memAvailablePct, swapUsedMb: sample.swapUsedMb, serverRssMb: sample.serverRssMb, terminalsRssMb: sample.terminalsRssMb, browserRssMb: sample.browserRssMb },
        },
        { throttle: { key: "low-memory", ms: ALERT_EVERY_MS } },
      );
    }
    this.low = low;
    const pressureLimit = this.options.pressureWarnPct ?? 10;
    const pressured = sample.psiFull10 !== undefined && sample.psiFull10 >= pressureLimit;
    if (pressured && !this.pressured) {
      log.record(
        {
          category: "sistema",
          action: "pressao_de_memoria",
          actor: "sistema",
          summary: `O sistema está travando por falta de memória (${sample.psiFull10}% do tempo parado nos últimos 10 s)`,
          data: { psiFull10: sample.psiFull10, psiFull60: sample.psiFull60, memAvailableMb: sample.memAvailableMb, swapUsedMb: sample.swapUsedMb },
        },
        { throttle: { key: "memory-pressure", ms: ALERT_EVERY_MS } },
      );
    }
    this.pressured = pressured;
    if (sample.oomKills !== undefined) {
      if (this.lastOomKills !== undefined && sample.oomKills > this.lastOomKills) {
        const kills = sample.oomKills - this.lastOomKills;
        log.record({
          category: "sistema",
          action: "processo_morto_por_memoria",
          actor: "sistema",
          summary: `O sistema matou ${kills} ${kills === 1 ? "processo" : "processos"} por falta de memória`,
          data: { kills, memAvailableMb: sample.memAvailableMb, swapUsedMb: sample.swapUsedMb },
        });
      }
      this.lastOomKills = sample.oomKills;
    }
  }

  /** Soma a amostra na hora corrente; ao virar a hora, grava a linha da anterior (uma por hora). */
  private async addToHour(sample: ResourceSample, nowMs: number): Promise<void> {
    if (!this.options.metricsDir) return;
    const hour = spIso(Math.floor(nowMs / 3_600_000) * 3_600_000).slice(0, 13);
    let closed: HourBucket | undefined;
    if (this.bucket && this.bucket.hour !== hour) {
      closed = this.bucket;
      this.bucket = undefined;
    }
    const b = (this.bucket ??= { hour, n: 0, availMin: Infinity, availSum: 0, pctMin: Infinity, swapMax: 0, serverSum: 0, serverMax: 0, terminalsMax: 0, browserMax: 0, psiMax: 0 });
    b.n += 1;
    b.availMin = Math.min(b.availMin, sample.memAvailableMb);
    b.availSum += sample.memAvailableMb;
    b.pctMin = Math.min(b.pctMin, sample.memAvailablePct);
    b.swapMax = Math.max(b.swapMax, sample.swapUsedMb);
    b.serverSum += sample.serverRssMb;
    b.serverMax = Math.max(b.serverMax, sample.serverRssMb);
    b.terminalsMax = Math.max(b.terminalsMax, sample.terminalsRssMb);
    b.browserMax = Math.max(b.browserMax, sample.browserRssMb);
    b.psiMax = Math.max(b.psiMax, sample.psiFull10 ?? 0);
    if (closed) await this.writeBucket(closed);
  }

  /** Grava a hora em andamento (desligamento). */
  async flushMetrics(): Promise<void> {
    const open = this.bucket;
    this.bucket = undefined;
    if (open) await this.writeBucket(open);
  }

  private async writeBucket(b: HourBucket): Promise<void> {
    const dir = this.options.metricsDir;
    if (!dir || b.n === 0) return;
    const line = {
      hour: `${b.hour}:00:00-03:00`,
      samples: b.n,
      memAvailableMb: { min: b.availMin, avg: Math.round(b.availSum / b.n) },
      memAvailablePctMin: b.pctMin,
      swapUsedMbPeak: b.swapMax,
      serverRssMb: { peak: b.serverMax, avg: Math.round(b.serverSum / b.n) },
      terminalsRssMbPeak: b.terminalsMax,
      browserRssMbPeak: b.browserMax,
      psiFull10Peak: b.psiMax,
    };
    try {
      await mkdir(dir, { recursive: true });
      await appendFile(path.join(dir, `metrics-${activityDay(Date.parse(`${b.hour}:30:00-03:00`)).slice(0, 7)}.jsonl`), `${JSON.stringify(line)}\n`, "utf8");
    } catch {
      // Sem disco: perde a linha da hora.
    }
  }

  private async read(file: string): Promise<string> {
    try {
      return await readFile(path.join(this.procDir, file), "utf8");
    } catch {
      return "";
    }
  }

  /** pids da árvore de `root` (inclusive), lendo o stat de cada um em `stats`. */
  private async tree(root: number, stats: Map<number, ProcStat>): Promise<number[]> {
    const out: number[] = [];
    const queue = [root];
    const seen = new Set<number>();
    while (queue.length > 0 && out.length < 2000) {
      const pid = queue.shift()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      if (!stats.has(pid)) {
        const stat = parseStat(await this.read(`${pid}/stat`));
        if (!stat) continue;
        stats.set(pid, stat);
      }
      out.push(pid);
      for (const child of await this.children(pid)) queue.push(child);
    }
    return out;
  }

  /** Filhos de um processo (todas as threads). */
  private async children(pid: number): Promise<number[]> {
    let tids: string[];
    try {
      tids = await readdir(path.join(this.procDir, String(pid), "task"));
    } catch {
      return [];
    }
    const out: number[] = [];
    for (const tid of tids) {
      const text = await this.read(`${pid}/task/${tid}/children`);
      for (const part of text.split(" ")) {
        const child = Number(part);
        if (part && Number.isInteger(child)) out.push(child);
      }
    }
    return out;
  }
}
