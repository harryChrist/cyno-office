import { projectDefaults, projectTaskDefaults, type ForYouItem, type Project, type ProjectTask, type Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { makeHistory } from "./fixtures/make-history";
import { findRetro, groupHash, impactLine, jaccard, passesThreshold, patternCount, pluralPt, reasonWords, ruleImpact, stem, type RetroSnapshot } from "./retro";

// "Agora": quinta, 12/11/2026 12:00 em São Paulo (15:00 UTC). Nada aqui lê o relógio nem o fuso da máquina.
const NOW = Date.parse("2026-11-12T15:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number): string => new Date(ms).toISOString();
/** `back` dias atrás, ao meio-dia de São Paulo (nunca perto da virada do dia). */
const noon = (back: number): number => Date.parse("2026-11-12T15:00:00.000Z") - back * DAY;

const AGENTS = [
  { id: "clara", name: "Clara" },
  { id: "eco", name: "Eco" },
];

let counter = 0;
function item(over: Partial<ForYouItem> & { back?: number } = {}): ForYouItem {
  const { back = 1, ...rest } = over;
  counter += 1;
  const decided = noon(back);
  return {
    id: `A-${String(counter).padStart(4, "0")}`,
    agentId: "clara",
    roomId: "q",
    type: "comentario",
    status: "aprovado",
    meta: {},
    text: "texto",
    originalText: "texto",
    editedByUser: false,
    createdAt: at(decided - 2 * HOUR),
    decidedAt: at(decided),
    decidedBy: "usuario",
    ...rest,
  };
}

const refused = (reason: string, over: Partial<ForYouItem> & { back?: number } = {}): ForYouItem => item({ status: "rejeitado", rejection: { reason }, ...over });
const withEmoji = (over: Partial<ForYouItem> & { back?: number } = {}): ForYouItem => item({ originalText: "Boa leitura 🎉🚀 do texto", text: "Boa leitura do texto", editedByUser: true, ...over });
const typeName = (type: string): string => (type === "comentario" ? "Comentário" : type);

function snapshot(forYou: ForYouItem[], over: Partial<RetroSnapshot> = {}): RetroSnapshot {
  return { agents: AGENTS, tasks: [], projects: [], forYou, typeName, ...over };
}

describe("texto: palavras do motivo", () => {
  it("minúsculas, sem acento, sem palavras vazias e com radical simples (formal e formais se juntam)", () => {
    expect(reasonWords("Tom FORMAL demais, até para o Cliente!")).toEqual(["tom", "formal", "cliente"]);
    expect(stem("formais")).toBe(stem("formal"));
    expect(stem("mensagens")).toBe(stem("mensagem"));
    expect(pluralPt("Comentário")).toBe("comentários");
    expect(pluralPt("Mensagem")).toBe("mensagens");
    expect(pluralPt("Post")).toBe("posts");
  });

  it("Jaccard de conjuntos de palavras", () => {
    expect(jaccard(new Set(["tom", "formal"]), new Set(["tom", "formal"]))).toBe(1);
    expect(jaccard(new Set(["tom", "formal"]), new Set(["formal", "longo"]))).toBeCloseTo(1 / 3, 10);
    expect(jaccard(new Set(), new Set(["a"]))).toBe(0);
  });
});

describe("limites de um candidato: 3 itens em 2 dias, ou 5 no total", () => {
  it("passesThreshold", () => {
    expect(passesThreshold(3, 2)).toBe(true);
    expect(passesThreshold(3, 1)).toBe(false);
    expect(passesThreshold(2, 2)).toBe(false);
    expect(passesThreshold(5, 1)).toBe(true);
    expect(passesThreshold(4, 1)).toBe(false);
  });

  it("3 recusas no mesmo dia não bastam; 3 em dois dias sim; 5 no mesmo dia sim", () => {
    const sameDay = [refused("muito longo", { back: 2 }), refused("muito longo", { back: 2 }), refused("muito longo", { back: 2 })];
    expect(findRetro(snapshot(sameDay), NOW).groups).toEqual([]);
    const twoDays = [...sameDay.slice(0, 2), refused("muito longo", { back: 3 })];
    const found = findRetro(snapshot(twoDays), NOW).groups;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "rejection", count: 3, days: 2 });
    const five = Array.from({ length: 5 }, () => refused("muito longo", { back: 2 }));
    expect(findRetro(snapshot(five), NOW).groups).toHaveLength(1);
    expect(findRetro(snapshot(five.slice(0, 2)), NOW).groups).toEqual([]);
  });

  it("só os últimos 14 dias contam", () => {
    const old = [refused("muito longo", { back: 15 }), refused("muito longo", { back: 16 }), refused("muito longo", { back: 17 })];
    expect(findRetro(snapshot(old), NOW).groups).toEqual([]);
  });
});

