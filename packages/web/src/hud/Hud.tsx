import { useRef } from "react";
import { pendingCount } from "../store/forYouItems";
import { PAGES, useNavStore, type PageId } from "../store/navStore";
import { useOfficeStore } from "../store/officeStore";
import { useAwaiting } from "../pages/work/useWork";
import { useWorkspaceView } from "../store/workspaceStore";
import { WorkPanelHost } from "../agentWork/WorkPanelHost";
import { ConnectorDetailHost } from "../connectors/ConnectorDetail";
import { StatusPill } from "./AgentsPopover";
import { AttentionCounter } from "./AttentionCounter";
import { CommandShortcut } from "./CommandBar";
import { NotificationsBell } from "./NotificationsBell";
import { BrainButton } from "./BrainButton";
import { ActivityButton } from "./ActivityButton";
import { SettingsButton } from "./SettingsButton";
import { SocketIndicator } from "./SocketIndicator";
import { useOverlayInsets } from "./useOverlayInsets";
import { WorkspacePicker } from "./WorkspacePicker";
import { AppNav } from "./nav/AppNav";
import "./hud.css";

/** O indicador de conexão mora em SocketIndicator.tsx (a barra lateral também usa). */
export { SERVER_DOWN_AFTER_MS, SERVER_DOWN_LABEL, SocketIndicator } from "./SocketIndicator";

/** Contador em pílula pequena ao lado do nome da aba. */
function TabCount({ count, singular, plural, testId }: { count: number; singular: string; plural: string; testId: string }) {
  if (count <= 0) return null;
  return (
    <span className="topbar__badge" data-testid={testId}>
      <span className="sr-only">, </span>
      {count}
      <span className="sr-only">{count === 1 ? ` ${singular}` : ` ${plural}`}</span>
    </span>
  );
}

/** Abas principais, no meio da barra, num grupo em pílula. */
function PageNav() {
  const page = useNavStore((state) => state.page);
  const go = useNavStore((state) => state.go);
  const pending = useOfficeStore((state) => pendingCount(state.forYou));
  const awaiting = useAwaiting().count;
  const counts: Partial<Record<PageId, { count: number; singular: string; plural: string; testId: string }>> = {
    trabalho: { count: awaiting, singular: "esperando você", plural: "esperando você", testId: "nav-trabalho-count" },
    "para-voce": { count: pending, singular: "pendente", plural: "pendentes", testId: "nav-para-voce-count" },
  };
  return (
    <nav className="topbar__nav" aria-label="Páginas">
      {PAGES.map((item) => {
        const badge = counts[item.id];
        return (
          <button
            key={item.id}
            type="button"
            className="topbar__tab"
            aria-current={page === item.id ? "page" : undefined}
            aria-pressed={page === item.id}
            onClick={() => go(item.id)}
            data-testid={`nav-${item.id}`}
          >
            {item.label}
            {badge && <TabCount {...badge} />}
          </button>
        );
      })}
    </nav>
  );
}

/**
 * Barra de cima flutuante (vidro), a navegação antiga: workspace à esquerda, páginas no meio,
 * comando, status e sino à direita. Sem workspace nenhum, fica só o seletor (com "Criar"), a
 * conexão e as Configurações. Protótipo da barra lateral: ela só aparece com `?topbar=1`.
 */
export function TopBar() {
  const status = useOfficeStore((state) => state.status);
  const ready = useOfficeStore((state) => state.office !== null);
  const empty = useWorkspaceView() === "empty";
  const ref = useRef<HTMLElement>(null);
  useOverlayInsets("topbar", ref, "top", true);

  return (
    <header ref={ref} className="topbar" data-testid="hud">
      <div className="topbar__start">
        <img className="topbar__logo" src="/cyno-tile.svg" alt="" aria-hidden="true" width={30} height={30} />
        <h1 className="topbar__title">Cyno</h1>
        <WorkspacePicker />
      </div>
      {empty ? <span className="topbar__spacer" aria-hidden="true" /> : <PageNav />}
      <div className="topbar__end">
        {!empty && <CommandShortcut />}
        <SocketIndicator />
        {!empty && <BrainButton />}
        {!empty && ready && <StatusPill />}
        {!empty && !ready && (status === "idle" || status === "loading") && <p className="topbar__status">Carregando…</p>}
        {!empty && status === "error" && !ready && (
          <p className="topbar__status topbar__status--error" role="alert" data-testid="hud-error">
            Não foi possível carregar o escritório.
          </p>
        )}
        {!empty && <AttentionCounter />}
        {!empty && <NotificationsBell />}
        <ActivityButton />
        <SettingsButton />
      </div>
      {/* A tela de trabalho aberta (Maestro ou um agente): dialog por cima de tudo. */}
      <WorkPanelHost />
      {/* Detalhe de um conector (status, ferramentas, quem usa): abre da faixa do HUD, das Configurações e do painel do agente. */}
      <ConnectorDetailHost />
    </header>
  );
}

/** `?topbar=1` volta para a barra de cima antiga (para comparar com a barra lateral). */
function legacyTopbar(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("topbar") === "1";
}

/** Navegação do app: a barra lateral (gaveta no celular) ou, com `?topbar=1`, a barra de cima antiga. */
export function Hud() {
  return legacyTopbar() ? <TopBar /> : <AppNav />;
}
