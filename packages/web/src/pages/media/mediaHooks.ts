import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { hashWithMedia, mediaFromHash } from "./mediaNav";

/**
 * A mídia aberta, guardada no endereço (`?midia=<código>`): abrir empilha uma entrada no histórico (o Voltar do navegador
 * fecha a gaveta); trocar de mídia dentro da gaveta só troca a entrada (`replace`); fechar volta uma entrada se foi a
 * gaveta que a criou, ou só tira o parâmetro (link aberto direto).
 */
export function useMediaParam(): [string | null, (key: string | null, how?: "push" | "replace") => void] {
  const [key, setKey] = useState(() => mediaFromHash(window.location.hash));
  useEffect(() => {
    const sync = () => setKey(mediaFromHash(window.location.hash));
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);
  const set = useCallback((next: string | null, how: "push" | "replace" = "push") => {
    const hash = hashWithMedia(window.location.hash, next);
    if (hash === window.location.hash) return;
    const state = window.history.state as { cynoMedia?: boolean } | null;
    if (next === null && state?.cynoMedia) {
      window.history.back();
      return;
    }
    if (next !== null && how === "push") window.history.pushState({ ...state, cynoMedia: true }, "", hash);
    else window.history.replaceState(next === null ? state : { ...state, cynoMedia: state?.cynoMedia ?? false }, "", hash);
    // pushState e replaceState não avisam: o resto do app (a Biblioteca, a navegação) lê o endereço pelo popstate.
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);
  return [key, set];
}

/** O elemento que rola a página em volta de `el` (a área da Biblioteca no computador, a página no celular). */
export function findScroller(el: Element | null): HTMLElement {
  for (let node = el?.parentElement ?? null; node && node !== document.body; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return (document.scrollingElement ?? document.documentElement) as HTMLElement;
}

/**
 * Guarda a posição de rolagem de cada escopo e a devolve ao voltar a um já visto (um escopo novo começa no topo).
 * `key` é o conteúdo que está na tela agora; o hook liga ao `root` (algo dentro da área que rola).
 */
export function useScopeScroll(root: RefObject<HTMLElement | null>, key: string): void {
  const saved = useRef(new Map<string, number>());
  const current = useRef(key);
  useEffect(() => {
    const onScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element || target instanceof Document)) return;
      const scroller = findScroller(root.current);
      const element = target instanceof Document ? target.scrollingElement : target;
      if (element === scroller) saved.current.set(current.current, scroller.scrollTop);
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, [root]);
  useLayoutEffect(() => {
    if (current.current === key) return;
    current.current = key;
    const scroller = findScroller(root.current);
    scroller.scrollTop = saved.current.get(key) ?? 0;
  }, [key, root]);
}
