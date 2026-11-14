import { BROWSER_LIMITS, BROWSER_USER_OWNER, browserHostLabel, type BrowserTab } from "@cyno/shared";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { api, describeError } from "../api/client";
import { useBrowserStore } from "../store/browserStore";
import { useNavStore } from "../store/navStore";
import { useOfficeStore } from "../store/officeStore";
import { AvatarSprite } from "../ui/AvatarSprite";
import { BrowserStream, browserStreamUrl, keyMessage, type StreamStatus } from "./browserStream";
import { GlobeIcon } from "./GlobeIcon";
import "./browser.css";

const NO_TABS: BrowserTab[] = [];

/** Teclas que o celular não manda pelo teclado da tela: botões. */
const MOBILE_KEYS = [
  { key: "Enter", label: "Enter" },
  { key: "Backspace", label: "⌫" },
  { key: "Tab", label: "Tab" },
  { key: "Escape", label: "Esc" },
] as const;

/** Dono da aba como o usuário lê: o avatar do agente, ou "Você". */
function TabOwner({ tab }: { tab: BrowserTab }) {
  const agent = useOfficeStore((state) => state.office?.agents.find((candidate) => candidate.id === tab.owner));
  if (tab.owner === BROWSER_USER_OWNER || !agent) {
    return (
      <span className="browser-tab__avatar browser-tab__avatar--user" aria-hidden="true">
        {tab.owner === BROWSER_USER_OWNER ? "Você".slice(0, 1) : tab.ownerName.slice(0, 1)}
      </span>
    );
  }
  return (
    <span className="browser-tab__avatar" aria-hidden="true">
      <AvatarSprite avatar={agent.avatar} seedId={agent.id} size={28} framing="head" />
    </span>
  );
}

/**
 * Página "Navegador": o Chromium compartilhado do workspace. Lista as abas (de qual agente é cada
 * uma), mostra a aba escolhida ao vivo e deixa o usuário controlar (clique, rolagem, teclado,
 * endereço). É assim que ele faz login nos sites uma vez: o perfil guarda a sessão para os agentes.
 */
