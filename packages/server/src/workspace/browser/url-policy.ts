import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Para onde o navegador compartilhado pode ir. Só http(s): nada de `file://`, `chrome://` & cia
 * (sempre). Endereços locais (loopback, rede local, link-local, CGNAT, multicast…) ficam bloqueados
 * por padrão, para o agente não alcançar o próprio app nem outras máquinas da rede; o nome do site
 * também é resolvido (um domínio que aponta para um IP local é bloqueado). Vale para a navegação e
 * para cada requisição da página (uma página pública não faz o navegador buscar nada na rede
 * local). A política de acesso do workspace (Configurações → Acesso dos agentes) pode liberar a rede
 * local e ter listas de domínios permitidos/bloqueados; é lida a cada navegação (muda na hora).
 * `blockedHosts` vem do server (ex.: o endereço público do app).
 */

/** A parte da política de acesso do workspace que vale aqui. */
export type UrlAccess = { allowLocalNetwork: boolean; allowedDomains: readonly string[]; blockedDomains: readonly string[] };

export type UrlPolicyOptions = {
  /** Política do workspace (padrão: rede local bloqueada, sem listas). */
  access?: () => UrlAccess;
  /** Domínios sempre bloqueados (configuração do server). */
  blockedHosts?: readonly string[];
  /** SÓ NOS TESTES: libera endereços locais (a página de teste é servida em 127.0.0.1). */
  allowPrivateNetwork?: boolean;
  /** Resolve um nome para os IPs (padrão: o DNS do sistema). */
  resolve?: (hostname: string) => Promise<string[]>;
};

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

const LOCAL_NAMES = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home\.arpa)$/i;

/** IPv4 em números (ou null). */
function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

/** Endereço que não é da internet pública (loopback, privado, link-local, CGNAT, multicast, reservado…)? */
export function isPrivateAddress(ip: string): boolean {
  const address = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = ipv4Parts(address);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(address) !== 6) return true; // não é IP: quem chama trata nomes
  if (address === "::" || address === "::1") return true;
  // IPv4 dentro do IPv6 (::ffff:10.0.0.1, ::10.0.0.1, 64:ff9b::/96 com o IPv4 no fim).
  const embedded = /(?:^::(?:ffff:)?|^64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (embedded) return isPrivateAddress(embedded[1]!);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (mapped) {
    const high = parseInt(mapped[1]!, 16);
    const low = parseInt(mapped[2]!, 16);
    return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  const first = parseInt(address.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 (ULA)
    (first & 0xffc0) === 0xfe80 || // fe80::/10 (link-local)
    (first & 0xffc0) === 0xfec0 || // fec0::/10 (site-local, antigo)
    (first & 0xff00) === 0xff00 || // multicast
    address.startsWith("2001:db8:") // documentação
  );
}

/** Domínio de uma lista (sem esquema, porta, caminho nem "*."), em minúsculas. */
export function normalizeDomain(entry: string): string {
  return entry
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#:].*$/, "")
    .replace(/^\*?\.+/, "")
    .replace(/\.$/, "");
}

/** O host é o domínio (ou um subdomínio) de algum da lista? */
function matchesDomain(hostname: string, domains: readonly string[]): boolean {
  return domains.some((raw) => {
    const domain = normalizeDomain(raw);
    return domain !== "" && (hostname === domain || hostname.endsWith(`.${domain}`));
  });
}

async function systemResolve(hostname: string): Promise<string[]> {
  const found = await lookup(hostname, { all: true, verbatim: true });
  return found.map((entry) => entry.address);
}

/** Cache curto das resoluções (cada requisição da página passa por aqui). */
const RESOLVE_TTL_MS = 60_000;

const NO_ACCESS: UrlAccess = { allowLocalNetwork: false, allowedDomains: [], blockedDomains: [] };

export class UrlPolicy {
  private readonly resolved = new Map<string, { at: number; private: boolean }>();

  constructor(private readonly options: UrlPolicyOptions = {}) {}

  private access(): UrlAccess {
    return this.options.access?.() ?? NO_ACCESS;
  }

  /** Confere um endereço digitado pelo agente ou pelo usuário (sem esquema = https://). */
  async check(raw: string): Promise<UrlVerdict> {
    const text = raw.trim();
    if (!text) return { ok: false, reason: "Empty URL" };
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^:/]+:\d+(\/|$)/.test(text) ? text : `https://${text}`);
    } catch {
      return { ok: false, reason: `Invalid URL: ${text}` };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: `Only http and https pages are allowed (blocked: ${url.protocol}//)` };
    if (url.username || url.password) return { ok: false, reason: "URLs with a user/password are not allowed" };
    const host = await this.hostVerdict(url.hostname, true);
    return host ? { ok: false, reason: host } : { ok: true, url };
  }

  /**
   * Requisição da página: pode sair? A rede local vale para tudo (imagem, script, fetch,
   * websocket); as listas de domínios do workspace, só para navegações (`navigation`): um site
   * permitido continua carregando o que vem de CDNs.
   */
  async allowsRequest(raw: string, navigation = false): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    if (url.protocol === "data:" || url.protocol === "blob:" || url.href === "about:blank") return true;
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
    return (await this.hostVerdict(url.hostname, navigation)) === null;
  }

  /** null = liberado; senão o motivo (em inglês: vai para o modelo). */
  private async hostVerdict(rawHost: string, navigation: boolean): Promise<string | null> {
    const hostname = rawHost.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    if (!hostname) return "URL without a host";
    const access = this.access();
    if (matchesDomain(hostname, this.options.blockedHosts ?? [])) return `The site ${hostname} is blocked for the office browser`;
    if (navigation) {
      if (matchesDomain(hostname, access.blockedDomains)) return `The site ${hostname} is blocked in this workspace's access settings`;
      const allowed = access.allowedDomains.map(normalizeDomain).filter(Boolean);
      if (allowed.length > 0 && !matchesDomain(hostname, allowed)) return `This workspace only allows these sites: ${allowed.join(", ")}`;
    }
    if (this.options.allowPrivateNetwork || access.allowLocalNetwork) return null;
    const local = "Local network addresses (localhost, LAN, the office app itself) are blocked for the office browser";
    if (isIP(hostname)) return isPrivateAddress(hostname) ? local : null;
    if (LOCAL_NAMES.test(hostname) || !hostname.includes(".")) return local;
    const cached = this.resolved.get(hostname);
    if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.private ? local : null;
    let addresses: string[];
    try {
      addresses = await (this.options.resolve ?? systemResolve)(hostname);
    } catch {
      // Nome que não resolve: o próprio navegador vai falhar; não há o que proteger.
      return null;
    }
    const isPrivate = addresses.some((address) => isPrivateAddress(address));
    if (this.resolved.size > 2000) this.resolved.clear();
    this.resolved.set(hostname, { at: Date.now(), private: isPrivate });
    return isPrivate ? local : null;
  }
}
