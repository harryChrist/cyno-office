import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { findLiveSession, freebuffFolderName } from "./files";
import { FreebuffService, nextDayReset } from "./service";

const tempDir = useTempDirs();
afterEach(() => {
  vi.useRealTimers();
});
const ANA = { workspaceId: "ws", agentId: "ana" };
const BETO = { workspaceId: "ws", agentId: "beto" };
const input = (ref: { workspaceId: string; agentId: string }) => ({ ...ref, agentName: ref.agentId, folder: freebuffFolderName(ref.workspaceId, ref.agentId), cwd: `/tmp/${ref.agentId}`, chatId: "chat-1" });

function clock(start = "2026-11-12T12:00:00.000Z") {
  let now = Date.parse(start);
  return { now: () => new Date(now), advance: (ms: number) => void (now += ms), set: (iso: string) => void (now = Date.parse(iso)) };
}

describe("FreebuffService: a hora aberta", () => {
  it("abre na primeira mensagem, custa o multiplicador do modelo e some quando acaba (avisando quem segurava)", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-12T12:00:00.000Z") });
    const service = await FreebuffService.open(undefined, { now: () => new Date() });
    const expired: string[] = [];
    service.subscribe((event) => event.type === "expired" && expired.push(event.agentId));
    await service.measure({ remaining: 21, total: 21 });
    expect(service.multiplier()).toBe(2); // DeepSeek V4.1 Flash (lista de reserva) = 2x
    const session = await service.openHour(input(ANA));
    expect(session).toMatchObject({ agentId: "ana", multiplier: 2, endsAtSource: "estimated" });
    expect(Date.parse(session!.endsAt) - Date.parse(session!.openedAt)).toBe(3_600_000);
    expect(service.hours()).toMatchObject({ total: 21, remaining: 19, openedSince: 2 });
    await vi.advanceTimersByTimeAsync(3_600_000 + 100); // o relógio do serviço
    expect(service.sessions()).toHaveLength(0);
    expect(expired).toEqual(["ana"]);
    service.close();
  });

  it("teto de horas abertas: o segundo agente não abre (e vê o motivo), o dono da hora nunca espera", async () => {
    const time = clock();
    const service = await FreebuffService.open(undefined, { now: time.now });
    expect(await service.openHour(input(ANA))).toBeDefined();
    expect(await service.openHour(input(BETO))).toBeUndefined();
    expect(service.blockFor(BETO)).toMatchObject({ reason: "hour", holder: "ana" });
    expect(service.blockFor(ANA)).toBeUndefined();
    await service.setSettings({ maxOpenHours: 2 });
    expect(service.blockFor(BETO)).toBeUndefined();
    expect(await service.openHour(input(BETO))).toBeDefined();
    expect(service.detail().sessions).toHaveLength(2);
    service.close();
  });

  it("o pedido na fila já reserva a vaga (dois agentes não começam juntos); a reserva sai quando a hora abre ou o pedido some", async () => {
    const service = await FreebuffService.open(undefined, { now: clock().now });
    service.claim(ANA, "Ana");
    expect(service.blockFor(BETO)).toMatchObject({ reason: "hour", holder: "Ana" });
    expect(service.blockFor(ANA)).toBeUndefined();
    await service.openHour(input(ANA));
    expect(service.detail().pending).toBeUndefined();
    expect(service.blockFor(BETO)).toMatchObject({ reason: "hour" });
    service.close();
    const other = await FreebuffService.open(undefined, { now: clock().now });
    other.claim(ANA, "Ana");
    other.release(ANA);
    expect(other.blockFor(BETO)).toBeUndefined();
    other.close();
  });

  it("sem horas no dia: o saldo (e a carteira) não paga uma hora do modelo escolhido; vira quando o dia vira", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-12T20:00:00.000Z") });
    const service = await FreebuffService.open(undefined, { now: () => new Date() });
    await service.measure({ remaining: 1, total: 21, wallet: 0, resetsInMs: 7 * 3_600_000 });
    expect(service.blockFor(ANA)).toMatchObject({ reason: "quota", resetsAt: "2026-11-13T03:00:00.000Z" });
    await service.setSettings({ model: "DeepSeek V4.1 Flash Slow" }); // 1x cabe em 1 hora
    expect(service.blockFor(ANA)).toBeUndefined();
    await service.setSettings({ model: "DeepSeek V4.1 Flash" });
    // A carteira paga depois do saldo do dia.
    await service.measure({ remaining: 0, total: 21, wallet: 25 });
    expect(service.blockFor(ANA)).toBeUndefined();
    await service.measure({ remaining: 0, total: 21, wallet: 0, resetsInMs: 3_600_000 });
    expect(service.blockFor(ANA)).toMatchObject({ reason: "quota" });
    await vi.advanceTimersByTimeAsync(3_600_000 + 100);
    expect(service.hours()).toMatchObject({ remaining: 21, openedSince: 0 });
    expect(service.blockFor(ANA)).toBeUndefined();
    service.close();
  });

  it("o fim real da hora (do arquivo da sessão) substitui a estimativa; a hora fica gravada e reaparece depois de reiniciar", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "platform", "engine-sessions.json");
    const time = clock();
    const first = await FreebuffService.open(file, { now: time.now });
    await first.openHour(input(ANA));
    await first.setEnd(ANA, Date.parse("2026-11-12T12:57:05.000Z"));
    await first.setChat(ANA, "2026-11-12T12-00-01.000Z");
    await first.setSettings({ maxOpenHours: 2 });
    await first.flush();
    first.close();
    time.advance(10 * 60_000);
    const second = await FreebuffService.open(file, { now: time.now });
    expect(second.sessionOf(ANA)).toMatchObject({ endsAt: "2026-11-12T12:57:05.000Z", endsAtSource: "measured", chatId: "2026-11-12T12-00-01.000Z", folder: freebuffFolderName("ws", "ana") });
    expect(second.settings().maxOpenHours).toBe(2);
    expect(second.detail().sessions[0]).toMatchObject({ hasProcess: false });
    second.close();
    // Passou da hora: nada para reassumir.
    time.advance(60 * 60_000);
    const third = await FreebuffService.open(file, { now: time.now });
    expect(third.sessions()).toHaveLength(0);
    third.close();
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveProperty("sessions");
  });

  it("a hora que o Freebuff retomou (de outro processo) não é cobrada de novo: a estimativa é desfeita uma vez só", async () => {
    const time = clock();
    const service = await FreebuffService.open(undefined, { now: time.now });
    await service.measure({ remaining: 14, total: 21 });
    await service.openHour(input(ANA));
    expect(service.hours().remaining).toBe(12);
    // O arquivo da sessão diz que a hora acaba 41 min depois da nossa abertura + 1 h... ou seja, começou 19 min ANTES de abrirmos.
    await service.setEnd(ANA, Date.parse("2026-11-12T12:41:00.000Z"));
    expect(service.sessionOf(ANA)).toMatchObject({ endsAt: "2026-11-12T12:41:00.000Z", endsAtSource: "measured", openedAt: "2026-11-12T11:41:00.000Z" });
    expect(service.hours()).toMatchObject({ remaining: 14, openedSince: 0 });
    await service.setEnd(ANA, Date.parse("2026-11-12T12:42:00.000Z"));
    expect(service.hours().remaining).toBe(14);
    // Hora aberta de verdade (fim = abertura + 1 h): nada é desfeito.
    const other = await FreebuffService.open(undefined, { now: time.now });
    await other.measure({ remaining: 14, total: 21 });
    await other.openHour(input(BETO));
    await other.setEnd(BETO, time.now().getTime() + 3_600_000 + 2_000);
    expect(other.hours()).toMatchObject({ remaining: 12, openedSince: 2 });
    service.close();
    other.close();
  });

  it("o modelo escolhido: o esforço padrão dele ao trocar, o multiplicador da lista lida e o multiplicador visto na tela", async () => {
    const service = await FreebuffService.open(undefined, { now: clock().now });
    expect(service.settings()).toEqual({ model: "DeepSeek V4.1 Flash", effort: "high", maxOpenHours: 1 });
    await service.setSettings({ model: "DeepSeek V4.1 Flash Slow" });
    expect(service.settings()).toMatchObject({ model: "DeepSeek V4.1 Flash Slow", effort: "low" });
    expect(service.multiplier()).toBe(1);
    await service.setModels([{ name: "Modelo Novo", multiplier: 5, efforts: ["high"], defaultEffort: "high" }]);
    await service.setSettings({ model: "Modelo Novo" });
    expect(service.multiplier()).toBe(5);
    await service.noteMultiplier("Outro", 3);
    await service.setSettings({ model: "Outro", effort: "medium" });
    expect(service.multiplier()).toBe(3);
    expect(service.models().readAt).toBeTruthy();
    service.close();
  });
});

describe("virada do dia e arquivos do Freebuff", () => {
  it("o dia do Freebuff vira às 03:00 UTC (meia-noite em Brasília)", () => {
    expect(new Date(nextDayReset(Date.parse("2026-11-12T12:00:00Z"))).toISOString()).toBe("2026-11-13T03:00:00.000Z");
    expect(new Date(nextDayReset(Date.parse("2026-11-12T02:00:00Z"))).toISOString()).toBe("2026-11-12T03:00:00.000Z");
  });

  it("acha o fim da hora só no arquivo de um dos processos do terminal", async () => {
    const dir = await tempDir();
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "freebuff-live-111.json"), JSON.stringify({ instanceId: "a", ownerPid: 111, expiresAt: 1_000 }));
    await writeFile(path.join(dir, "freebuff-live-222.json"), JSON.stringify({ instanceId: "b", ownerPid: 222, expiresAt: 2_000 }));
    expect(await findLiveSession(dir, [222, 333])).toEqual({ pid: 222, expiresAt: 2_000, instanceId: "b" });
    expect(await findLiveSession(dir, [999])).toBeUndefined();
    expect(await findLiveSession(path.join(dir, "nao-existe"), [111])).toBeUndefined();
  });
});
