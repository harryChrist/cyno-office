import type { LibraryConnector, LibraryWorkspaceInfo } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import {
  LIBRARY_TABS,
  applyLibraryEvent,
  describeDraftChange,
  draftOf,
  filterConnectors,
  filterCounts,
  grantsOf,
  hasProblem,
  hasSecret,
  libraryHash,
  parseLibraryHash,
  sameDraft,
  toggleAgent,
  toggleAllAgents,
  toggleWorkspace,
  usageLabel,
} from "./libraryView";

const AVATAR = { skin: "a", hair: "b", hairColor: "c", shirt: "d", pants: "e" };
const agent = (id: string, name: string, maestro = false) => ({ id, name, avatar: AVATAR, maestro });

const connector = (over: Partial<LibraryConnector> & { id: string }): LibraryConnector => ({
  name: over.id,
  kind: "http",
  url: `https://${over.id}.example/mcp`,
  secretHeaders: [],
  secretEnv: [],
  icon: { kind: "monogram" },
  enabled: true,
  toolPrefix: over.id,
  origin: "manual",
  status: { state: "connected", tools: [{ name: "fetch" }] },
  createdAt: "x",
  updatedAt: "x",
  description: "",
  warnings: [],
  weightTokens: 0,
  grants: {},
  uses: [],
  ...over,
});

const fetchTool = connector({
  id: "fetch",
  name: "Fetch",
  description: "Lê páginas da web",
  grants: { principal: { agentIds: ["clara"], grantedAt: "x" } },
  uses: [{ workspaceId: "principal", workspaceName: "Principal", agents: [agent("clara", "Clara")] }],
});
const docs = connector({ id: "context7", name: "Context7", grants: { principal: { agentIds: [], grantedAt: "x" } }, uses: [{ workspaceId: "principal", workspaceName: "Principal", agents: [] }] });
const broken = connector({ id: "notion", name: "Notion", status: { state: "needs_auth", tools: [] } });
const off = connector({ id: "velho", enabled: false, status: { state: "disabled", tools: [] } });
const all = [fetchTool, docs, broken, off];

describe("endereço da Biblioteca", () => {
  it("monta e lê #/biblioteca/<aba>/<workspace>; sem aba, ou com aba desconhecida, abre no Cérebro", () => {
    expect(libraryHash()).toBe("#/biblioteca/cerebro");
    expect(libraryHash({ tab: "conectores", workspaceId: "meu ws" })).toBe("#/biblioteca/conectores/meu%20ws");
    expect(parseLibraryHash("#/biblioteca/conectores/principal")).toEqual({ tab: "conectores", workspaceId: "principal" });
    expect(parseLibraryHash("#/biblioteca")).toEqual({ tab: "cerebro", workspaceId: null });
    expect(parseLibraryHash("#/biblioteca/nao-existe")).toEqual({ tab: "cerebro", workspaceId: null });
    expect(LIBRARY_TABS.map((tab) => tab.id)).toEqual(["cerebro", "midia", "apps", "conectores", "skills"]);
    expect(parseLibraryHash("#/biblioteca/midia")).toEqual({ tab: "midia", workspaceId: null });
    expect(parseLibraryHash("#/biblioteca/cerebro/principal/global/a.md")).toEqual({ tab: "cerebro", workspaceId: "principal" });
    expect(libraryHash({ tab: "midia", workspaceId: "principal" })).toBe("#/biblioteca/midia/principal");
    expect(libraryHash({ tab: "skills", item: "hyperframes video" })).toBe("#/biblioteca/skills?item=hyperframes%20video");
    expect(parseLibraryHash("#/biblioteca/skills?item=abc")).toEqual({ tab: "skills", workspaceId: null, item: "abc" });
    expect(parseLibraryHash("#/biblioteca/skills")).toEqual({ tab: "skills", workspaceId: null });
    expect(parseLibraryHash("#/biblioteca/conectores/meu%20ws")).toMatchObject({ workspaceId: "meu ws" });
  });
});

