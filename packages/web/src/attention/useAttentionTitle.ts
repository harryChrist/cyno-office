import { attentionTitle } from "@cyno/shared";
import { useEffect } from "react";
import { selectOwnerCount, useAttentionStore } from "../store/attentionStore";

/**
 * O título da aba vira `(N) Cyno` com N = coisas esperando o dono (itens somados, como no contador), e o selo do app instalado
 * (`navigator.setAppBadge`) acompanha. Com a aba escondida o navegador atrasa os temporizadores,
 * então o título também é refeito num `setTimeout` curto (o mesmo cuidado do Habblaud).
 */
export function useAttentionTitle(): number {
  const count = useAttentionStore(selectOwnerCount);
  useEffect(() => {
    const apply = () => {
      document.title = attentionTitle(count);
    };
    apply();
    const again = window.setTimeout(apply, 500);
    const nav = navigator as Navigator & { setAppBadge?: (count?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    try {
      if (count > 0) void nav.setAppBadge?.(count)?.catch(() => undefined);
      else void nav.clearAppBadge?.()?.catch(() => undefined);
    } catch {
      // Sem selo neste navegador: só o título.
    }
    return () => window.clearTimeout(again);
  }, [count]);
  return count;
}
