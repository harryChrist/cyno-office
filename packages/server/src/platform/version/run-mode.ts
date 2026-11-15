import { existsSync } from "node:fs";
import type { RunMode } from "@cyno/shared";

export type RunModeInput = {
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  execArgv?: readonly string[];
  /** Existe `.git` na raiz do app. */
  hasGit: boolean;
  /** Existe o `version.json` gravado no build da imagem Docker. */
  hasVersionFile: boolean;
  /** Existe `/.dockerenv`. */
  dockerEnv: boolean;
};

/**
 * Como este processo foi iniciado, para dar a instrução de reinício certa:
 * docker (imagem sem `.git` com `version.json`, ou `/.dockerenv`), pm2 (`pm_id` definido pelo pm2),
 * dev (`tsx watch` / `npm run dev`) e start (o resto).
 */
export function detectRunMode(input: RunModeInput): RunMode {
  const { env } = input;
  if (input.dockerEnv || (!input.hasGit && input.hasVersionFile)) return "docker";
  if (typeof env.pm_id === "string" && env.pm_id !== "") return "pm2";
  const script = env.npm_lifecycle_script ?? "";
  const watching = /\btsx\s+watch\b/.test(script) || input.argv.includes("watch") || (input.execArgv ?? []).some((arg) => arg === "--watch");
  if (env.npm_lifecycle_event === "dev" || watching) return "dev";
  return "start";
}

/** A leitura do ambiente real (a parte impura; `detectRunMode` é a regra). */
export function detectRunModeFromProcess(rootDir: string, hasGit: boolean): RunMode {
  return detectRunMode({
    env: process.env,
    argv: process.argv,
    execArgv: process.execArgv,
    hasGit,
    hasVersionFile: existsSync(`${rootDir}/version.json`),
    dockerEnv: existsSync("/.dockerenv"),
  });
}

/** `CYNO_UPDATE_APPLY=off|0` desliga o botão que baixa a atualização (o aviso continua). */
export function updateApplyFromEnv(env: NodeJS.ProcessEnv): boolean {
  const value = (env.CYNO_UPDATE_APPLY ?? "").trim().toLowerCase();
  return value !== "off" && value !== "0";
}
