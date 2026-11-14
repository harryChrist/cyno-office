import type { Connector } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { CONNECTOR_BRANDS } from "./brands.generated";
import {
  applyConnectorEvent,
  connectorForTool,
  connectorStatus,
  connectorsOfAgent,
  createBody,
  EMPTY_FORM,
  expireActivity,
  formErrors,
  formFromCandidate,
  formFromConnector,
  iconLook,
  monogram,
  patchBody,
  recordActivity,
  searchBrands,
  suggestBrand,
} from "./connectorView";

const NOTION: Connector = {
  id: "notion",
  name: "Notion",
  kind: "http",
  url: "https://mcp.notion.com/mcp",
  secretHeaders: ["Authorization", "X-Workspace"],
  secretEnv: [],
  icon: { kind: "brand", slug: "notion" },
  enabled: true,
  agentIds: ["maestro", "clara"],
  toolPrefix: "notion",
  origin: "manual",
  status: { state: "connected", tools: [{ name: "create_page" }] },
  createdAt: "2026-11-08T12:00:00.000Z",
  updatedAt: "2026-11-08T12:00:00.000Z",
};

describe("lista de conectores", () => {
  it("aplica connector:upserted/deleted; antes do GET (null) ignora", () => {
    expect(applyConnectorEvent(null, { type: "connector:upserted", connector: NOTION })).toBeNull();
    const list = applyConnectorEvent([], { type: "connector:upserted", connector: NOTION })!;
    expect(list).toEqual([NOTION]);
    const renamed = applyConnectorEvent(list, { type: "connector:upserted", connector: { ...NOTION, name: "N" } })!;
    expect(renamed[0]!.name).toBe("N");
    expect(applyConnectorEvent(renamed, { type: "connector:deleted", id: "notion" })).toEqual([]);
    expect(applyConnectorEvent(renamed, { type: "connector:deleted", id: "outro" })).toBe(renamed);
  });

  it("estado: texto e cor (desligado vence o estado guardado)", () => {
    expect(connectorStatus(NOTION)).toEqual({ tone: "success", label: "Conectado", dot: "ok" });
    expect(connectorStatus({ ...NOTION, status: { state: "needs_auth", tools: [] } }).label).toBe("Precisa de login");
    expect(connectorStatus({ ...NOTION, status: { state: "error", reason: "x", tools: [] } }).tone).toBe("danger");
    expect(connectorStatus({ ...NOTION, enabled: false }).label).toBe("Desligado");
    expect(connectorStatus({ ...NOTION, status: { state: "unknown", tools: [] } }).label).toBe("Não testado");
  });

  it("conectores de um agente e ferramenta do log → conector", () => {
    expect(connectorsOfAgent([NOTION], "clara")).toEqual([NOTION]);
    expect(connectorsOfAgent([NOTION], "beto")).toEqual([]);
    expect(connectorForTool([NOTION], "mcp__office__notion__create_page")).toEqual({ connector: NOTION, tool: "create_page" });
    expect(connectorForTool([NOTION], "mcp__office__entregar")).toBeNull();
    expect(connectorForTool([NOTION], "mcp__office__github__x")).toBeNull();
  });

  it("atividade: guarda por conector e por agente; expira só a mesma marca", () => {
    const empty = { byConnector: {}, byAgent: {} };
    const first = recordActivity(empty, { connectorId: "notion", agentId: "clara", tool: "create_page", phase: "started", at: "x" }, 1);
    expect(first.byAgent.clara).toMatchObject({ connectorId: "notion", running: true, at: 1 });
    const second = recordActivity(first, { connectorId: "notion", agentId: "clara", tool: "create_page", phase: "finished", ok: true, at: "x" }, 2);
    // A marca velha (1) não apaga a nova (2).
    expect(expireActivity(second, first.mark)).toBe(second);
    expect(expireActivity(second, second.mark)).toEqual({ byConnector: {}, byAgent: {} });
  });
});

