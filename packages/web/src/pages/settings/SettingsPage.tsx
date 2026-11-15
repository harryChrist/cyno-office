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
import { GestaoSettings } from "./GestaoSettings";
import { EnginesPanel } from "./EnginesPanel";
import { HistorySettings } from "./HistorySettings";
import { GlobalModelsSettings, WorkspaceModelsSettings } from "./ModelsSettings";
import { OfficeSettings } from "./OfficeSettings";
import { PasswordSettings } from "./PasswordSettings";
import { OptionHead, Seal, StateBadge } from "./SettingsOption";
import { SettingsSummary } from "./SettingsSummary";
import { useSettingsLayout } from "./settingsLayout";
import "./settings.css";
import "./settingsLayout.css";
import {
  AREA_LABELS,
  buildSummary,
  SEAL_LABELS,
  isRemoteHost,
  searchSettings,
  sectionsWithMatches,
  settingsHash,
  settingsSection,
  settingsSectionFromHash,
  settingsSectionsOf,
  settingsWarnings,
  type SettingsArea,
  type SettingsSectionId,
} from "./settingsView";

const sectionDomId = (id: SettingsSectionId) => `settings-sec-${id}`;

/** Rola até a seção (o painel rola por dentro no desktop; no celular a própria página). */
function scrollToSection(id: SettingsSectionId): void {
  const element = document.getElementById(sectionDomId(id));
  if (!element) return;
  const calm = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element.scrollIntoView?.({ block: "start", behavior: calm ? "auto" : "smooth" });
}

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

