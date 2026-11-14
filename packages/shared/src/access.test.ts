import { describe, expect, it } from "vitest";
import { accessSummary, domainAllowed, effectiveAccess, normalizeDomain, updateWorkspaceAccessBodySchema, workspaceAccess } from "./access";

describe("acesso dos agentes", () => {
  it("padrões: internet e navegador ligados, terminal e rede local desligados, aprovação ligada, sem domínios", () => {
    expect(workspaceAccess()).toEqual({
      internet: true,
      browser: true,
      terminal: false,
      approveSensitiveActions: true,
      allowLocalNetwork: false,
      allowedDomains: [],
      blockedDomains: [],
    });
    expect(workspaceAccess({ terminal: true }).terminal).toBe(true);
  });

  it("effectiveAccess: workspace E agente (agente sem campo segue o workspace; sem internet não há navegador)", () => {
    const ws = workspaceAccess({ terminal: true });
    expect(effectiveAccess(ws, {})).toMatchObject({ internet: true, browser: true, terminal: true });
    expect(effectiveAccess(ws, { internet: false })).toMatchObject({ internet: false, browser: false, terminal: true });
    expect(effectiveAccess(ws, { browser: false, terminal: false })).toMatchObject({ internet: true, browser: false, terminal: false });
    // O agente não ganha o que o workspace não permite.
    const closed = workspaceAccess({ internet: false, terminal: false });
    expect(effectiveAccess(closed, { internet: true, browser: true, terminal: true })).toMatchObject({ internet: false, browser: false, terminal: false });
    expect(effectiveAccess(workspaceAccess({ browser: false }), { browser: true }).browser).toBe(false);
  });

  it("domínios: normaliza o que o usuário digita e confere host com subdomínios; bloqueado vence", () => {
    expect(normalizeDomain(" https://www.Exemplo.com.br/caminho?x=1 ")).toBe("www.exemplo.com.br");
    expect(normalizeDomain("*.gov.br")).toBe("gov.br");
    expect(normalizeDomain("exemplo.com:8080")).toBe("exemplo.com");
    expect(normalizeDomain("não é domínio")).toBeUndefined();
    expect(normalizeDomain("")).toBeUndefined();
    const access = { allowedDomains: ["gov.br"], blockedDomains: ["ruim.gov.br"] };
    expect(domainAllowed(access, "www.gov.br")).toBe(true);
    expect(domainAllowed(access, "gov.br")).toBe(true);
    expect(domainAllowed(access, "ruim.gov.br")).toBe(false);
    expect(domainAllowed(access, "exemplo.com")).toBe(false);
    expect(domainAllowed({ allowedDomains: [], blockedDomains: [] }, "qualquer.com")).toBe(true);
  });

  it("resumo: o que pode e o que não pode, na ordem das telas", () => {
    expect(accessSummary(effectiveAccess(workspaceAccess(), {}))).toEqual({ can: ["pesquisar na web", "navegar"], cannot: ["usar o terminal"] });
    expect(accessSummary({ internet: false, browser: false, terminal: true })).toEqual({ can: ["usar o terminal"], cannot: ["pesquisar na web", "navegar"] });
  });

  it("corpo do PUT: normaliza e tira repetidos; inválido, vazio ou campo extra = erro", () => {
    expect(updateWorkspaceAccessBodySchema.parse({ allowedDomains: ["Exemplo.com", "https://exemplo.com/"] })).toEqual({ allowedDomains: ["exemplo.com"] });
    expect(updateWorkspaceAccessBodySchema.safeParse({ allowedDomains: ["a b"] }).success).toBe(false);
    expect(updateWorkspaceAccessBodySchema.safeParse({}).success).toBe(false);
    expect(updateWorkspaceAccessBodySchema.safeParse({ shell: true }).success).toBe(false);
  });
});
