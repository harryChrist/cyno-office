import { useState, type FocusEvent } from "react";
import { useNavGroupsStore } from "../../store/navGroupsStore";
import { useNavLayoutStore, type NavPanel } from "../../store/navLayoutStore";
import { useNoticesStore } from "../../store/notices";
import { pageLabel, useNavStore } from "../../store/navStore";
import { useOfficeStore } from "../../store/officeStore";
import { useWorkspaceView } from "../../store/workspaceStore";
import { countLabel } from "../../ui/format";
import { useAgentsSummary } from "../AgentsPopover";
import { NavIcon } from "../navIcons";
import { useNotificationsSummary } from "../NotificationsBell";
import { useRunningCount } from "../hoje/TodayPanel";
import { useNavBadges } from "./navHooks";
import { activeChild, APP_WIDE_SECTIONS, childSub, HOJE_HINT, NAV_SECTIONS, nonEmptySections, NOTIFICATIONS_HINT, PAGE_HINTS, railGroupSub, visibleChildren, visibleShortcuts, type Badge, type NavChildDef, type NavItemDef } from "./navItems";

/** Selo de contagem: pílula ao lado do nome (aberta) ou bolinha no canto do ícone (recolhida). */
function CountBadge({ badge }: { badge: Badge | undefined }) {
  if (!badge || badge.count <= 0) return null;
  return (
    <span className={`navitem__badge navitem__badge--${badge.tone ?? "accent"}`} data-testid={badge.testId}>
      <span className="sr-only">, </span>
      {badge.count > 99 ? "99+" : badge.count}
      <span className="sr-only">{badge.count === 1 ? ` ${badge.singular}` : ` ${badge.plural}`}</span>
    </span>
  );
}

/** Nome + linha discreta embaixo (some na barra recolhida junto com o nome). */
function ItemText({ label, hint }: { label: string; hint?: string }) {
  return (
    <span className="navitem__text">
      <span className="navitem__label">{label}</span>
      {hint && (
        <span className="navitem__hint" aria-hidden="true">
          {hint}
        </span>
      )}
    </span>
  );
}

/** Item de página: ícone + nome + descrição curta (+ contador). Recolhida, o nome e a descrição viram dica ao lado (data-tip). */
export function PageItem({ item, badge, onNavigate }: { item: NavItemDef; badge?: Badge; onNavigate?: () => void }) {
  const active = useNavStore((state) => state.page === item.page && (!item.sub || state.sub === item.sub));
  const go = useNavStore((state) => state.go);
  const label = item.label ?? pageLabel(item.page);
  return (
    <li>
      <button
        type="button"
        className="navitem"
        aria-current={active ? "page" : undefined}
        onClick={() => {
          go(item.page, item.sub);
          onNavigate?.();
        }}
        title={item.hint}
        data-tip={label}
        data-tip-hint={item.hint}
        data-testid={item.testId}
      >
        <NavIcon name={item.icon} />
        <ItemText label={label} hint={item.hint} />
        <CountBadge badge={badge} />
      </button>
    </li>
  );
}

/** Um destino de um grupo (recuado sob o pai, ou dentro do menu flutuante da barra recolhida). */
function ChildLink({ child, active, onPick, item }: { child: NavChildDef; active: boolean; onPick: () => void; item: NavItemDef }) {
  const go = useNavStore((state) => state.go);
  return (
    <li>
      <button
        type="button"
        className="navitem navitem--sub"
        aria-current={active ? "page" : undefined}
        onClick={() => {
          go(item.page, childSub(child, useNavStore.getState().workspaceId));
          onPick();
        }}
        data-testid={child.testId}
      >
        <span className="navitem__label">{child.label}</span>
      </button>
    </li>
  );
}

/**
 * Item com destinos (Gestão, Biblioteca): o item da página e, logo abaixo e recuados, links diretos para as
 * abas; um botão recolhe o grupo (lembrado por navegador). Com a barra recolhida, passar o mouse (ou o foco)
 * no ícone abre um menu flutuante com os mesmos destinos. Na gaveta do celular o grupo vem sempre aberto.
 */
