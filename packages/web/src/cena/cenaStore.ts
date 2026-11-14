// A loja que o motor de cena espera (`OfficeStore` do Habblaud), alimentada pelo Cyno em vez de SSE ou simulador.
import { OfficeStore } from "@cyno/cena";
import type { OfficeSnapshot } from "@cyno/cena";

/**
 * `OfficeStore` sem rede: o motor só lê `snapshot` e escuta o evento `snapshot`. Quem publica é o Cyno, com os
 * retratos montados pelo adaptador (`montarRetrato`), por `publicar` (o `pushReplay` do original, que guarda o
 * retrato e dispara o evento).
 */
export class CenaStore extends OfficeStore {
  constructor() {
    super({ mock: true });
  }

  /** Nada a conectar: os dados vêm das lojas do Cyno. */
  override connect(): void {}

  /** Entrega um retrato novo ao motor. */
  publicar(retrato: OfficeSnapshot): void {
    this.pushReplay(retrato);
  }
}
