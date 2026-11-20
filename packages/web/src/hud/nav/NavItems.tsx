import { useEffect, useState, type CSSProperties, type FocusEvent, type ReactElement } from "react";
import { stepAttention } from "../../attention/useAttentionKeys";
import { useBrowserStore } from "../../store/browserStore";
import { useNavGroupsStore } from "../../store/navGroupsStore";
import { useNavLayoutStore, type NavPanel } from "../../store/navLayoutStore";
import { useNoticesStore } from "../../store/notices";
import { pageLabel, useNavStore } from "../../store/navStore";
import { useOfficeStore } from "../../store/officeStore";
import { useWorkspaceView } from "../../store/workspaceStore";
import { countLabel } from "../../ui/format";
import { useAgentsSummary } from "../AgentsPopover";
import { useAttentionCounter } from "../AttentionCounter";
import { NavIcon } from "../navIcons";
import { useNotificationsSummary } from "../NotificationsBell";
import { useRunningCount } from "../hoje/TodayPanel";
import { useScriptsStore } from "../../store/scriptsStore";
import { runningCount } from "../../pages/scripts/scriptsView";
import { useNavBadges } from "./navHooks";
import { activeChild, childSub, counterParts, isGroupOpen, PAGE_HINTS, railGroupSub, visibleChildren, visibleParaVoce, visibleSections, type Badge, type NavChildDef, type NavCounterKind, type NavItemDef, type ParaVoceButtonDef, type ParaVoceId } from "./navItems";

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
        {item.counter && <RowCounter kind={item.counter} testId={`${item.testId}-count`} />}
      </button>
    </li>
  );
}