function NavGroup({ item, badge, onNavigate, drawer }: { item: NavItemDef; badge?: Badge; onNavigate?: () => void; drawer: boolean }) {
  const empty = useWorkspaceView() === "empty";
  const page = useNavStore((state) => state.page);
  const sub = useNavStore((state) => state.sub);
  const go = useNavStore((state) => state.go);
  const collapsedBar = useNavLayoutStore((state) => state.collapsed);
  const open = useNavGroupsStore((state) => !state.collapsed.includes(item.testId));
  const toggle = useNavGroupsStore((state) => state.toggle);
  const [fly, setFly] = useState<number | null>(null);
  const rail = collapsedBar && !drawer;
  const children = visibleChildren(item, empty);
  const current = activeChild(item, page, sub);
  const label = item.label ?? pageLabel(item.page);
  const openFly = (group: HTMLElement) => {
    const rect = (group.querySelector(".navitem") ?? group).getBoundingClientRect();
    const bar = group.closest(".sidenav")?.getBoundingClientRect();
    // O menu é posicionado na barra (que é fixa): o topo é medido nela e cabe na tela, subindo se o item está perto do rodapé.
    const top = Math.max(8, Math.min(rect.top - 6, window.innerHeight - (64 + children.length * 36) - 8));
    setFly(top - (bar?.top ?? 0));
  };
  const pick = () => {
    setFly(null);
    onNavigate?.();
  };
  return (
    <li
      className="navgroup"
      onPointerEnter={rail ? (event) => openFly(event.currentTarget) : undefined}
      onPointerLeave={rail ? () => setFly(null) : undefined}
      onFocus={rail ? (event: FocusEvent<HTMLLIElement>) => (event.target.matches(":focus-visible") ? openFly(event.currentTarget) : undefined) : undefined}
      onBlur={rail ? (event: FocusEvent<HTMLLIElement>) => (event.currentTarget.contains(event.relatedTarget) ? undefined : setFly(null)) : undefined}
      onKeyDown={rail ? (event) => (event.key === "Escape" ? setFly(null) : undefined) : undefined}
      data-testid={`navgroup-${item.page}`}
    >
      <div className="navgroup__row">
        <button
          type="button"
          className="navitem navitem--group"
          aria-current={page === item.page ? "page" : undefined}
          onClick={() => {
            // Recolhida: o ícone leva à primeira página do grupo (os destinos aparecem no balão ao lado).
            go(item.page, rail ? railGroupSub(item, empty, useNavStore.getState().workspaceId) : item.sub);
            pick();
          }}
          title={item.hint}
          data-tip={rail ? undefined : label}
          data-tip-hint={rail ? undefined : item.hint}
          data-testid={item.testId}
        >
          <NavIcon name={item.icon} />
          <ItemText label={label} hint={item.hint} />
          <CountBadge badge={badge} />
        </button>
        {!drawer && !rail && (
          <button
            type="button"
            className="navgroup__toggle"
            aria-label={open ? `Recolher ${label}` : `Mostrar os itens de ${label}`}
            aria-expanded={open}
            onClick={() => toggle(item.testId)}
            data-testid={`${item.testId}-toggle`}
          >
            <NavIcon name="chevron" className="navgroup__chevron" />
          </button>
        )}
      </div>
      {(drawer || open) && !rail && (
        <ul className="navsub" aria-label={`Itens de ${label}`}>
          {children.map((child) => (
            <ChildLink key={child.testId} child={child} item={item} active={current?.testId === child.testId} onPick={pick} />
          ))}
        </ul>
      )}
      {rail && fly !== null && (
        <div className="navfly" style={{ top: fly }} data-testid={`navfly-${item.page}`}>
          <div className="navfly__box">
            <p className="navfly__head">
              {label}
              {item.hint && <span className="navfly__hint">{item.hint}</span>}
            </p>
            <ul className="navsub navsub--fly" aria-label={`Itens de ${label}`}>
              {children.map((child) => (
                <ChildLink key={child.testId} child={child} item={item} active={current?.testId === child.testId} onPick={pick} />
              ))}
            </ul>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * Topo da barra: logo + "Cyno" (e um "Início" discreto) numa entrada só, que leva à página do agente da
 * plataforma (fora dos workspaces). Faz o papel da marca e do item "Cyno · Início". Recolhida, fica só o logo,
 * com a dica ao lado. `brand` marca o nome (clicar nele cai no botão).
 */
export function CynoItem({ onNavigate }: { onNavigate?: () => void }) {
  const active = useNavStore((state) => state.page === "cyno");
  const go = useNavStore((state) => state.go);
  return (
    <button
      type="button"
      className="navitem navitem--cyno"
      aria-current={active ? "page" : undefined}
      aria-label={pageLabel("cyno")}
      onClick={() => {
        go("cyno");
        onNavigate?.();
      }}
      title={PAGE_HINTS.cyno}
      data-tip={pageLabel("cyno")}
      data-tip-hint={PAGE_HINTS.cyno}
      data-testid="nav-cyno"
    >
      <img className="sidenav__logo" src="/cyno-tile.svg" alt="" aria-hidden="true" width={30} height={30} />
      <span className="navitem__text" aria-hidden="true">
        <span className="navitem__label" data-testid="brand">
          Cyno
        </span>
        <span className="navitem__sub">Início</span>
      </span>
    </button>
  );
}

/** As seções de páginas (a mesma lista na barra lateral e na gaveta do celular). */
export function NavSections({ onNavigate, drawer = false }: { onNavigate?: () => void; drawer?: boolean }) {
  const empty = useWorkspaceView() === "empty";
  const badges = useNavBadges();
  const sections = nonEmptySections(empty ? APP_WIDE_SECTIONS : NAV_SECTIONS);
  return (
    <nav className="navsections" aria-label="Páginas">
      {sections.map((section, index) => {
        const titleId = section.title ? `navsection-${section.title}` : undefined;
        return (
          <div key={section.title ?? index} className="navsection" role="group" aria-labelledby={titleId}>
            {section.title && (
              <h2 id={titleId} className="navsection__title">
                {section.title}
              </h2>
            )}
            <ul className="navsection__list">
              {section.items.map((item) =>
                item.children ? (
                  <NavGroup key={item.page} item={item} badge={badges[item.page]} onNavigate={onNavigate} drawer={drawer} />
                ) : (
                  <PageItem key={item.page} item={item} badge={badges[item.page]} onNavigate={onNavigate} />
                ),
              )}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/**
 * Atalhos (a Sua agenda e o navegador do workspace): dois botões lado a lado no rodapé da barra
 * (só ícones na barra recolhida). No celular, a gaveta os mostra numa seção "Atalhos".
 */
export function ShortcutsRow({ onNavigate, titled = false }: { onNavigate?: () => void; titled?: boolean }) {
  const empty = useWorkspaceView() === "empty";
  const page = useNavStore((state) => state.page);
  const go = useNavStore((state) => state.go);
  const shortcuts = visibleShortcuts(empty);
  if (shortcuts.length === 0) return null;
  return (
    <div className="navshortcuts" role="group" aria-label="Atalhos">
      {titled && <h2 className="navsection__title">Atalhos</h2>}
      <ul className="navshortcuts__list">
        {shortcuts.map(({ item, tip, short }) => (
          <li key={item.page}>
            <button
              type="button"
              className="navitem navitem--shortcut"
              aria-current={page === item.page ? "page" : undefined}
              aria-label={tip}
              title={item.hint ? `${tip}: ${item.hint}` : tip}
              data-tip={tip}
              data-tip-hint={item.hint}
              data-testid={item.testId}
              onClick={() => {
                go(item.page);
                onNavigate?.();
              }}
            >
              <NavIcon name={item.icon} />
              <ItemText label={titled ? (item.label ?? tip) : short} hint={titled ? item.hint : undefined} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Abre um painel, marcando os avisos como lidos quando é o das notificações. */
export function openPanel(panel: NavPanel): void {
  const store = useNavLayoutStore.getState();
  if (panel === "notificacoes" && store.panel !== panel) useNoticesStore.getState().markRead();
  store.togglePanel(panel);
}

/** "Notificações" na barra: abre o painel ao lado com os avisos e as últimas atividades. */
export function NotificationsItem({ testId = "bell", onBeforeOpen }: { testId?: string; onBeforeOpen?: () => void }) {
  // Só o ponto de aviso novo: os pendentes já aparecem no contador de Aprovações.
  const { unread, label } = useNotificationsSummary();
  const open = useNavLayoutStore((state) => state.panel === "notificacoes");
  return (
    <button
      type="button"
      className="navitem navitem--panel"
      aria-label={label}
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={() => {
        onBeforeOpen?.();
        openPanel("notificacoes");
      }}
      title={NOTIFICATIONS_HINT}
      data-tip="Notificações"
      data-tip-hint={NOTIFICATIONS_HINT}
      data-panel-trigger="notificacoes"
      data-testid={testId}
    >
      <span className="navitem__icon-wrap">
        <NavIcon name="bell" />
        {unread > 0 && <span className="navitem__dot" aria-hidden="true" data-testid="bell-dot" />}
      </span>
      <ItemText label="Notificações" hint={NOTIFICATIONS_HINT} />
    </button>
  );
}

/** "Hoje" na barra: quantas tarefas rodam agora (ponto pulsando) e abre o painel do dia ao lado. */
export function TodayItem({ testId = "nav-hoje", onBeforeOpen }: { testId?: string; onBeforeOpen?: () => void }) {
  const open = useNavLayoutStore((state) => state.panel === "hoje");
  const running = useRunningCount();
  return (
    <button
      type="button"
      className="navitem navitem--panel"
      aria-label={running > 0 ? `Hoje, ${running} fazendo` : "Hoje"}
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={() => {
        onBeforeOpen?.();
        openPanel("hoje");
      }}
      title={HOJE_HINT}
      data-tip={running > 0 ? `Hoje · ${running} fazendo` : "Hoje"}
      data-tip-hint={HOJE_HINT}
      data-panel-trigger="hoje"
      data-testid={testId}
    >
      <span className="navitem__icon-wrap">
        <NavIcon name="hoje" />
      </span>
      <ItemText label="Hoje" hint={HOJE_HINT} />
      {running > 0 && (
        <span className="navitem__badge navitem__badge--live" data-testid="nav-running">
          <span className="navitem__live-dot" aria-hidden="true" />
          {running}
          <span className="navitem__live-text"> fazendo</span>
        </span>
      )}
    </button>
  );
}

/** "Agentes" no rodapé: quantos e quantos trabalhando; abre a lista de agentes ao lado. */
export function AgentsItem({ onBeforeOpen }: { onBeforeOpen?: () => void }) {
  const { live, rooms, teams, agents, working } = useAgentsSummary();
  const status = useOfficeStore((state) => state.status);
  const ready = useOfficeStore((state) => state.office !== null);
  const open = useNavLayoutStore((state) => state.panel === "agentes");
  if (!ready) {
    return (
      <p className={`navagents navagents--static${status === "error" ? " navagents--error" : ""}`} role={status === "error" ? "alert" : undefined} data-testid={status === "error" ? "hud-error" : undefined}>
        <NavIcon name="agentes" />
        <span className="navitem__label">{status === "error" ? "Não foi possível carregar o escritório." : "Carregando…"}</span>
      </p>
    );
  }
  const tone = !live ? "offline" : working > 0 ? "busy" : "idle";
  return (
    <button
      type="button"
      className={`navitem navagents navagents--${tone}`}
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={() => {
        onBeforeOpen?.();
        openPanel("agentes");
      }}
      data-tip={`${countLabel(agents, "agente", "agentes")} · ${working} trabalhando`}
      data-panel-trigger="agentes"
      data-testid="hud-status"
    >
      <span className="navitem__icon-wrap">
        <NavIcon name="agentes" />
        <span className="navagents__dot" aria-hidden="true" />
      </span>
      <span className="sr-only">Agentes do escritório: </span>
      <span className="sr-only" data-testid="hud-rooms">
        {countLabel(rooms, "sala", "salas")}
      </span>
      <span className="sr-only">, </span>
      <span className="sr-only" data-testid="hud-teams">
        {countLabel(teams, "time", "times")}
      </span>
      <span className="sr-only">, </span>
      <span className="navagents__text ui-tabular">
        <span className="navagents__count" data-testid="hud-agents">
          {countLabel(agents, "agente", "agentes")}
        </span>
        <span className="sr-only">, </span>
        <span className="navagents__working" data-testid="hud-working">
          {working} trabalhando
        </span>
      </span>
      {working > 0 && (
        <span className="navitem__badge navitem__badge--ok navagents__rail-count" aria-hidden="true">
          {working}
        </span>
      )}
    </button>
  );
}
