import type { LibrarySkillView, LibraryWorkspaceInfo } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { libraryHash, parseLibraryHash } from "./libraryView";
import { agentSkillBudget, applySkillEvent, filterSkills, formatBytes, grantBudgetWarnings, randomSelftestPhrase, readsLabel, skillFilterCounts, skillsOfAgent, skillUsageLabel, tokensLabel } from "./skillsView";

const AVATAR = { skin: "a", hair: "b", hairColor: "c", shirt: "d", pants: "e" };
const agent = (id: string, name: string, maestro = false) => ({ id, name, avatar: AVATAR, maestro });

const skill = (over: Partial<LibrarySkillView> & { id: string }): LibrarySkillView => ({
  name: over.id,
  description: "Use quando precisar de algo.",
  origin: { kind: "manual" },
  requires: [],
  files: 1,
  bytes: 100,
  weightTokens: 200,
  indexTokens: 50,
  readonly: false,
  usage: { reads: 0 },
  grants: {},
  version: 1,
  hasPrevious: false,
  createdAt: "x",
  updatedAt: "x",
  warnings: [],
  uses: [],
  ...over,
});

const used = skill({ id: "carrossel", name: "Carrossel de post", description: "Layout de post em HTML", grants: { principal: { agentIds: ["clara"], grantedAt: "x" } }, uses: [{ workspaceId: "principal", workspaceName: "Principal", agents: [agent("clara", "Clara")] }] });
const idle = skill({ id: "pdf", name: "PDF", origin: { kind: "folder", from: "~/.claude/skills", copiedAt: "x" }, warnings: ["Tem o script a.py: o agente só o roda se tiver terminal."] });
const fromApp = skill({ id: "video", name: "Vídeo", origin: { kind: "app", appId: "hyperframes", path: "x" }, readonly: true, grants: { outro: { agentIds: [], grantedAt: "x" } }, uses: [{ workspaceId: "outro", workspaceName: "Outro", agents: [] }] });
const all = [used, idle, fromApp];

describe("filtros e busca das skills", () => {
  it("filtra por uso, aviso, origem e workspace", () => {
    expect(filterSkills(all, { filter: "todas", origin: "todas", query: "" }).map((s) => s.id)).toEqual(["carrossel", "pdf", "video"]);
    expect(filterSkills(all, { filter: "em-uso", origin: "todas", query: "" }).map((s) => s.id)).toEqual(["carrossel"]);
    expect(filterSkills(all, { filter: "sem-uso", origin: "todas", query: "" }).map((s) => s.id)).toEqual(["pdf", "video"]);
    expect(filterSkills(all, { filter: "com-aviso", origin: "todas", query: "" }).map((s) => s.id)).toEqual(["pdf"]);
    expect(filterSkills(all, { filter: "todas", origin: "app", query: "" }).map((s) => s.id)).toEqual(["video"]);
    expect(filterSkills(all, { filter: "todas", origin: "folder", query: "" }).map((s) => s.id)).toEqual(["pdf"]);
    expect(filterSkills(all, { filter: "todas", origin: "todas", query: "", workspaceId: "outro" }).map((s) => s.id)).toEqual(["video"]);
  });

  it("busca sem acento e sem caixa em nome, descrição, workspace e agente", () => {
    const q = (query: string) => filterSkills(all, { filter: "todas", origin: "todas", query }).map((s) => s.id);
    expect(q("CARROSSEL")).toEqual(["carrossel"]);
    expect(q("video")).toEqual(["video"]);
    expect(q("layout de post")).toEqual(["carrossel"]);
    expect(q("clara")).toEqual(["carrossel"]);
    expect(q("principal")).toEqual(["carrossel"]);
    expect(q("nada disso")).toEqual([]);
    expect(skillFilterCounts(all, "todas")).toEqual({ todas: 3, "em-uso": 1, "sem-uso": 2, "com-aviso": 1 });
  });
});

