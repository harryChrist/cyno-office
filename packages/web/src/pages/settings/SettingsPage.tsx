import { AUTH_STATUS_PATH, workspaceAccess, type AuthStatus, type EngineInfo, type ModelDefaults, type Workspace } from "@cyno/shared";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { escapeReturnsToMap } from "../../cena/escape";
import { useConnectorsStore } from "../../store/connectorsStore";
import { useForYouTypesSheet } from "../../store/forYouTypesSheet";
import { useNavStore } from "../../store/navStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { workspaceColor } from "../../ui/workspaceColor";
import { AccessSettings, SecuritySettings } from "./AccessSettings";
import { FoldersSettings } from "./FoldersSettings";
import { AttentionSettings } from "./AttentionSettings";
import { ConnectorsSettings } from "./ConnectorsSettings";
import { CynoSettings } from "./CynoSettings";
import { LocalConnectorsSettings } from "./LocalConnectorsSettings";
import { DispatchSettings } from "./DispatchSettings";
import { PlanApprovalSettings } from "./PlanApprovalSettings";
import { GestaoSettings } from "./GestaoSettings";
import { EnginesPanel } from "./EnginesPanel";
import { EngineStorageSettings } from "./EngineStorageSettings";
import { HistorySettings } from "./HistorySettings";
import { GlobalModelsSettings, WorkspaceModelsSettings } from "./ModelsSettings";
import { OfficeSettings } from "./OfficeSettings";
import { ShortcutsSettings } from "./ShortcutsSettings";
import { PasswordSettings } from "./PasswordSettings";
import { UsageGuardSettings } from "./UsageGuardSettings";
import { VersionSettings } from "./VersionSettings";
import { OptionHead, Seal, StateBadge } from "./SettingsOption";
import { SettingsWarnings } from "./SettingsWarnings";
import { useIsPhone, useSettingsLayout } from "./settingsLayout";
import "./settings.css";
import "./settingsLayout.css";
import {
  AREA_LABELS,
  DEFAULT_SETTINGS_SECTION,
  navBadges,
  SEAL_LABELS,
  isRemoteHost,
  searchSettings,
  sectionsWithMatches,
  settingsHash,
  settingsHashHasSection,
  settingsPageOf,
  settingsPageSeal,
  settingsPagesOf,
  settingsSection,
  settingsSectionFromHash,
  settingsSectionsOf,
  settingsWarnings,
  type SettingsArea,
  type SettingsPageInfo,
  type SettingsSeal,
  type SettingsSectionId,
} from "./settingsView";

const sectionDomId = (id: SettingsSectionId) => `settings-sec-${id}`;

/** Esc (fora de campo, sem janela aberta e sem outro dono, como um popover da barra) volta ao escritório. */
function useEscapeToOffice(): void {
  const go = useNavStore((state) => state.go);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const modalOpen = document.querySelector("dialog[open]") !== null;
      if (escapeReturnsToMap({ key: event.key, defaultPrevented: event.defaultPrevented, target, modalOpen })) go("office");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);
}

/** Estado da senha (o resumo do topo e o aviso de "sem senha"). */
function useAuthStatus(): AuthStatus | null {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(AUTH_STATUS_PATH, { cache: "no-store", headers: { accept: "application/json" } })
      .then((response) => response.json() as Promise<AuthStatus>)
      .then((next) => alive && setStatus(next))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return status;
}

/** O selo com o nome do workspace (é o que diz onde a opção vale). */
function sealText(seal: SettingsSeal, workspaceName: string | null): string | undefined {
  return seal === "workspace" && workspaceName ? `Só em ${workspaceName}` : undefined;
}

type SectionMode = {
  /** Não é da página aberta, ou a busca a escondeu. Escondida ela continua montada: nada digitado ou carregado se perde. */
  hidden: boolean;
  /** Única seção da página: o cabeçalho da página já diz o título, o dela some. */
  solo: boolean;
  /** Mostra o selo (na busca, com seções de páginas diferentes juntas). */
  seal: boolean;
  workspaceName: string | null;
};