describe("recusas: agrupadas por agente e tipo", () => {
  it("a categoria agrupa motivos escritos de jeitos diferentes; o outro agente e o outro tipo ficam em grupos separados", () => {
    const list = [
      refused("tom formal demais", { rejection: { reason: "tom formal demais", category: "tom" }, back: 1 }),
      refused("muito formal", { rejection: { reason: "muito formal", category: "tom" }, back: 2 }),
      refused("seco e formal", { rejection: { reason: "seco e formal", category: "tom" }, back: 3 }),
      // Mesmo padrão em outro tipo: grupo à parte.
      refused("tom formal", { type: "convite", rejection: { reason: "tom formal", category: "tom" }, back: 1 }),
      refused("tom formal", { type: "convite", rejection: { reason: "tom formal", category: "tom" }, back: 2 }),
    ];
    const found = findRetro(snapshot(list), NOW);
    expect(found.groups).toHaveLength(1);
    expect(found.groups[0]).toMatchObject({ kind: "rejection", agentIds: ["clara"], type: "comentario", key: "c:tom", count: 3, days: 3, total: 3 });
    expect(found.groups[0]!.words).toContain("formal");
    expect(found.groups[0]!.template).toBeUndefined();
    expect(found.groups[0]!.line).toContain("recusou 3 de 3 comentários de Clara");
  });

  it("motivo em texto livre (sem categoria): une os parecidos (Jaccard >= 0,4) e deixa de fora o que não se parece", () => {
    const list = [
      refused("tom formal demais", { back: 1 }),
      refused("muito formal", { back: 2 }),
      refused("formal demais para o cliente", { back: 3 }),
      refused("faltou um exemplo concreto", { back: 1 }),
    ];
    const found = findRetro(snapshot(list), NOW).groups;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ count: 3, key: expect.stringMatching(/^w:/) });
    expect(found[0]!.words[0]).toBe("formal");
    expect(found[0]!.samples).toContain("tom formal demais");
  });

  it("recusa pelo Modo Automático ou sem motivo não entra", () => {
    const list = [item({ status: "rejeitado", decidedBy: "automatico", rejection: { reason: "tom formal" } }), item({ status: "rejeitado" }), refused("tom formal", { back: 2 }), refused("tom formal", { back: 3 })];
    expect(findRetro(snapshot(list), NOW).groups).toEqual([]);
  });
});

describe("edições: o traço de emoji sai por molde, sem IA", () => {
  it("'cortou emojis em 6 de 7 comentários' e a regra 'Não usar emojis em comentários.'", () => {
    const list = [
      ...[1, 2, 3, 4, 5, 6].map((back) => withEmoji({ back })),
      // O sétimo veio com emoji e o dono deixou como estava.
      item({ originalText: "Concordo 👏", text: "Concordo 👏", editedByUser: false, back: 2 }),
      // Sem emoji no rascunho: fora da conta.
      item({ originalText: "Sem nada", text: "Sem nada", back: 2 }),
    ];
    const found = findRetro(snapshot(list), NOW).groups;
    const emoji = found.find((group) => group.trait === "emoji")!;
    expect(emoji).toMatchObject({ kind: "edit_trait", count: 6, total: 7, key: "emoji", template: "Não usar emojis em comentários." });
    expect(emoji.line).toBe("cortou emojis em 6 de 7 comentários (Clara)");
    expect(emoji.excerpts).toHaveLength(5);
    expect(emoji.excerpts[0]).toMatchObject({ before: "Boa leitura 🎉🚀 do texto", after: "Boa leitura do texto" });
  });

  it("hashtag, exclamação e tamanho também têm molde; um texto encurtado pela metade vira 'Encurtar…'", () => {
    const long = "Esta é uma resposta bem comprida que o dono encurta em quase tudo sempre que lê.";
    const list = [1, 2, 3].map((back) => item({ originalText: `${long} #tag!`, text: "Resposta curta.", editedByUser: true, back }));
    const traits = findRetro(snapshot(list), NOW).groups.map((group) => group.trait);
    expect(traits).toEqual(expect.arrayContaining(["hashtag", "exclamation", "shorter"]));
    const shorter = findRetro(snapshot(list), NOW).groups.find((group) => group.trait === "shorter")!;
    expect(shorter.template).toMatch(/^Encurtar o texto de comentários \(o dono costuma cortar cerca de \d+%\)\.$/);
  });

  it("palavras tiradas em muitos itens (sem traço conhecido) ficam para o Maestro, sem molde", () => {
    const list = [1, 2, 3].map((back) => item({ originalText: "Prezado colega, adorei o texto", text: "Colega, adorei o texto", editedByUser: true, back }));
    const found = findRetro(snapshot(list), NOW).groups.filter((group) => group.kind === "edit_words");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "edit_words", words: ["prezado"] });
    expect(found[0]!.template).toBeUndefined();
  });
});

