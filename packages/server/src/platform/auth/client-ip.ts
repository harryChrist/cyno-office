import { isIP } from "node:net";

type Header = string | string[] | undefined;

/** Normaliza o IP (tira o "::ffff:" do IPv4 mapeado, a zona do IPv6 e a caixa). */
export function normalizeIp(raw: string): string {
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  const zone = ip.indexOf("%");
  if (zone > 0) ip = ip.slice(0, zone);
  if (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return ip;
}

export function isLoopback(raw: string): boolean {
  const ip = normalizeIp(raw);
  return ip === "::1" || ip === "0:0:0:0:0:0:0:1" || (isIP(ip) === 4 && ip.startsWith("127."));
}

const hops = (value: Header): string[] =>
  (Array.isArray(value) ? value.join(",") : (value ?? ""))
    .split(",")
    .map((hop) => normalizeIp(hop))
    .filter((hop) => isIP(hop) !== 0);

/**
 * O IP real de quem fez a requisição. Os proxies confiáveis são só os que falam pelo loopback
 * (o proxy do Vite, cloudflared, nginx ou Caddy na mesma máquina). Cabeçalhos só valem quando o
 * socket é loopback; senão vale o endereço do socket.
 *
 * O proxy do Vite ACRESCENTA o IP de quem falou com ele no fim do `x-forwarded-for`: o que o cliente
 * mandou fica à esquerda e não é confiável. Lê-se o salto mais à direita; se for loopback, há outro
 * proxy local na frente: usa-se o `cf-connecting-ip` (que o Cloudflare define) se existir, senão o salto
 * anterior, e assim por diante enquanto for loopback.
 */
export function resolveClientIp(input: { socket: string | undefined; xForwardedFor?: Header; cfConnectingIp?: Header }): string {
  const socket = normalizeIp(input.socket ?? "") || "unknown";
  if (!isLoopback(socket)) return socket;
  const chain = hops(input.xForwardedFor);
  if (chain.length === 0) return socket;
  const cf = hops(input.cfConnectingIp)[0];
  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = chain[i]!;
    if (!isLoopback(hop)) return hop;
    if (cf && !isLoopback(cf)) return cf;
  }
  return chain[0]!;
}
