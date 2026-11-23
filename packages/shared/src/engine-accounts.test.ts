import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ENGINES,
  createEngineAccountSchema,
  ENGINE_ACCOUNTS_PATH,
  engineAccountItemPath,
  engineAccountSchema,
  patchEngineAccountSchema,
} from "./engine-accounts";
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
});