describe("eventos e rótulos", () => {
  it("aplica library:skill-upserted e library:skill-deleted; antes do GET ignora", () => {
    expect(applySkillEvent(null, { type: "library:skill-deleted", id: "x" })).toBeNull();
    const added = applySkillEvent([used], { type: "library:skill-upserted", item: idle })!;
    expect(added.map((s) => s.id)).toEqual(["carrossel", "pdf"]);
    const replaced = applySkillEvent(added, { type: "library:skill-upserted", item: { ...used, version: 2 } })!;
    expect(replaced.find((s) => s.id === "carrossel")!.version).toBe(2);
    expect(applySkillEvent(replaced, { type: "library:skill-deleted", id: "pdf" })!.map((s) => s.id)).toEqual(["carrossel"]);
    const same = [used];
    expect(applySkillEvent(same, { type: "library:skill-deleted", id: "nao-tem" })).toBe(same);
    // Eventos de conector não mexem na lista de skills.
    expect(applySkillEvent(same, { type: "library:deleted", kind: "connector", id: "carrossel" })).toBe(same);
  });

  it("formata tamanho, tokens, uso e leituras", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2,0 KB");
    expect(formatBytes(50 * 1024)).toBe("50 KB");
    expect(tokensLabel(340)).toBe("~340 tokens");
    expect(tokensLabel(1250)).toBe("~1,3 mil tokens");
    expect(skillUsageLabel(used)).toBe("1 workspace · 1 agente");
    expect(skillUsageLabel(fromApp)).toBe("1 workspace · nenhum agente");
    expect(skillUsageLabel(idle)).toBe("Ninguém usa ainda");
    expect(readsLabel(used)).toBe("Nunca lida por um agente");
    expect(readsLabel(skill({ id: "a", usage: { reads: 1 } }))).toBe("Lida 1 vez");
    expect(readsLabel(skill({ id: "a", usage: { reads: 5 } }))).toBe("Lida 5 vezes");
  });

  it("a frase do autoteste é determinística com o aleatório injetado", () => {
    expect(randomSelftestPhrase(() => 0)).toBe("abacaxi-abacaxi-1000");
    expect(randomSelftestPhrase(() => 0.99)).toMatch(/^jabuticaba-jabuticaba-\d{4}$/);
  });

  it("a aba Skills está no endereço", () => {
    expect(libraryHash({ tab: "skills", workspaceId: "principal" })).toBe("#/biblioteca/skills/principal");
    expect(parseLibraryHash("#/biblioteca/skills/principal")).toEqual({ tab: "skills", workspaceId: "principal" });
  });
});

describe("skills por agente e limites", () => {
  it("só conta o que foi liberado ao workspace E entregue ao agente", () => {
    expect(skillsOfAgent(all, "principal", "clara").map((s) => s.id)).toEqual(["carrossel"]);
    expect(skillsOfAgent(all, "principal", "outra").map((s) => s.id)).toEqual([]);
    expect(skillsOfAgent(all, "outro", "clara")).toEqual([]);
    expect(skillsOfAgent(null, "principal", "clara")).toEqual([]);
    expect(skillsOfAgent(all, null, "clara")).toEqual([]);
  });

  it("avisa acima de 12 skills ou ~6 mil tokens de índice", () => {
    expect(agentSkillBudget([{ indexTokens: 50 }])).toEqual({ count: 1, indexTokens: 50, warnings: [] });
    expect(agentSkillBudget(Array.from({ length: 13 }, () => ({ indexTokens: 10 }))).warnings[0]).toMatch(/Mais de 12/);
    expect(agentSkillBudget([{ indexTokens: 4000 }, { indexTokens: 2500 }]).warnings[0]).toMatch(/6000 tokens/);
  });

  it("a janela de liberar mostra, por agente marcado, quando a liberação passa dos limites", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => skill({ id: `s${i}`, grants: { principal: { agentIds: ["clara"], grantedAt: "x" } } }));
    const extra = skill({ id: "extra" });
    const workspaces: LibraryWorkspaceInfo[] = [{ id: "principal", name: "Principal", agents: [agent("clara", "Clara"), agent("beto", "Beto")] }];
    const warnings = grantBudgetWarnings([...twelve, extra], extra, { principal: { agentIds: ["clara", "beto"] } }, workspaces);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^Clara \(Principal\): 13 skills/);
    // Sem passar do limite, nada.
    expect(grantBudgetWarnings(twelve, twelve[0]!, { principal: { agentIds: ["clara"] } }, workspaces)).toEqual([]);
  });
});
