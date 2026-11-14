import { describe, expect, it } from "vitest";
import {
  attentionPrefsBodySchema,
  attentionPrefsSchema,
  attentionTitle,
  counterSummary,
  DEFAULT_ATTENTION_PREFS,
  doNotDisturbActive,
  needsOwnerOf,
  nextAttention,
  ownerCount,
  silenceReason,
  tourOrder,
  untilTomorrow,
  workspaceMuted,
  type AttentionAlert,
} from "./attention";
import { parseCynoEvent } from "./cyno";

const alert = (key: string, at: string, change: Partial<AttentionAlert> = {}): AttentionAlert => ({
  id: `al-${key}`,
  key,
  kind: "approval",
  level: "alert",
  needsOwner: true,
  text: key,
  count: 1,
  at,
  updatedAt: at,
  target: { page: "para-voce" },
  ...change,
});

const NOW = Date.parse("2026-11-12T15:00:00.000Z");

describe("needsOwnerOf", () => {
  it("só alert dos tipos que o dono responde; limite de uso e falha não contam", () => {
    expect(needsOwnerOf("approval", "alert")).toBe(true);
    expect(needsOwnerOf("help", "alert")).toBe(true);
    expect(needsOwnerOf("engine_down", "alert")).toBe(true);
    expect(needsOwnerOf("approval", "warn")).toBe(false);
    expect(needsOwnerOf("usage", "alert")).toBe(false);
    expect(needsOwnerOf("budget", "alert")).toBe(false);
    expect(needsOwnerOf("failed", "alert")).toBe(false);
  });
});

describe("o percurso do contador", () => {
  const open = [
    alert("c", "2026-11-12T12:30:00Z"),
    alert("falha", "2026-11-12T10:00:00Z", { kind: "failed", level: "warn", needsOwner: false }),
    alert("a", "2026-11-12T09:00:00Z"),
    alert("b", "2026-11-12T11:00:00Z"),
  ];

  it("ordem: o que espera o dono, do mais antigo ao mais novo; o resto vem depois", () => {
    expect(tourOrder(open).map((entry) => entry.key)).toEqual(["a", "b", "c", "falha"]);
  });

  it("um clique anda para o próximo, dá a volta no fim e Shift volta", () => {
    expect(nextAttention(open, null)?.key).toBe("a");
    expect(nextAttention(open, "a")?.key).toBe("b");
    expect(nextAttention(open, "b")?.key).toBe("c");
    expect(nextAttention(open, "c")?.key).toBe("a");
    expect(nextAttention(open, "a", -1)?.key).toBe("c");
    expect(nextAttention(open, null, -1)?.key).toBe("c");
  });

  it("uma chave que já saiu da lista recomeça pelo mais antigo; sem nada esperando, nada", () => {
    expect(nextAttention(open, "sumiu")?.key).toBe("a");
    expect(nextAttention([open[1]!], null)).toBeUndefined();
    expect(nextAttention([], "a")).toBeUndefined();
  });

  it("empate de hora desempata pelo id", () => {
    const tie = [alert("z", "2026-11-12T09:00:00Z"), alert("y", "2026-11-12T09:00:00Z")];
    expect(tourOrder(tie).map((entry) => entry.key)).toEqual(["y", "z"]);
  });
});

describe("o número e o título da aba", () => {
  it("ownerCount conta só o que espera o dono", () => {
    expect(ownerCount([alert("a", "2026-11-12T09:00:00Z"), alert("b", "2026-11-12T09:00:00Z", { needsOwner: false })])).toBe(1);
  });

  it("ownerCount soma os itens: lote de 5 aprovações conta 5, ajuda e terminal caído contam 1", () => {
    const open = [
      alert("lote", "2026-11-12T09:00:00Z", { count: 5 }),
      alert("ajuda", "2026-11-12T09:00:00Z", { kind: "help" }),
      alert("terminal", "2026-11-12T09:00:00Z", { kind: "engine_down" }),
      alert("fim", "2026-11-12T09:00:00Z", { needsOwner: false, count: 4 }),
    ];
    expect(ownerCount(open)).toBe(7);
    // Só aprovações: o número é o de Aprovações (itens).
    expect(ownerCount([alert("lote", "2026-11-12T09:00:00Z", { count: 5 })])).toBe(5);
    expect(counterSummary([alert("lote", "2026-11-12T06:00:00Z", { count: 5 }), alert("b", "2026-11-12T14:00:00Z")], NOW)).toBe("6 esperando você; o mais antigo há 9 h");
  });

  it("(N) Cyno com N, sem número em zero, 99+ no teto", () => {
    expect(attentionTitle(0)).toBe("Cyno");
    expect(attentionTitle(3)).toBe("(3) Cyno");
    expect(attentionTitle(250)).toBe("(99+) Cyno");
  });

  it("a dica do contador diz quantos e há quanto tempo o mais antigo espera", () => {
    expect(counterSummary([], NOW)).toBe("Nada esperando você");
    expect(counterSummary([alert("a", "2026-11-12T06:00:00Z"), alert("b", "2026-11-12T14:00:00Z")], NOW)).toBe("2 esperando você; o mais antigo há 9 h");
    expect(counterSummary([alert("a", "2026-11-12T14:50:00Z")], NOW)).toBe("1 esperando você; o mais antigo há 10 min");
  });
});

