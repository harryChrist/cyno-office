import { afterEach, describe, expect, it, vi } from "vitest";
import { McpTokens } from "./tokens";

afterEach(() => {
  vi.useRealTimers();
});

describe("McpTokens: espera das ferramentas de uma CLI subindo", () => {
  it("resolve 'ready' só depois do initialize E do tools/list desta subida (notificações no meio não contam)", async () => {
    const tokens = new McpTokens();
    const token = tokens.issue({ workspaceId: "principal", agentId: "maestro" });
    const wait = tokens.waitForTools(token, 30_000);
    let outcome: string | undefined;
    void wait.done.then((value) => (outcome = value));

    // tools/list sem initialize desta subida não libera.
    tokens.observe(token, "tools/list");
    tokens.observe(token, "initialize");
    tokens.observe(token, "notifications/initialized");
    await Promise.resolve();
    expect(outcome).toBeUndefined();
    tokens.observe(token, "tools/list");
    expect(await wait.done).toBe("ready");
  });

  it("um initialize da subida anterior não conta: cada espera começa do zero", async () => {
    const tokens = new McpTokens();
    const token = tokens.issue({ workspaceId: "principal", agentId: "maestro" });
    tokens.observe(token, "initialize");
    const wait = tokens.waitForTools(token, 30_000);
    tokens.observe(token, "tools/list");
    let outcome: string | undefined;
    void wait.done.then((value) => (outcome = value));
    await Promise.resolve();
    expect(outcome).toBeUndefined();
    tokens.observe(token, "initialize");
    tokens.observe(token, "tools/list");
    expect(await wait.done).toBe("ready");
  });

  it("sem conexão: 'timeout' depois do teto (timers falsos)", async () => {
    vi.useFakeTimers();
    const tokens = new McpTokens();
    const token = tokens.issue({ workspaceId: "principal", agentId: "maestro" });
    const wait = tokens.waitForTools(token, 30_000);
    let outcome: string | undefined;
    void wait.done.then((value) => (outcome = value));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("timeout");
    // Conectar depois não muda nada (e não quebra).
    tokens.observe(token, "initialize");
    tokens.observe(token, "tools/list");
    expect(await wait.done).toBe("timeout");
  });

  it("cancel e revoke encerram a espera com 'cancelled'; token desconhecido também", async () => {
    vi.useFakeTimers();
    const tokens = new McpTokens();
    const token = tokens.issue({ workspaceId: "principal", agentId: "maestro" });
    const cancelled = tokens.waitForTools(token, 30_000);
    cancelled.cancel();
    expect(await cancelled.done).toBe("cancelled");
    const revoked = tokens.waitForTools(token, 30_000);
    tokens.revoke(token);
    expect(await revoked.done).toBe("cancelled");
    expect(await tokens.waitForTools(token, 30_000).done).toBe("cancelled");
    expect(vi.getTimerCount()).toBe(0);
    // Métodos de um token revogado são ignorados.
    tokens.observe(token, "initialize");
    expect(tokens.resolve(token)).toBeUndefined();
  });
});
