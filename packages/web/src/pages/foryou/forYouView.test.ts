import { FOR_YOU_STATUS_LABELS, FOR_YOU_TYPE_ICONS, legacyForYouTypes, type ForYouItem, type ForYouTypeDef } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import {
  approvalConfirm,
  batchLabel,
  batchOf,
  cancelLabel,
  canDiscard,
  cardTitle,
  counterState,
  DONE_LABELS,
  crivoTone,
  extraMeta,
  inlineRequestLabel,
  showGroupHeader,
  overLimitWarning,
  primaryAction,
  pruneDrafts,
  statusCounts,
  statusGroup,
  stepIndex,
  typeDisplay,
  typeOptions,
  typeStyle,
  updateBadge,
  visibleItems,
} from "./forYouView";
import { circlePath, ICON_PATHS, roundRectPath } from "./iconPaths";

function item(id: string, overrides: Partial<ForYouItem> = {}): ForYouItem {
  return {
    id,
    agentId: "ana",
    roomId: "a",
    type: "outro",
    status: "pendente",
    meta: {},
    text: "texto",
    originalText: "texto",
    editedByUser: false,
    createdAt: "2026-11-07T10:00:00.000Z",
    ...overrides,
  };
}

const TYPES = legacyForYouTypes("2026-11-07T10:00:00.000Z");

const items = [
  item("A-0001", { type: "convite", createdAt: "2026-11-07T10:02:00.000Z" }),
  item("A-0002", { type: "post", createdAt: "2026-11-07T10:01:00.000Z" }),
  item("A-0003", { type: "convite", status: "aprovado", decidedAt: "2026-11-07T11:00:00.000Z" }),
  item("A-0004", { type: "pergunta", status: "respondido", decidedAt: "2026-11-07T12:00:00.000Z" }),
  item("A-0005", { type: "post", status: "rejeitado", decidedAt: "2026-11-07T10:30:00.000Z" }),
];

