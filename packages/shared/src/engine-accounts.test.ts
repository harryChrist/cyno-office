import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ENGINES,
  createEngineAccountSchema,
  DEFAULT_ACCOUNT_ID,
  ENGINE_ACCOUNTS_PATH,
  engineAccountItemPath,
  engineAccountSchema,
  patchEngineAccountSchema,
} from "./engine-accounts";
import {
  engineAccountLoginPath,
  engineLoginClientMessageSchema,
  engineLoginServerMessageSchema,
} from "./engine-login";
import { INSTALLABLE_ENGINE_IDS, isInstallableEngineId } from "./engine-status";
import { subscriptionUsageSchema, usageKey, usageRefreshBodySchema } from "./usage";

describe("engine-accounts e usageKey", () => {
  it("valida schemas de conta e caminhos das rotas", () => {
    expect(ACCOUNT_ENGINES).toEqual(["claude", "gemini"]);
    expect(ENGINE_ACCOUNTS_PATH).toBe("/api/engines/accounts");
    expect(engineAccountItemPath("trabalho-1")).toBe("/api/engines/accounts/trabalho-1");

    expect(createEngineAccountSchema.parse({ engine: "claude", label: "  Trabalho  " })).toEqual({ engine: "claude", label: "Trabalho" });
    expect(patchEngineAccountSchema.parse({ label: "  Pessoal  " })).toEqual({ label: "Pessoal" });
    expect(() => createEngineAccountSchema.parse({ engine: "freebuff", label: "x" })).toThrow();
    expect(() => createEngineAccountSchema.parse({ engine: "claude", label: "   " })).toThrow();
    expect(() => createEngineAccountSchema.parse({ engine: "claude", label: "a".repeat(41) })).toThrow();

    const valid = engineAccountSchema.parse({
      id: "trabalho-1",
      engine: "gemini",
      label: "Trabalho",
      createdAt: "2026-11-23T00:00:00.000Z",
    });
    expect(valid.id).toBe("trabalho-1");

    for (const badId of ["ab", "-abc", "abc-", "../etc", "a/b", "ABC", "a".repeat(41)]) {
      expect(engineAccountSchema.safeParse({ id: badId, engine: "claude", label: "X", createdAt: "2026-11-23T00:00:00.000Z" }).success).toBe(false);
    }
  });

  it("usageKey separa conta padrão (só provedor) e contas extras", () => {
    expect(usageKey("claude")).toBe("claude");
    expect(usageKey("claude", undefined)).toBe("claude");
    expect(usageKey("claude", "trabalho")).toBe("claude:trabalho");
    expect(usageKey("gemini", "conta-2")).toBe("gemini:conta-2");
  });

  it("subscriptionUsageSchema e usageRefreshBodySchema aceitam accountId opcional", () => {
    const base = { provider: "claude", windows: [], updatedAt: "2026-11-23T00:00:00.000Z" };
    expect(subscriptionUsageSchema.parse(base).accountId).toBeUndefined();
    expect(subscriptionUsageSchema.parse({ ...base, accountId: "trabalho" }).accountId).toBe("trabalho");
    expect(subscriptionUsageSchema.safeParse({ ...base, accountId: "../x" }).success).toBe(false);

    expect(usageRefreshBodySchema.parse({})).toEqual({ provider: "claude" });
    expect(usageRefreshBodySchema.parse({ provider: "gemini", accountId: "pessoal" })).toEqual({ provider: "gemini", accountId: "pessoal" });
    expect(usageRefreshBodySchema.safeParse({ provider: "claude", accountId: "ab" }).success).toBe(false);
  });

  it("protocolo de login (engine-login) e motores instaláveis", () => {
    expect(DEFAULT_ACCOUNT_ID).toBe("padrao");
    expect(INSTALLABLE_ENGINE_IDS).toEqual(["claude", "gemini", "openclaw", "hermes"]);
    expect(isInstallableEngineId("claude")).toBe(true);
    expect(isInstallableEngineId("gemini")).toBe(true);
    expect(isInstallableEngineId("freebuff")).toBe(false);

    expect(engineAccountLoginPath("trabalho")).toBe("/api/engines/accounts/trabalho/login");
    expect(engineAccountLoginPath("padrao", "gemini")).toBe("/api/engines/accounts/padrao/login?engine=gemini");

    expect(engineLoginClientMessageSchema.parse({ type: "in", data: "abc\r" })).toEqual({ type: "in", data: "abc\r" });
    expect(engineLoginClientMessageSchema.parse({ type: "resize", cols: 100, rows: 30 })).toEqual({ type: "resize", cols: 100, rows: 30 });
    expect(engineLoginClientMessageSchema.safeParse({ type: "resize", cols: 5, rows: 30 }).success).toBe(false);
    expect(engineLoginClientMessageSchema.safeParse({ type: "shell" }).success).toBe(false);

    expect(engineLoginServerMessageSchema.parse({ type: "hello", engine: "claude", label: "Padrão" })).toEqual({ type: "hello", engine: "claude", label: "Padrão" });
    expect(engineLoginServerMessageSchema.parse({ type: "replay", data: "oi" })).toEqual({ type: "replay", data: "oi" });
    expect(engineLoginServerMessageSchema.parse({ type: "out", data: "url" })).toEqual({ type: "out", data: "url" });
    expect(engineLoginServerMessageSchema.parse({ type: "login", loggedIn: true })).toEqual({ type: "login", loggedIn: true });
    expect(engineLoginServerMessageSchema.parse({ type: "exit", code: 0 })).toEqual({ type: "exit", code: 0 });
  });
});