describe("falhas: cota e acesso são aviso, não regra", () => {
  const failed = (id: string, kind: Task["failureKind"], back: number, ref: string): Task => ({ id, roomId: "q", teamId: "t", agentId: "clara", prompt: `Tarefa ${id}`, status: "failed", ...(kind ? { failureKind: kind } : {}), work: { projectId: "p1", ref, step: 0 }, createdAt: at(noon(back) - HOUR), updatedAt: at(noon(back)) });
  const leaf = (ref: string, failure: string): ProjectTask => ({ ...projectTaskDefaults(), ref, title: ref, briefing: "", ownerId: "clara", steps: [], current: 0, dependsOn: [], priority: "normal", status: "falhou", failure, updatedAt: at(NOW) });
  const project = (leaves: ProjectTask[]): Project => ({ ...projectDefaults(), id: "p1", kind: "projeto", title: "P1", origin: "maestro", status: "ativo", version: 1, priority: "normal", mode: { kind: "pede-ok" }, tasks: leaves, createdAt: at(NOW - 30 * DAY), updatedAt: at(NOW) });

  it("falhas por cota viram um aviso e nunca um candidato; falhas do agente com o mesmo começo de erro viram candidato", () => {
    const tasks = [failed("q1", "cota", 1, "T1"), failed("q2", "cota", 2, "T2"), failed("q3", "cota", 3, "T3"), failed("a1", "agente", 1, "T4"), failed("a2", "agente", 2, "T5"), failed("a3", "agente", 3, "T6")];
    const projects = [project([leaf("T1", "Sem cota no motor"), leaf("T2", "Sem cota no motor"), leaf("T3", "Sem cota no motor"), leaf("T4", "Não achei o botão Publicar na página"), leaf("T5", "Não achei o botão Publicar no site"), leaf("T6", "Não achei o botão Publicar na tela")])];
    const found = findRetro(snapshot([], { tasks, projects }), NOW);
    expect(found.notices).toHaveLength(1);
    expect(found.notices[0]).toMatchObject({ kind: "cota", agentId: "clara", count: 3 });
    expect(found.notices[0]!.text).toContain("não vira regra");
    expect(found.groups).toHaveLength(1);
    expect(found.groups[0]).toMatchObject({ kind: "failure", count: 3 });
    expect(found.groups.some((group) => group.samples.some((sample) => /cota/i.test(sample)))).toBe(false);
  });

  it("falha cancelada não conta", () => {
    const tasks = [failed("a1", "cancelada", 1, "T1"), failed("a2", "cancelada", 2, "T1"), failed("a3", "cancelada", 3, "T1")];
    const found = findRetro(snapshot([], { tasks, projects: [project([leaf("T1", "Parado por alguém")])] }), NOW);
    expect(found.groups).toEqual([]);
    expect(found.considered.failed).toBe(0);
  });
});

describe("o mesmo padrão em 2 agentes vira uma regra global; o id do padrão é estável", () => {
  it("junta Clara e Eco no mesmo grupo (escopo global) e o id não depende da ordem dos itens", () => {
    const list = [...[1, 2, 3].map((back) => withEmoji({ back })), ...[1, 2, 3].map((back) => withEmoji({ back, agentId: "eco", roomId: "q2" }))];
    const found = findRetro(snapshot(list), NOW).groups.filter((group) => group.trait === "emoji");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ agentIds: ["clara", "eco"], roomIds: ["q", "q2"], count: 6 });
    const again = findRetro(snapshot([...list].reverse()), NOW).groups.find((group) => group.trait === "emoji")!;
    expect(again.id).toBe(found[0]!.id);
    expect(groupHash({ kind: "edit_trait", type: "comentario", key: "emoji", agentIds: ["eco", "clara"] })).toBe(found[0]!.id);
  });
});