describe("filtros e contagens", () => {
  it("conta pendentes e decididos", () => {
    expect(statusCounts(items)).toEqual({ pendente: 2, decididos: 3, cancelados: 0 });
    expect(statusCounts([])).toEqual({ pendente: 0, decididos: 0, cancelados: 0 });
  });

  it("cancelados têm grupo próprio (não entram em Decididos), do mais recente ao mais antigo", () => {
    const list = [
      ...items,
      item("A-0006", { status: "cancelado", cancelledBy: "maestro", cancelReason: "duplicado", decidedAt: "2026-11-07T13:00:00.000Z" }),
      item("A-0007", { status: "cancelado", cancelledBy: "usuario", decidedAt: "2026-11-07T14:00:00.000Z" }),
    ];
    expect(statusCounts(list)).toEqual({ pendente: 2, decididos: 3, cancelados: 2 });
    expect(statusGroup(list[5]!)).toBe("cancelados");
    expect(visibleItems(list, "cancelados", "todos").map((current) => current.id)).toEqual(["A-0007", "A-0006"]);
    expect(visibleItems(list, "decididos", "todos").map((current) => current.id)).not.toContain("A-0006");
    expect(typeOptions(list, "cancelados", "todos", TYPES)[0]).toMatchObject({ type: "todos", count: 2 });
  });

  it("opções por tipo dentro do grupo, na ordem fixa, com o selecionado mesmo zerado", () => {
    expect(typeOptions(items, "pendente", "todos", TYPES).map((option) => [option.type, option.label, option.count])).toEqual([
      ["todos", "Todos", 2],
      ["convite", "Convite", 1],
      ["post", "Post", 1],
    ]);
    expect(typeOptions(items, "decididos", "mensagem", TYPES).map((option) => [option.type, option.count])).toEqual([
      ["todos", 3],
      ["pergunta", 1],
      ["convite", 1],
      ["mensagem", 0],
      ["post", 1],
    ]);
  });

  it("tipos do workspace na ordem deles; um id sem tipo vai no fim, cinza e com o id como nome", () => {
    const reels: ForYouTypeDef = { ...TYPES[0]!, id: "reels", name: "Reels", behavior: "texto", icon: "video", color: "coral" };
    const list = [item("A-0001", { type: "reels" }), item("A-0002", { type: "sumiu-daqui" }), item("A-0003", { type: "pergunta" })];
    expect(typeOptions(list, "pendente", "todos", [...TYPES, reels]).map((option) => [option.type, option.label])).toEqual([
      ["todos", "Todos"],
      ["pergunta", "Pergunta"],
      ["reels", "Reels"],
      ["sumiu-daqui", "Sumiu daqui"],
    ]);
    expect(typeDisplay(TYPES, "sumiu-daqui")).toMatchObject({ icon: "ponto", color: "cinza", behavior: "texto" });
    expect(typeStyle(reels)).toEqual({ "--c": "var(--ui-tc-10)" });
  });

  it("plano e questionário têm filtro próprio (não aparecem como Outro/Pergunta)", () => {
    const list = [item("A-0001", { type: "outro", kind: "plano" }), item("A-0002", { type: "pergunta", kind: "questionario" }), item("A-0003", { type: "convite" }), item("A-0004", { type: "outro" })];
    expect(typeOptions(list, "pendente", "todos", TYPES).map((option) => [option.type, option.label, option.count])).toEqual([
      ["todos", "Todos", 4],
      ["@plano", "Planos", 1],
      ["@questionario", "Questionários", 1],
      ["convite", "Convite", 1],
      ["outro", "Outro", 1],
    ]);
    expect(visibleItems(list, "pendente", "@plano").map((current) => current.id)).toEqual(["A-0001"]);
    expect(visibleItems(list, "pendente", "outro").map((current) => current.id)).toEqual(["A-0004"]);
    expect(typeDisplay(TYPES, "@questionario")).toMatchObject({ name: "Questionários", icon: "interrogacao", behavior: "pergunta" });
  });

  it("pendentes do mais antigo ao mais novo; decididos do mais recente ao mais antigo", () => {
    expect(visibleItems(items, "pendente", "todos").map((current) => current.id)).toEqual(["A-0002", "A-0001"]);
    expect(visibleItems(items, "decididos", "todos").map((current) => current.id)).toEqual(["A-0004", "A-0003", "A-0005"]);
    expect(visibleItems(items, "decididos", "post").map((current) => current.id)).toEqual(["A-0005"]);
    expect(visibleItems(items, "pendente", "mensagem")).toEqual([]);
  });

  it("descarta rascunhos de itens que já não estão pendentes", () => {
    const drafts = { "A-0001": { text: "x" }, "A-0003": { text: "y" } };
    expect(pruneDrafts(drafts, items)).toEqual({ "A-0001": { text: "x" } });
    const kept = { "A-0001": { text: "x" } };
    expect(pruneDrafts(kept, items)).toBe(kept);
  });
});