/** Uma seção: título, o que ela é, o selo e o conteúdo. `hidden`: a busca a escondeu (continua montada). */
function SectionBlock({ id, hidden, children }: { id: SettingsSectionId; hidden: boolean; children: ReactNode }) {
  const section = settingsSection(id);
  return (
    <section id={sectionDomId(id)} className="settings__sec" hidden={hidden} aria-labelledby={`${sectionDomId(id)}-title`} data-testid={`settings-section-${id}`}>
      <header className="settings__sec-head">
        <h3 id={`${sectionDomId(id)}-title`} className="settings__section-title">
          {section.label}
        </h3>
        <Seal kind={section.seal} />
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
 * Página "Configurações": duas áreas na mesma página, "Da plataforma" (vale para tudo) e "Do
 * workspace" (vale só para o workspace do seletor), com um resumo no topo, um índice lateral (abas
 * no celular), busca por nome da opção e endereço direto para cada seção.
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
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<SettingsSectionId>(() => settingsSectionFromHash(window.location.hash));
  const titleRef = useRef<HTMLHeadingElement>(null);
  const layout = useSettingsLayout();
  useEscapeToOffice();

  // Sem workspace no endereço, o primeiro da lista vale (os conectores e o resto dependem de um aberto).
  useEffect(() => {
    if (workspaceId === null && workspaces && workspaces.length > 0) setWorkspace(workspaces[0]!.id);
  }, [workspaceId, workspaces, setWorkspace]);

  // Ao abrir, o foco vai para o título (leitor de tela anuncia a página).
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  // Link direto: abre rolando até a seção do endereço (as seções carregam dados e mexem na altura, então tenta de novo).
  useEffect(() => {
    const jumpToHash = () => {
      const section = settingsSectionFromHash(window.location.hash);
      setActive(section);
      if (/\/configuracoes\/[^/?]+/.test(window.location.hash)) {
        window.setTimeout(() => scrollToSection(section), 120);
        window.setTimeout(() => scrollToSection(section), 700);
      }
    };
    jumpToHash();
    window.addEventListener("hashchange", jumpToHash);
    return () => window.removeEventListener("hashchange", jumpToHash);
  }, []);

  // A seção que está à vista fica marcada no índice.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Map<string, boolean>();
    const order = [...settingsSectionsOf("plataforma"), ...settingsSectionsOf("workspace")].map((section) => section.id);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting);
        const first = order.find((id) => visible.get(sectionDomId(id)));
        if (first) setActive(first);
      },
      { rootMargin: "0px 0px -65% 0px" },
    );
    for (const id of order) {
      const element = document.getElementById(sectionDomId(id));
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [workspace?.id]);

  const jump = (id: SettingsSectionId) => {
    setQuery("");
    setActive(id);
    const hash = settingsHash(workspaceId, id);
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
    // Depois de limpar a busca, as seções escondidas voltam; espera o quadro seguinte para rolar.
    window.requestAnimationFrame(() => scrollToSection(id));
  };

  const chooseWorkspace = (id: string) => {
    setWorkspace(id);
    const hash = settingsHash(id, active);
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
  };

  const matches = useMemo(() => searchSettings(query), [query]);
  const shown = useMemo(() => sectionsWithMatches(matches), [matches]);
  const searching = query.trim() !== "";
  const hide = (id: SettingsSectionId) => searching && !shown.has(id);
  const areaHidden = (area: SettingsArea) => searching && !settingsSectionsOf(area).some((section) => shown.has(section.id));

  const access = workspace ? workspaceAccess(workspace.access) : null;
  const summary = buildSummary({ auth, engines, defaults, connectorCount: connectors === null ? null : connectors.length });
  const warnings = settingsWarnings({ auth, remote: isRemoteHost(window.location.hostname), workspaceName: workspace?.name ?? null, access });
  const wsColor = workspaceColor(workspace?.name ?? workspaceId ?? "");
  const noWorkspace = workspaces !== null && workspaces.length === 0;

  const navButton = (id: SettingsSectionId) => {
    const section = settingsSection(id);
    return (
      <button
        key={id}
        type="button"
        className="settings__nav-item"
        aria-current={id === active ? "true" : undefined}
        onClick={() => jump(id)}
        data-testid={`settings-nav-${id}`}
      >
        <span className="settings__nav-label">{section.label}</span>
        <span className="settings__nav-hint">{section.hint}</span>
      </button>
    );
  };

  return (
    <section className="page page--settings page--fill" aria-labelledby="page-title-configuracoes" data-testid="page-configuracoes">
      <header className="page__header page__header--row">
        <div className="page__heading">
          <h2 id="page-title-configuracoes" ref={titleRef} tabIndex={-1} className="page__title">
            Configurações
          </h2>
          <p className="page__subtitle">O que vale para a plataforma inteira e o que vale só para um workspace, cada coisa com o seu selo e o seu estado.</p>
        </div>
      </header>
      <div className="settings" data-cols={layout.columns} data-split={layout.split} style={{ ["--settings-max" as string]: `${layout.maxWidth}px` }} data-testid="settings-layout">
        <nav className="settings__nav" aria-label="Seções das configurações">
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
                    <button key={option.id} type="button" className="settings__nav-item" onClick={() => jump(option.section)} data-testid={`settings-result-${option.id}`}>
                      <span className="settings__nav-label">{option.title}</span>
                      <span className="settings__nav-hint">
                        {settingsSection(option.section).label} · {SEAL_LABELS[option.seal]}
                      </span>
                    </button>
                  ))}
                </>
              )}
            </div>
          ) : (
            (["plataforma", "workspace"] as const).map((area) => (
              <div key={area} className="settings__nav-group" role="group" aria-label={AREA_LABELS[area]}>
                <p className="settings__nav-group-title">
                  {area === "workspace" && <span className="settings__ws-dot" aria-hidden="true" style={{ ["--ws-color" as string]: wsColor }} />}
                  <span className="settings__nav-group-label">{AREA_LABELS[area]}</span>
                  {area === "workspace" && workspace && <span className="settings__nav-group-name">{workspace.name}</span>}
                </p>
                {settingsSectionsOf(area).map((section) => navButton(section.id))}
              </div>
            ))
          )}
        </nav>
        <div id="settings-panel" className="settings__panel">
          <SettingsSummary items={summary} warnings={warnings} onJump={jump} />
          {searching && matches.length > 0 && (
            <p className="settings__card-hint" role="status">
              Mostrando só o que casa com “{query.trim()}”.
            </p>
          )}

          <div className="settings__area" hidden={areaHidden("plataforma")} data-testid="settings-area-plataforma">
            <header className="settings__area-head">
              <h3 className="settings__area-title">{AREA_LABELS.plataforma}</h3>
              <Seal kind="plataforma" />
              <p className="settings__area-hint">Vale para tudo: todos os workspaces, o Cyno e este servidor.</p>
            </header>
            <SectionBlock id="senha" hidden={hide("senha")}>
              <PasswordSettings />
            </SectionBlock>
            <SectionBlock id="motores" hidden={hide("motores")}>
              <EnginesPanel onLoaded={setEngines} onOpenModels={() => jump("modelos-padrao")} />
            </SectionBlock>
            <SectionBlock id="modelos-padrao" hidden={hide("modelos-padrao")}>
              <GlobalModelsSettings onLoaded={setDefaults} onOpenWorkspaceModels={workspace ? () => jump("modelos") : undefined} />
            </SectionBlock>
            <SectionBlock id="cyno-ajustes" hidden={hide("cyno-ajustes")}>
              <CynoSettings />
            </SectionBlock>
            <SectionBlock id="avisos" hidden={hide("avisos")}>
              <AttentionSettings />
            </SectionBlock>
            <SectionBlock id="conectores-locais" hidden={hide("conectores-locais")}>
              <LocalConnectorsSettings />
            </SectionBlock>
            <SectionBlock id="historico" hidden={hide("historico")}>
              <HistorySettings />
            </SectionBlock>
            <SectionBlock id="escritorio" hidden={hide("escritorio")}>
              <OfficeSettings />
            </SectionBlock>
          </div>

          <div className="settings__area settings__area--workspace" hidden={areaHidden("workspace")} data-testid="settings-area-workspace">
            <header className="settings__area-head">
              <h3 className="settings__area-title">
                <span className="settings__ws-dot" aria-hidden="true" style={{ ["--ws-color" as string]: wsColor }} />
                {AREA_LABELS.workspace}
                {workspace ? <span className="settings__area-ws">: {workspace.name}</span> : null}
              </h3>
              <Seal kind="workspace" />
              {workspaces && workspaces.length > 0 && (
                <label className="settings__ws-picker">
                  <span>Workspace</span>
                  <select className="ui-input ui-input--compact" value={workspace?.id ?? ""} onChange={(event) => chooseWorkspace(event.currentTarget.value)} data-testid="settings-workspace-select">
                    {workspaces.map((ws) => (
                      <option key={ws.id} value={ws.id}>
                        {ws.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p className="settings__area-hint">
                Vale só para {workspace ? <strong>{workspace.name}</strong> : "o workspace escolhido"}; os outros não mudam. Trocar o workspace aqui troca o workspace aberto no app.
              </p>
            </header>
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
                <SectionBlock id="modelos" hidden={hide("modelos")}>
                  <WorkspaceModelsSettings key={workspace.id} workspace={workspace} onOpenGlobalModels={() => jump("modelos-padrao")} />
                </SectionBlock>
                <SectionBlock id="acesso" hidden={hide("acesso")}>
                  <AccessSettings key={workspace.id} workspace={workspace} />
                </SectionBlock>
                <SectionBlock id="pastas" hidden={hide("pastas")}>
                  <FoldersSettings key={workspace.id} workspace={workspace} />
                </SectionBlock>
                <SectionBlock id="seguranca" hidden={hide("seguranca")}>
                  <SecuritySettings key={workspace.id} workspace={workspace} />
                </SectionBlock>
                <SectionBlock id="distribuicao" hidden={hide("distribuicao")}>
                  <div className="settings__groups">
                    <DispatchSettings key={workspace.id} workspace={workspace} />
                  </div>
                </SectionBlock>
                <SectionBlock id="relatorios" hidden={hide("relatorios")}>
                  <div className="settings__groups">
                    <GestaoSettings key={workspace.id} workspace={workspace} />
                  </div>
                </SectionBlock>
                <SectionBlock id="aprovacoes" hidden={hide("aprovacoes")}>
                  <ApprovalTypesSettings />
                </SectionBlock>
                <SectionBlock id="conectores" hidden={hide("conectores")}>
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
