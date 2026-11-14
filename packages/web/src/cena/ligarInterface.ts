// Liga a cena (WorldApi do motor) à interface do Cyno nos dois sentidos: seleção, foco, "Ver no mapa", Esc e a
// área livre da câmera. Sem React; as regras puras vivem em `traducaoView.ts`.
import type { WorldApi } from "@cyno/cena";
import { escapeReturnsToMap } from "./escape";
import { replayAtivo } from "./replay/replayStore";
import { useOfficeStore } from "../store/officeStore";
import { useViewStore } from "../store/viewStore";
import { alvoDoFoco, insetsDaCena, mesmaSelecaoDaView, selecaoDaCena, selecaoParaCena } from "./traducaoView";

/** O que a interface usa do mundo da cena. */
export type MundoInterativo = Pick<WorldApi, "select" | "getSelection" | "onSelect" | "focusAgent" | "focusRoom" | "overview" | "zoomBy" | "setViewInsets" | "social" | "onSound">;

/**
 * Espera entre uma mudança da interface e o movimento da câmera: o painel que abre mede o espaço que cobre num
 * efeito de layout logo depois da seleção; sem esta folga a câmera enquadraria o agente com a área livre antiga
 * e ele acabaria atrás do painel.
 */
export const FOLGA_DO_PAINEL_MS = 70;

/** Há uma janela modal (`<dialog open>`) na página? */
const haModal = (): boolean => typeof document !== "undefined" && document.querySelector("dialog[open]") !== null;

/** O mundo da cena também sabe quais salas já tem (o `probe` do gancho de desenvolvimento do motor); sem ele, toda sala vale. */
export type MundoComSalas = Partial<MundoInterativo> & { probe?: () => { sim: { rooms: ReadonlyMap<string, { listed: boolean }> } } };

/** Quanto a interface espera uma sala nova chegar à cena (o retrato sai ~150 ms depois do evento), e de quanto em quanto confere. */
export const ESPERA_DA_SALA_MS = 3_000;
export const CONFERE_SALA_MS = 80;