describe("card", () => {
  it("título: onde, para, pergunta ou tipo + agente", () => {
    expect(cardTitle(item("A", { where: "Sobre", to: "Ana" }), undefined, TYPES)).toBe("Sobre");
    expect(cardTitle(item("A", { to: "Ana Souza" }), undefined, TYPES)).toBe("Para Ana Souza");
    expect(cardTitle(item("A", { type: "pergunta", title: "Qual dia?" }), undefined, TYPES)).toBe("Qual dia?");
    expect(cardTitle(item("A", { type: "pergunta" }), undefined, TYPES)).toBe("Pergunta para você");
    expect(cardTitle(item("A", { type: "post" }), "Lia", TYPES)).toBe("Post de Lia");
    expect(cardTitle(item("A", { type: "comentario" }), undefined, TYPES)).toBe("Comentário");
  });

  it("contador: limite por tipo, perto a partir de 90% e passou acima", () => {
    const convite = item("A", { type: "convite" });
    expect(counterState(convite, "x".repeat(100), TYPES)).toMatchObject({ tone: "ok", over: 0, fill: 0.5, limit: { max: 200 } });
    expect(counterState(convite, "x".repeat(180), TYPES).tone).toBe("perto");
    expect(counterState(convite, "x".repeat(205), TYPES)).toMatchObject({ tone: "passou", over: 5, fill: 1 });
    expect(counterState(item("A", { type: "perfil", where: "Headline" }), "x".repeat(221), TYPES).over).toBe(1);
    expect(counterState(item("A", { type: "post" }), "abc", TYPES)).toMatchObject({ limit: null, length: 3, tone: "ok" });
  });

  it("contador conta emoji como 1 (igual ao server)", () => {
    expect(counterState(item("A", { type: "convite" }), "🎉".repeat(200), TYPES)).toMatchObject({ length: 200, over: 0, tone: "perto" });
  });

  it("aviso acima do limite: quanto passou e de qual limite", () => {
    const legenda: ForYouTypeDef = { ...TYPES[0]!, id: "legenda-de-post", name: "Legenda de post", behavior: "texto", limits: { default: 2200 } };
    const types = [...TYPES, legenda];
    expect(overLimitWarning(item("A", { type: "legenda-de-post" }), "x".repeat(2450), types)).toBe("Passa 250 caracteres do limite de Legenda de post");
    expect(overLimitWarning(item("A", { type: "convite" }), "x".repeat(201), types)).toBe("Passa 1 caractere do limite de Convite");
    expect(overLimitWarning(item("A", { type: "perfil", where: "Headline" }), "x".repeat(1220), types)).toBe("Passa 1.000 caracteres do limite de Perfil (headline)");
    expect(overLimitWarning(item("A", { type: "legenda-de-post" }), "x".repeat(2200), types)).toBeNull();
    expect(overLimitWarning(item("A", { type: "post" }), "x".repeat(9000), types)).toBeNull();
  });

  it("aprovar acima do limite pede confirmação (não bloqueia); rejeitar, responder ou caber não", () => {
    const convite = item("A", { type: "convite" });
    expect(approvalConfirm(convite, "aprovado", "x".repeat(250), TYPES)).toEqual({ length: 250, max: 200, label: "Convite" });
    expect(approvalConfirm(convite, "aprovado", "x".repeat(200), TYPES)).toBeNull();
    expect(approvalConfirm(convite, "rejeitado", "x".repeat(250), TYPES)).toBeNull();
    expect(approvalConfirm(item("A", { type: "post" }), "aprovado", "x".repeat(9000), TYPES)).toBeNull();
    const enquete: ForYouTypeDef = { ...TYPES[0]!, id: "enquete", name: "Enquete", behavior: "pergunta", limits: { default: 10 } };
    expect(approvalConfirm(item("A", { type: "enquete" }), "aprovado", "x".repeat(50), [enquete])).toBeNull();
  });

  it("metadados extras sem os que viraram chip; tom do crivo", () => {
    expect(extraMeta(item("A", { meta: { crivo: "aprovado", simulado: "sim", pedido: "x" } }))).toEqual([["pedido", "x"]]);
    expect(crivoTone("Aprovado (simulado)")).toBe("ok");
    expect(crivoTone("reprovado: tom")).toBe("no");
    expect(crivoTone("pendente")).toBe("neutro");
  });

  it("ação principal: responder nos tipos de pergunta, aprovar no resto", () => {
    expect(primaryAction({ type: "pergunta" }, TYPES)).toEqual({ status: "respondido", label: "Responder" });
    expect(primaryAction({ type: "convite" }, TYPES)).toEqual({ status: "aprovado", label: "Aprovar" });
    const enquete: ForYouTypeDef = { ...TYPES[0]!, id: "enquete", name: "Enquete", behavior: "pergunta" };
    expect(primaryAction({ type: "enquete" }, [enquete])).toEqual({ status: "respondido", label: "Responder" });
    expect(primaryAction({ type: "pergunta" }, null)).toEqual({ status: "respondido", label: "Responder" });
  });

  it("J/K: começa no primeiro e para nas pontas", () => {
    expect(stepIndex(-1, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, 1)).toBe(2);
    expect(stepIndex(0, 3, -1)).toBe(0);
    expect(stepIndex(-1, 0, 1)).toBe(-1);
  });
});

describe("ícones de traço", () => {
  it("todo ícone da galeria tem desenho, e todo ícone tem ao menos um traço", () => {
    for (const icon of FOR_YOU_TYPE_ICONS) expect(ICON_PATHS[icon]).toBeDefined();
    expect(FOR_YOU_TYPE_ICONS.length).toBeGreaterThanOrEqual(30);
    for (const paths of Object.values(ICON_PATHS)) {
      expect(paths.length).toBeGreaterThan(0);
      for (const d of paths) expect(d).toMatch(/^M/);
    }
  });

  it("círculo e retângulo arredondado viram path fechado na grade 24×24", () => {
    expect(circlePath(12, 8, 4)).toBe("M8 8a4 4 0 1 0 8 0a4 4 0 1 0 -8 0");
    expect(roundRectPath(9, 9, 12, 12, 2)).toBe("M11 9h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2v-8a2 2 0 0 1 2 -2z");
  });
});

