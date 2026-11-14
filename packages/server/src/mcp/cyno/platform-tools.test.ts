import { cardSummarySchema, type Card, type WaitingItem } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { PLATFORM_TOOL_MAX_CHARS, platformTools, type PlatformToolsDeps } from "./platform-tools";

const card = (over: Partial<Card> = {}): Card => ({
  workspace: "linkedin",
  name: "LinkedIn",
  summary: cardSummarySchema.parse({ summary: "Posts do perfil." }),
  team: { rooms: [{ id: "a", name: "Conteúdo" }], agents: [{ id: "eco", name: "Eco", engine: "claude", model: "haiku", terminal: "stopped" }], maestro: { engine: "claude", model: "sonnet", status: "ocioso" } },
  engines: [{ engine: "claude", available: true }],
  sites: [],
  connectors: [],
  routines: [],
  projects: { active: [{ id: "P-1", title: "Comentários", status: "ativo" }], counts: { ativo: 1 } },
  deliveries: [],
  waitingForYou: 2,
  waitingIds: ["A-1", "A-2"],
  usage: { turns5h: 0 },
  updatedAt: "2026-11-11T12:00:00.000Z",
  ...over,
});

const waiting: WaitingItem = { workspace: "linkedin", workspaceName: "LinkedIn", id: "A-1", type: "post", title: "Post sobre HxH", agent: "Eco", at: "2026-11-10T09:00:00.000Z", href: "#/linkedin/para-voce" };

function setup(over: Partial<PlatformToolsDeps> = {}) {
  const deps: PlatformToolsDeps = { cards: () => [card()], waiting: () => [waiting], setSummary: async () => "frase", usageReport: async () => "", ...over };
  const tools = platformTools(deps);
  return { tools, call: (name: string, input: object = {}) => tools.find((tool) => tool.name === name)!.call(input as never) };
}

