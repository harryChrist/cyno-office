import { counterSummary } from "@cyno/shared";
import { useMemo } from "react";
import { stepAttention } from "../attention/useAttentionKeys";
import { useNow } from "../ui/ActivityFeed";
import { selectOwnerCount, useAttentionStore } from "../store/attentionStore";
import { NavIcon } from "./navIcons";
import "./attention.css";

/** O que o contador diz (rótulo acessível e dica): "3 esperando você; o mais antigo há 9 h. Tecla P". */
export function useAttentionCounter() {
  const open = useAttentionStore((state) => state.open);
  const count = useAttentionStore(selectOwnerCount);
  const nowMs = useNow().getTime();
  const hint = useMemo(() => `${counterSummary(open, nowMs)}${count > 0 ? ". Conta aprovações, perguntas, pedidos de ajuda e terminais caídos (um lote de aprovações conta cada item). Clique ou tecla P para ir ao próximo (Shift volta)" : ""}`, [open, count, nowMs]);
  return { count, hint };
}

/**
 * "Esperando você · N": pílula curta do celular e da barra de cima (a barra lateral tem o botão "Espera" em "Para você").
 * Cada clique vai ao próximo alerta que espera o dono, do mais antigo ao mais novo, e dá a volta no fim; `Shift`+clique
 * volta. Só aparece quando há alguém esperando (a barra é estreita).
 */
export function AttentionCounter() {
  const { count, hint } = useAttentionCounter();
  if (count <= 0) return null;
  return (
    <button type="button" className="attn-pill" onClick={(event) => stepAttention(event.shiftKey ? -1 : 1)} aria-label={hint} title={hint} data-testid="attention-counter">
      <NavIcon name="mao" className="nav-icon attn-pill__icon" />
      <span className="attn-pill__label">Esperando você</span>
      <span className="attn-pill__count" data-testid="attention-count">
        {count > 99 ? "99+" : count}
      </span>
    </button>
  );
}