describe("cancelar e atualizar", () => {
  it("rótulo de quem cancelou: Maestro, o agente pelo nome, ou você (Descartado)", () => {
    expect(cancelLabel(item("A-1", { status: "cancelado", cancelledBy: "maestro" }))).toBe("Cancelado pelo Maestro");
    expect(cancelLabel(item("A-1", { status: "cancelado", cancelledBy: "agente" }), "Clara")).toBe("Cancelado por Clara");
    expect(cancelLabel(item("A-1", { status: "cancelado", cancelledBy: "usuario" }))).toBe("Descartado por você");
    expect(cancelLabel(item("A-1"))).toBeNull();
  });

  it("descartar só em pendentes que não são plano", () => {
    expect(canDiscard(item("A-1"))).toBe(true);
    expect(canDiscard(item("A-1", { kind: "questionario" }))).toBe(true);
    expect(canDiscard(item("A-1", { kind: "plano" }))).toBe(false);
    expect(canDiscard(item("A-1", { kind: "organizacao" }))).toBe(false);
    expect(canDiscard(item("A-1", { status: "aprovado" }))).toBe(false);
    expect(canDiscard(item("A-1", { status: "cancelado" }))).toBe(false);
  });

  it("selo Atualizado: a última alteração dá quem e o motivo; o cancelamento não conta", () => {
    expect(updateBadge(item("A-1"))).toBeNull();
    const history = [
      { at: "2026-11-07T10:05:00.000Z", by: "maestro" as const, action: "alterado" as const, reason: "trocar a pergunta 2" },
      { at: "2026-11-07T10:06:00.000Z", by: "agente" as const, action: "alterado" as const },
      { at: "2026-11-07T10:07:00.000Z", by: "usuario" as const, action: "cancelado" as const, reason: "não precisa" },
    ];
    expect(updateBadge(item("A-1", { history }), "Clara")).toMatchObject({ label: "Atualizado por Clara", count: 2 });
    expect(updateBadge(item("A-1", { history: history.slice(0, 1) }))).toMatchObject({ label: "Atualizado pelo Maestro", reason: "trocar a pergunta 2", count: 1 });
  });
});

describe("agrupamento por pedido", () => {
  const one = { requestId: "T-1", title: "Post de quarta", items: [item("A-1")] };
  const two = { requestId: "T-2", title: "Convites", items: [item("A-2"), item("A-3")] };
  const loose = { title: "Outros", items: [item("A-4")] };

  it("cabeçalho só com 2 itens ou mais", () => {
    expect(showGroupHeader(one)).toBe(false);
    expect(showGroupHeader(two)).toBe(true);
    expect(showGroupHeader(loose)).toBe(false);
  });

  it("pedido na linha só quando o grupo tem um item e veio de um pedido", () => {
    expect(inlineRequestLabel(one)).toBe("Post de quarta");
    expect(inlineRequestLabel(two)).toBeUndefined();
    expect(inlineRequestLabel(loose)).toBeUndefined();
  });
});

describe("lote de aprovações", () => {
  it("batchOf: só vale com mais de um item do mesmo groupId; conta decididos (cancelados incluídos) e devolve os pendentes", () => {
    const list = [
      item("A-1", { groupId: "G-1", status: "aprovado" }),
      item("A-2", { groupId: "G-1", status: "pendente" }),
      item("A-3", { groupId: "G-1", status: "cancelado" }),
      item("A-4", { groupId: "G-1", status: "pendente" }),
      item("A-5", { groupId: "G-2", status: "pendente" }),
      item("A-6"),
    ];
    const batch = batchOf(list, list[1]!)!;
    expect(batch).toMatchObject({ groupId: "G-1", total: 4, decided: 2 });
    expect(batch.pending.map((current) => current.id)).toEqual(["A-2", "A-4"]);
    expect(batchLabel(batch)).toBe("2 de 4 decididos");
    expect(batchOf(list, list[4]!)).toBeUndefined();
    expect(batchOf(list, list[5]!)).toBeUndefined();
  });
});

describe("rótulos de decisão", () => {
  it("o valor gravado rejeitado aparece como Recusado", () => {
    expect(FOR_YOU_STATUS_LABELS.rejeitado).toBe("Recusado");
    expect(DONE_LABELS.rejeitado).toBe("Recusado");
  });
});