export function ligarInterface(mundo: MundoComSalas): () => void {
  const desfazer: (() => void)[] = [];
  /** Verdadeiro enquanto a interface empurra uma seleção para a cena: o eco da cena não volta para a interface. */
  let empurrando = false;
  let adiado: ReturnType<typeof setTimeout> | null = null;
  /** Os pedidos à cena que esperam a folga do painel, na ordem: um pedido novo não cancela o anterior (ex.: limpar a seleção e voltar ao mapa). */
  let pedidos: (() => void)[] = [];

  const depoisDoPainel = (acao: () => void): void => {
    pedidos.push(acao);
    if (adiado !== null) clearTimeout(adiado);
    adiado = setTimeout(() => {
      adiado = null;
      const agora = pedidos;
      pedidos = [];
      aplicarInsets();
      for (const pedido of agora) pedido();
    }, FOLGA_DO_PAINEL_MS);
  };

  const aplicarInsets = (): void => {
    mundo.setViewInsets?.(insetsDaCena(useViewStore.getState().overlays, { w: window.innerWidth, h: window.innerHeight }));
  };

  /** A sala já está na cena? (Uma sala recém-criada chega ao mapa um instante depois de a interface selecioná-la.) */
  const salaNaCena = (id: string): boolean => (mundo.probe ? mundo.probe().sim.rooms.get(id)?.listed === true : true);
  const esperas = new Set<ReturnType<typeof setInterval>>();
  /** Roda `acao` quando a sala existir na cena; passado o prazo roda mesmo assim (a cena limpa a seleção, como antes). */
  const quandoASalaChegar = (id: string, acao: () => void): void => {
    if (salaNaCena(id)) return acao();
    const inicio = Date.now();
    const espera = setInterval(() => {
      if (!salaNaCena(id) && Date.now() - inicio < ESPERA_DA_SALA_MS) return;
      clearInterval(espera);
      esperas.delete(espera);
      acao();
    }, CONFERE_SALA_MS);
    esperas.add(espera);
  };

  /** O agente está na cena agora (quem está offline ou ainda não entrou não tem personagem para destacar)? */
  const presente = (id: string): boolean => (mundo.social ? mundo.social(id) !== null : true);

  const empurrar = (acao: () => void): void => {
    empurrando = true;
    try {
      acao();
    } finally {
      empurrando = false;
    }
  };

  // Cena -> interface: clique no personagem, na sala, no núcleo ou no vazio.
  if (mundo.onSelect) {
    desfazer.push(
      mundo.onSelect((sel) => {
        // Durante o "Rever o dia" a cena é só para olhar: o clique não abre painel de agente do escritório de verdade.
        if (empurrando || replayAtivo()) return;
        const salas = useOfficeStore.getState().office?.rooms ?? [];
        const destino = selecaoDaCena(sel, (id) => salas.some((sala) => sala.id === id));
        if (destino === undefined) return;
        const view = useViewStore.getState();
        if (!mesmaSelecaoDaView(destino, view.selection)) view.select(destino);
      }),
    );
  }

  // Interface -> cena: lista, painel, "Ver no mapa", botões de foco e a área livre.
  desfazer.push(
    useViewStore.subscribe((state, prev) => {
      if (state.overlays !== prev.overlays) aplicarInsets();

      if (state.selection !== prev.selection) {
        const atual = mundo.getSelection?.() ?? null;
        const igual = mesmaSelecaoDaView(selecaoDaCena(atual) ?? null, state.selection);
        if (!igual) {
          const selecao = state.selection;
          depoisDoPainel(() => {
            // A seleção pode ter mudado de novo durante a folga.
            if (useViewStore.getState().selection !== selecao) return;
            if (!selecao) return empurrar(() => mundo.select?.(null));
            // Quem não está na cena (offline, ainda a chegar) fica só no painel: a cena limparia a seleção no quadro seguinte.
            if (selecao.kind === "agent" && !presente(selecao.id)) return empurrar(() => mundo.select?.(null));
            const empurrarSelecao = () => {
              // A seleção pode ter mudado de novo enquanto a sala não chegava.
              if (useViewStore.getState().selection !== selecao) return;
              empurrar(() => mundo.select?.(selecaoParaCena(selecao), { focus: selecao.kind === "agent" }));
            };
            if (selecao.kind === "room") quandoASalaChegar(selecao.id, empurrarSelecao);
            else empurrarSelecao();
          });
        }
      }

      if (state.focus !== prev.focus) {
        const alvo = alvoDoFoco(state.focus);
        depoisDoPainel(() => {
          if (alvo === null) mundo.overview?.();
          else quandoASalaChegar(alvo, () => useViewStore.getState().focus === state.focus && mundo.focusRoom?.(alvo));
        });
      }

      const pedido = state.showAgentRequest;
      if (pedido && pedido !== prev.showAgentRequest) {
        depoisDoPainel(() => (presente(pedido.id) ? mundo.focusAgent?.(pedido.id, { follow: true }) : mundo.focusRoom?.(pedido.fallback)));
      }
    }),
  );

  // Esc volta ao mapa (a menos que seja de um campo, de uma janela ou de quem já tratou o evento).
  const aoTeclar = (evento: KeyboardEvent): void => {
    const alvo = evento.target instanceof HTMLElement ? evento.target : null;
    const modal = haModal() || alvo?.closest("dialog") != null;
    if (!escapeReturnsToMap({ key: evento.key, defaultPrevented: evento.defaultPrevented, target: alvo, modalOpen: modal })) return;
    const view = useViewStore.getState();
    // Sem nada aberto nem enquadrado, o Esc não mexe na câmera que o dono arrumou.
    if (view.focus.kind === "map" && !view.selection) return;
    mundo.overview?.();
    if (view.focus.kind !== "map") view.setFocus({ kind: "map" });
  };
  // Na captura: roda antes do Esc do painel lateral, que limpa a seleção.
  window.addEventListener("keydown", aoTeclar, true);
  desfazer.push(() => window.removeEventListener("keydown", aoTeclar, true));

  window.addEventListener("resize", aplicarInsets);
  desfazer.push(() => window.removeEventListener("resize", aplicarInsets));

  aplicarInsets();
  // Se o Cyno já tinha algo selecionado ao montar (trocar de página e voltar), a cena o mostra.
  const inicial = useViewStore.getState().selection;
  if (inicial?.kind === "agent" && presente(inicial.id)) depoisDoPainel(() => empurrar(() => mundo.select?.(selecaoParaCena(inicial))));

  return () => {
    if (adiado !== null) clearTimeout(adiado);
    adiado = null;
    for (const espera of esperas) clearInterval(espera);
    esperas.clear();
    for (const fn of desfazer) fn();
  };
}
