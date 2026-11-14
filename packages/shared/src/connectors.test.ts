import { describe, expect, it } from "vitest";
import {
  CONNECTOR_TOOL_NAME_MAX,
  connectorToolName,
  connectorToolPrefix,
  createConnectorBodySchema,
  OFFICE_TOOL_PREFIX,
  parseConnectorToolName,
  updateConnectorBodySchema,
} from "./connectors";

describe("nomes das ferramentas de conector", () => {
  it("prefixo vem do id: minúsculas, números e hífens, até 20", () => {
    expect(connectorToolPrefix("notion")).toBe("notion");
    expect(connectorToolPrefix("google-drive")).toBe("google-drive");
    expect(connectorToolPrefix("um-nome-de-conector-bem-comprido")).toBe("um-nome-de-conector");
    expect(connectorToolPrefix("--")).toBe("conector");
  });

  it("namespacing: <prefixo>__<ferramenta>, sempre válido para as APIs e dentro do limite", () => {
    expect(connectorToolName("notion", "create_page")).toBe("notion__create_page");
    const weird = connectorToolName("notion", "buscar página/por título");
    expect(weird).toMatch(/^notion__buscar_p_gina_por_t_tulo_[0-9a-z]{5}$/);
    const long = connectorToolName("um-nome-de-conector", "x".repeat(80));
    expect(long.length).toBeLessThanOrEqual(CONNECTOR_TOOL_NAME_MAX);
    expect(`${OFFICE_TOOL_PREFIX}${long}`.length).toBeLessThanOrEqual(64);
    // Dois nomes que viram o mesmo texto limpo não colidem (o hash é do original).
    expect(connectorToolName("a", "x y")).not.toBe(connectorToolName("a", "x/y"));
  });

  it("lê o nome no log (com ou sem mcp__office__) e ignora ferramentas do escritório e embutidas", () => {
    expect(parseConnectorToolName("mcp__office__notion__create_page")).toEqual({ prefix: "notion", tool: "create_page" });
    expect(parseConnectorToolName("google-drive__search")).toEqual({ prefix: "google-drive", tool: "search" });
    expect(parseConnectorToolName("mcp__office__entregar")).toBeNull();
    expect(parseConnectorToolName("mcp__outro__a__b")).toBeNull();
    expect(parseConnectorToolName("Read")).toBeNull();
  });
});

describe("schemas dos conectores", () => {
  it("HTTP precisa de URL http(s) sem usuário/senha; stdio precisa de comando", () => {
    expect(createConnectorBodySchema.safeParse({ name: "Notion", kind: "http", url: "https://mcp.notion.com/mcp" }).success).toBe(true);
    expect(createConnectorBodySchema.safeParse({ name: "Notion", kind: "http" }).success).toBe(false);
    expect(createConnectorBodySchema.safeParse({ name: "X", kind: "http", url: "file:///etc/passwd" }).success).toBe(false);
    expect(createConnectorBodySchema.safeParse({ name: "X", kind: "http", url: "https://user:pw@x.com/mcp" }).success).toBe(false);
    expect(createConnectorBodySchema.safeParse({ name: "Local", kind: "stdio" }).success).toBe(false);
    expect(createConnectorBodySchema.safeParse({ name: "Local", kind: "stdio", command: "npx", args: ["-y", "pkg"] }).success).toBe(true);
    expect(createConnectorBodySchema.safeParse({ name: "Local", kind: "stdio", command: "--evil" }).success).toBe(false);
  });

  it("cabeçalhos: nome válido, sem os que o gateway controla, sem quebra de linha no valor", () => {
    const base = { name: "X", kind: "http", url: "https://x.com/mcp" } as const;
    expect(createConnectorBodySchema.safeParse({ ...base, headers: { Authorization: "Bearer abc" } }).success).toBe(true);
    expect(createConnectorBodySchema.safeParse({ ...base, headers: { "Mcp-Session-Id": "x" } }).success).toBe(false);
    expect(createConnectorBodySchema.safeParse({ ...base, headers: { "X-Key": "a\r\nInjected: 1" } }).success).toBe(false);
  });

  it("PATCH: null apaga um segredo", () => {
    expect(updateConnectorBodySchema.parse({ headers: { Authorization: null } })).toEqual({ headers: { Authorization: null } });
  });
});