/** Contagem à direita da linha (abas abertas do navegador, scripts rodando); nada quando é zero. Recolhida, só o número. */
function RowCounter({ kind, testId }: { kind: NavCounterKind; testId: string }) {
  const tabs = useBrowserStore((state) => state.browser?.tabs.length ?? 0);
  const running = useScriptsStore((state) => runningCount(state.runs ?? []));
  const parts = counterParts(kind, kind === "tabs" ? tabs : running);
  if (!parts) return null;
  return (
    <span className={kind === "running" ? "navitem__badge navitem__badge--running" : "navitem__muted"} data-testid={testId}>
      {parts.number}
      <span className="navitem__counter-word"> {parts.word}</span>
    </span>
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
 * abas. No computador começa fechado (no menu do celular, aberto); abre quando a página atual é dele, ao clicar no item ou no botão da seta (que só abre e
 * fecha, sem navegar); a escolha fica lembrada por navegador. Com a barra recolhida, passar o mouse (ou o foco)
 * no ícone abre um menu flutuante com os mesmos destinos.
 */
function NavGroup({ item, badge, onNavigate, drawer }: { item: NavItemDef; badge?: Badge; onNavigate?: () => void; drawer: boolean }) {
  const empty = useWorkspaceView() === "empty";
  const page = useNavStore((state) => state.page);
  const sub = useNavStore((state) => state.sub);
  const go = useNavStore((state) => state.go);
  const collapsedBar = useNavLayoutStore((state) => state.collapsed);
  const choice = useNavGroupsStore((state) => state.choices[item.testId]);
  const open = isGroupOpen(item, page, choice, drawer);
  const inside = page === item.page;
  const [fly, setFly] = useState<number | null>(null);
  const rail = collapsedBar && !drawer;
  const children = visibleChildren(item, empty);
  const current = activeChild(item, page, sub);
  const label = item.label ?? pageLabel(item.page);
  // Entrar na página do grupo (por onde for) o abre: a escolha de fechar vale só enquanto o dono está em outra página.
  useEffect(() => {
    const groups = useNavGroupsStore.getState();
    if (inside && groups.choices[item.testId] === false) groups.clear(item.testId);
  }, [inside, item.testId]);
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
            if (!rail) useNavGroupsStore.getState().choose(item.testId, true);
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
        {!rail && (
          <button
            type="button"
            className="navgroup__toggle"
            aria-label={open ? `Recolher ${label}` : `Abrir ${label}`}
            aria-expanded={open}
            onClick={() => useNavGroupsStore.getState().choose(item.testId, !open)}
            data-testid={`${item.testId}-toggle`}
          >
            <NavIcon name="chevron" className="navgroup__chevron" />
          </button>
        )}
      </div>
      {open && !rail && (
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

/** As seções do menu (a mesma lista na barra lateral e na gaveta do celular): "Para você" em cima e, depois, as páginas. */
export function NavSections({ onNavigate, drawer = false }: { onNavigate?: () => void; drawer?: boolean }) {
  const empty = useWorkspaceView() === "empty";
  const badges = useNavBadges();
  const sections = visibleSections(empty);
  return (
    <nav className="navsections" aria-label="Páginas">
      <ParaVoceRow drawer={drawer} onNavigate={onNavigate} />
      {sections.map((section, index) => {
        const titleId = section.title ? `navsection-${section.title}` : undefined;
        return (
          <div key={section.title ?? index} className={`navsection${section.separated ? " navsection--separated" : ""}`} role="group" aria-labelledby={titleId}>
            {section.separated && <div className="navsection__sep" role="separator" />}
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

/** Um botão de "Para você": ícone com o nome curto embaixo e, se houver, a contagem no canto de cima. Painel aberto ou página atual = aceso. */
function ParaVoceTile({
  def,
  label,
  hint,
  count = 0,
  tone,
  hot = false,
  active = false,
  panel,
  countTestId,
  testId,
  onClick,
}: {
  def: ParaVoceButtonDef;
  label: string;
  hint: string;
  count?: number;
  tone?: "danger" | "info" | "live";
  hot?: boolean;
  active?: boolean;
  /** O painel que o botão abre (marca `aria-expanded`); sem isso, é página ou ação. */
  panel?: { open: boolean; id: NavPanel };
  countTestId?: string;
  testId: string;
  onClick: (event: { shiftKey: boolean }) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={`navtile${hot ? " navtile--hot" : ""}`}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        aria-expanded={panel ? panel.open : undefined}
        aria-haspopup={panel ? "dialog" : undefined}
        onClick={onClick}
        title={hint}
        data-tip={def.label}
        data-tip-hint={hint}
        data-panel-trigger={panel?.id}
        data-testid={testId}
      >
        <NavIcon name={def.icon} />
        <span className="navtile__name" aria-hidden="true">
          {def.short}
        </span>
        {count > 0 && (
          <span className={`navtile__badge navtile__badge--${tone ?? "info"}`} aria-hidden="true" data-testid={countTestId}>
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
    </li>
  );
}

/** Ids de teste de cada botão: a gaveta do celular tem os próprios (a barra de cima já usa "bell" e "attention-counter"). */
const TILE_IDS: Record<"bar" | "drawer", Record<ParaVoceId, { button: string; count?: string }>> = {
  bar: { hoje: { button: "nav-hoje" }, espera: { button: "attention-counter", count: "attention-count" }, avisos: { button: "bell", count: "bell-dot" }, agenda: { button: "nav-agenda" } },
  drawer: { hoje: { button: "nav-hoje-drawer" }, espera: { button: "nav-espera-drawer", count: "nav-espera-drawer-count" }, avisos: { button: "nav-notificacoes", count: "nav-notificacoes-count" }, agenda: { button: "nav-agenda" } },
};

function HojeTile({ def, ids, onNavigate }: TileProps) {
  const open = useNavLayoutStore((state) => state.panel === "hoje");
  const running = useRunningCount();
  return (
    <ParaVoceTile
      def={def}
      label={running > 0 ? `Hoje, ${running} fazendo` : def.label}
      hint={running > 0 ? `${def.hint} (${running} fazendo agora)` : def.hint}
      count={running}
      tone="live"
      countTestId="nav-running"
      active={open}
      panel={{ open, id: "hoje" }}
      testId={ids.button}
      onClick={() => {
        onNavigate?.();
        openPanel("hoje");
      }}
    />
  );
}

/** "Esperando você": não abre painel; cada clique vai ao próximo alerta que espera o dono (Shift volta). Parado em zero. */
function EsperaTile({ def, ids }: TileProps) {
  const { count, hint } = useAttentionCounter();
  return (
    <ParaVoceTile
      def={def}
      label={count > 0 ? hint : def.label}
      hint={hint}
      count={count}
      tone="danger"
      hot={count > 0}
      countTestId={ids.count}
      testId={ids.button}
      onClick={(event) => {
        if (count > 0) stepAttention(event.shiftKey ? -1 : 1);
      }}
    />
  );
}

function AvisosTile({ def, ids, onNavigate }: TileProps) {
  const { unread, label } = useNotificationsSummary();
  const open = useNavLayoutStore((state) => state.panel === "notificacoes");
  return (
    <ParaVoceTile
      def={def}
      label={label}
      hint={def.hint}
      count={unread}
      tone="info"
      active={open}
      panel={{ open, id: "notificacoes" }}
      countTestId={ids.count}
      testId={ids.button}
      onClick={() => {
        onNavigate?.();
        openPanel("notificacoes");
      }}
    />
  );
}

function AgendaTile({ def, ids, onNavigate }: TileProps) {
  const active = useNavStore((state) => state.page === "agenda");
  const go = useNavStore((state) => state.go);
  return (
    <ParaVoceTile
      def={def}
      label={def.label}
      hint={def.hint}
      active={active}
      testId={ids.button}
      onClick={() => {
        go("agenda");
        onNavigate?.();
      }}
    />
  );
}

type TileProps = { def: ParaVoceButtonDef; ids: { button: string; count?: string }; onNavigate?: () => void };

const TILES: Record<ParaVoceId, (props: TileProps) => ReactElement> = { hoje: HojeTile, espera: EsperaTile, avisos: AvisosTile, agenda: AgendaTile };

/** "Para você": quatro botões iguais numa linha (Hoje, Espera, Avisos, Agenda); recolhida, quatro ícones empilhados. */
function ParaVoceRow({ drawer, onNavigate }: { drawer: boolean; onNavigate?: () => void }) {
  const empty = useWorkspaceView() === "empty";
  const buttons = visibleParaVoce(empty);
  if (buttons.length === 0) return null;
  const ids = TILE_IDS[drawer ? "drawer" : "bar"];
  return (
    <div className="navsection navsection--para-voce" role="group" aria-labelledby="navsection-para-voce">
      <h2 id="navsection-para-voce" className="navsection__title">
        Para você
      </h2>
      <ul className="navtiles" style={{ "--tiles": buttons.length } as CSSProperties}>
        {buttons.map((def) => {
          const Tile = TILES[def.id];
          return <Tile key={def.id} def={def} ids={ids[def.id]} onNavigate={onNavigate} />;
        })}
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
