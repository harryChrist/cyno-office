import { describe, expect, it, vi } from "vitest";
import { aoMudarTelaCheiaDoNavegador, entrarNaTelaCheia, escSaiDaTelaCheia, podeTelaCheiaNativa, sairDaTelaCheia, TELA_CHEIA_FECHADA, type AmbienteTelaCheia } from "./telaCheia";

const comApi = (sobre: Partial<AmbienteTelaCheia> = {}): AmbienteTelaCheia => ({
  fullscreenEnabled: true,
  fullscreenElement: null,
  documentElement: { requestFullscreen: vi.fn(async () => undefined) },
  exitFullscreen: vi.fn(async () => undefined),
  ...sobre,
});
const semApi: AmbienteTelaCheia = { documentElement: {} };

describe("tela cheia: entrar e sair", () => {
  it("com a API do navegador, entra pela nativa", async () => {
    const doc = comApi();
    expect(podeTelaCheiaNativa(doc)).toBe(true);
    expect(await entrarNaTelaCheia(doc)).toEqual({ ativa: true, modo: "nativa" });
    expect(doc.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("sem a API (iPhone) ou com ela desligada, cai para a camada, sem erro", async () => {
    expect(podeTelaCheiaNativa(semApi)).toBe(false);
    expect(await entrarNaTelaCheia(semApi)).toEqual({ ativa: true, modo: "camada" });
    const desligada = comApi({ fullscreenEnabled: false });
    expect(await entrarNaTelaCheia(desligada)).toEqual({ ativa: true, modo: "camada" });
    expect(desligada.documentElement.requestFullscreen).not.toHaveBeenCalled();
  });

  it("o navegador que nega (a promessa rejeita) também cai para a camada", async () => {
    const doc = comApi({ documentElement: { requestFullscreen: vi.fn(async () => Promise.reject(new TypeError("negado"))) } });
    expect(await entrarNaTelaCheia(doc)).toEqual({ ativa: true, modo: "camada" });
  });

  it("sair fecha a nativa; a camada só fecha o estado", async () => {
    const doc = comApi({ fullscreenElement: {} as Element });
    expect(await sairDaTelaCheia(doc, { ativa: true, modo: "nativa" })).toEqual(TELA_CHEIA_FECHADA);
    expect(doc.exitFullscreen).toHaveBeenCalledTimes(1);
    const outro = comApi();
    expect(await sairDaTelaCheia(outro, { ativa: true, modo: "camada" })).toEqual(TELA_CHEIA_FECHADA);
    expect(outro.exitFullscreen).not.toHaveBeenCalled();
  });

  it("o navegador saindo sozinho (Esc na nativa) fecha o estado; na camada nada muda", () => {
    expect(aoMudarTelaCheiaDoNavegador({ ativa: true, modo: "nativa" }, { fullscreenElement: null })).toEqual(TELA_CHEIA_FECHADA);
    const dentro = { ativa: true, modo: "nativa" as const };
    expect(aoMudarTelaCheiaDoNavegador(dentro, { fullscreenElement: {} as Element })).toBe(dentro);
    const camada = { ativa: true, modo: "camada" as const };
    expect(aoMudarTelaCheiaDoNavegador(camada, { fullscreenElement: null })).toBe(camada);
  });

  it("Esc sai só quando ativa e sem diálogo aberto", () => {
    const ativa = { ativa: true, modo: "camada" as const };
    expect(escSaiDaTelaCheia(ativa, "Escape", false)).toBe(true);
    expect(escSaiDaTelaCheia(ativa, "Escape", true)).toBe(false);
    expect(escSaiDaTelaCheia(ativa, "Enter", false)).toBe(false);
    expect(escSaiDaTelaCheia(TELA_CHEIA_FECHADA, "Escape", false)).toBe(false);
  });
});
