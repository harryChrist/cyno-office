import { describe, expect, it } from "vitest";
import { daysToExpire, expiresAtFor, findStatus, isItemDue, isItemExpired, itemLabel, summarizeChanges, summarizeItems, validateValues } from "./routine-tracking";
import type { TrackedItem, TrackingSpec } from "./routines";

const spec: TrackingSpec = {
  fields: [
    { key: "empresa", label: "Empresa", type: "texto", required: true },
    { key: "salario", label: "Salário", type: "numero" },
    { key: "etapa", label: "Etapa", type: "opcao", options: ["RH", "Técnica"] },
    { key: "link", label: "Link", type: "link" },
    { key: "em", label: "Em", type: "data" },
  ],
  statuses: [{ name: "Inscrito" }, { name: "Entrevista", alert: true }, { name: "Recusado", terminal: true }],
  lifespan: { days: 15, untilTerminal: true },
  checkEveryHours: 24,
};
const NOW = new Date("2026-11-11T12:00:00Z");
const item = (extra: Partial<TrackedItem> = {}): TrackedItem => ({ id: "I-0001", routineId: "R-0001", values: { empresa: "Acme" }, status: "Inscrito", state: "ativo", createdAt: NOW.toISOString(), history: [], ...extra });

describe("regras dos itens acompanhados", () => {
  it("valida e normaliza os valores contra os campos", () => {
    expect(validateValues(spec, { empresa: " Acme ", salario: "1500,5", etapa: "rh", link: "https://a.test/x", em: "2026-11-11T10:00:00Z" }, { full: true })).toEqual({ values: { empresa: "Acme", salario: 1500.5, etapa: "RH", link: "https://a.test/x", em: "2026-11-11" }, errors: [] });
    const bad = validateValues(spec, { salario: "muito", etapa: "Final", link: "ftp://x", em: "amanhã", extra: 1 }, { full: true });
    expect(bad.errors).toHaveLength(6);
    expect(bad.errors.join("\n")).toContain('Unknown field "extra". Valid fields: empresa');
    expect(bad.errors.join("\n")).toContain('Required field "empresa"');
    // Atualização parcial não exige obrigatórios.
    expect(validateValues(spec, { salario: 3 }, { full: false }).errors).toEqual([]);
  });

  it("status sem diferenciar maiúsculas; rótulo do item é o primeiro valor", () => {
    expect(findStatus(spec, "entrevista")?.name).toBe("Entrevista");
    expect(findStatus(spec, "Contratado")).toBeUndefined();
    expect(itemLabel(spec, item())).toBe("Acme");
    expect(itemLabel(spec, item({ values: {} }))).toBe("I-0001");
  });

  it("vida e conferência: nunca conferido é vencido; passou de checkEveryHours é vencido; parado nunca", () => {
    expect(expiresAtFor(spec, NOW)).toBe("2026-11-26T12:00:00.000Z");
    expect(expiresAtFor({ lifespan: { untilTerminal: true } }, NOW)).toBeUndefined();
    expect(isItemDue(item(), spec, NOW)).toBe(true);
    expect(isItemDue(item({ lastCheckedAt: "2026-11-11T00:00:00Z" }), spec, NOW)).toBe(false);
    expect(isItemDue(item({ lastCheckedAt: "2026-11-10T11:59:00Z" }), spec, NOW)).toBe(true);
    expect(isItemDue(item({ state: "parado" }), spec, NOW)).toBe(false);
    expect(isItemExpired(item({ expiresAt: "2026-11-11T12:00:00Z" }), NOW)).toBe(true);
    expect(isItemExpired(item({ expiresAt: "2026-11-12T00:00:00Z" }), NOW)).toBe(false);
    expect(isItemExpired(item({ state: "encerrado", expiresAt: "2026-11-01T00:00:00Z" }), NOW)).toBe(false);
    expect(daysToExpire(item({ expiresAt: "2026-11-12T00:00:00Z" }), NOW)).toBe(1);
  });

  it("resumo dos itens e das mudanças", () => {
    const items = [
      item({ history: [{ at: NOW.toISOString(), by: "agente", field: "criado", to: "Inscrito" }] }),
      item({ id: "I-0002", state: "parado" }),
      item({ id: "I-0003", state: "encerrado", lastCheckedAt: NOW.toISOString() }),
    ];
    expect(summarizeItems(items, spec, NOW)).toEqual({ active: 1, ended: 1, stopped: 1, changedToday: 1, due: 1 });
    expect(summarizeChanges([{ itemId: "I-1", text: "Novo: A", kind: "novo" }, { itemId: "I-2", text: "Novo: B", kind: "novo" }, { itemId: "I-3", text: "Empresa X → Entrevista", kind: "status" }])).toBe("2 novos; Empresa X → Entrevista");
    expect(summarizeChanges([{ itemId: "I-1", text: "x".repeat(150), kind: "status" }, { itemId: "I-2", text: "y".repeat(150), kind: "status" }, { itemId: "I-3", text: "z", kind: "status" }])).toMatch(/; \+2$/);
  });
});
