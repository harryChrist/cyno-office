import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { ServerLifecycle } from "./lifecycle";
import { ActivityLog, setActivityLog, systemActivityDir, type ActivityLogger } from "../../workspace/activity/log";
import { ResourceSampler } from "./sampler";

export type ActivityHandle = {
  log: ActivityLog;
  lifecycle: ServerLifecycle;
  sampler: ResourceSampler;
  /** O logger do Fastify (pino) depois que o app existe: avisos de gravação vão para lá. */
  attachLogger: (logger: ActivityLogger) => void;
  /** Desligamento limpo: para a amostra, marca o batimento e grava o resto. */
  shutdown: (signal?: string) => Promise<void>;
};

export type StartActivityOptions = {
  dataDir: string;
  /** Intervalo da amostra de recursos e do batimento (ms). Padrão: 60 s; 0 desliga a amostra. */
  sampleMs?: number;
  /** Vai na entrada de "iniciado" (porta, runner…). */
  startData?: Record<string, unknown>;
};

/**
 * O batimento morava em `logs/system/heartbeat.json`: leva para `activity/` (uma vez, antes de ler
 * como o processo anterior parou), senão o primeiro boot depois da mudança não saberia.
 */
function moveHeartbeat(dataDir: string): void {
  try {
    const next = path.join(systemActivityDir(dataDir), "heartbeat.json");
    const old = path.join(dataDir, "logs", "system", "heartbeat.json");
    if (existsSync(next) || !existsSync(old)) return;
    mkdirSync(path.dirname(next), { recursive: true });
    renameSync(old, next);
  } catch {
    // Sem o batimento anterior o boot só não sabe como o processo parou.
  }
}

/**
 * Liga a Atividade do processo (index.ts): grava o boot (com o palpite de como o processo anterior
 * parou), ouve os erros não tratados e, a cada minuto, amostra a memória (só batimento, métricas por
 * hora e alertas; a amostra em si não é gravada) e regrava o batimento.
 */
export async function startActivity(options: StartActivityOptions): Promise<ActivityHandle> {
  const dir = systemActivityDir(options.dataDir);
  moveHeartbeat(options.dataDir);
  const log = new ActivityLog({ dataDir: options.dataDir });
  setActivityLog(log);
  const lifecycle = new ServerLifecycle({ log, dir, intervalMs: 0 });
  await lifecycle.start(options.startData);
  const sampler = new ResourceSampler({
    activity: log,
    metricsDir: dir,
    onSample: (sample) =>
      lifecycle.noteSample({
        memAvailableMb: sample.memAvailableMb,
        memAvailablePct: sample.memAvailablePct,
        swapUsedMb: sample.swapUsedMb,
        serverRssMb: sample.serverRssMb,
        terminalsRssMb: sample.terminalsRssMb,
        browserRssMb: sample.browserRssMb,
        ...(sample.psiFull10 !== undefined ? { psiFull10: sample.psiFull10 } : {}),
      }),
  });
  const tick = async () => {
    await sampler.tick();
    await lifecycle.beat();
  };
  const interval = options.sampleMs ?? 60_000;
  const timer = interval > 0 ? setInterval(() => void tick(), interval) : undefined;
  timer?.unref?.();
  // Primeira amostra logo depois do boot (com os workspaces subindo).
  const first = interval > 0 ? setTimeout(() => void tick(), 5000) : undefined;
  first?.unref?.();
  return {
    log,
    lifecycle,
    sampler,
    attachLogger: (logger) => log.setLogger(logger),
    shutdown: async (signal) => {
      if (timer) clearInterval(timer);
      if (first) clearTimeout(first);
      await sampler.flushMetrics();
      await lifecycle.markClean(signal);
      await log.close();
    },
  };
}
