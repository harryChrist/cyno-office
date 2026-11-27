import { cardSummarySchema, type AgendaEvent, type Card, type SentRequestView, type WaitingItem } from "@cyno/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agendaTodayCount, clampSideWidth, loadSideWidth, saveSideWidth, loadSideCollapsed, loadSideTab, openRequests, oldestWaiting, saveSideCollapsed, saveSideTab, sideCounts, workspaceLine } from "./cynoSideView";

const NOW = new Date("2026-11-11T15:00:00Z"); // 12h em São Paulo

const card = (over: Partial<Card> = {}): Card => ({
  workspace: "demo",
  name: "Demonstração",
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
const wait = (id: string, at: string): WaitingItem => ({ workspace: "demo", workspaceName: "Demonstração", id, type: "post", title: id, at, href: "#/demo/para-voce" });
const request = (projectId: string, state: SentRequestView["state"], sentAt: string): SentRequestView => ({ projectId, workspace: "demo", workspaceName: "Demonstração", title: projectId, address: "", sentAt, state, tasksDone: 0, tasksTotal: 0, waitingForYou: 0 });
const event = (id: string, start: string, end: string): AgendaEvent => ({ id, title: id, start, end, status: "marcado" }) as AgendaEvent;

/** localStorage de mentira (o ambiente dos testes é node). */
function stubStorage(): Map<string, string> {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) });
  return data;
}

afterEach(() => vi.unstubAllGlobals());

describe("largura do painel", () => {
  it("clampSideWidth respeita 300–640 e deixa 420 px para a conversa", () => {
    expect(clampSideWidth(360, 1440)).toBe(360);
    expect(clampSideWidth(100, 1440)).toBe(300);
    expect(clampSideWidth(900, 2560)).toBe(640);
    expect(clampSideWidth(640, 900)).toBe(464); // 900 - 16 - 420
    expect(clampSideWidth(500, 700)).toBe(300); // o painel cede até o mínimo
    expect(clampSideWidth(Number.NaN, 1440)).toBe(360);
  });

  it("lembra a largura; valor fora dos limites volta a 360", () => {
    const data = stubStorage();
    expect(loadSideWidth()).toBe(360);
    saveSideWidth(480);
    expect(loadSideWidth()).toBe(480);
    data.set("cyno:side-width", "50");
    expect(loadSideWidth()).toBe(360);
    data.set("cyno:side-width", "abc");
    expect(loadSideWidth()).toBe(360);
  });
});

describe("cynoSide", () => {
  it("lembra a aba e o painel recolhido; valor estranho volta ao Resumo", () => {
    const data = stubStorage();
    expect(loadSideTab()).toBe("resumo");
    saveSideTab("agenda");
    expect(loadSideTab()).toBe("agenda");
    data.set("cyno:side-tab", "esperando");
    expect(loadSideTab()).toBe("resumo");
    expect(loadSideCollapsed()).toBe(false);
    saveSideCollapsed(true);
    expect(loadSideCollapsed()).toBe(true);
    saveSideCollapsed(false);
    expect(loadSideCollapsed()).toBe(false);
  });

  it("sem localStorage (bloqueado) nada quebra", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("bloqueado");
      },
    });
    expect(loadSideTab()).toBe("resumo");
    expect(loadSideCollapsed()).toBe(false);
    expect(() => saveSideTab("mural")).not.toThrow();
    expect(() => saveSideCollapsed(true)).not.toThrow();
  });

  it("os mais antigos esperando você, no máximo três", () => {
    const items = [wait("c", "2026-11-11T12:00:00Z"), wait("a", "2026-11-11T09:00:00Z"), wait("d", "2026-11-11T13:00:00Z"), wait("b", "2026-11-11T10:00:00Z")];
    expect(oldestWaiting(items).map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(oldestWaiting([])).toEqual([]);
  });

  it("a entrega de sprint pendente aparece sempre, mesmo com três itens mais antigos", () => {
    const delivery = { ...wait("e", "2026-11-11T14:00:00Z"), kind: "sprint" };
    const items = [wait("a", "2026-11-11T09:00:00Z"), wait("b", "2026-11-11T10:00:00Z"), wait("c", "2026-11-11T12:00:00Z"), wait("d", "2026-11-11T13:00:00Z"), delivery];
    expect(oldestWaiting(items).map((item) => item.id)).toEqual(["a", "b", "e"]);
    // Já entre os mais antigos: nada muda.
    expect(oldestWaiting([{ ...wait("a", "2026-11-11T09:00:00Z"), kind: "sprint" }, ...items.slice(1, 4)]).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("pedidos em aberto: os fechados ficam de fora e o mais novo vem primeiro", () => {
    const list = [request("velho", "andando", "2026-11-10T10:00:00Z"), request("pronto", "concluido", "2026-11-11T10:00:00Z"), request("novo", "esperando_voce", "2026-11-11T11:00:00Z")];
    expect(openRequests(list).map((view) => view.projectId)).toEqual(["novo", "velho"]);
  });

  it("compromissos de hoje que ainda faltam", () => {
    const events = [event("passou", "2026-11-11T11:00:00Z", "2026-11-11T12:00:00Z"), event("tarde", "2026-11-11T17:00:00Z", "2026-11-11T18:00:00Z"), event("amanha", "2026-11-12T12:00:00Z", "2026-11-12T13:00:00Z")];
    expect(agendaTodayCount(events, NOW)).toBe(1);
  });

  it("contadores das abas", () => {
    expect(sideCounts({ waiting: 6, openRequests: 1, agendaToday: 0, muralNews: 2 })).toEqual({ resumo: 6, workspaces: 1, agenda: 0, mural: 2 });
  });

  it("uma linha por workspace: espera você, anda ou nada em andamento", () => {
    expect(workspaceLine(card(), NOW)).toMatchObject({ tone: "idle", text: "Nada em andamento" });
    const projects = { active: [{ id: "P-1", title: "Post da semana", status: "ativo", done: 1, total: 3 }, { id: "P-2", title: "Outro", status: "ativo" }], counts: {} };
    expect(workspaceLine(card({ projects }), NOW)).toMatchObject({ tone: "busy", text: "Post da semana · 1/3 e mais 1" });
    const waiting = workspaceLine(card({ projects, waitingForYou: 2 }), NOW);
    expect(waiting).toMatchObject({ tone: "wait", text: "2 itens esperam você", meta: "Post da semana · 1/3 e mais 1" });
    expect(workspaceLine(card({ waitingForYou: 1 }), NOW).text).toBe("1 item espera você");
    expect(workspaceLine(card({ routines: [{ id: "R", title: "Convites", type: "meta", next: "2026-11-11T21:00:00Z" }] }), NOW).meta).toBe("Convites · hoje 18h");
  });
});
