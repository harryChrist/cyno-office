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
 * "Esperando você · N": sempre visível. Cada clique vai ao próximo alerta que espera o dono, do mais
 * antigo ao mais novo, e dá a volta no fim; `Shift`+clique volta. Parado em zero. `nav` é a linha da
 * barra lateral; `pill` é a pílula curta do celular e da barra de cima.
 */
export function AttentionCounter({ variant = "nav" }: { variant?: "nav" | "pill" }) {
  const { count, hint } = useAttentionCounter();
  const active = count > 0;
  const onClick = (event: { shiftKey: boolean }) => {
    if (active) stepAttention(event.shiftKey ? -1 : 1);
  };
  if (variant === "pill") {
    // No celular só aparece quando há alguém esperando (a barra é estreita).
    if (!active) return null;
    return (
      <button type="button" className="attn-pill" onClick={onClick} aria-label={hint} title={hint} data-testid="attention-counter">
        <NavIcon name="mao" className="nav-icon attn-pill__icon" />
        <span className="attn-pill__label">Esperando você</span>
        <span className="attn-pill__count" data-testid="attention-count">
          {count > 99 ? "99+" : count}
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`navitem navitem--attention${active ? " navitem--attention-on" : ""}`}
      aria-disabled={!active}
      aria-label={hint}
      title={hint}
      data-tip={active ? `Esperando você · ${count}` : "Esperando você"}
      data-tip-hint={hint}
      onClick={onClick}
      data-testid="attention-counter"
    >
      <span className="navitem__icon-wrap">
        <NavIcon name="mao" />
      </span>
      <span className="navitem__text">
        <span className="navitem__label">Esperando você</span>
      </span>
      <span className={`navitem__badge${active ? " navitem__badge--attn" : ""}`} data-testid="attention-count">
        {count > 99 ? "99+" : count}
      </span>
    </button>
  );
}
