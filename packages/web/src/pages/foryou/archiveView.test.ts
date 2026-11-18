import type { ForYouItem } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import {
  archiveHint,
  archiveTotal,
  itemsLabel,
  monthLabel,
  sortArchiveItems,
} from "./archiveView";

const item = (id: string, decidedAt: string): ForYouItem => ({
  id,
  agentId: "a",
  roomId: "r",
  type: "post",
  status: "aprovado",
  meta: {},
  text: "t",
  editedByUser: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  decidedAt,
});

describe("arquivo das aprovações (Mais antigos)", () => {
  it("nomeia o mês em pt-BR e nunca devolve undefined", () => {
    expect(monthLabel("2026-11")).toBe("novembro de 2026");
    expect(monthLabel("2027-01")).toBe("janeiro de 2027");
    expect(monthLabel("2026-03")).toBe("março de 2026");
    expect(monthLabel("2026-13")).toBe("2026-13");
    expect(monthLabel("lixo")).toBe("lixo");
  });

  it("a linha de explicação usa o prazo e some sem prazo", () => {
    expect(archiveHint(7)).toBe(
      "Aprovações decididas há mais de 7 dias ficam aqui.",
    );
    expect(archiveHint(1)).toBe(
      "Aprovações decididas há mais de 1 dia ficam aqui.",
    );
    expect(archiveHint(0)).toBe("");
  });

  it("soma e rotula as contagens", () => {
    expect(archiveTotal([{ count: 3 }, { count: 9 }])).toBe(12);
    expect(archiveTotal([])).toBe(0);
    expect(itemsLabel(1)).toBe("1 item");
    expect(itemsLabel(12)).toBe("12 itens");
  });

  it("ordena do decidido mais recentemente para o mais antigo", () => {
    const sorted = sortArchiveItems([
      item("A-1", "2026-10-01T10:00:00.000Z"),
      item("A-3", "2026-10-20T10:00:00.000Z"),
      item("A-2", "2026-10-10T10:00:00.000Z"),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["A-3", "A-2", "A-1"]);
  });
});
