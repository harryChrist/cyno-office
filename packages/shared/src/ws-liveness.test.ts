import { describe, expect, it } from "vitest";
import { parseServerEvent } from "./events";
import { createWsLiveness, isWsHeartbeat, WS_HEARTBEAT_MS, WS_HEARTBEAT_WIRE, WS_SILENCE_LIMIT_MS, WS_WAKE_SILENCE_MS } from "./ws-liveness";

describe("aviso de vida dos WebSockets", () => {
  it("a batida não é um evento: os leitores de evento a ignoram", () => {
    expect(isWsHeartbeat(WS_HEARTBEAT_WIRE)).toBe(true);
    expect(isWsHeartbeat('{"type":"task:upserted"}')).toBe(false);
    expect(parseServerEvent(WS_HEARTBEAT_WIRE)).toBeNull();
  });

  it("os limites deixam perder uma batida ao voltar para a frente e duas com a página parada", () => {
    expect(WS_WAKE_SILENCE_MS).toBeGreaterThan(WS_HEARTBEAT_MS);
    expect(WS_SILENCE_LIMIT_MS).toBeGreaterThan(2 * WS_HEARTBEAT_MS);
  });

  it("o silêncio só conta depois da primeira batida ouvida na conexão, e qualquer mensagem o zera", () => {
    let clock = 1000;
    const liveness = createWsLiveness(() => clock);
    clock += 500_000;
    expect(liveness.silentFor()).toBe(0);
    liveness.seen('{"type":"task:upserted"}');
    clock += 500_000;
    expect(liveness.silentFor()).toBe(0);
    liveness.seen(WS_HEARTBEAT_WIRE);
    clock += 45_000;
    expect(liveness.silentFor()).toBe(45_000);
    liveness.seen('{"type":"task:upserted"}');
    expect(liveness.silentFor()).toBe(0);
    clock += 80_000;
    expect(liveness.silentFor()).toBe(80_000);
    liveness.reset();
    clock += 80_000;
    expect(liveness.silentFor()).toBe(0);
  });
});
