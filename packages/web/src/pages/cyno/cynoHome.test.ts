import { cardSummarySchema, type Card, type WaitingItem } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { ageLabel, busyAgents, engineName, groupWaiting, modelLabel, nextRoutine, nextRunLabel, progressLabel, sortCards, teamLine, usageLabel, waitingBadge, workingLines } from "./cynoHome";

const NOW = new Date("2026-11-11T15:00:00Z"); // 12h em São Paulo

const card = (over: Partial<Card> = {}): Card => ({
  workspace: "linkedin",
  name: "LinkedIn",
  summary: cardSummarySchema.parse({ summary: "Posts." }),
  team: { rooms: [], agents: [], maestro: { engine: "claude", model: "sonnet", status: "ocioso" } },
  engines: [],
  sites: [],
  connectors: [],
  routines: [],
  projects: { active: [], counts: {} },
  deliveries: [],
  waitingForYou: 0,
  waitingIds: [],
  usage: { turns5h: 0 },
  updatedAt: NOW.toISOString(),
  ...over,
});
const agent = (name: string, terminal: Card["team"]["agents"][number]["terminal"] = "stopped") => ({ id: name.toLowerCase(), name, engine: "claude", terminal });
const wait = (workspace: string, id: string, at: string): WaitingItem => ({ workspace, workspaceName: workspace.toUpperCase(), id, type: "post", title: id, at, href: `#/${workspace}/para-voce` });

describe("cynoHome", () => {
  it("nomes de motor e modelo", () => {
    expect(engineName("claude")).toBe("Claude Code");
    expect(engineName("desconhecido")).toBe("desconhecido");
    expect(modelLabel("claude", "sonnet")).toBe("Claude Code · sonnet");
    expect(modelLabel("claude")).toBe("Claude Code");
  });

  it("equipe em uma linha, sem o Maestro", () => {
    expect(teamLine(card())).toBe("Só o Maestro");
    expect(teamLine(card({ team: { ...card().team, agents: [agent("Eco"), agent("Crivo")] } }))).toBe("Eco, Crivo");
    expect(teamLine(card({ team: { ...card().team, agents: ["A", "B", "C", "D", "E"].map((name) => agent(name)) } }))).toBe("A, B, C e mais 2");
    expect(busyAgents(card({ team: { ...card().team, agents: [agent("Eco", "busy"), agent("Crivo")] } }))).toBe(1);
  });

  it("em andamento: título e progresso, no máximo duas linhas", () => {
    const projects = [1, 2, 3].map((n) => ({ id: `P-${n}`, title: `Projeto ${n}`, status: "ativo", ...(n === 1 ? { done: 3, total: 10 } : {}) }));
    expect(workingLines(card({ projects: { active: projects, counts: { ativo: 3 } } }))).toEqual([
      { id: "P-1", text: "Projeto 1", progress: "3/10" },
      { id: "P-2", text: "Projeto 2", progress: "" },
    ]);
    expect(progressLabel({ done: 0, total: 4 })).toBe("0/4");
  });

  it("próximo horário: hoje, amanhã ou o dia da semana", () => {
    expect(nextRunLabel("2026-11-11T21:00:00Z", NOW)).toBe("hoje 18h");
    expect(nextRunLabel("2026-11-12T11:30:00Z", NOW)).toBe("amanhã 08h30");
    expect(nextRunLabel("2026-11-14T11:00:00Z", NOW)).toMatch(/^sáb 08h$/);
    const routines = [
      { id: "R-1", title: "E-mail", type: "acompanhamento", next: "2026-11-12T11:00:00Z" },
      { id: "R-2", title: "Convites", type: "meta", next: "2026-11-11T21:00:00Z" },
      { id: "R-3", title: "Sem horário", type: "meta" },
    ];
    expect(nextRoutine(card({ routines }), NOW)).toBe("Convites · hoje 18h");
    expect(nextRoutine(card(), NOW)).toBeUndefined();
  });

  it("uso e selo de espera", () => {
    expect(usageLabel(card())).toBe("Sem uso em 5 h");
    expect(usageLabel(card({ usage: { turns5h: 1 } }))).toBe("1 turno em 5 h");
    expect(usageLabel(card({ usage: { turns5h: 4 } }))).toBe("4 turnos em 5 h");
    expect(usageLabel(card({ usage: { turns5h: 4, windowPercent: 41, windowEngine: "claude" } }))).toBe("Claude Code 41% das 5 h");
    expect(waitingBadge(card())).toBe("");
    expect(waitingBadge(card({ waitingForYou: 1 }))).toBe("1 espera você");
    expect(waitingBadge(card({ waitingForYou: 2 }))).toBe("2 esperam você");
  });

  it("idade do item", () => {
    expect(ageLabel("2026-11-11T14:59:40Z", NOW)).toBe("agora");
    expect(ageLabel("2026-11-11T14:55:00Z", NOW)).toBe("há 5 min");
    expect(ageLabel("2026-11-11T12:00:00Z", NOW)).toBe("há 3 h");
    expect(ageLabel("2026-11-10T12:00:00Z", NOW)).toBe("há 1 dia");
    expect(ageLabel("2026-11-08T12:00:00Z", NOW)).toBe("há 3 dias");
  });

  it("o Esperando você agrupa por workspace: o mais antigo primeiro, dentro e entre os grupos", () => {
    const groups = groupWaiting([wait("b", "A-2", "2026-11-10T12:00:00Z"), wait("a", "A-1", "2026-11-11T09:00:00Z"), wait("b", "A-1", "2026-11-09T12:00:00Z")]);
    expect(groups.map((group) => [group.workspace, group.items.map((item) => item.id)])).toEqual([
      ["b", ["A-1", "A-2"]],
      ["a", ["A-1"]],
    ]);
    expect(groupWaiting([])).toEqual([]);
  });

  it("ordem dos cartões: quem espera você, depois quem anda, depois o nome", () => {
    const project = { id: "P", title: "P", status: "ativo" };
    const cards = [card({ workspace: "z", name: "Zeta" }), card({ workspace: "b", name: "Beta", projects: { active: [project], counts: {} } }), card({ workspace: "a", name: "Alfa", waitingForYou: 2 }), card({ workspace: "c", name: "Alfa2" })];
    expect(sortCards(cards).map((entry) => entry.workspace)).toEqual(["a", "b", "c", "z"]);
  });
});
