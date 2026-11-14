// O escritório de demonstração: o motor de cena (@cyno/cena) alimentado pelo simulador dele (`mock`), que fabrica as
// sessões dentro do próprio navegador. Sem servidor, sem rede, sem dado de ninguém. Este módulo é carregado sob demanda
// (import dinâmico em Mapa.tsx): quem não liga a demonstração não baixa o motor.
import { createWorld, OfficeStore, type WorldApi } from "@cyno/cena";

export interface DemoMontada {
  mundo: WorldApi;
  /** Suspende (fora da tela) ou retoma o laço de desenho. */
  suspender(valor: boolean): void;
  desmontar(): void;
}

export function montarDemo(canvas: HTMLCanvasElement): DemoMontada {
  // 6 agentes e uma semente fixa: o mesmo escritório a cada abertura. O tema fica no original (o automático põe Natal no fim do ano).
  const loja = new OfficeStore({ mock: true, search: "?sessions=6&seed=7&speed=1.5" });
  const mundo = createWorld(canvas, loja);
  mundo.setOptions({ theme: "none", daylight: "day", bubbles: "all", liveliness: "lively", showNames: true });
  loja.connect();
  return {
    mundo,
    suspender: (valor) => mundo.setSuspended?.(valor),
    desmontar() {
      mundo.destroy();
      loja.disconnect();
    },
  };
}
