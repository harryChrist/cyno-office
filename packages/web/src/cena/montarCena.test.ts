import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parametrosDemo, pedeCenaDemo } from "./chave";
import { montarCena, type DepsCena } from "./montarCena";

/** DOM mínimo: só o que a ligação toca (`document.hidden` e os ouvintes de visibilitychange). */
function falsoDocumento() {
  const ouvintes = new Set<() => void>();
  const doc = {
    hidden: false,
    addEventListener: vi.fn((tipo: string, fn: () => void) => {
      if (tipo === "visibilitychange") ouvintes.add(fn);
    }),
    removeEventListener: vi.fn((tipo: string, fn: () => void) => {
      if (tipo === "visibilitychange") ouvintes.delete(fn);
    }),
  };
  return { doc, ouvintes, mudar(hidden: boolean) { doc.hidden = hidden; for (const fn of [...ouvintes]) fn(); } };
}

function falsasDeps() {
  const loja = { connect: vi.fn(), disconnect: vi.fn() };
  const mundo = { destroy: vi.fn(), setSuspended: vi.fn() };
  const deps: DepsCena = { criarLoja: vi.fn(() => loja), criarMundo: vi.fn(() => mundo) };
  return { loja, mundo, deps };
}

describe("montarCena", () => {
  let dom: ReturnType<typeof falsoDocumento>;
  const canvas = {} as HTMLCanvasElement;

  beforeEach(() => {
    dom = falsoDocumento();
    vi.stubGlobal("document", dom.doc);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("cria a loja com os parâmetros, o mundo no canvas, e liga a loja", () => {
    const { loja, deps } = falsasDeps();
    montarCena(canvas, "?sessions=6&seed=7", deps);
    expect(deps.criarLoja).toHaveBeenCalledWith("?sessions=6&seed=7");
    expect(deps.criarMundo).toHaveBeenCalledWith(canvas, loja);
    expect(loja.connect).toHaveBeenCalledTimes(1);
  });

  it("desmontar destrói o mundo, desliga a loja e solta o ouvinte (sem vazar)", () => {
    const { loja, mundo, deps } = falsasDeps();
    const cena = montarCena(canvas, "", deps);
    expect(dom.ouvintes.size).toBe(1);
    cena.desmontar();
    expect(mundo.destroy).toHaveBeenCalledTimes(1);
    expect(loja.disconnect).toHaveBeenCalledTimes(1);
    expect(dom.ouvintes.size).toBe(0);
    // chamar de novo (o StrictMode do React monta e desmonta duas vezes) não repete nada
    cena.desmontar();
    expect(mundo.destroy).toHaveBeenCalledTimes(1);
    expect(loja.disconnect).toHaveBeenCalledTimes(1);
  });

  it("com `bichos`, liga os bichos ao gancho de extras do mundo e os tira ao desmontar; sem `bichos` não mexe em nada", () => {
    const { loja, mundo } = falsasDeps();
    const add = vi.fn(() => vi.fn());
    const onFrame = vi.fn(() => vi.fn());
    const onClick = vi.fn(() => vi.fn());
    const extras = { add, onFrame, onClick, at: () => null, list: () => [] };
    const probe = () => ({ sim: { layoutVersion: 1, building: { core: [], rooms: [], corridor: {}, spots: [] }, chars: new Map() } }) as never;
    const mundoComExtras = { ...mundo, probe, extras };
    const deps: DepsCena = { criarLoja: vi.fn(() => loja), criarMundo: vi.fn(() => mundoComExtras) };
    montarCena(canvas, "", deps);
    expect(add).not.toHaveBeenCalled();
    const cena = montarCena(canvas, "", deps, undefined, { bichos: "demo" });
    // poleiro, calopsita, gato, cachorro e os efeitos
    expect(add).toHaveBeenCalledTimes(5);
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
    const remocoes = add.mock.results.map((r) => r.value as ReturnType<typeof vi.fn>);
    cena.desmontar();
    for (const r of remocoes) expect(r).toHaveBeenCalledTimes(1);
  });

  it("monta, desmonta e monta de novo: cada montagem tem o próprio mundo e nenhum ouvinte sobra", () => {
    const { deps } = falsasDeps();
    montarCena(canvas, "", deps).desmontar();
    const segunda = montarCena(canvas, "", deps);
    expect(deps.criarMundo).toHaveBeenCalledTimes(2);
    expect(dom.ouvintes.size).toBe(1);
    segunda.desmontar();
    expect(dom.ouvintes.size).toBe(0);
  });

  it("suspende com a aba escondida e retoma ao voltar", () => {
    const { mundo, deps } = falsasDeps();
    const cena = montarCena(canvas, "", deps);
    dom.mudar(true);
    expect(mundo.setSuspended).toHaveBeenLastCalledWith(true);
    dom.mudar(false);
    expect(mundo.setSuspended).toHaveBeenLastCalledWith(false);
    cena.desmontar();
    dom.mudar(true);
    expect(mundo.setSuspended).toHaveBeenCalledTimes(2);
  });

  it("voltar para a aba não religa a cena que a interface suspendeu", () => {
    const { mundo, deps } = falsasDeps();
    const cena = montarCena(canvas, "", deps);
    cena.suspender(true);
    expect(mundo.setSuspended).toHaveBeenLastCalledWith(true);
    dom.mudar(true);
    dom.mudar(false);
    expect(mundo.setSuspended).toHaveBeenLastCalledWith(true);
    cena.suspender(false);
    expect(mundo.setSuspended).toHaveBeenLastCalledWith(false);
    dom.mudar(true);
    expect(mundo.setSuspended).toHaveBeenLastCalledWith(true);
    cena.desmontar();
  });

  it("começa suspensa se a aba já estiver escondida", () => {
    dom.doc.hidden = true;
    const { mundo, deps } = falsasDeps();
    montarCena(canvas, "", deps).desmontar();
    expect(mundo.setSuspended).toHaveBeenCalledWith(true);
  });
});

describe("montarCena com alimentação (?cena=1)", () => {
  it("liga a alimentação depois de criar o mundo e a desliga antes de destruí-lo", () => {
    vi.stubGlobal("document", falsoDocumento().doc);
    const { loja, deps } = falsasDeps();
    const ordem: string[] = [];
    const desligar = vi.fn(() => ordem.push("desligou"));
    const ligar = vi.fn(() => {
      ordem.push("ligou");
      return desligar;
    });
    const cena = montarCena({} as HTMLCanvasElement, "", deps, ligar);
    expect(ligar).toHaveBeenCalledWith(loja);
    cena.desmontar();
    cena.desmontar();
    expect(desligar).toHaveBeenCalledTimes(1);
    expect(ordem).toEqual(["ligou", "desligou"]);
    vi.unstubAllGlobals();
  });
});

describe("a chave ?cena=demo", () => {
  it("só `demo` liga a cena", () => {
    expect(pedeCenaDemo("?cena=demo")).toBe(true);
    expect(pedeCenaDemo("?cena=demo&hora=22")).toBe(true);
    expect(pedeCenaDemo("")).toBe(false);
    expect(pedeCenaDemo("?cena=1")).toBe(false);
    expect(pedeCenaDemo("?gallery=1")).toBe(false);
  });

  it("os parâmetros do simulador têm padrão fixo (6 sessões, semente 7) e repassam os conhecidos", () => {
    expect(parametrosDemo("?cena=demo")).toBe("?sessions=6&seed=7");
    expect(parametrosDemo("?cena=demo&sessions=12&seed=3&speed=2&hora=22:30&lixo=1")).toBe("?sessions=12&seed=3&speed=2&hora=22%3A30");
  });
});
