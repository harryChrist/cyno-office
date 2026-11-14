import { useSyncExternalStore } from "react";

const QUERY = "(max-width: 640px)";

const subscribe = (notify: () => void) => {
  if (typeof window === "undefined") return () => undefined;
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};

/** A tela é de celular (até 640 px)? Na árvore, as colunas viram uma linha de detalhes e a edição vai para o painel. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (typeof window === "undefined" ? false : window.matchMedia(QUERY).matches),
    () => false,
  );
}
