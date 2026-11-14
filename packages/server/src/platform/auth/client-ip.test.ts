import { describe, expect, it } from "vitest";
import { isLoopback, normalizeIp, resolveClientIp } from "./client-ip";

const LOCAL = "127.0.0.1";

describe("IP real do cliente", () => {
  it("normaliza IPv4 mapeado e reconhece loopback", () => {
    expect(normalizeIp("::ffff:192.168.0.5")).toBe("192.168.0.5");
    expect(normalizeIp("[2001:DB8::1]")).toBe("2001:db8::1");
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("127.5.5.5")).toBe(true);
    expect(isLoopback("192.168.0.5")).toBe(false);
  });

  it("acesso direto ao server (sem x-forwarded-for): vale o socket", () => {
    expect(resolveClientIp({ socket: LOCAL })).toBe(LOCAL);
    expect(resolveClientIp({ socket: "::ffff:127.0.0.1", cfConnectingIp: "6.6.6.6" })).toBe(LOCAL);
  });

  it("LAN direta pelo Vite: o IP posto pelo Vite (último salto) vale; cabeçalhos forjados são ignorados", () => {
    // O cliente mandou x-forwarded-for e cf-connecting-ip falsos; o Vite acrescentou o IP real no fim.
    const forged = { socket: LOCAL, xForwardedFor: "8.8.8.8, 1.2.3.4, 192.168.1.20", cfConnectingIp: "9.9.9.9" };
    expect(resolveClientIp(forged)).toBe("192.168.1.20");
    expect(resolveClientIp({ ...forged, xForwardedFor: ["8.8.8.8", "192.168.1.20"] })).toBe("192.168.1.20");
    // Trocar o que vem antes não muda o IP.
    expect(resolveClientIp({ ...forged, xForwardedFor: "7.7.7.7, 192.168.1.20" })).toBe("192.168.1.20");
  });

  it("túnel Cloudflare local (cloudflared → Vite): o último salto é loopback, vale o cf-connecting-ip", () => {
    expect(resolveClientIp({ socket: LOCAL, xForwardedFor: "127.0.0.1", cfConnectingIp: "203.0.113.9" })).toBe("203.0.113.9");
    // Mesmo com lixo forjado à esquerda.
    expect(resolveClientIp({ socket: LOCAL, xForwardedFor: "8.8.8.8, 127.0.0.1", cfConnectingIp: "203.0.113.9" })).toBe("203.0.113.9");
  });

  it("nginx/Caddy local (sem cf-connecting-ip): vale o salto anterior ao loopback", () => {
    // nginx pôs o IP real; o Vite acrescentou 127.0.0.1 (o nginx falou com ele pelo loopback).
    expect(resolveClientIp({ socket: LOCAL, xForwardedFor: "198.51.100.7, 127.0.0.1" })).toBe("198.51.100.7");
    expect(resolveClientIp({ socket: LOCAL, xForwardedFor: "198.51.100.7, 127.0.0.1, ::1" })).toBe("198.51.100.7");
  });

  it("tudo loopback: é o próprio dono na máquina", () => {
    expect(resolveClientIp({ socket: LOCAL, xForwardedFor: "127.0.0.1" })).toBe(LOCAL);
  });

  it("socket que não é loopback (porta exposta direto): nenhum cabeçalho vale", () => {
    expect(resolveClientIp({ socket: "172.18.0.1", xForwardedFor: "8.8.8.8", cfConnectingIp: "9.9.9.9" })).toBe("172.18.0.1");
  });

  it("lixo no x-forwarded-for é descartado", () => {
    expect(resolveClientIp({ socket: LOCAL, xForwardedFor: "não-é-ip, , 192.168.1.9" })).toBe("192.168.1.9");
    expect(resolveClientIp({ socket: LOCAL, xForwardedFor: "lixo" })).toBe(LOCAL);
  });
});
