import { useEffect, useState } from "react";
import { lastWorkspace, useNavStore } from "../../store/navStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { PageTabs } from "../PageTabs";
import { BrainPage } from "../brain/BrainPage";
import { MediaPage } from "../media/MediaPage";
import { LibraryAppsTab } from "./apps/LibraryAppsTab";
import { LibraryConnectorsTab } from "./LibraryConnectorsTab";
import { LibrarySkillsTab } from "./LibrarySkillsTab";
import { LIBRARY_TABS, PLATFORM_LIBRARY_TAB, isWorkspaceTab, libraryHash, openLibrary, parseLibraryHash, type LibraryLocation } from "./libraryView";
import "./library.css";

/** O endereço da Biblioteca (`#/biblioteca/conectores/<workspace>`), acompanhando voltar/avançar e a troca de workspace. */
function useLibraryLocation(): LibraryLocation {
  const sub = useNavStore((state) => state.sub);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const sync = () => setTick((value) => value + 1);
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);
  void sub;
  void tick;
  return parseLibraryHash(window.location.hash);
}

/** O que o selo "Toda a plataforma" explica ao passar o mouse (antes era o subtítulo, em duas linhas). */
const LIBRARY_SCOPE_HINT = "Tudo o que o sistema guarda para os agentes usarem, num lugar só. Apps, conectores (MCP) e skills valem para a plataforma inteira e você decide quais workspaces e agentes os recebem; Mídia e Cérebro (notas) são de cada workspace.";

const ITEM_SELECTORS = (id: string) => [`library-card-${id}`, `skill-card-${id}`, `app-card-${id}`].map((testId) => `[data-testid="${testId.replace(/"/g, "")}"]`).join(",");

/** O cartão apontado por `?item=<id>` (do painel do agente): rola até ele e o destaca um instante (os cartões podem chegar depois). */
function useFocusItem(item: string | null | undefined, tab: string): void {
  useEffect(() => {
    if (!item) return;
    let tries = 0;
    let marked: Element | null = null;
    const timer = window.setInterval(() => {
      tries += 1;
      const card = document.querySelector(ITEM_SELECTORS(item));
      if (card) {
        window.clearInterval(timer);
        card.scrollIntoView({ block: "center", behavior: "smooth" });
        card.setAttribute("data-focus", "true");
        marked = card;
        window.setTimeout(() => card.removeAttribute("data-focus"), 2600);
      } else if (tries > 30) window.clearInterval(timer);
    }, 100);
    return () => {
      window.clearInterval(timer);
      marked?.removeAttribute("data-focus");
    };
  }, [item, tab]);
}

/** Seletor de workspace das abas Mídia e Cérebro (as duas páginas são de um workspace só). */
function WorkspaceSelect({ tab, workspaceId }: { tab: LibraryLocation["tab"]; workspaceId: string | null }) {
  const workspaces = useWorkspaceStore((state) => state.workspaces) ?? [];
  const setWorkspace = useNavStore((state) => state.setWorkspace);
  return (
    <label className="lib__ws">
      <span className="lib__ws-label">Workspace</span>
      <select
        className="ui-input ui-input--compact"
        value={workspaceId ?? ""}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (next) setWorkspace(next);
        }}
        data-testid={`library-ws-${tab}`}
      >
        {workspaceId === null && <option value="">Escolha…</option>}
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * A Biblioteca: o que o sistema guarda para os workspaces e os agentes usarem. É da plataforma
 * (fora dos workspaces): cada item é guardado uma vez e liberado a workspaces e, dentro deles, a
 * agentes. Cinco abas: por workspace (com seletor), Cérebro e Mídia; da plataforma, Apps, Conectores e Skills.
 * Abre no Cérebro do workspace atual.
 */
export function LibraryPage() {
  const location = useLibraryLocation();
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const navWorkspace = useNavStore((state) => state.workspaceId);
  const byWorkspace = isWorkspaceTab(location.tab);
  useFocusItem(location.item, location.tab);

  // Mídia e Cérebro sem workspace no endereço: abre no workspace de onde o dono veio (ou o último usado).
  useEffect(() => {
    if (!byWorkspace || location.workspaceId || !workspaces) return;
    const ws = [navWorkspace, lastWorkspace()].find((id) => id && workspaces.some((workspace) => workspace.id === id)) ?? workspaces[0]?.id;
    // Sem workspace nenhum não há Cérebro nem Mídia para mostrar: a Biblioteca abre nos conectores, que são da plataforma.
    window.history.replaceState(null, "", ws ? libraryHash({ tab: location.tab, workspaceId: ws }) : libraryHash({ tab: PLATFORM_LIBRARY_TAB }));
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [byWorkspace, location.workspaceId, location.tab, workspaces, navWorkspace]);

  const selected = byWorkspace ? (location.workspaceId ?? null) : null;
  return (
    <div className={`page lib${byWorkspace ? " lib--fill" : ""}${location.tab === "midia" ? " lib--media" : ""}`} data-testid="library-page">
      {/* Um cabeçalho só para as cinco abas: título e abas na mesma linha, sempre no mesmo lugar. O texto longo
          que havia aqui virou a dica do selo; cada aba já traz a sua própria introdução. */}
      <div className="lib__top">
        <header className="lib__head">
          <h1 className="page__title">
            Biblioteca{" "}
            <span className="ui-badge ui-badge--neutral lib__scope" title={LIBRARY_SCOPE_HINT}>
              Toda a plataforma
            </span>
          </h1>
        </header>

        {/* Na Mídia, "este workspace" é o de onde você veio; os outros se escolhem no seletor de escopo da própria página. */}
        <PageTabs
          className="lib__tabbar"
          flush
          label="Seções da Biblioteca"
          tabs={LIBRARY_TABS.map((tab) => ({ id: tab.id, label: tab.label, disabled: !tab.ready, badge: tab.ready ? undefined : "em breve" }))}
          active={location.tab}
          onSelect={(id) => openLibrary({ tab: id, workspaceId: isWorkspaceTab(id) ? (navWorkspace ?? lastWorkspace()) : null })}
          testIdPrefix="library-tab"
          idPrefix="lib-tab"
          controls="lib-panel"
          trailing={byWorkspace && location.tab !== "midia" ? <WorkspaceSelect tab={location.tab} workspaceId={selected} /> : undefined}
        />
      </div>

      <div id="lib-panel" className={byWorkspace ? "lib__panel lib__panel--fill" : "lib__panel"} role="tabpanel" aria-labelledby={`lib-tab-${location.tab}`}>
        {location.tab === "apps" && <LibraryAppsTab />}
        {location.tab === "conectores" && <LibraryConnectorsTab workspaceId={location.workspaceId} />}
        {location.tab === "skills" && <LibrarySkillsTab workspaceId={location.workspaceId} />}
        {location.tab === "midia" && selected && <MediaPage />}
        {location.tab === "cerebro" && selected && <BrainPage />}
      </div>
    </div>
  );
}