/** Uma seção de uma página: título, o que ela é e o conteúdo. */
function SectionBlock({ id, mode, children }: { id: SettingsSectionId; mode: SectionMode; children: ReactNode }) {
  const section = settingsSection(id);
  return (
    <section id={sectionDomId(id)} className={`settings__sec${mode.solo ? " settings__sec--solo" : ""}`} hidden={mode.hidden} aria-labelledby={`${sectionDomId(id)}-title`} data-testid={`settings-section-${id}`}>
      <header className="settings__sec-head">
        <h3 id={`${sectionDomId(id)}-title`} className="settings__section-title">
          {section.label}
        </h3>
        {mode.seal && <Seal kind={section.seal} label={sealText(section.seal, mode.workspaceName)} />}
        <p className="settings__sec-hint">{section.hint}</p>
      </header>
      {children}
    </section>
  );
}

/** Aprovação: a lista de tipos mora em Aprovações; aqui só o atalho e o que ela faz. */
function ApprovalTypesSettings() {
  return (
    <div className="settings__groups" data-testid="settings-approvals">
      <section className="settings__card">
        <OptionHead
          title="Tipos de aprovação"
          seal="workspace"
          state={<StateBadge tone="value">Lista em Aprovações</StateBadge>}
          line="O que conta como aprovação e vai para Aprovações esperar o seu OK. A lista e as regras de cada tipo ficam lá."
        />
        <div>
          <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => useForYouTypesSheet.getState().show()} data-testid="settings-approvals-open">
            Abrir tipos de aprovação
          </button>
        </div>
      </section>
    </div>
  );
}

/** Conectores: continuam aqui por enquanto, com o aviso de que vão para a Biblioteca. */
function ConnectorsSection() {
  return (
    <div className="settings__groups">
      <p className="settings__notice" role="note" data-testid="settings-connectors-moving">
        Os conectores vão para a Biblioteca, que junta apps, conectores e skills para a plataforma toda. Até lá eles continuam aqui, separados por workspace.
      </p>
      <ConnectorsSettings />
    </div>
  );
}

/**
 * Página "Configurações": um índice de páginas à esquerda e UMA página aberta por vez à direita. O índice separa
 * o que é "Da plataforma" (vale para tudo) do que é "Do workspace" (vale só para o workspace do seletor) e mostra
 * o estado do que mais se confere (senha, motores, modelo padrão, conectores). No celular o índice é a tela de
 * entrada e cada página abre por cima dele, com um "voltar". Cada seção tem endereço próprio; a busca por nome da
 * opção mostra juntas as seções que casam.
 */
