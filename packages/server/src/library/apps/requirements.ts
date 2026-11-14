import { accessSync, constants, readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppRequirement, CatalogApp, RequirementResult } from "@cyno/shared";
import { RUNTIMES, platformKey } from "./runtimes";

/** O que a máquina tem (injetável nos testes). */
export type MachineProbe = {
  platform: NodeJS.Platform;
  arch: string;
  /** RAM total e disponível, em MB. */
  totalMemMB: () => number;
  availMemMB: () => number;
  /** Espaço livre, em MB, onde os dados da plataforma moram. */
  diskFreeMB: () => number;
  /** Caminho do binário no PATH, se existir. */
  which: (bin: string) => string | undefined;
  /** Versão do Node do próprio servidor. */
  nodeVersion: string;
  /** O runtime compartilhado já está baixado? */
  runtimeInstalled: (runtimeId: string) => boolean;
};

export function whichInPath(bin: string, envPath: string | undefined = process.env.PATH): string | undefined {
  for (const dir of (envPath ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // próximo
    }
  }
  return undefined;
}

function availMemMB(): number {
  try {
    const match = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
    if (match) return Math.round(Number(match[1]) / 1024);
  } catch {
    // sem /proc: cai no que o Node sabe
  }
  return Math.round(os.freemem() / 1024 / 1024);
}

export function realProbe(dataDir: string, runtimesRoot: string): MachineProbe {
  return {
    platform: process.platform,
    arch: process.arch,
    totalMemMB: () => Math.round(os.totalmem() / 1024 / 1024),
    availMemMB,
    diskFreeMB: () => {
      try {
        const stats = statfsSync(dataDir);
        return Math.round((Number(stats.bavail) * Number(stats.bsize)) / 1024 / 1024);
      } catch {
        return Number.MAX_SAFE_INTEGER;
      }
    },
    which: (bin) => whichInPath(bin),
    nodeVersion: process.versions.node,
    runtimeInstalled: (id) => {
      const def = RUNTIMES[id as keyof typeof RUNTIMES];
      if (!def) return false;
      try {
        accessSync(path.join(runtimesRoot, id, def.bin), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** "1500MB" / "2GB" -> MB. */
export function parseMB(spec: string): number | undefined {
  const match = /^(\d+(?:[.,]\d+)?)\s*(MB|GB)$/i.exec(spec.trim());
  if (!match) return undefined;
  const value = Number(match[1]!.replace(",", "."));
  return Math.round(match[2]!.toUpperCase() === "GB" ? value * 1024 : value);
}

const fmtMB = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1).replace(".", ",")} GB` : `${mb} MB`);

/** Versão mínima de um `>=22` / `>=3.12`: compara só major (e minor, se houver). */
function atLeast(found: string, spec: string): boolean {
  const need = /(\d+)(?:\.(\d+))?/.exec(spec);
  const have = /(\d+)(?:\.(\d+))?/.exec(found);
  if (!need || !have) return true;
  const [nMajor, nMinor] = [Number(need[1]), Number(need[2] ?? 0)];
  const [hMajor, hMinor] = [Number(have[1]), Number(have[2] ?? 0)];
  return hMajor > nMajor || (hMajor === nMajor && hMinor >= nMinor);
}

/** Cada requisito do app verificado agora, nesta máquina. */
export function checkRequirements(entry: Pick<CatalogApp, "requires">, probe: MachineProbe): RequirementResult[] {
  return entry.requires.map((requirement) => checkOne(requirement, probe));
}

function checkOne(requirement: AppRequirement, probe: MachineProbe): RequirementResult {
  const base = { kind: requirement.kind, spec: requirement.spec, ...(requirement.sudoHint ? { sudoHint: requirement.sudoHint } : {}) };
  switch (requirement.kind) {
    case "python": {
      const system = probe.which("python3");
      // O Python do sistema nunca é usado: o uv traz o dele para a pasta de runtimes.
      const have = probe.runtimeInstalled("uv");
      return { ...base, status: have ? "ok" : "baixa", label: `Python ${requirement.spec.replace(/^>=/, "")}+`, found: have ? "Python do uv, já baixado" : system ? "o do sistema não é usado; o uv baixa o dele" : "nenhum no sistema; o uv baixa o dele" };
    }
    case "node": {
      const ok = atLeast(probe.nodeVersion, requirement.spec);
      return { ...base, status: ok ? "ok" : "falta", label: `Node ${requirement.spec.replace(/^>=/, "")}+`, found: `Node ${probe.nodeVersion}`, ...(ok ? {} : { sudoHint: requirement.sudoHint }) };
    }
    case "binary": {
      const bin = requirement.spec.replace(/[<>=].*$/, "");
      const found = probe.which(bin);
      if (found) return { ...base, status: "ok", label: bin, found };
      return { ...base, status: requirement.provision ? "baixa" : "falta", label: bin, found: requirement.provision ? "será baixado para a pasta da plataforma" : "não encontrado" };
    }
    case "chrome": {
      const found = probe.which("google-chrome") ?? probe.which("chromium") ?? probe.which("chromium-browser");
      return { ...base, status: found ? "ok" : requirement.provision ? "baixa" : "falta", label: requirement.spec, ...(found ? { found } : { found: requirement.provision ? "será baixado para a pasta do app" : "não encontrado" }) };
    }
    case "gpu":
      return { ...base, status: "ok", label: "Placa de vídeo", found: requirement.spec };
    case "ram": {
      const need = parseMB(requirement.spec) ?? 0;
      const total = probe.totalMemMB();
      const avail = probe.availMemMB();
      const label = `RAM livre: ${fmtMB(need)}`;
      if (total < need) return { ...base, status: "falta", label, found: `${fmtMB(total)} no total` };
      if (avail < need) return { ...base, status: "aviso", label, found: `${fmtMB(avail)} livres agora (de ${fmtMB(total)}); pode ficar lento` };
      return { ...base, status: "ok", label, found: `${fmtMB(avail)} livres agora` };
    }
    case "disk": {
      const need = parseMB(requirement.spec) ?? 0;
      const free = probe.diskFreeMB();
      const label = `Espaço em disco: ${fmtMB(need)}`;
      return { ...base, status: free >= need ? "ok" : "falta", label, found: `${fmtMB(free)} livres` };
    }
  }
}

/** O instalador sabe baixar o runtime para este sistema? (hoje: Linux x64 e arm64) */
export function platformSupported(probe: Pick<MachineProbe, "platform" | "arch">): boolean {
  return `${platformKey(probe.platform, probe.arch)}` in RUNTIMES.uv.targets;
}