describe("o histórico semeado tem os dois padrões do plano", () => {
  const agents = ["rapido", "editado", "recusado", "lento", "cota"].map((id) => ({ id, name: id }));
  const history = makeHistory({ now: NOW, days: 21, seed: 7, agents, retro: true });
  const found = findRetro({ agents, tasks: history.tasks, projects: history.projects, forYou: history.forYou, typeName }, NOW);

  it("o agente que o dono edita corta emoji em comentários (molde, sem IA)", () => {
    const emoji = found.groups.find((group) => group.trait === "emoji")!;
    expect(emoji).toMatchObject({ agentIds: ["editado"], type: "comentario", template: "Não usar emojis em comentários." });
    expect(emoji.count).toBeGreaterThanOrEqual(5);
    expect(emoji.total).toBeGreaterThanOrEqual(emoji.count);
  });

  it("o agente recusado por 'tom formal demais' vira um grupo de recusas por categoria, que precisa do Maestro", () => {
    const tone = found.groups.find((group) => group.kind === "rejection")!;
    expect(tone).toMatchObject({ agentIds: ["recusado"], type: "comentario", key: "c:tom", count: 5 });
    expect(tone.template).toBeUndefined();
    expect(tone.samples.join(" ")).toContain("tom formal demais");
  });

  it("a falta de cota do agente 'cota' é aviso, não regra", () => {
    expect(found.notices.some((notice) => notice.kind === "cota" && notice.agentId === "cota")).toBe(true);
    expect(found.groups.some((group) => group.agentIds.includes("cota") && group.kind === "failure" && /cota/i.test(group.samples.join(" ")))).toBe(false);
  });
});

describe("antes e depois de uma regra aprovada", () => {
  const target = { kind: "rejection" as const, type: "comentario", key: "c:tom", words: ["formal"], agentIds: ["clara"] };
  const tone = (back: number): ForYouItem => refused("tom formal", { rejection: { reason: "tom formal", category: "tom" }, back });
  const approvedAt = noon(16);

  it("só mede 14 dias depois da aprovação", () => {
    expect(ruleImpact(snapshot([]), target, approvedAt, approvedAt + 13 * DAY)).toBeUndefined();
    expect(ruleImpact(snapshot([]), target, approvedAt, approvedAt + 14 * DAY)).toEqual({ before: 0, after: 0 });
  });

  it("a mesma fórmula nas duas pontas: 5 recusas antes, 1 depois -> 'caíram de 5 para 1'", () => {
    // Aprovada há 16 dias (back 16): antes = dias 17 a 30 atrás; depois = dias 16 a 2 atrás.
    const before = [17, 18, 19, 20, 21].map(tone);
    const after = [tone(5)];
    const list = [...before, ...after, tone(1)];
    const impact = ruleImpact(snapshot(list), target, approvedAt, NOW)!;
    // tone(1) é de 1 dia atrás: depois da janela de 14 dias da aprovação, então não entra no "depois".
    expect(impact).toEqual({ before: 5, after: 1 });
    expect(patternCount(snapshot(list), target, approvedAt - 14 * DAY, approvedAt)).toBe(5);
    expect(impactLine("Evitar tom formal demais em comentários.", "recusas desse tipo", 5, 1)).toBe("Regra “Evitar tom formal demais em comentários.”: recusas desse tipo caíram de 5 para 1.");
    expect(impactLine("X", "recusas desse tipo", 1, 4)).toContain("subiram de 1 para 4");
    expect(impactLine("X", "recusas desse tipo", 2, 2)).toContain("ficaram em 2");
  });

  it("recusa de outra categoria ou de outro agente não entra na conta", () => {
    const other = refused("fora do assunto", { rejection: { reason: "fora do assunto", category: "fora_do_pedido" }, back: 5 });
    const stranger = refused("tom formal", { agentId: "eco", rejection: { reason: "tom formal", category: "tom" }, back: 5 });
    expect(ruleImpact(snapshot([other, stranger]), target, approvedAt, NOW)).toEqual({ before: 0, after: 0 });
  });
});
