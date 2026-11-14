import type { ForYouItem, RetroGroup, RetroView } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { askButtonLabel, askDisabledReason, badgeLabel, considerLine, groupLine, hasReady, ruleItems, waitingRules } from "./retroView";

const rule = (id: string, status: ForYouItem["status"], over: Partial<ForYouItem> = {}): ForYouItem => ({
  id,
  agentId: "clara",
  roomId: "q",
  type: "outro",
  status,
  meta: {},
  text: "Não usar emojis em comentários.",
  originalText: "Não usar emojis em comentários.",
  editedByUser: false,
  kind: "regra",
  rule: { text: "Não usar emojis em comentários.", scope: { global: true }, evidence: { itemIds: [], count: 3, days: 2 }, source: "molde", retro: "2026-W46" },
  createdAt: "2026-11-12T10:00:00.000Z",
  ...over,
});

const group = (over: Partial<RetroGroup> = {}): RetroGroup => ({ id: "g-1", kind: "rejection", agentIds: ["clara"], agentNames: ["Clara"], roomIds: ["q"], type: "comentario", typeName: "Comentário", key: "c:tom", words: ["formal"], count: 5, total: 13, days: 4, itemIds: [], excerpts: [], line: "recusou 5 de 13 comentários de Clara (tom)", samples: [], ...over });

const view = (over: Partial<RetroView> = {}): RetroView => ({
  period: "2026-W46",
  from: "2026-10-29T15:00:00.000Z",
  to: "2026-11-12T15:00:00.000Z",
  now: "2026-11-12T15:00:00.000Z",
  ready: [],
  needsMaestro: [group()],
  rules: [],
  impacts: [],
  notices: [],
  waiting: 0,
  estimate: { groups: 1, tokens: 1300, usd: 0.0123, model: "sonnet", label: "cerca de US$ 0,01 (equivalente)" },
  maestro: { available: true, asking: false },
  stored: [],
  considered: { decided: 58, edited: 13, rejected: 6, failed: 7 },
  ...over,
});

describe("O que aprendemos: os cartões de regra", () => {
  it("os que esperam o dono vêm primeiro (o mais antigo no topo); os decididos depois (o mais recente primeiro); cancelado fica fora", () => {
    const items = [
      rule("A-1", "aprovado", { decidedAt: "2026-11-10T10:00:00.000Z" }),
      rule("A-2", "pendente", { createdAt: "2026-11-12T12:00:00.000Z" }),
      rule("A-3", "pendente", { createdAt: "2026-11-11T12:00:00.000Z" }),
      rule("A-4", "rejeitado", { decidedAt: "2026-11-11T10:00:00.000Z" }),
      rule("A-5", "cancelado"),
      { ...rule("A-6", "pendente"), kind: "aprovacao" as const },
    ];
    expect(ruleItems(items).map((item) => item.id)).toEqual(["A-3", "A-2", "A-4", "A-1"]);
    expect(ruleItems(null)).toEqual([]);
  });

  it("o selo da aba conta só as regras pendentes", () => {
    const items = [rule("A-1", "pendente"), rule("A-2", "pendente"), rule("A-3", "aprovado"), { ...rule("A-4", "pendente"), kind: undefined }];
    expect(waitingRules(items)).toBe(2);
    expect(badgeLabel(0)).toBe("");
    expect(badgeLabel(1)).toBe("1 regra esperando o seu OK");
    expect(badgeLabel(3)).toBe("3 regras esperando o seu OK");
  });
});

describe("O que aprendemos: o quadro", () => {
  it("a linha de cima diz o que foi olhado e avisa quando há poucos dados", () => {
    expect(considerLine(view())).toBe("Olhei 58 decisões suas dos últimos 14 dias: 6 recusas, 13 textos editados e 7 falhas.");
    expect(considerLine(view({ considered: { decided: 0, edited: 0, rejected: 0, failed: 0 } }))).toContain("Nenhuma decisão sua");
    expect(considerLine(view({ considered: { decided: 3, edited: 1, rejected: 1, failed: 0 } }))).toContain("Poucos dados");
  });

  it("o botão do Maestro mostra o custo antes do clique e diz por que está desligado", () => {
    expect(askButtonLabel(view())).toBe("Escrever as regras com o Maestro (cerca de US$ 0,01 (equivalente))");
    expect(askDisabledReason(view())).toBeUndefined();
    expect(askDisabledReason(view({ needsMaestro: [] }))).toMatch(/Nenhum padrão espera texto/);
    expect(askDisabledReason(view({ maestro: { available: false, asking: false, reason: "O Maestro não roda numa CLI." } }))).toBe("O Maestro não roda numa CLI.");
    expect(askDisabledReason(view({ maestro: { available: true, asking: true } }))).toMatch(/já está escrevendo/);
  });

  it("a lista dos padrões e a abertura automática dos cartões por molde", () => {
    expect(groupLine(group())).toBe("Recusas · Comentário: recusou 5 de 13 comentários de Clara (tom) (4 dias)");
    expect(groupLine(group({ kind: "edit_trait", days: 1, line: "cortou emojis em 3 de 3 comentários (Clara)" }))).toBe("Edições · Comentário: cortou emojis em 3 de 3 comentários (Clara) (1 dia)");
    expect(hasReady(view())).toBe(false);
    expect(hasReady(view({ ready: [group({ kind: "edit_trait", template: "Não usar emojis em comentários." })] }))).toBe(true);
  });
});
