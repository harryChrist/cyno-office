// Regras puras da "tela cheia" (a cidade do Cyno e o mapa do Escritório): entrar pela API do navegador quando ela
// existe e deixa, cair para uma camada fixa cobrindo a janela quando não (iPhone, navegador que nega), e sair pelo
// botão, pelo Esc ou quando o navegador sai sozinho. O ambiente (`document`) entra por parâmetro: testa com ele simulado.

export type ModoTelaCheia = "nativa" | "camada";
export type EstadoTelaCheia = { ativa: boolean; modo: ModoTelaCheia | null };
export const TELA_CHEIA_FECHADA: EstadoTelaCheia = { ativa: false, modo: null };

/** O pedaço do `document` que a tela cheia usa. */
export type AmbienteTelaCheia = {
  fullscreenEnabled?: boolean;
  fullscreenElement?: Element | null;
  documentElement: { requestFullscreen?: (opcoes?: FullscreenOptions) => Promise<void> };
  exitFullscreen?: () => Promise<void>;
};

/** O navegador oferece a tela cheia e a permite aqui? */
export function podeTelaCheiaNativa(doc: AmbienteTelaCheia): boolean {
  return doc.fullscreenEnabled === true && typeof doc.documentElement.requestFullscreen === "function";
}

/** Entra: pela API quando existir e for aceita; senão (ou se o navegador recusar) pela camada fixa. Nunca lança. */
export async function entrarNaTelaCheia(doc: AmbienteTelaCheia): Promise<EstadoTelaCheia> {
  if (podeTelaCheiaNativa(doc)) {
    try {
      await doc.documentElement.requestFullscreen!({ navigationUI: "hide" });
      return { ativa: true, modo: "nativa" };
    } catch {
      // negado (sem gesto do usuário, política da página): cai para a camada
    }
  }
  return { ativa: true, modo: "camada" };
}

/** Sai: fecha a tela cheia nativa (se for o caso) e devolve o estado fechado. Nunca lança. */
export async function sairDaTelaCheia(doc: AmbienteTelaCheia, estado: EstadoTelaCheia): Promise<EstadoTelaCheia> {
  if (estado.modo === "nativa" && doc.fullscreenElement && typeof doc.exitFullscreen === "function") {
    try {
      await doc.exitFullscreen();
    } catch {
      // já tinha saído
    }
  }
  return TELA_CHEIA_FECHADA;
}

/** O navegador avisou que a tela cheia mudou (o dono apertou Esc, F11…): na nativa, sem elemento = saiu. */
export function aoMudarTelaCheiaDoNavegador(estado: EstadoTelaCheia, doc: Pick<AmbienteTelaCheia, "fullscreenElement">): EstadoTelaCheia {
  if (estado.ativa && estado.modo === "nativa" && !doc.fullscreenElement) return TELA_CHEIA_FECHADA;
  return estado;
}

/** Esc sai da tela cheia (a nativa o navegador já trata; a camada, nós), a não ser que um diálogo aberto o queira. */
export function escSaiDaTelaCheia(estado: EstadoTelaCheia, tecla: string, temDialogoAberto: boolean): boolean {
  return estado.ativa && tecla === "Escape" && !temDialogoAberto;
}
