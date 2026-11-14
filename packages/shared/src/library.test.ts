import { describe, expect, it } from "vitest";
import { createLibraryConnectorBodySchema, libraryAppSchema, librarySkillSchema, libraryUsage, setLibraryGrantsBodySchema } from "./library";

describe("Biblioteca: schemas", () => {
  it("conector: HTTP precisa de URL, stdio de comando; liberações são opcionais (nada vem liberado por padrão)", () => {
    expect(createLibraryConnectorBodySchema.safeParse({ name: "Fetch", kind: "http" }).success).toBe(false);
    expect(createLibraryConnectorBodySchema.safeParse({ name: "Fetch", kind: "stdio" }).success).toBe(false);
    const ok = createLibraryConnectorBodySchema.parse({ name: "Fetch", kind: "stdio", command: "uvx", args: ["mcp-server-fetch"], description: "Lê páginas" });
    expect(ok.grants).toBeUndefined();
    expect(createLibraryConnectorBodySchema.safeParse({ name: "X", kind: "ftp", url: "https://x" }).success).toBe(false);
  });

  it("liberações: o mapa inteiro de workspace -> agentes, com agentes vazios por padrão", () => {
    expect(setLibraryGrantsBodySchema.parse({ grants: { principal: {} } })).toEqual({ grants: { principal: { agentIds: [] } } });
    expect(setLibraryGrantsBodySchema.safeParse({ grants: { "Id Inválido": { agentIds: [] } } }).success).toBe(false);
  });

  it("skill e app já existem com padrões (as próximas fatias não brigam pelo shared)", () => {
    const skill = librarySkillSchema.parse({ id: "cyno-selftest", name: "Selftest", description: "x", origin: { kind: "manual" } });
    expect(skill).toMatchObject({ grants: {}, requires: [], readonly: false, usage: { reads: 0 } });
    const app = libraryAppSchema.parse({ id: "markitdown", catalogId: "markitdown", name: "MarkItDown", version: "1.0.0", dir: "apps/markitdown", license: { spdx: "MIT", level: "livre" }, installedAt: "2026-11-11T12:00:00.000Z" });
    expect(app).toMatchObject({ state: "instalando", requires: [], provides: { connectorIds: [], skillIds: [] } });
  });

  it("libraryUsage conta workspaces e agentes", () => {
    const avatar = { skin: "a", hair: "b", hairColor: "c", shirt: "d", pants: "e" };
    expect(libraryUsage({ uses: [{ workspaceId: "a", workspaceName: "A", agents: [{ id: "x", name: "X", avatar, maestro: false }] }, { workspaceId: "b", workspaceName: "B", agents: [] }] })).toEqual({ workspaces: 2, agents: 1 });
  });
});
