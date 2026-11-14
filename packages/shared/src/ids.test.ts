import { describe, expect, it } from "vitest";
import { isReservedRoomId, isSafeId, slugify, uniqueSlug } from "./ids";

describe("slugify", () => {
  it("remove acentos, espaços e símbolos", () => {
    expect(slugify("Conteúdo & Revisão")).toBe("conteudo-revisao");
    expect(slugify("  Tomás  ")).toBe("tomas");
    expect(slugify("ProjetoX")).toBe("projetox");
  });

  it("usa o fallback quando nada sobra", () => {
    expect(slugify("!!!")).toBe("item");
    expect(slugify("", "agente")).toBe("agente");
  });

  it("sempre gera ids seguros e curtos", () => {
    for (const input of ["--a--", "Ação 123", "x".repeat(200), "Ñandú"]) {
      expect(isSafeId(slugify(input))).toBe(true);
    }
  });
});

describe("isSafeId", () => {
  it("aceita slugs válidos", () => {
    expect(isSafeId("projetox")).toBe(true);
    expect(isSafeId("projetox-frontend")).toBe(true);
    expect(isSafeId("1a")).toBe(true);
  });

  it("rejeita ids inseguros", () => {
    for (const id of ["", "-a", "A", "a_b", "a b", "../x", "a/b", "x".repeat(65)]) {
      expect(isSafeId(id)).toBe(false);
    }
  });
});

describe("uniqueSlug", () => {
  it("adiciona sufixos -2, -3...", () => {
    expect(uniqueSlug("Lia", [])).toBe("lia");
    expect(uniqueSlug("Lia", ["lia"])).toBe("lia-2");
    expect(uniqueSlug("Lia", ["lia", "lia-2"])).toBe("lia-3");
  });

  it("evita ids reservados", () => {
    expect(uniqueSlug("Lobby", [], ["lobby", "global"])).toBe("lobby-2");
    expect(isReservedRoomId("global")).toBe(true);
    expect(isReservedRoomId("projetox")).toBe(false);
  });
});
