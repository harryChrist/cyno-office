import { describe, expect, it } from "vitest";
import { sanitizeChildEnv } from "./env";

describe("sanitizeChildEnv", () => {
  it("passa HOME e CLAUDE_CONFIG_DIR vindos em extra e sobrescreve os da base", () => {
    const result = sanitizeChildEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/original",
        CLAUDE_CONFIG_DIR: "/home/original/.claude",
        ANTHROPIC_API_KEY: "sk-ant-api-nao-passa",
        GEMINI_API_KEY: "gemini-nao-passa",
      },
      {
        HOME: "/tmp/perfil-gemini/home",
        CLAUDE_CONFIG_DIR: "/tmp/perfil-claude",
      },
    );

    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBe("/tmp/perfil-gemini/home");
    expect(result.CLAUDE_CONFIG_DIR).toBe("/tmp/perfil-claude");
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.GEMINI_API_KEY).toBeUndefined();
  });
});