export function SettingsPage() {
  const workspaceId = useNavStore((state) => state.workspaceId);
  const setWorkspace = useNavStore((state) => state.setWorkspace);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const workspace: Workspace | null = workspaces?.find((ws) => ws.id === workspaceId) ?? null;
  const connectors = useConnectorsStore((state) => state.list);
  const auth = useAuthStatus();
  const [engines, setEngines] = useState<EngineInfo[] | null>(null);
  const [defaults, setDefaults] = useState<ModelDefaults | null>(null);
  const [pauses, setPauses] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<SettingsSectionId>(() => settingsSectionFromHash(window.location.hash));
  // Celular: há uma página aberta (o endereço diz qual)? Sem isso, a tela é o menu.
  const [inPage, setInPage] = useState(() => settingsHashHasSection(window.location.hash));
  const pushedRef = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const layout = useSettingsLayout();
  const phone = useIsPhone();
  useEscapeToOffice();

  // Sem workspace no endereço, o primeiro da lista vale (os conectores e o resto dependem de um aberto).
  useEffect(() => {
    if (workspaceId === null && workspaces && workspaces.length > 0) setWorkspace(workspaces[0]!.id);
  }, [workspaceId, workspaces, setWorkspace]);

  // Ao abrir, o foco vai para o título (leitor de tela anuncia a página).
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  // Link direto e voltar/avançar do navegador: a seção do endereço é a que abre (no celular, sem seção = menu).
  useEffect(() => {
    const openFromHash = () => {
      setQuery("");
      setActive(settingsSectionFromHash(window.location.hash));
      setInPage(settingsHashHasSection(window.location.hash));
      pushedRef.current = false;
    };
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, []);

  const searching = query.trim() !== "";
  const page = settingsPageOf(active);
  const pageFirst = page.sections[0];
  const showMenu = phone && !inPage;

  // Trocou de página (ou começou a buscar): a leitura volta ao topo; uma seção do meio da página rola até ela.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const scroller = panel.closest(".pages");
    panel.scrollTop = 0;
    if (scroller) scroller.scrollTop = 0;
    if (searching || active === pageFirst) return;
    // As seções de cima carregam dados e mudam de altura: tenta de novo um pouco depois.
    const reach = () => document.getElementById(sectionDomId(active))?.scrollIntoView?.({ block: "start" });
    reach();
    const timers = [window.setTimeout(reach, 150), window.setTimeout(reach, 700)];
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [active, pageFirst, searching, showMenu]);

  /** Abre a página de uma seção. No celular entra na página por cima do menu (o "voltar" do aparelho devolve o menu). */
  const jump = (id: SettingsSectionId) => {
    setQuery("");
    setActive(id);
    const hash = settingsHash(workspaceId, id, phone);
    if (window.location.hash !== hash) {
      if (phone && !inPage) {
        window.history.pushState(null, "", hash);
        pushedRef.current = true;
      } else window.history.replaceState(null, "", hash);
    }
    if (phone) setInPage(true);
  };

  /** Celular: volta da página para o menu. */
  const backToMenu = () => {
    if (pushedRef.current) {
      window.history.back();
      return;
    }
    window.history.replaceState(null, "", settingsHash(workspaceId, DEFAULT_SETTINGS_SECTION));
    setInPage(false);
  };

  const chooseWorkspace = (id: string) => {
    setWorkspace(id);
    const hash = settingsHash(id, active, phone && inPage);
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
  };

  const matches = useMemo(() => searchSettings(query), [query]);
  const shown = useMemo(() => sectionsWithMatches(matches), [matches]);
  // Uma página por vez; buscando, aparecem juntas as seções que têm opção com aquele nome.
  const inOpenPage = (id: SettingsSectionId) => (page.sections as readonly SettingsSectionId[]).includes(id);
  const mode = (id: SettingsSectionId): SectionMode => ({
    hidden: searching ? !shown.has(id) : !inOpenPage(id),
    solo: !searching && page.sections.length === 1,
    seal: searching,
    workspaceName: workspace?.name ?? null,
  });
  const areaHidden = (area: SettingsArea) => (searching ? !settingsSectionsOf(area).some((section) => shown.has(section.id)) : page.area !== area);

  const access = workspace ? workspaceAccess(workspace.access) : null;
  const badges = navBadges({ auth, engines, defaults, connectorCount: connectors === null ? null : connectors.length, pauses });
  const warnings = settingsWarnings({ auth, remote: isRemoteHost(window.location.hostname), workspaceName: workspace?.name ?? null, access });
  const wsColor = workspaceColor(workspace?.name ?? workspaceId ?? "");
  const noWorkspace = workspaces !== null && workspaces.length === 0;
  const pageSeal = settingsPageSeal(page);

  const navButton = (item: SettingsPageInfo) => {
    const first = item.sections[0];
    const badge = item.sections.map((id) => badges[id]).find((found) => found !== undefined);
    return (
      <button
        key={first}
        type="button"
        className="settings__nav-item"
        title={item.hint}
        aria-current={item === page && !showMenu ? "true" : undefined}
        onClick={() => jump(first)}
        data-testid={`settings-nav-${first}`}
      >
        <span className="settings__nav-label">{item.label}</span>
        <span className="settings__nav-hint">{item.hint}</span>
        {badge && (
          <span className={`settings__nav-badge settings__nav-badge--${badge.tone}`} data-testid={`settings-nav-badge-${first}`}>
            {badge.text}
          </span>
        )}
        <svg className="settings__nav-chev" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
          <path d="M8 5l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    );
  };

  return (
    <section className={`page page--settings page--fill${phone && inPage ? " page--settings-open" : ""}`} aria-labelledby="page-title-configuracoes" data-testid="page-configuracoes">
      <header className="page__header page__header--row">
        <div className="page__heading">
          <h2 id="page-title-configuracoes" ref={titleRef} tabIndex={-1} className="page__title">
            Configurações
          </h2>
          <p className="page__subtitle">O que vale para a plataforma inteira e o que vale só para um workspace.</p>
        </div>
      </header>
      <div className="settings" data-cols={layout.columns} data-split={layout.split} data-view={phone ? (inPage ? "page" : "menu") : "split"} style={{ ["--settings-max" as string]: `${layout.maxWidth}px` }} data-testid="settings-layout">
        <nav className="settings__nav" aria-label="Páginas das configurações" hidden={phone && inPage} data-testid="settings-nav">
          {showMenu && <SettingsWarnings warnings={warnings} open={[]} onJump={jump} />}
          <div className="settings__search">
            <input
              type="search"
              className="ui-input"
              value={query}
              placeholder="Buscar uma opção…"
              aria-label="Buscar uma opção das configurações"
              maxLength={80}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery("");
                }
              }}
              data-testid="settings-search"
            />
          </div>
          {searching ? (
            <div className="settings__results" role="group" aria-label="Opções encontradas" data-testid="settings-results">
              {matches.length === 0 ? (
                <p className="settings__nav-empty" role="status" data-testid="settings-search-empty">
                  Nenhuma opção com esse nome.
                </p>
              ) : (
                <>
                  <p className="settings__nav-empty" role="status">
                    {matches.length === 1 ? "1 opção encontrada" : `${matches.length} opções encontradas`}
                  </p>
                  {matches.map((option) => (
                    <button key={option.id} type="button" className="settings__nav-item settings__nav-item--result" onClick={() => jump(option.section)} data-testid={`settings-result-${option.id}`}>
                      <span className="settings__nav-label">{option.title}</span>
                      <span className="settings__nav-hint">
                        {settingsPageOf(option.section).label} · {SEAL_LABELS[option.seal]}
                      </span>
                    </button>
                  ))}
                </>
              )}
            </div>
          ) : (
            (["plataforma", "workspace"] as const).map((area) => (
              <div key={area} className="settings__nav-group" role="group" aria-label={AREA_LABELS[area]}>
                <div className="settings__nav-group-title">
                  {area === "workspace" && <span className="settings__ws-dot" aria-hidden="true" style={{ ["--ws-color" as string]: wsColor }} />}
                  <span className="settings__nav-group-label">{AREA_LABELS[area]}</span>
                  {area === "workspace" && workspaces && workspaces.length > 0 && (
                    <label className="settings__ws-picker">
                      <span className="sr-only">Workspace das páginas abaixo</span>
                      <select className="ui-input ui-input--compact" value={workspace?.id ?? ""} onChange={(event) => chooseWorkspace(event.currentTarget.value)} title="Trocar aqui troca o workspace aberto no app" data-testid="settings-workspace-select">
                        {workspaces.map((ws) => (
                          <option key={ws.id} value={ws.id}>
                            {ws.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                {settingsPagesOf(area).map(navButton)}
              </div>
            ))
          )}
        </nav>
        <div id="settings-panel" ref={panelRef} className="settings__panel" hidden={showMenu} data-page-seal={searching ? undefined : (pageSeal ?? undefined)}>
          {!phone && <SettingsWarnings warnings={warnings} open={searching ? [] : page.sections} onJump={jump} />}
          {searching ? (
            matches.length > 0 && (
              <p className="settings__card-hint" role="status">
                Mostrando só o que casa com “{query.trim()}”.
              </p>
            )
          ) : (
            <header className="settings__page-head" data-testid="settings-page-head">
              {phone && (
                <button type="button" className="settings__back" onClick={backToMenu} data-testid="settings-back">
                  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
                    <path d="M12 5l-5 5 5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Configurações
                </button>
              )}
              <div className="settings__page-title-row">
                <h3 className="settings__page-title">{page.label}</h3>
                {pageSeal && pageSeal !== "plataforma" && <Seal kind={pageSeal} label={sealText(pageSeal, workspace?.name ?? null)} />}
              </div>
              <p className="settings__page-hint">{page.hint}</p>
            </header>
          )}

          <div className="settings__area" hidden={areaHidden("plataforma")} data-testid="settings-area-plataforma">
            <SectionBlock id="senha" mode={mode("senha")}>
              <PasswordSettings />
            </SectionBlock>
            <SectionBlock id="motores" mode={mode("motores")}>
              <EnginesPanel onLoaded={setEngines} onOpenModels={() => jump("modelos-padrao")} />
            </SectionBlock>
            <SectionBlock id="limites" mode={mode("limites")}>
              <div className="settings__groups">
                <div className="settings__card settings__card--wide">
                  <UsageGuardSettings onPauses={setPauses} />
                </div>
              </div>
            </SectionBlock>
            <SectionBlock id="modelos-padrao" mode={mode("modelos-padrao")}>
              <GlobalModelsSettings onLoaded={setDefaults} onOpenWorkspaceModels={workspace ? () => jump("modelos") : undefined} />
            </SectionBlock>
            <SectionBlock id="cyno-ajustes" mode={mode("cyno-ajustes")}>
              <CynoSettings />
            </SectionBlock>
            <SectionBlock id="avisos" mode={mode("avisos")}>
              <AttentionSettings />
            </SectionBlock>
            <SectionBlock id="versao" mode={mode("versao")}>
              <VersionSettings />
            </SectionBlock>
            <SectionBlock id="historico" mode={mode("historico")}>
              <HistorySettings />
            </SectionBlock>
            <SectionBlock id="armazenamento" mode={mode("armazenamento")}>
              <EngineStorageSettings />
            </SectionBlock>
            <SectionBlock id="conectores-locais" mode={mode("conectores-locais")}>
              <LocalConnectorsSettings />
            </SectionBlock>
            <SectionBlock id="escritorio" mode={mode("escritorio")}>
              <OfficeSettings />
            </SectionBlock>
            <SectionBlock id="atalhos" mode={mode("atalhos")}>
              <ShortcutsSettings />
            </SectionBlock>
          </div>

          <div className="settings__area settings__area--workspace" hidden={areaHidden("workspace")} data-testid="settings-area-workspace">
            {noWorkspace ? (
              <p className="page__empty" data-testid="settings-no-workspace">
                Ainda não há workspace. Crie um para ver as opções que valem só para ele.
              </p>
            ) : !workspace ? (
              <p className="settings__card-hint" role="status">
                Carregando o workspace…
              </p>
            ) : (
              <>
                <SectionBlock id="modelos" mode={mode("modelos")}>
                  <WorkspaceModelsSettings key={workspace.id} workspace={workspace} onOpenGlobalModels={() => jump("modelos-padrao")} />
                </SectionBlock>
                <SectionBlock id="distribuicao" mode={mode("distribuicao")}>
                  <div className="settings__groups">
                    <DispatchSettings key={workspace.id} workspace={workspace} />
                    <PlanApprovalSettings key={`plan-approval-${workspace.id}`} workspace={workspace} />
                  </div>
                </SectionBlock>
                <SectionBlock id="acesso" mode={mode("acesso")}>
                  <AccessSettings key={workspace.id} workspace={workspace} />
                </SectionBlock>
                <SectionBlock id="seguranca" mode={mode("seguranca")}>
                  <SecuritySettings key={workspace.id} workspace={workspace} />
                </SectionBlock>
                <SectionBlock id="pastas" mode={mode("pastas")}>
                  <FoldersSettings key={workspace.id} workspace={workspace} />
                </SectionBlock>
                <SectionBlock id="relatorios" mode={mode("relatorios")}>
                  <div className="settings__groups">
                    <GestaoSettings key={workspace.id} workspace={workspace} />
                  </div>
                </SectionBlock>
                <SectionBlock id="aprovacoes" mode={mode("aprovacoes")}>
                  <ApprovalTypesSettings />
                </SectionBlock>
                <SectionBlock id="conectores" mode={mode("conectores")}>
                  <ConnectorsSection />
                </SectionBlock>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
