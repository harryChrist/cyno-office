import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { forYouKind, type ForYouItem, type ForYouRule, type Room, type ServerEvent } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { reportText } from "../../mcp/report-tools";
import { dataPaths } from "../../store/paths";
import { AgentRules } from "../brain/agent-rules";
import { Brain } from "../brain/brain";
import { buildContext } from "../brain/context";
import { parseFrontmatter } from "../brain/frontmatter";
import type { RetroSnapshot } from "../metrics/retro";
import { renderRetroHtml, renderRetroMarkdown, renderRetroText } from "./render";
import { RetroService } from "./service";
import { RetroStore } from "./store";

const tempDir = useTempDirs();

// "Agora": quinta, 12/11/2026 12:00 em São Paulo; o teste move o relógio.
const START = Date.parse("2026-11-12T15:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

const ROOMS = [
  { id: "sala-a", name: "Sala A", kind: "team" },
  { id: "sala-b", name: "Sala B", kind: "team" },
] as unknown as Room[];

let counter = 0;
function item(over: Partial<ForYouItem> & { back?: number; now?: number } = {}): ForYouItem {
  const { back = 1, now = START, ...rest } = over;
  counter += 1;
  const decided = now - back * DAY;
  return { id: `A-${String(counter).padStart(4, "0")}`, agentId: "clara", roomId: "sala-a", type: "comentario", status: "aprovado", meta: {}, text: "x", originalText: "x", editedByUser: false, createdAt: iso(decided - 2 * HOUR), decidedAt: iso(decided), decidedBy: "usuario", ...rest };
}
const withEmoji = (over: Partial<ForYouItem> & { back?: number; now?: number } = {}): ForYouItem => item({ originalText: "Boa leitura 🎉🚀 do texto", text: "Boa leitura do texto", editedByUser: true, ...over });
const refusedTone = (over: Partial<ForYouItem> & { back?: number; now?: number } = {}): ForYouItem => item({ status: "rejeitado", rejection: { reason: "tom formal demais", category: "tom" }, ...over });

async function setup(history: ForYouItem[], options: { maestro?: boolean } = {}) {
  const dir = await tempDir();
  const clock = { ms: START };
  const brain = new Brain({ paths: dataPaths(dir), rooms: () => ROOMS, now: () => new Date(clock.ms) });
  const items: ForYouItem[] = [...history];
  const listeners = new Set<(event: ServerEvent) => void>();
  const asked: { title: string; message: string }[] = [];
  const agents = [
    { id: "clara", name: "Clara", room: "sala-a" },
    { id: "eco", name: "Eco", room: "sala-b" },
  ];
  const forYou = {
    list: () => items,
    openSpecial: vi.fn((input: { agentId: string; roomId: string; title: string; text: string; rule: ForYouRule }): ForYouItem => {
      counter += 1;
      const created: ForYouItem = { id: `A-${String(counter).padStart(4, "0")}`, agentId: input.agentId, roomId: input.roomId, type: "outro", status: "pendente", title: input.title, meta: {}, text: input.text, originalText: input.text, editedByUser: false, kind: "regra", rule: input.rule, createdAt: iso(clock.ms) };
      items.push(created);
      return created;
    }),
    updateRule: vi.fn(async (id: string, rule: ForYouRule): Promise<ForYouItem> => {
      const found = items.find((candidate) => candidate.id === id)!;
      found.rule = rule;
      found.text = rule.text;
      return found;
    }),
  };
  const agentRules = new AgentRules((agentId) => path.join(dir, "agents", agentId), () => new Date(clock.ms));
  const service = new RetroService({
    workspaceId: "principal",
    workspaceName: () => "Principal",
    store: new RetroStore(path.join(dir, "reports", "retro")),
    now: () => new Date(clock.ms),
    snapshot: (): RetroSnapshot => ({ agents, tasks: [], projects: [], forYou: items, typeName: (type) => (type === "comentario" ? "Comentário" : type) }),
    forYou,
    brain,
    agentRules,
    roomOfAgent: (agentId) => agents.find((agent) => agent.id === agentId)?.room,
    roomExists: (roomId) => ROOMS.some((room) => room.id === roomId),
    maestro: {
      available: () => options.maestro !== false,
      model: () => "claude-sonnet-5-5",
      ask: ({ title, message }) => {
        asked.push({ title, message });
        return { id: "T-ask" };
      },
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  const notes = async (brainId: string): Promise<string[]> => (await readdir(brain.dir(brainId)).catch(() => [] as string[])).filter((name) => name.endsWith(".md") && !name.startsWith("_"));
  const decide = async (id: string, status: "aprovado" | "rejeitado", rule?: { text?: string; scope?: ForYouRule["scope"] }) => {
    const card = items.find((candidate) => candidate.id === id)!;
    await service.decide(card, { status, ...(rule ? { rule } : {}) });
    card.status = status;
    card.decidedAt = iso(clock.ms);
  };
  return { service, items, clock, brain, agentRules, asked, notes, decide, forYou, finishAsk: () => listeners.forEach((listener) => listener({ type: "task:upserted", task: { id: "T-ask", status: "done" } } as unknown as ServerEvent)) };
}

describe("retrospectiva: as regras por molde não gastam nada e nada entra no Cérebro sem o clique", () => {
  it("gerar abre o cartão do emoji por molde (sem pedir nada ao Maestro) e o Cérebro continua vazio", async () => {
    const s = await setup([1, 2, 3, 4].map((back) => withEmoji({ back })));
    const { report, opened } = await s.service.generate("manual");
    expect(opened).toBe(1);
    expect(s.asked).toEqual([]);
    const card = s.items.find((candidate) => forYouKind(candidate) === "regra")!;
    expect(card).toMatchObject({ status: "pendente", agentId: "clara", roomId: "sala-a" });
    expect(card.rule).toMatchObject({ text: "Não usar emojis em comentários.", source: "molde", retro: "2026-W46", scope: { agentId: "clara", roomId: "sala-a" } });
    expect(card.rule!.evidence).toMatchObject({ count: 4, days: 4, total: 4 });
    expect(card.rule!.evidence.line).toBe("cortou emojis em 4 de 4 comentários (Clara)");
    expect(report.rules).toHaveLength(1);
    expect(await s.notes("sala-a")).toEqual([]);
    expect(await s.notes("global")).toEqual([]);
    // Gerar de novo não duplica o cartão.
    expect((await s.service.generate("manual")).opened).toBe(0);
    expect(s.items.filter((candidate) => forYouKind(candidate) === "regra")).toHaveLength(1);
    const view = await s.service.view();
    expect(view.waiting).toBe(1);
    expect(view.ready).toEqual([]);
  });

  it("aprovar a regra de um agente grava nas regras DELE (não numa nota da sala) e só ele a recebe no contexto", async () => {
    const s = await setup([1, 2, 3].map((back) => withEmoji({ back })));
    await s.service.generate("manual");
    const card = s.items.find((candidate) => forYouKind(candidate) === "regra")!;
    expect(await s.notes("sala-a")).toEqual([]);
    await s.decide(card.id, "aprovado");
    expect(await s.notes("sala-a")).toEqual([]);
    expect(await s.notes("global")).toEqual([]);
    expect((await s.agentRules.read("clara")).content).toBe("- Não usar emojis em comentários.");
    expect((await s.agentRules.read("eco")).content).toBe("");
    const deps = { rooms: () => ROOMS, readNotes: (id: string) => s.brain.readNotes(id), readAgentRules: async (id: string) => (await s.agentRules.read(id)).content, now: () => new Date(s.clock.ms) };
    const forClara = await buildContext(deps, "sala-a", "Escreva um comentário para o post", { id: "clara", name: "Clara" });
    expect(forClara.text).toContain("## Suas regras (só para você, Clara)");
    expect(forClara.text).toContain("Não usar emojis em comentários.");
    expect(forClara.sources[0]!.kind).toBe("agent");
    const forEco = await buildContext(deps, "sala-a", "Escreva um comentário para o post", { id: "eco", name: "Eco" });
    expect(forEco.text).not.toContain("Não usar emojis");
    const view = await s.service.view();
    expect(view.rules[0]).toMatchObject({ state: "aprovada" });
    expect(view.rules[0]!.notePath).toBeUndefined();
    expect(view.waiting).toBe(0);
  });

  it("regra de escopo de sala vira nota com tag regra e entra no contexto de todos da sala como regra carregada", async () => {
    const s = await setup([1, 2, 3].map((back) => withEmoji({ back })));
    await s.service.generate("manual");
    const card = s.items.find((candidate) => forYouKind(candidate) === "regra")!;
    await s.decide(card.id, "aprovado", { scope: { roomId: "sala-a" } });
    const [file] = await s.notes("sala-a");
    expect(file).toBeDefined();
    expect((await s.agentRules.read("clara")).content).toBe("");
    const content = await readFile(path.join(s.brain.dir("sala-a"), file!), "utf8");
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.tags).toEqual(["regra", "retro"]);
    expect(frontmatter.origem).toBe("retro-2026-W46");
    expect(body).toContain("Não usar emojis em comentários.");
    const context = await buildContext({ rooms: () => ROOMS, readNotes: (id) => s.brain.readNotes(id), now: () => new Date(s.clock.ms) }, "sala-a", "Escreva um comentário para o post");
    expect(context.text).toContain("Não usar emojis em comentários.");
    expect(context.text).not.toContain("## Notas do Cérebro");
    expect((await s.service.view()).rules[0]).toMatchObject({ state: "aprovada", notePath: `sala-a/${file}` });
  });

  it("padrão de 2 agentes: o cartão nasce global e a aprovação grava no Cérebro global (não no do quarto)", async () => {
    const s = await setup([...[1, 2, 3].map((back) => withEmoji({ back })), ...[1, 2, 3].map((back) => withEmoji({ back, agentId: "eco", roomId: "sala-b" }))]);
    await s.service.generate("manual");
    const card = s.items.find((candidate) => forYouKind(candidate) === "regra")!;
    expect(card.rule!.scope).toEqual({ global: true });
    await s.decide(card.id, "aprovado");
    expect(await s.notes("global")).toHaveLength(1);
    expect(await s.notes("sala-a")).toEqual([]);
    expect(await s.notes("sala-b")).toEqual([]);
  });

  it("o dono edita o texto e troca o escopo antes de aprovar: vale o que ele escolheu", async () => {
    const s = await setup([1, 2, 3].map((back) => withEmoji({ back })));
    await s.service.generate("manual");
    const card = s.items.find((candidate) => forYouKind(candidate) === "regra")!;
    await s.decide(card.id, "aprovado", { text: "Nada de emojis nos comentários de ninguém.", scope: { global: true } });
    const [file] = await s.notes("global");
    expect(await readFile(path.join(s.brain.dir("global"), file!), "utf8")).toContain("Nada de emojis nos comentários de ninguém.");
    expect(await s.notes("sala-a")).toEqual([]);
    expect(s.forYou.updateRule).toHaveBeenCalledOnce();
    expect(card.rule).toMatchObject({ text: "Nada de emojis nos comentários de ninguém.", scope: { global: true } });
  });

  it("escopo de um agente que não existe mais é recusado (400) e nada é gravado", async () => {
    const s = await setup([1, 2, 3].map((back) => withEmoji({ back })));
    await s.service.generate("manual");
    const card = s.items.find((candidate) => forYouKind(candidate) === "regra")!;
    await expect(s.decide(card.id, "aprovado", { scope: { agentId: "fantasma" } })).rejects.toMatchObject({ statusCode: 400 });
    expect(await s.notes("sala-a")).toEqual([]);
  });
});

describe("retrospectiva: o Maestro só escreve quando o dono pede, e só pelo propose_rule", () => {
  it("o botão manda UMA mensagem em inglês com o grupo de texto livre; propose_rule abre o cartão, só uma vez por grupo", async () => {
    const s = await setup([1, 2, 3].map((back) => refusedTone({ back })));
    expect(s.asked).toEqual([]);
    const view = await s.service.view();
    expect(view.needsMaestro).toHaveLength(1);
    expect(view.estimate).toMatchObject({ groups: 1, model: "claude-sonnet-5-5" });
    expect(view.estimate.label).toContain("equivalente");
    expect(view.maestro).toMatchObject({ available: true, asking: false });

    const result = await s.service.ask();
    expect(result).toEqual({ asked: 1, taskId: "T-ask" });
    expect(s.asked).toHaveLength(1);
    const message = s.asked[0]!.message;
    expect(message).toContain("propose_rule");
    expect(message).toContain(`Group ${view.needsMaestro[0]!.id}`);
    expect(message).toContain("tom formal demais");
    expect(message.length).toBeLessThan(2400);
    expect((await s.service.view()).maestro.asking).toBe(true);
    await expect(s.service.ask()).rejects.toMatchObject({ statusCode: 409 });

    const groupId = view.needsMaestro[0]!.id;
    await expect(s.service.proposeRule({ groupId: "g-outro", text: "Evitar tom formal demais.", scope: "agent" })).rejects.toThrow(/Unknown group/);
    const done = await s.service.proposeRule({ groupId, text: "Evitar tom formal demais em comentários: escrever leve e direto.", scope: "agent" });
    expect(done).toContain("Rule card");
    const card = s.items.find((candidate) => forYouKind(candidate) === "regra")!;
    expect(card.rule).toMatchObject({ source: "maestro", groupId, text: "Evitar tom formal demais em comentários: escrever leve e direto." });
    expect(card.status).toBe("pendente");
    expect(await s.notes("sala-a")).toEqual([]);
    // O mesmo grupo não aceita outra regra.
    await expect(s.service.proposeRule({ groupId, text: "Outra regra qualquer.", scope: "agent" })).rejects.toThrow(/Unknown group/);
    s.finishAsk();
    expect((await s.service.view()).maestro.asking).toBe(false);
  });

  it("propose_rule fora do pedido do dono não faz nada; sem Maestro de CLI o botão fica desligado", async () => {
    const s = await setup([1, 2, 3].map((back) => refusedTone({ back })), { maestro: false });
    await expect(s.service.proposeRule({ groupId: "g-x", text: "Uma regra qualquer aqui.", scope: "global" })).rejects.toThrow(/only works while/);
    await expect(s.service.ask()).rejects.toMatchObject({ statusCode: 409 });
    expect(s.items.filter((candidate) => forYouKind(candidate) === "regra")).toEqual([]);
    expect((await s.service.view()).maestro.available).toBe(false);
  });

  it("scope 'agent' num padrão de 2 agentes é recusado: tem de ser global", async () => {
    const both = [1, 2, 3].flatMap((back) => [refusedTone({ back }), refusedTone({ back, agentId: "eco", roomId: "sala-b" })]);
    const s = await setup(both);
    const view = await s.service.view();
    expect(view.needsMaestro).toHaveLength(1);
    expect(view.needsMaestro[0]!.agentIds).toEqual(["clara", "eco"]);
    await s.service.ask();
    await expect(s.service.proposeRule({ groupId: view.needsMaestro[0]!.id, text: "Evitar tom formal demais.", scope: "agent" })).rejects.toThrow(/global/);
    await s.service.proposeRule({ groupId: view.needsMaestro[0]!.id, text: "Evitar tom formal demais.", scope: "global" });
    expect(s.items.find((candidate) => forYouKind(candidate) === "regra")!.rule!.scope).toEqual({ global: true });
  });
});

describe("retrospectiva: recusar esconde o padrão por 8 semanas", () => {
  it("a regra recusada não volta antes de 8 semanas e volta depois", async () => {
    const s = await setup([1, 2, 3].map((back) => withEmoji({ back })));
    await s.service.generate("manual");
    const card = s.items.find((candidate) => forYouKind(candidate) === "regra")!;
    await s.decide(card.id, "rejeitado");
    expect(await s.notes("sala-a")).toEqual([]);
    expect((await s.service.view()).rules[0]).toMatchObject({ state: "recusada" });

    // Sete semanas depois, com o padrão ainda presente nos últimos 14 dias: continua escondido.
    const refresh = (): void => {
      for (const old of s.items.filter((candidate) => forYouKind(candidate) !== "regra")) {
        old.decidedAt = iso(s.clock.ms - 2 * DAY - (s.items.indexOf(old) % 3) * DAY);
      }
    };
    s.clock.ms = START + 7 * 7 * DAY;
    refresh();
    expect((await s.service.generate("manual")).opened).toBe(0);
    expect((await s.service.view()).ready).toEqual([]);
    // Passadas as 8 semanas, o padrão pode voltar como cartão novo.
    s.clock.ms = START + 8 * 7 * DAY + HOUR;
    refresh();
    expect((await s.service.view()).ready).toHaveLength(1);
    expect((await s.service.generate("manual")).opened).toBe(1);
  });
});

describe("retrospectiva: o relatório (kind retro) e o antes/depois", () => {
  it("guarda em reports/retro, lê com o estado de agora e, duas semanas depois da aprovação, traz a linha 'caíram de N para M'", async () => {
    const s = await setup([1, 2, 3].map((back) => refusedTone({ back })));
    await s.service.ask();
    const view = await s.service.view();
    await s.service.proposeRule({ groupId: view.needsMaestro[0]!.id, text: "Evitar tom formal demais em comentários.", scope: "agent" });
    s.finishAsk();
    const card = s.items.find((candidate) => forYouKind(candidate) === "regra")!;
    const stored = await s.service.generate("manual");
    expect(stored.report).toMatchObject({ kind: "retro", period: "2026-W46", trigger: "manual" });
    expect((await s.service.read("2026-W46"))!.rules[0]).toMatchObject({ state: "esperando", source: "maestro" });

    await s.decide(card.id, "aprovado");
    // Antes de 14 dias: sem linha de impacto.
    expect((await s.service.read("2026-W46"))!.impacts).toEqual([]);
    expect((await s.service.read("2026-W46"))!.rules[0]).toMatchObject({ state: "aprovada" });

    // Quinze dias depois: antes da aprovação houve 3 recusas e depois só 1.
    s.clock.ms = START + 15 * DAY;
    s.items.push(refusedTone({ now: START + 5 * DAY, back: 0 }));
    const later = await s.service.read("2026-W46");
    expect(later!.impacts).toHaveLength(1);
    expect(later!.impacts[0]).toMatchObject({ before: 3, after: 1, what: "recusas desse tipo" });
    expect(later!.impacts[0]!.line).toContain("caíram de 3 para 1");

    // As três formas do relatório (HTML da página isolada, Markdown e texto para o modelo).
    const html = renderRetroHtml(later!);
    expect(html).toContain("O que aprendemos");
    expect(html).toContain("caíram de 3 para 1");
    expect(html).not.toMatch(/<script|https?:\/\//);
    expect(renderRetroMarkdown(later!)).toContain("| Regra |");
    expect(renderRetroText(later!)).toContain("[approved]");

    // get_report({ kind: "retro" }) devolve as regras e o estado delas.
    const text = await reportText(async () => undefined, { kind: "retro", period: "latest" }, s.service);
    expect(text).toContain("Rules proposed (1)");
    expect(text).toContain("approved");
    expect(text).toContain("Two weeks after approval");
    await expect(reportText(async () => undefined, { kind: "retro", period: "2026-W01" }, s.service)).rejects.toThrow(/not a stored retrospective week/);
  });

  it("só leitura (revisão L5): sem retrospectiva guardada, 'latest' não gera nada nem abre cartão de regra; o get_report diz que não há", async () => {
    const s = await setup([1, 2, 3].map((back) => withEmoji({ back })));
    expect(await s.service.ensure("latest")).toBeUndefined();
    expect(await s.service.ensure(undefined)).toBeUndefined();
    const text = await reportText(async () => undefined, { kind: "retro", period: "latest" }, s.service);
    expect(text).toContain("No retrospective is stored yet");
    expect(s.forYou.openSpecial).not.toHaveBeenCalled();
    expect(await s.service.ensure("latest")).toBeUndefined();
    // Gerar continua com o botão e o agendador; depois disso a leitura devolve a guardada.
    await s.service.generate("manual");
    expect(await s.service.ensure("latest")).toMatchObject({ period: "2026-W46" });
  });
});
