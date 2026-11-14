// O enquadramento da cidade ao entrar e sair da tela cheia. Entrando, a cidade é reenquadrada para o espaço novo (a
// conta é a do `enquadrar` da vista: lotes e praça cabendo na área, sem cortar prédio); saindo, volta o centro e o
// zoom de antes. Puro: a câmera entra como um objeto com `x`, `y` (o ponto do mundo no meio da vista) e `zoom`.

export type CameraDaCidade = { x: number; y: number; zoom: number };
export type Enquadre = { x: number; y: number; zoom: number };

/** Foto do enquadramento (centro do mundo e zoom): vale em qualquer tamanho de vista, porque `x`,`y` são o centro. */
export function guardarEnquadre(camera: CameraDaCidade): Enquadre {
  return { x: camera.x, y: camera.y, zoom: camera.zoom };
}

/** Devolve à câmera o enquadramento guardado. */
export function restaurarEnquadre(camera: CameraDaCidade, enquadre: Enquadre): void {
  camera.x = enquadre.x;
  camera.y = enquadre.y;
  camera.zoom = enquadre.zoom;
}

/** Durante a troca de tamanho (a tela cheia do navegador demora alguns quadros) a vista é reenquadrada a cada resize, até aqui. */
export const JANELA_DE_REENQUADRE_MS = 900;

/** Ainda dentro da janela de reenquadre que começou em `inicio`? */
export function aindaReenquadrando(inicio: number, agora: number): boolean {
  return agora - inicio <= JANELA_DE_REENQUADRE_MS;
}