describe("ícones", () => {
  it("o conjunto curado tem as marcas que importam e cores válidas", () => {
    for (const slug of ["notion", "github", "pastebin", "gitlab", "googledrive", "n8n"]) expect(CONNECTOR_BRANDS.some((brand) => brand.slug === slug)).toBe(true);
    for (const brand of CONNECTOR_BRANDS) expect(brand.hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("monograma, contraste e contorno para marca preta", () => {
    expect(monogram("Meu Sistema")).toBe("MS");
    expect(monogram("pastebin")).toBe("PA");
    expect(monogram("")).toBe("?");
    const notion = iconLook(NOTION);
    expect(notion).toMatchObject({ background: "#000000", foreground: "#ffffff", outlined: true });
    expect(notion.brand?.slug).toBe("notion");
    const own = iconLook({ id: "x", name: "Sistema X", icon: { kind: "monogram" } });
    expect(own.text).toBe("SX");
    expect(own.outlined).toBe(false);
    // Cor clara (amarelo) = letra preta.
    expect(iconLook({ id: "y", name: "Y", icon: { kind: "monogram" }, color: "#ffe600" }).foreground).toBe("#111111");
  });

  it("sugere a marca pelo nome ou pelo domínio; busca por nome", () => {
    expect(suggestBrand("Google Drive")?.slug).toBe("googledrive");
    expect(suggestBrand("Notas", "https://mcp.notion.com/mcp")?.slug).toBe("notion");
    expect(suggestBrand("Meu sistema", "http://192.168.1.20:7575/api/mcp")).toBeUndefined();
    expect(searchBrands("git").map((brand) => brand.slug)).toEqual(expect.arrayContaining(["github", "gitlab", "gitea"]));
  });
});

describe("formulário do conector", () => {
  it("criar: token vira Authorization: Bearer; argumentos um por linha", () => {
    const http = createBody({ ...EMPTY_FORM, name: " Notion ", url: "https://mcp.notion.com/mcp", bearer: "abc123", iconKind: "brand", brand: "notion", agentIds: ["clara"] });
    expect(http).toEqual({ name: "Notion", kind: "http", url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer abc123" }, icon: { kind: "brand", slug: "notion" }, enabled: true, agentIds: ["clara"], origin: "manual" });
    const stdio = createBody({ ...EMPTY_FORM, name: "GH", kind: "stdio", command: "npx", args: "-y\n @mcp/github \n", secrets: [{ name: "GITHUB_TOKEN", value: "ghp", stored: false, remove: false }] });
    expect(stdio).toMatchObject({ kind: "stdio", command: "npx", args: ["-y", "@mcp/github"], env: { GITHUB_TOKEN: "ghp" }, icon: { kind: "monogram" } });
  });

  it("editar: só os nomes dos segredos; vazio mantém, valor troca, apagar manda null", () => {
    const form = formFromConnector(NOTION);
    expect(form).toMatchObject({ bearerStored: true, url: "", urlPlaceholder: NOTION.url, secrets: [{ name: "X-Workspace", value: "", stored: true, remove: false }] });
    expect(patchBody(NOTION, form)).toEqual({});
    const changed = { ...form, name: "Notion 2", bearer: "novo", secrets: [{ ...form.secrets[0]!, remove: true }], agentIds: ["clara"] };
    expect(patchBody(NOTION, changed)).toEqual({ name: "Notion 2", headers: { Authorization: "Bearer novo", "X-Workspace": null }, agentIds: ["clara"] });
    expect(patchBody(NOTION, { ...form, removeBearer: true })).toEqual({ headers: { Authorization: null } });
  });

  it("valida o mínimo antes de mandar", () => {
    expect(formErrors(EMPTY_FORM, false)).toMatchObject({ name: expect.any(String), url: expect.any(String) });
    expect(formErrors({ ...EMPTY_FORM, name: "X", url: "ftp://x" }, false).url).toMatch(/http/);
    expect(formErrors({ ...EMPTY_FORM, name: "X" }, true)).toEqual({});
    expect(formErrors({ ...EMPTY_FORM, name: "X", kind: "stdio" }, false).command).toBeDefined();
    const dup = { ...EMPTY_FORM, name: "X", url: "https://x.com", secrets: [{ name: "A", value: "1", stored: false, remove: false }, { name: "a", value: "2", stored: false, remove: false }] };
    expect(formErrors(dup, false).secrets).toBe("Nomes repetidos.");
  });

  it("importar: pré-preenche com a marca sugerida; URL com chave fica vazia (o usuário cola)", () => {
    const form = formFromCandidate({ sourceName: "claude.ai Notion", name: "Notion", kind: "http", url: "https://mcp.notion.com/mcp", sourceStatus: "connected", hostedByClaudeAi: true, alreadyImported: false });
    expect(form).toMatchObject({ name: "Notion", url: "https://mcp.notion.com/mcp", iconKind: "brand", brand: "notion", origin: "claude-code" });
    const masked = formFromCandidate({ sourceName: "x", name: "X", kind: "http", url: "https://x.com/mcp?k=•••", urlMasked: true, sourceStatus: "connected", hostedByClaudeAi: false, alreadyImported: false });
    expect(masked.url).toBe("");
    expect(masked.urlPlaceholder).toBe("https://x.com/mcp?k=•••");
  });
});