export function BrowserPage() {
  const workspaceId = useNavStore((state) => state.workspaceId);
  const browser = useBrowserStore((state) => state.browser);
  const loadError = useBrowserStore((state) => state.error);
  const tabs = browser?.tabs ?? NO_TABS;
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  /** Aba do último quadro recebido (a tela só aparece quando é a da aba escolhida). */
  const [frameTab, setFrameTab] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [address, setAddress] = useState("");
  const [typed, setTyped] = useState("");
  const screen = useRef<HTMLImageElement>(null);
  const stream = useRef<BrowserStream | null>(null);
  const editingAddress = useRef(false);

  useEffect(() => {
    if (useBrowserStore.getState().browser === null) void useBrowserStore.getState().load();
  }, [workspaceId]);

  // A aba escolhida sumiu (fechou) ou ainda não há escolha: a primeira da lista.
  const current = tabs.find((tab) => tab.id === selected) ?? tabs[0] ?? null;
  const currentId = current?.id ?? null;

  // Uma conexão por workspace enquanto a página está aberta.
  useEffect(() => {
    if (!workspaceId) return;
    const connection = new BrowserStream(browserStreamUrl(workspaceId), {
      onFrame: (tab, data) => {
        if (screen.current) screen.current.src = `data:image/jpeg;base64,${data}`;
        setFrameTab(tab);
      },
      onGone: (tab) => setFrameTab((shown) => (shown === tab ? null : shown)),
      onError: (message) => setError(message),
      onStatus: setStatus,
    });
    stream.current = connection;
    return () => {
      connection.close();
      stream.current = null;
    };
  }, [workspaceId]);

  useEffect(() => {
    stream.current?.watch(currentId);
  }, [currentId, status]);
  const hasFrame = currentId !== null && frameTab === currentId;

  // O endereço acompanha a aba (menos enquanto o usuário digita nele).
  useEffect(() => {
    if (!editingAddress.current) setAddress(current?.url === "about:blank" ? "" : (current?.url ?? ""));
  }, [current?.url, currentId]);

  // Rolagem na tela: listener nativo (não passivo) para a página de fora não rolar junto.
  useEffect(() => {
    const element = screen.current;
    if (!element) return;
    let pending = { dx: 0, dy: 0, x: 0.5, y: 0.5 };
    let timer: number | undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      pending = {
        dx: pending.dx + event.deltaX,
        dy: pending.dy + event.deltaY,
        x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
        y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
      };
      timer ??= window.setTimeout(() => {
        timer = undefined;
        const clamp = (value: number) => Math.max(-5000, Math.min(5000, Math.round(value)));
        stream.current?.send({ t: "wheel", x: pending.x, y: pending.y, dx: clamp(pending.dx), dy: clamp(pending.dy) });
        pending = { dx: 0, dy: 0, x: pending.x, y: pending.y };
      }, 60);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", onWheel);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [currentId]);

  const point = (event: ReactMouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) };
  };

  const onScreenClick = (event: ReactMouseEvent<HTMLImageElement>) => {
    event.currentTarget.parentElement?.focus();
    stream.current?.send({ t: "click", ...point(event) });
  };

  const onScreenKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const message = keyMessage(event);
    if (!message) return;
    event.preventDefault();
    stream.current?.send(message);
  };

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const text = event.clipboardData.getData("text").slice(0, 2000);
    if (!text) return;
    event.preventDefault();
    stream.current?.send({ t: "type", text });
  };

  const openTab = useCallback(async (url?: string) => {
    setOpening(true);
    setError(null);
    try {
      const tab = await api.openBrowserTab(url);
      setSelected(tab.id);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setOpening(false);
    }
  }, []);

  const closeTab = async (tabId: string) => {
    setError(null);
    try {
      await api.closeBrowserTab(tabId);
    } catch (failure) {
      setError(describeError(failure));
    }
  };

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    editingAddress.current = false;
    const url = address.trim();
    if (!url) return;
    setError(null);
    if (current) stream.current?.send({ t: "navigate", url });
    else void openTab(url);
  };

  const sendTyped = (event: FormEvent) => {
    event.preventDefault();
    if (!typed) return;
    stream.current?.send({ t: "type", text: typed.slice(0, 2000) });
    setTyped("");
  };

  const userTabs = useMemo(() => tabs.filter((tab) => tab.owner === BROWSER_USER_OWNER).length, [tabs]);
  const full = userTabs >= BROWSER_LIMITS.tabsPerOwner || tabs.length >= BROWSER_LIMITS.tabsTotal;
  const disabled = browser?.enabled === false;

  return (
    <section className="page page--browser page--fill" aria-labelledby="page-title-navegador" data-testid="page-navegador">
      <header className="page__header page__header--row browser-header">
        <div className="page__heading">
          <h2 className="page__title" id="page-title-navegador">
            Navegador dos agentes
          </h2>
          <p className="page__subtitle">
            Um Chromium compartilhado pelos agentes deste workspace. Faça login nos sites aqui (uma vez): a sessão fica salva e os agentes usam a mesma.
          </p>
        </div>
        <span className="browser-state" data-running={browser?.running ? "true" : "false"} data-testid="browser-state">
          <span className="browser-state__dot" aria-hidden="true" />
          {disabled ? "Desligado no servidor" : browser?.running ? `Aberto · ${tabs.length} ${tabs.length === 1 ? "aba" : "abas"}` : "Fechado · abre quando alguém usar"}
        </span>
      </header>

      {disabled ? (
        <p className="page__empty">O navegador compartilhado está desligado neste servidor (BROWSER=0).</p>
      ) : (
        <div className="browser-layout">
          <aside className="browser-tabs" aria-label="Abas abertas">
            <button type="button" className="ui-button ui-button--small browser-tabs__open" onClick={() => void openTab()} disabled={opening || full} aria-busy={opening} data-testid="browser-open-tab">
              + Abrir aba
            </button>
            {tabs.length === 0 ? (
              <p className="browser-tabs__empty">Nenhuma aba aberta.</p>
            ) : (
              <ul className="browser-tabs__list" data-testid="browser-tabs">
                {tabs.map((tab) => (
                  <li key={tab.id} className="browser-tab" data-current={tab.id === currentId ? "true" : undefined} data-owner={tab.owner}>
                    <button type="button" className="browser-tab__select" onClick={() => setSelected(tab.id)} aria-pressed={tab.id === currentId} data-testid={`browser-tab-${tab.id}`}>
                      <TabOwner tab={tab} />
                      <span className="browser-tab__text">
                        <span className="browser-tab__title">{tab.title || browserHostLabel(tab.url) || "Nova aba"}</span>
                        <span className="browser-tab__meta">
                          {tab.ownerName} · {tab.url === "about:blank" ? "em branco" : browserHostLabel(tab.url)}
                        </span>
                      </span>
                    </button>
                    <button type="button" className="browser-tab__close" onClick={() => void closeTab(tab.id)} aria-label={`Fechar a aba ${tab.title || tab.id} (${tab.ownerName})`} title="Fechar aba">
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="browser-hint">
              Clique na tela para usar o site (o teclado vai para a página). Senhas digitadas aqui vão direto para o site; o app não guarda nada além do perfil do navegador.
            </p>
          </aside>

          <div className="browser-view">
            <form className="browser-toolbar" onSubmit={navigate}>
              <button type="button" className="browser-toolbar__btn" onClick={() => stream.current?.send({ t: "back" })} disabled={!current} aria-label="Voltar" title="Voltar">
                ←
              </button>
              <button type="button" className="browser-toolbar__btn" onClick={() => stream.current?.send({ t: "forward" })} disabled={!current} aria-label="Avançar" title="Avançar">
                →
              </button>
              <button type="button" className="browser-toolbar__btn" onClick={() => stream.current?.send({ t: "reload" })} disabled={!current} aria-label="Recarregar" title="Recarregar">
                ⟳
              </button>
              <label className="browser-toolbar__address">
                <span className="sr-only">Endereço</span>
                <GlobeIcon size={14} />
                <input
                  type="text"
                  inputMode="url"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={address}
                  placeholder={current ? "Digite um endereço" : "Endereço para abrir numa aba nova"}
                  onFocus={() => (editingAddress.current = true)}
                  onBlur={() => (editingAddress.current = false)}
                  onChange={(event) => setAddress(event.target.value)}
                  data-testid="browser-address"
                />
              </label>
              <button type="submit" className="ui-button ui-button--small" disabled={!address.trim()}>
                Ir
              </button>
            </form>

            {error && (
              <p className="browser-error" role="alert" data-testid="browser-error">
                {error}
              </p>
            )}
            {loadError && !browser && <p className="browser-error">{loadError}</p>}

            <div
              className="browser-screen"
              tabIndex={current ? 0 : -1}
              onKeyDown={onScreenKey}
              onPaste={onPaste}
              aria-label={current ? `Tela da aba ${current.title || current.id}: clique para usar o site; o teclado vai para a página` : "Nenhuma aba"}
              data-testid="browser-screen"
            >
              <img ref={screen} className="browser-screen__img" alt="" draggable={false} onClick={onScreenClick} hidden={!current || !hasFrame} data-testid="browser-frame" />
              {!current && (
                <div className="browser-screen__empty">
                  <GlobeIcon size={34} />
                  <p>Nenhuma aba aberta. Abra uma para entrar no LinkedIn, no Google ou em outro site: a sessão fica salva para os agentes.</p>
                  <button type="button" className="ui-button" onClick={() => void openTab()} disabled={opening}>
                    Abrir aba
                  </button>
                </div>
              )}
              {current && !hasFrame && <div className="browser-screen__loading">{status === "open" ? "Carregando a tela…" : "Conectando…"}</div>}
            </div>

            {current && (
              <form className="browser-typer" onSubmit={sendTyped}>
                <label className="browser-typer__field">
                  <span className="sr-only">Digitar no site</span>
                  <input
                    type="text"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    placeholder="Digitar no campo selecionado do site"
                    data-testid="browser-typer"
                  />
                </label>
                <button type="submit" className="ui-button ui-button--small" disabled={!typed}>
                  Digitar
                </button>
                {MOBILE_KEYS.map((item) => (
                  <button key={item.key} type="button" className="browser-toolbar__btn browser-typer__key" onClick={() => stream.current?.send({ t: "key", key: item.key })} aria-label={`Tecla ${item.key}`}>
                    {item.label}
                  </button>
                ))}
              </form>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