describe("filtros e busca", () => {
  it("em uso = tem agente; sem uso = nenhum agente (inclusive só liberado ao workspace); problema = ligado e com erro/login", () => {
    const ids = (filter: Parameters<typeof filterConnectors>[1]["filter"]) => filterConnectors(all, { filter, query: "" }).map((item) => item.id);
    expect(ids("todos")).toEqual(["fetch", "context7", "notion", "velho"]);
    expect(ids("em-uso")).toEqual(["fetch"]);
    expect(ids("sem-uso")).toEqual(["context7", "notion", "velho"]);
    expect(ids("problema")).toEqual(["notion"]);
    expect(hasProblem(off)).toBe(false);
    expect(filterCounts(all)).toEqual({ todos: 4, "em-uso": 1, "sem-uso": 3, problema: 1 });
  });

  it("busca por nome, descrição, ferramenta, workspace e agente (sem acento); filtro por workspace", () => {
    const find = (query: string) => filterConnectors(all, { filter: "todos", query }).map((item) => item.id);
    expect(find("paginas")).toEqual(["fetch"]);
    expect(find("clara")).toEqual(["fetch"]);
    expect(find("principal")).toEqual(["fetch", "context7"]);
    expect(find("fetch")).toEqual(["fetch", "context7"]);
    expect(find("nada")).toEqual([]);
    expect(filterConnectors(all, { filter: "todos", query: "", workspaceId: "principal" }).map((item) => item.id)).toEqual(["fetch", "context7"]);
    expect(filterConnectors(all, { filter: "em-uso", query: "", workspaceId: "outro" })).toEqual([]);
  });

  it("eventos ao vivo: insere, atualiza e remove; antes do GET ignora", () => {
    expect(applyLibraryEvent(null, { type: "library:deleted", kind: "connector", id: "x" })).toBeNull();
    const added = applyLibraryEvent([fetchTool], { type: "library:upserted", kind: "connector", item: docs })!;
    expect(added.map((item) => item.id)).toEqual(["fetch", "context7"]);
    const updated = applyLibraryEvent(added, { type: "library:upserted", kind: "connector", item: { ...docs, name: "Docs" } })!;
    expect(updated[1]!.name).toBe("Docs");
    expect(applyLibraryEvent(updated, { type: "library:deleted", kind: "connector", id: "fetch" })!.map((item) => item.id)).toEqual(["context7"]);
  });

  it("rótulo de uso", () => {
    expect(usageLabel(fetchTool)).toBe("1 workspace · 1 agente");
    expect(usageLabel(docs)).toBe("1 workspace · nenhum agente");
    expect(usageLabel(broken)).toBe("Ninguém usa ainda");
  });
});

describe("rascunho de liberação", () => {
  const principal: LibraryWorkspaceInfo = { id: "principal", name: "Principal", agents: [agent("maestro", "Maestro", true), agent("clara", "Clara")] };
  const outro: LibraryWorkspaceInfo = { id: "outro", name: "Outro", agents: [agent("dora", "Dora")] };

  it("marcar o workspace não marca agentes; marcar agente libera o workspace; desmarcar o workspace tira os agentes", () => {
    const start = draftOf(fetchTool);
    expect(start).toEqual({ principal: { agentIds: ["clara"] } });
    const withOutro = toggleWorkspace(start, "outro", true);
    expect(withOutro.outro).toEqual({ agentIds: [] });
    const dora = toggleAgent({}, "outro", "dora", true);
    expect(dora).toEqual({ outro: { agentIds: ["dora"] } });
    expect(toggleWorkspace(dora, "outro", false)).toEqual({});
    expect(toggleAllAgents(start, principal, true).principal!.agentIds).toEqual(["maestro", "clara"]);
    expect(toggleAllAgents(start, principal, false).principal!.agentIds).toEqual([]);
    expect(grantsOf(withOutro)).toEqual({ principal: { agentIds: ["clara"] }, outro: { agentIds: [] } });
  });

  it("compara sem ordem e descreve o que a mudança faz", () => {
    const before = { principal: { agentIds: ["clara", "maestro"] } };
    expect(sameDraft(before, { principal: { agentIds: ["maestro", "clara"] } })).toBe(true);
    const after = { principal: { agentIds: ["maestro"] }, outro: { agentIds: ["dora"] } };
    expect(sameDraft(before, after)).toBe(false);
    expect(describeDraftChange(before, after, [principal, outro])).toEqual(["Tirar de 1 agente em Principal", "Liberar para Outro (1 agente)"]);
    expect(describeDraftChange(before, {}, [principal, outro])).toEqual(["Retirar de Principal"]);
    expect(describeDraftChange({}, { outro: { agentIds: [] } }, [principal, outro])).toEqual(["Liberar para Outro (sem agentes ainda)"]);
  });

  it("avisa de credencial só quando há segredo (cabeçalho, variável ou chave na URL)", () => {
    expect(hasSecret(fetchTool)).toBe(false);
    expect(hasSecret({ ...fetchTool, secretHeaders: ["Authorization"] })).toBe(true);
    expect(hasSecret({ ...fetchTool, secretEnv: ["TOKEN"] })).toBe(true);
    expect(hasSecret({ ...fetchTool, url: "https://x.example/mcp?key=•••" })).toBe(true);
  });
});
