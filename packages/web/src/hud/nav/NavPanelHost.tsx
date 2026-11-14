import { useEffect, useId, useRef } from "react";
import { useNavLayoutStore, type NavPanel } from "../../store/navLayoutStore";
import { useNavStore } from "../../store/navStore";
import { AgentsContent } from "../AgentsPopover";
import { NotificationsContent, PANEL_RECENT } from "../NotificationsBell";
import { TodayPanel } from "../hoje/TodayPanel";
import { UsagePanel } from "../UsagePanel";

const PANEL_TEST_IDS: Record<NavPanel, string> = { notificacoes: "bell-popover", hoje: "hoje-panel", agentes: "agents-popover", uso: "usage-panel" };

/**
 * Painel ao lado da barra (notificações, o painel Hoje ou agentes): desliza da barra lateral no computador e vira
 * uma folha abaixo da barra curta no celular. Fecha com Esc, clicando fora ou no mesmo item.
 */
export function NavPanelHost() {
  const panel = useNavLayoutStore((state) => state.panel);
  const close = useNavLayoutStore((state) => state.closePanel);
  const page = useNavStore((state) => state.page);
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();

  // Trocar de página fecha o painel.
  useEffect(() => {
    useNavLayoutStore.getState().closePanel();
  }, [page]);

  useEffect(() => {
    if (!panel) return;
    const trigger = () => document.querySelector<HTMLElement>(`[data-panel-trigger="${panel}"]`);
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (ref.current?.contains(target) || target?.closest?.("[data-panel-trigger]")) return;
      // Clique dentro de outra janela (ex.: a tela de trabalho aberta pela lista) não fecha aqui.
      if (target?.closest?.("dialog[open]")) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      close();
      trigger()?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [panel, close]);

  if (!panel) return null;
  return (
    <section ref={ref} className={`navpanel navpanel--${panel}`} role="dialog" aria-labelledby={titleId} data-testid={PANEL_TEST_IDS[panel]}>
      {panel === "notificacoes" && <NotificationsContent onClose={close} limit={PANEL_RECENT} title="Notificações" titleId={titleId} />}
      {panel === "hoje" && <TodayPanel onClose={close} titleId={titleId} />}
      {panel === "agentes" && <AgentsContent onClose={close} titleId={titleId} />}
      {panel === "uso" && <UsagePanel onClose={close} titleId={titleId} />}
    </section>
  );
}
