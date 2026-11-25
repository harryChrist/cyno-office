import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "./config";

describe("loadConfig", () => {
  it("usa padrões seguros", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      port: 3068,
      host: "127.0.0.1",
      logLevel: "info",
      // Produção: sem AGENT_RUNNER o modo simulado fica desligado.
      agentRunner: undefined,
      mock: { minMs: 3000, maxMs: 8000, approvalRate: 0.2, subagentRate: 0.4 },
      doneLingerMs: 5000,
      wsHeartbeatMs: 30_000,
      claudeUsagePollMs: 180_000,
    });
    expect(config.dataDir).toBe(path.join(REPO_ROOT, "data"));
    expect(config.terminals).toMatchObject({ claudeAutocompact: "auto", maestroRotateTokens: 0, maestroPty: true, maestroRemoteControl: true });
    expect(config.retention).toMatchObject({ autoRun: true });
    expect(config.retention.claudeProjectsDir.endsWith(path.join(".claude", "projects"))).toBe(true);
  });

  it("ROUTINE_TICK_MS (só teste): padrão 10 min, aceita o valor e recusa abaixo de 1 s", () => {
    expect(loadConfig({}).routineTickMs).toBe(600_000);
    expect(loadConfig({ ROUTINE_TICK_MS: "5000" }).routineTickMs).toBe(5000);
    expect(() => loadConfig({ ROUTINE_TICK_MS: "10" })).toThrow();
  });

  it("autocompact, renovação do Maestro e retenção", () => {
    const config = loadConfig({ CLAUDE_AUTOCOMPACT: "none", MAESTRO_ROTATE_TOKENS: "0", CLAUDE_CONFIG_DIR: "/tmp/cc", RETENTION_AUTO: "0" });
    expect(config.terminals).toMatchObject({ claudeAutocompact: "", maestroRotateTokens: 0 });
    expect(config.retention).toEqual({ claudeProjectsDir: "/tmp/cc/projects", autoRun: false });
    expect(loadConfig({ CLAUDE_AUTOCOMPACT: "200000" }).terminals.claudeAutocompact).toBe("200000");
    // Maestro headless (como os outros agentes) e sem Remote Control, se o usuário quiser.
    expect(loadConfig({ MAESTRO_TERMINAL: "headless", MAESTRO_REMOTE_CONTROL: "0" }).terminals).toMatchObject({ maestroPty: false, maestroRemoteControl: false });
    // Fora da faixa que a CLI aceita (100k–1M): erro ao subir, não um agente que nunca liga.
    expect(() => loadConfig({ CLAUDE_AUTOCOMPACT: "50000" })).toThrow();
    expect(() => loadConfig({ CLAUDE_AUTOCOMPACT: "2000000" })).toThrow();
  });

  it("lê as variáveis de ambiente", () => {
    const config = loadConfig({
      PORT: "4000",
      DATA_DIR: "/tmp/x",
      MOCK_MIN_MS: "10",
      MOCK_MAX_MS: "20",
      MOCK_APPROVAL_RATE: "0",
      DONE_LINGER_MS: "100",
      HOST: "",
      CLAUDE_USAGE_POLL_MS: "0",
    });
    expect(config).toMatchObject({
      port: 4000,
      host: "127.0.0.1",
      dataDir: "/tmp/x",
      mock: { minMs: 10, maxMs: 20, approvalRate: 0 },
      doneLingerMs: 100,
      claudeUsagePollMs: 0,
    });
  });

  it("AGENT_RUNNER=mock liga o modo simulado (só testes); vazio continua desligado", () => {
    expect(loadConfig({ AGENT_RUNNER: "mock" }).agentRunner).toBe("mock");
    expect(loadConfig({ AGENT_RUNNER: "" }).agentRunner).toBeUndefined();
    expect(() => loadConfig({ AGENT_RUNNER: "outro" })).toThrow();
  });

  it("rejeita valores inválidos", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow();
    expect(() => loadConfig({ MOCK_MIN_MS: "50", MOCK_MAX_MS: "10" })).toThrow(/MOCK_MAX_MS/);
    expect(() => loadConfig({ MOCK_APPROVAL_RATE: "1.5" })).toThrow();
    expect(() => loadConfig({ AGENT_RUNNER: "claude" })).toThrow();
  });

  it("no Windows (win32), resolve pastas padrão dos motores a partir de USERPROFILE", () => {
    const config = loadConfig({ USERPROFILE: "/tmp/win-user" }, "win32");
    expect(config.retention.claudeProjectsDir).toBe(path.join(path.resolve("/tmp/win-user", ".claude"), "projects"));
    expect(config.engineStorage.antigravityHome).toBe(path.resolve("/tmp/win-user", ".gemini", "antigravity-cli"));
    expect(config.engineStorage.freebuffHome).toBe(path.join("/tmp/win-user", ".config", "manicode"));
  });
});
