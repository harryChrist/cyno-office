import { builtinForYouTypes, legacyForYouTypes } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { createBody, formFromType, itemCounts, itemsLabel, limitsSummary, suggestedIcon, updateBody } from "./typeForm";

const AT = "2026-11-08T12:00:00.000Z";
const LEGACY = legacyForYouTypes(AT);
const byId = (id: string) => LEGACY.find((type) => type.id === id)!;

describe("formulário do tipo", () => {
  it("tipo novo: vazio, ícone genérico e a próxima cor livre", () => {
    expect(formFromType(null, builtinForYouTypes(AT))).toMatchObject({ name: "", behavior: "texto", icon: "documento", color: "azul", limit: "", byWhere: [] });
  });

  it("ida e volta: o perfil vira formulário e volta igual no PATCH", () => {
    const form = formFromType(byId("perfil"), LEGACY);
    expect(form.byWhere[0]).toEqual({ match: "headline", max: "220", name: "headline" });
    const { body, errors } = updateBody(form);
    expect(errors).toEqual({});
    expect(body).toMatchObject({ name: "Perfil", limits: byId("perfil").limits, fields: { where: true } });
  });

  it("sem limites nem campos: o PATCH tira (null); o POST nem manda", () => {
    const form = { ...formFromType(byId("convite"), LEGACY), limit: "", to: false };
    expect(updateBody(form).body).toMatchObject({ limits: null, fields: null });
    const created = createBody({ ...form, name: "Reels" }).body!;
    expect(created).not.toHaveProperty("limits");
    expect(created).not.toHaveProperty("fields");
  });

  it("valida nome, limite e as linhas por 'onde' (linha vazia é ignorada)", () => {
    const base = formFromType(null, []);
    expect(createBody(base).errors.name).toBeDefined();
    expect(createBody({ ...base, name: "X", limit: "abc" }).errors.limit).toBeDefined();
    expect(createBody({ ...base, name: "X", limit: "0" }).errors.limit).toBeDefined();
    expect(createBody({ ...base, name: "X", byWhere: [{ match: "legenda", max: "", name: "" }] }).errors.byWhere).toBeDefined();
    const ok = createBody({ ...base, name: " Reels ", limit: "2.200", byWhere: [{ match: "titulo", max: "60", name: "" }, { match: "", max: "", name: "" }] });
    expect(ok.errors).toEqual({});
    expect(ok.body).toMatchObject({ name: "Reels", limits: { default: 2200, byWhere: [{ match: "titulo", max: 60, name: "titulo" }] } });
  });

  it("ícone sugerido pelo nome", () => {
    expect(suggestedIcon("Reels", "")).toBe("video");
    expect(suggestedIcon("Algo", "newsletter da semana")).toBe("email");
  });
});

describe("resumos da lista", () => {
  it("limites por extenso", () => {
    expect(limitsSummary(byId("convite"))).toBe("até 200 caracteres");
    expect(limitsSummary(byId("perfil"))).toBe("headline 220 · Sobre 2.600 · experiência 2.000 · projeto 2.000");
    expect(limitsSummary(byId("post"))).toBe("sem limite");
    expect(limitsSummary({ limits: { default: 150, byWhere: [{ match: "legenda", max: 2200, name: "legenda" }] } })).toBe("legenda 2.200 · demais 150");
  });

  it("contagem de itens por tipo", () => {
    const counts = itemCounts([{ type: "post" }, { type: "post" }, { type: "outro" }]);
    expect(counts.get("post")).toBe(2);
    expect(itemsLabel(0)).toBe("nenhum item");
    expect(itemsLabel(1)).toBe("1 item");
    expect(itemsLabel(1200)).toBe("1.200 itens");
  });
});