describe("as preferências da conta", () => {
  const prefs = (change: object) => attentionPrefsSchema.parse(change);

  it("o padrão não silencia nada", () => {
    expect(silenceReason(DEFAULT_ATTENTION_PREFS, { kind: "approval", workspaceId: "ws" }, NOW)).toBeNull();
  });

  it("tipo desligado não avisa, os outros sim", () => {
    const p = prefs({ kinds: { failed: false } });
    expect(silenceReason(p, { kind: "failed", workspaceId: "ws" }, NOW)).toBe("kind");
    expect(silenceReason(p, { kind: "approval", workspaceId: "ws" }, NOW)).toBeNull();
  });

  it("workspace silenciado: sempre ou até o fim do prazo; só aquele workspace", () => {
    const p = prefs({ mutedWorkspaces: { a: {}, b: { until: "2026-11-12T16:00:00Z" }, c: { until: "2026-11-12T14:00:00Z" } } });
    expect(workspaceMuted(p, "a", NOW)).toBe(true);
    expect(workspaceMuted(p, "b", NOW)).toBe(true);
    expect(workspaceMuted(p, "c", NOW)).toBe(false);
    expect(workspaceMuted(p, "d", NOW)).toBe(false);
    expect(workspaceMuted(p, undefined, NOW)).toBe(false);
    expect(workspaceMuted(p, "__proto__", NOW)).toBe(false);
    expect(silenceReason(p, { kind: "approval", workspaceId: "a" }, NOW)).toBe("workspace");
    expect(silenceReason(p, { kind: "usage" }, NOW)).toBeNull();
  });

  it("não perturbe vale até o instante e depois some", () => {
    const p = prefs({ dndUntil: "2026-11-12T16:00:00Z" });
    expect(doNotDisturbActive(p, NOW)).toBe(true);
    expect(doNotDisturbActive(p, NOW + 2 * 3_600_000)).toBe(false);
    expect(silenceReason(p, { kind: "approval", workspaceId: "ws" }, NOW)).toBe("dnd");
    expect(doNotDisturbActive(prefs({ dndUntil: "lixo" }), NOW)).toBe(false);
  });

  it("\"até amanhã\" é a meia-noite de São Paulo do dia seguinte", () => {
    // 12:00 em SP (15:00Z): amanhã 00:00 em SP = 03:00Z do dia 13.
    expect(untilTomorrow(NOW)).toBe("2026-11-13T03:00:00.000Z");
    // 23:30 em SP (02:30Z do dia 13): ainda é dia 12 em SP, então amanhã começa às 03:00Z do dia 13.
    expect(untilTomorrow(Date.parse("2026-11-13T02:30:00Z"))).toBe("2026-11-13T03:00:00.000Z");
  });

  it("o corpo do PUT recusa tipo inventado, id inseguro e campo sobrando", () => {
    expect(attentionPrefsBodySchema.safeParse({ kinds: { approval: false } }).success).toBe(true);
    expect(attentionPrefsBodySchema.safeParse({ kinds: { inventado: true } }).success).toBe(false);
    expect(attentionPrefsBodySchema.safeParse({ mutedWorkspaces: { "../x": {} } }).success).toBe(false);
    expect(attentionPrefsBodySchema.safeParse({ dndUntil: null }).success).toBe(true);
    expect(attentionPrefsBodySchema.safeParse({ sobra: 1 }).success).toBe(false);
  });
});

describe("eventos no socket da plataforma", () => {
  it("parseCynoEvent reconhece attention:*", () => {
    expect(parseCynoEvent({ type: "attention:cleared", key: "k", reason: "decided" })).toEqual({ type: "attention:cleared", key: "k", reason: "decided" });
    expect(parseCynoEvent({ type: "attention:inventado" })).toBeNull();
  });
});