describe("ferramentas do Cyno (escopo plataforma)", () => {
  it("expõe só leitura de código e a frase da ficha, em inglês", () => {
    const { tools } = setup();
    expect(tools.map((tool) => tool.name)).toEqual(["list_workspaces", "get_workspace_card", "list_waiting_for_you", "set_workspace_summary", "get_usage"]);
    for (const tool of tools) expect(tool.description).toMatch(/^[A-Z]/);
  });

  it("list_workspaces: devolve a frase, o Maestro, o time, os projetos e o que espera o dono", async () => {
    const { call } = setup({ cards: () => [card(), card({ workspace: "lab", name: "Laboratório", summary: cardSummarySchema.parse({}), waitingForYou: 0, projects: { active: [], counts: {} } })] });
    const result = await call("list_workspaces");
    expect(result.isError).toBeUndefined();
    expect(result.text).toBe(
      [
        "2 workspaces:",
        '- linkedin — "LinkedIn": Posts do perfil. | maestro ocioso | 1 team agent | 1 active project | 2 waiting for the owner',
        "- lab — \"Laboratório\": (no 'what it does' sentence yet) | maestro ocioso | 1 team agent | 0 active projects | 0 waiting for the owner",
      ].join("\n"),
    );
  });

  it("list_workspaces sem nenhum workspace diz isso, e a resposta tem teto", async () => {
    expect((await setup({ cards: () => [] }).call("list_workspaces")).text).toMatch(/no workspaces yet/);
    const many = Array.from({ length: 400 }, (_, index) => card({ workspace: `ws-${index}`, name: `Workspace ${index}` }));
    const text = (await setup({ cards: () => many }).call("list_workspaces")).text;
    expect(text.length).toBeLessThanOrEqual(PLATFORM_TOOL_MAX_CHARS);
    expect(text.endsWith("…")).toBe(true);
  });

  it("get_workspace_card: a ficha completa, achada por id ou por nome; erro claro se não existe", async () => {
    const { call } = setup();
    expect((await call("get_workspace_card", { workspace: "linkedin" })).text).toContain("Faz: Posts do perfil.");
    expect((await call("get_workspace_card", { workspace: "linkedin" })).text).toContain("Equipe:");
    expect((await call("get_workspace_card", { workspace: "LinkedIn" })).text).toContain("# linkedin · LinkedIn");
    const missing = await call("get_workspace_card", { workspace: "nada" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/No workspace "nada"/);
  });

  it("list_waiting_for_you: de todos ou de um workspace", async () => {
    const { call } = setup({ cards: () => [card(), card({ workspace: "lab", name: "Lab" })], waiting: () => [waiting, { ...waiting, workspace: "lab", id: "A-9", title: "Outro" }] });
    expect((await call("list_waiting_for_you")).text).toContain("linkedin/A-1 [post] Post sobre HxH (from Eco)");
    const only = (await call("list_waiting_for_you", { workspace: "lab" })).text;
    expect(only).toContain("lab/A-9");
    expect(only).not.toContain("linkedin/A-1");
    expect((await setup({ waiting: () => [] }).call("list_waiting_for_you")).text).toBe("Nothing is waiting for the owner.");
  });

  it("set_workspace_summary: grava pelo id resolvido e explica quando vira sugestão", async () => {
    const setSummary = vi.fn(async () => "frase" as const);
    const { call } = setup({ setSummary });
    expect((await call("set_workspace_summary", { workspace: "LinkedIn", text: "Posts e convites." })).text).toMatch(/^Saved/);
    expect(setSummary).toHaveBeenCalledWith("linkedin", "Posts e convites.");
    const suggested = setup({ setSummary: async () => "sugestao" });
    expect((await suggested.call("set_workspace_summary", { workspace: "linkedin", text: "X" })).text).toMatch(/suggestion/);
    expect((await setup().call("set_workspace_summary", { workspace: "nada", text: "X" })).isError).toBe(true);
  });

  it("set_workspace_summary rejeita frase de mais de 280 caracteres", () => {
    const tool = setup().tools.find((candidate) => candidate.name === "set_workspace_summary")!;
    expect(tool.input.safeParse({ workspace: "linkedin", text: "x".repeat(281) }).success).toBe(false);
  });

  it("get_usage devolve o relatório de uso do servidor", async () => {
    expect((await setup({ usageReport: async () => "## Claude Code — available" }).call("get_usage")).text).toBe("## Claude Code — available");
  });
});

describe("get_today do Cyno", () => {
  it("só existe com a dependência e aceita a plataforma ou um workspace", async () => {
    expect(setup().tools.map((tool) => tool.name)).not.toContain("get_today");
    const today = vi.fn((workspace?: string) => (workspace ? `one:${workspace}` : "all"));
    const { tools, call } = setup({ today });
    expect(tools.map((tool) => tool.name)).toContain("get_today");
    expect(tools.find((tool) => tool.name === "get_today")!.description).toMatch(/^What is happening today/);
    expect((await call("get_today")).text).toBe("all");
    expect(today).toHaveBeenLastCalledWith(undefined);
    expect((await call("get_today", { workspace: "LinkedIn" })).text).toBe("one:linkedin");
    const missing = await call("get_today", { workspace: "nada" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("No workspace");
  });
});


describe("get_day_stats do Cyno", () => {
  it("só existe com a dependência; sem workspace soma tudo, com workspace lê um; dia ruim vira erro de texto", async () => {
    expect(setup().tools.map((tool) => tool.name)).not.toContain("get_day_stats");
    const dayStats = vi.fn(async (input: { day?: string; workspace?: string }) => {
      if (input.day === "2020-01-01") throw new Error("Só há registro dos últimos 90 dias.");
      return input.workspace === "nada" ? undefined : `${input.workspace ?? "all"}:${input.day ?? "today"}`;
    });
    const { tools, call } = setup({ dayStats });
    expect(tools.find((tool) => tool.name === "get_day_stats")!.description).toMatch(/^How the day went/);
    expect((await call("get_day_stats")).text).toBe("all:today");
    expect(dayStats).toHaveBeenLastCalledWith({});
    expect((await call("get_day_stats", { day: "2026-11-10", workspace: "LinkedIn" })).text).toBe("linkedin:2026-11-10");
    const bad = await call("get_day_stats", { day: "2020-01-01" });
    expect(bad).toMatchObject({ isError: true, text: "Só há registro dos últimos 90 dias." });
  });
});

describe("get_away_summary do Cyno", () => {
  it("só existe com a dependência; devolve o mesmo resumo do cartão, em inglês; erro vira texto", async () => {
    expect(setup().tools.map((tool) => tool.name)).not.toContain("get_away_summary");
    const away = vi.fn(async () => "While the owner was away: 2 tasks done");
    const { tools, call } = setup({ away });
    const tool = tools.find((candidate) => candidate.name === "get_away_summary")!;
    expect(tool.description).toMatch(/^What happened while the owner was away/);
    expect((await call("get_away_summary")).text).toBe("While the owner was away: 2 tasks done");
    expect(away).toHaveBeenCalledTimes(1);
    const broken = setup({ away: async () => Promise.reject(new Error("sem dados")) });
    expect(await broken.call("get_away_summary")).toMatchObject({ isError: true, text: "sem dados" });
  });
});

