import { describe, expect, it } from "vitest";
import { isPrivateAddress, normalizeDomain, UrlPolicy, type UrlAccess } from "./url-policy";

/** DNS falso: nomes conhecidos -> IPs. */
const fakeDns = (table: Record<string, string[]>) => async (hostname: string) => {
  const found = table[hostname];
  if (!found) throw new Error("ENOTFOUND");
  return found;
};

const dns = fakeDns({
  "google.com": ["142.250.79.46"],
  "www.google.com": ["142.250.79.46"],
  "intranet.example.com": ["192.168.1.20"],
  "linkedin.com": ["13.107.42.14"],
  "www.linkedin.com": ["13.107.42.14"],
  "static.licdn.com": ["104.18.1.1"],
  "evil.com": ["::ffff:127.0.0.1"],
});

describe("isPrivateAddress", () => {
  it("rede local, loopback, link-local, CGNAT e afins são privados; IPs públicos não", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.20", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:192.168.0.1", "::ffff:c0a8:0001"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "142.250.79.46", "172.32.0.1", "2606:4700:3032::ac43:86b8", "100.128.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe("UrlPolicy", () => {
  it("só http(s): file://, chrome://, javascript: e data: são recusados sempre", async () => {
    const policy = new UrlPolicy({ resolve: dns, access: () => ({ allowLocalNetwork: true, allowedDomains: [], blockedDomains: [] }) });
    for (const url of ["file:///etc/passwd", "chrome://settings", "javascript:alert(1)", "data:text/html,oi", "about:config", "ftp://x.com"]) {
      expect((await policy.check(url)).ok, url).toBe(false);
    }
    expect(await policy.check("google.com")).toMatchObject({ ok: true });
    expect(((await policy.check("google.com")) as { url: URL }).url.href).toBe("https://google.com/");
  });

  it("bloqueia o próprio app e a rede local: IPs, localhost, nomes .local e domínios que apontam para a LAN", async () => {
    const policy = new UrlPolicy({ resolve: dns });
    for (const url of ["http://192.168.1.20:5173", "localhost:3001", "http://127.0.0.1:3001/api/workspaces", "http://[::1]/", "http://servidor.local/", "http://intranet.example.com/", "http://evil.com/", "http://0x7f000001/", "http://nas/"]) {
      const verdict = await policy.check(url);
      expect(verdict.ok, url).toBe(false);
    }
    expect(await policy.check("https://www.google.com/search?q=pizza")).toMatchObject({ ok: true });
    // Requisições da página (imagem, fetch) também: uma página pública não alcança a LAN.
    expect(await policy.allowsRequest("http://192.168.1.20:3001/api/w/principal/tasks")).toBe(false);
    expect(await policy.allowsRequest("ws://127.0.0.1:3001/ws")).toBe(false);
    expect(await policy.allowsRequest("https://www.google.com/logo.png")).toBe(true);
    expect(await policy.allowsRequest("data:image/png;base64,AAAA")).toBe(true);
    expect(await policy.allowsRequest("file:///etc/passwd")).toBe(false);
  });

  it("domínios bloqueados pelo server (o endereço público do app) e os subdomínios", async () => {
    const policy = new UrlPolicy({ resolve: dns, blockedHosts: ["app.exemplo.com"] });
    expect((await policy.check("https://app.exemplo.com/#/principal")).ok).toBe(false);
    expect((await policy.check("https://a.app.exemplo.com/")).ok).toBe(false);
    expect(await policy.allowsRequest("https://app.exemplo.com/api/x")).toBe(false);
  });

  it("política do workspace: rede local liberada, listas de domínios (com subdomínios) e mudança na hora", async () => {
    let access: UrlAccess = { allowLocalNetwork: false, allowedDomains: [], blockedDomains: [] };
    const policy = new UrlPolicy({ resolve: dns, access: () => access });
    expect((await policy.check("http://192.168.1.20:8080")).ok).toBe(false);

    access = { ...access, allowLocalNetwork: true };
    expect((await policy.check("http://192.168.1.20:8080")).ok).toBe(true);
    expect((await policy.check("file:///etc/passwd")).ok).toBe(false);

    access = { allowLocalNetwork: false, allowedDomains: ["https://LinkedIn.com/feed", "*.google.com"], blockedDomains: [] };
    expect((await policy.check("https://www.linkedin.com/feed")).ok).toBe(true);
    expect((await policy.check("https://www.google.com")).ok).toBe(true);
    const other = await policy.check("https://evil-site.org");
    expect(other).toEqual({ ok: false, reason: "This workspace only allows these sites: linkedin.com, google.com" });
    // A lista vale para navegações; os recursos (CDN) do site permitido continuam carregando.
    expect(await policy.allowsRequest("https://static.licdn.com/app.js")).toBe(true);
    expect(await policy.allowsRequest("https://static.licdn.com/", true)).toBe(false);

    access = { allowLocalNetwork: false, allowedDomains: [], blockedDomains: ["linkedin.com"] };
    expect((await policy.check("https://www.linkedin.com")).ok).toBe(false);
    expect((await policy.check("https://google.com")).ok).toBe(true);
  });

  it("normalizeDomain tira esquema, caminho, porta e curinga", () => {
    expect(normalizeDomain(" https://www.LinkedIn.com:443/feed ")).toBe("www.linkedin.com");
    expect(normalizeDomain("*.google.com")).toBe("google.com");
    expect(normalizeDomain(".exemplo.com.")).toBe("exemplo.com");
  });
});
