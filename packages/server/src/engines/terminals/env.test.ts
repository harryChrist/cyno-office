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

  it("continua removendo ANTHROPIC_*, GEMINI_*, OPENAI_*, GOOGLE_API_KEY, CLAUDECODE e preserva TERM/CLAUDE_CODE_OAUTH_TOKEN", () => {
    const result = sanitizeChildEnv(
      {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-ant-1",
        ANTHROPIC_BASE_URL: "https://evil.example",
        ANTHROPIC_AUTH_TOKEN: "tok",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-assinatura",
        CLAUDECODE: "1",
        GEMINI_API_KEY: "gem-1",
        GOOGLE_API_KEY: "goog-1",
        OPENAI_API_KEY: "oa-1",
      },
      {
        TERM: "xterm-256color",
        ANTHROPIC_API_KEY: "nao-pode-voltar",
      },
    );

    expect(result.PATH).toBe("/usr/bin");
    expect(result.TERM).toBe("xterm-256color");
    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-assinatura");
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(result.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(result.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(result.CLAUDECODE).toBeUndefined();
    expect(result.GEMINI_API_KEY).toBeUndefined();
    expect(result.GOOGLE_API_KEY).toBeUndefined();
    expect(result.OPENAI_API_KEY).toBeUndefined();
  });
});
