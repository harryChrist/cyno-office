import { describe, expect, it } from "vitest";
import { detectRunMode, updateApplyFromEnv, type RunModeInput } from "./run-mode";

const base: RunModeInput = { env: {}, argv: ["node", "src/index.ts"], execArgv: [], hasGit: true, hasVersionFile: false, dockerEnv: false };

describe("detectRunMode", () => {
  it("pm2: a variável pm_id definida pelo pm2", () => {
    expect(detectRunMode({ ...base, env: { pm_id: "3" } })).toBe("pm2");
    expect(detectRunMode({ ...base, env: { pm_id: "0" } })).toBe("pm2");
  });
  it("docker: sem .git e com version.json, ou /.dockerenv (mesmo com pm_id)", () => {
    expect(detectRunMode({ ...base, hasGit: false, hasVersionFile: true })).toBe("docker");
    expect(detectRunMode({ ...base, dockerEnv: true })).toBe("docker");
    expect(detectRunMode({ ...base, dockerEnv: true, env: { pm_id: "1" } })).toBe("docker");
  });
  it("sem .git e sem version.json não é Docker", () => {
    expect(detectRunMode({ ...base, hasGit: false, hasVersionFile: false })).toBe("start");
  });
  it("dev: npm run dev ou tsx watch", () => {
    expect(detectRunMode({ ...base, env: { npm_lifecycle_event: "dev" } })).toBe("dev");
    expect(detectRunMode({ ...base, env: { npm_lifecycle_script: "tsx watch src/index.ts" } })).toBe("dev");
    expect(detectRunMode({ ...base, argv: ["node", "tsx", "watch", "src/index.ts"] })).toBe("dev");
  });
  it("start: o resto", () => {
    expect(detectRunMode(base)).toBe("start");
    expect(detectRunMode({ ...base, env: { npm_lifecycle_event: "start", npm_lifecycle_script: "tsx src/index.ts" } })).toBe("start");
  });
});

describe("CYNO_UPDATE_APPLY", () => {
  it("ligado por padrão; off e 0 desligam", () => {
    expect(updateApplyFromEnv({})).toBe(true);
    expect(updateApplyFromEnv({ CYNO_UPDATE_APPLY: "on" })).toBe(true);
    expect(updateApplyFromEnv({ CYNO_UPDATE_APPLY: "off" })).toBe(false);
    expect(updateApplyFromEnv({ CYNO_UPDATE_APPLY: " OFF " })).toBe(false);
    expect(updateApplyFromEnv({ CYNO_UPDATE_APPLY: "0" })).toBe(false);
  });
});
