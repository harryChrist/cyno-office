import { mkdir } from "node:fs/promises";
import {
  BROWSER_LIMITS,
  BROWSER_USER_OWNER,
  BROWSER_VIEWPORT,
  browserHostLabel,
  type BrowserClientMessage,
  type BrowserState,
  type BrowserTab,
  type ServerEvent,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { chromium, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { activity } from "../activity/log";
import { describeFind, describeInspect, FIND_DEFAULT_LIMIT, FIND_MAX_LIMIT, findElements, INSPECT_DEFAULT_CHARS, INSPECT_DEFAULT_DEPTH, INSPECT_MAX_CHARS, INSPECT_MAX_DEPTH, inspectElement } from "./inspect";
import { CLEAR_COPIED_SOURCE, COPY_CAPTURE_SCRIPT, describeLinks, type LinkRecipe, readLinks, recipesFor, TAKE_COPIED_SOURCE } from "./links";
import { looksLoggedIn, readFocused, readTarget, sensitiveReason, type SensitiveAction } from "./sensitive";
import { compactSnapshot, SNAPSHOT_MAX_CHARS, UNTRUSTED_NOTE } from "./snapshot";
import { renderHtml, type RenderInput, type RenderLauncher } from "./render";
import type { UrlPolicy } from "./url-policy";

/** Abre o contexto persistente (o perfil) do Chromium. Os testes podem trocar. */
export type BrowserLauncher = (profileDir: string, options: { userAgent?: string }) => Promise<BrowserContext>;

export type BrowserServiceOptions = {
  /** Pasta do perfil (cookies, sessões, localStorage): data/workspaces/<ws>/browser/profile. */
  profileDir: string;
  /** Workspace dono do navegador (vai nos eventos do diário do sistema). */
  workspaceId?: string;
  policy: UrlPolicy;
  /** Sem uso (agentes nem painel aberto) por tanto tempo, o Chromium fecha (0 = nunca). */
  idleMs: number;
  /** Pedir aprovação antes de publicar/enviar/comprar? (configuração do workspace; padrão sim). */
  approvalsRequired: () => boolean;
  /** Nome de quem é dono de uma aba (agente) para a interface. */
  ownerName: (owner: string) => string;
  publish: (event: ServerEvent) => void;
  now: () => Date;
  log: FastifyBaseLogger;
  limits?: { tabsPerOwner: number; tabsTotal: number };
  launch?: BrowserLauncher;
  /** Tempo máximo de uma navegação (ms). */
  navigationTimeoutMs?: number;
  /**
   * Rotina "sem OK": esta ação sensível (clique, rótulo, host) está liberada pela rotina da tarefa
   * que o agente roda agora? `null` = não (segue o caminho normal de aprovação). Só o que o usuário
   * liberou na rotina; as regras de sensitive.ts não mudam.
   */
  routineGrant?: (owner: string, host: string, label: string, actionKind: string) => { allowed: boolean; routineId: string } | null;
  /**
   * Modo Automático do projeto: o clique sensível da tarefa de um projeto em Automático, cujo tipo de
   * ação e site o usuário liberou (e dentro do teto do dia), passa sem cartão, como a rotina "sem OK".
   * `null` = não (segue o caminho normal). Consultar já conta o uso quando libera.
   */
  autoGrant?: (owner: string, host: string, label: string, actionKind: string) => { allowed: boolean; projectId: string; usage: string } | null;
  /** Uma ação sensível passou (aprovada, liberada pela rotina, pelo Automático ou sem aprovação no workspace): prova de execução. */
  onExecuted?: (event: { owner: string; host: string; label: string; actionKind: string; via: "aprovacao" | "rotina" | "automatico" | "livre"; routineId?: string; /** Automático: "3 de 8 hoje". */ usage?: string; /** Endereço da página (sem consulta nem âncora). */ url?: string }) => void;
  /** Página inicial das abas do usuário em branco (padrão: google.com; "" desliga). */
  homeUrl?: string;
  /** Abre o Chromium da renderização de HTML (os testes podem trocar). */
  renderLauncher?: RenderLauncher;
  /** Receitas de permalink por site (padrão: LINK_RECIPES; os testes trocam o host). */
  linkRecipes?: LinkRecipe[];
};

type Tab = { id: string; owner: string; page: Page; openedAt: string; lastActiveAt: string };

/** Resultado de uma ação do agente: feita (texto para o modelo) ou esperando a aprovação do usuário. */
export type BrowserActionResult = { status: "done"; text: string } | { status: "needs_approval"; key: string; question: string; reason: string };

/** Quadro da tela ao vivo (JPEG em base64) de uma aba. */
export type BrowserFrame = { tab: string; data: string; width: number; height: number };

/** Uma tela ao vivo em curso (uma sessão CDP por aba, dividida entre os painéis que assistem). */
type Screencast = { session: CDPSession; listeners: Set<(frame: BrowserFrame) => void>; gone: Set<() => void> };

/** Quanto tempo uma aprovação concedida vale (o agente repete a chamada logo depois). */
const PASS_TTL_MS = 15 * 60_000;
/** Memória máxima do JavaScript de uma página (MB). */
const BROWSER_PAGE_HEAP_MB = 640;

/** Clique, digitação e tecla: espera curta pelo elemento. */
const ACTION_TIMEOUT_MS = 8000;

/** Página inicial padrão do navegador do usuário. */
const DEFAULT_HOME_URL = "https://www.google.com";

/** User agent sem "HeadlessChrome" (sites como o Google tratam o navegador sem tela como robô). Descoberto na primeira vez. */
let cachedUserAgent: string | undefined;

const defaultLauncher: BrowserLauncher = (profileDir, { userAgent }) =>
  chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    acceptDownloads: false,
    viewport: { ...BROWSER_VIEWPORT },
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      // Teto do JS de cada página: um feed infinito (LinkedIn) passou de 1,8 GB e o sistema matou o app
      // inteiro por falta de memória. Com o teto, só aquela aba quebra (ver "crash" em register).
      `--js-flags=--max-old-space-size=${BROWSER_PAGE_HEAP_MB}`,
    ],
    ...(userAgent ? { userAgent } : {}),
  });

/** Alvo por seletor CSS (`css=<seletor>` + `>> nth=<n>` opcional), ou undefined se for um ref. */
export function parseCssTarget(target: string): { selector: string; nth: number } | undefined {
  const match = /^css=([\s\S]+?)(?:\s*>>\s*nth=(\d{1,4}))?$/.exec(target.trim());
  if (!match) return undefined;
  const selector = match[1]!.trim();
  if (!selector || selector.includes(">>") || selector.length > 500) throw new BrowserError(`Invalid selector "${selector.slice(0, 80)}". Use a plain CSS selector (e.g. "div[data-id='42'] button").`);
  return { selector, nth: Number(match[2] ?? 0) };
}

/** Monta o alvo de uma ferramenta: o ref do snapshot ou o seletor CSS (com a posição entre os achados). */
export function browserElement(input: { ref?: string; selector?: string; nth?: number }): string {
  if (input.selector?.trim()) return `css=${input.selector.trim()}${input.nth ? ` >> nth=${input.nth}` : ""}`;
  if (input.ref?.trim()) return input.ref.trim();
  throw new BrowserError('Pass the element: "ref" from browser_snapshot, or "selector" (CSS) from the HTML (browser_inspect/browser_find).');
}

const notFound = (target: string) =>
  target.startsWith("css=")
    ? `No element matches ${target} on the page now. Check the selector with browser_find (it lists what matches) or take a new browser_snapshot.`
    : `Element ref "${target}" was not found on the page (it may have changed). Take a new browser_snapshot and use a fresh ref.`;

/** Erro que o modelo lê (em inglês) e pode corrigir. */
class BrowserError extends Error {
  /** Nas rotas do painel vira 400 (a mensagem vai para o usuário). */
  readonly statusCode = 400;
}

/**
 * Navegador compartilhado do workspace: um Chromium headless com perfil persistente (login feito
 * uma vez pelo usuário no painel vale para todos os agentes). Sobe na primeira chamada e fecha
 * depois de `idleMs` sem uso. Cada aba tem dono (agente ou usuário): o agente só mexe nas dele; o
 * usuário, em todas. Toda navegação e toda requisição da página passam pela política de endereços
 * (nada de rede local). Ações que parecem publicar/enviar/comprar voltam como "needs_approval"
 * (quem chama abre o pedido no "Para você"; aprovado, `grant` libera uma repetição).
 */
export class BrowserService {
  private context: BrowserContext | undefined;
  private starting: Promise<BrowserContext> | undefined;
  private readonly tabs = new Map<string, Tab>();
  /** Aba em uso de cada dono (a que vale quando a ferramenta não diz `tab`). */
  private readonly current = new Map<string, string>();
  private readonly screencasts = new Map<string, Screencast>();
  private readonly passes = new Map<string, number>();
  /** Ações sensíveis com pedido aberto: chave -> quando o pedido deixa de valer (rede de segurança contra pedido preso). */
  private readonly pending = new Map<string, number>();
  /** Abas que quebraram (falta de memória da página): o aviso que o dono recebe na próxima chamada. */
  private readonly crashed = new Map<string, string>();
  /** Página em branco que o Chromium abre ao subir: vira a primeira aba. */
  private spare: Page | undefined;
  private tabSeq = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private publishTimer: NodeJS.Timeout | undefined;
  private viewers = 0;
  private closed = false;
  private readonly limits: { tabsPerOwner: number; tabsTotal: number };

  constructor(private readonly options: BrowserServiceOptions) {
    this.limits = options.limits ?? BROWSER_LIMITS;
  }

  get running(): boolean {
    return this.context !== undefined;
  }

  /** Estado para a interface (abas de todo mundo, mais recentes primeiro). */
  state(): BrowserState {
    return { enabled: true, running: this.running, tabs: [...this.tabs.values()].map((tab) => this.describe(tab)) };
  }

  // ---------- Ciclo de vida ----------

  private async ensure(): Promise<BrowserContext> {
    if (this.closed) throw new BrowserError("The office browser is shutting down");
    this.touch();
    if (this.context) return this.context;
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
      // A ociosidade conta do fim da subida: com o Chromium lento para abrir, o relógio já teria vencido no meio da primeira navegação.
      this.touch();
    });
    return this.starting;
  }

  /** Falhas do navegador viram Atividade (o resto — abrir, fechar, aba, navegação — é ruído). */
  private note(level: "info" | "warn" | "error", type: string, owner: string | undefined, fields: { durationMs?: number; data?: Record<string, unknown> } = {}): void {
    if (type !== "launch_failed" && type !== "tab_crash") return;
    const workspaceId = this.options.workspaceId;
    const error = typeof fields.data?.error === "string" ? fields.data.error : undefined;
    activity(
      {
        category: type === "launch_failed" ? "sistema" : "agente",
        action: type === "launch_failed" ? "navegador_nao_abriu" : "navegador_caiu",
        actor: owner && owner !== BROWSER_USER_OWNER ? owner : "sistema",
        ...(workspaceId ? { workspaceId } : {}),
        summary: type === "launch_failed" ? `O navegador compartilhado não abriu${error ? `: ${error}` : ""}` : `Uma aba do navegador${fields.data?.host ? ` (${String(fields.data.host)})` : ""} caiu`,
        data: { level, ...fields.data },
      },
      { throttle: { key: `browser:${type}:${workspaceId ?? ""}`, ms: 5 * 60_000 } },
    );
  }

  private async start(): Promise<BrowserContext> {
    const startedAt = Date.now();
    await mkdir(this.options.profileDir, { recursive: true });
    const launch = this.options.launch ?? defaultLauncher;
    let context: BrowserContext;
    try {
      context = await launch(this.options.profileDir, { userAgent: cachedUserAgent });
      if (!this.options.launch && !cachedUserAgent) {
        // Primeira vez: descobre a versão e, se o user agent entregar o "Headless", sobe de novo sem ele.
        const probe = context.pages()[0] ?? (await context.newPage());
        const agent = String(await probe.evaluate("navigator.userAgent"));
        cachedUserAgent = agent.replace(/HeadlessChrome/g, "Chrome");
        if (cachedUserAgent !== agent) {
          await context.close();
          context = await launch(this.options.profileDir, { userAgent: cachedUserAgent });
        }
      }
    } catch (error) {
      this.options.log.error({ err: error }, "não foi possível abrir o navegador compartilhado");
      this.note("error", "launch_failed", undefined, { durationMs: Date.now() - startedAt, data: { error: error instanceof Error ? error.message.split("\n")[0] : String(error) } });
      throw new BrowserError(`Could not start the office browser: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
    if (this.closed) {
      await context.close().catch(() => undefined);
      throw new BrowserError("The office browser is shutting down");
    }
    context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs ?? 30_000);
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    // "Copiar link" e afins: a página copia para a área de transferência; o script guarda o texto
    // para o agente receber no resultado da ação (o headless não tem área de transferência útil).
    await context.addInitScript(COPY_CAPTURE_SCRIPT);
    // Toda requisição (navegação, imagem, fetch, websocket) passa pela política: nada de rede local.
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (await this.options.policy.allowsRequest(request.url(), request.isNavigationRequest())) await route.fallback();
      else await route.abort("blockedbyclient");
    });
    await context.routeWebSocket(/.*/, async (socket) => {
      if (await this.options.policy.allowsRequest(socket.url())) socket.connectToServer();
      else await socket.close({ code: 1008, reason: "blocked" });
    });
    context.on("page", (page) => this.adoptPopup(page));
    context.on("close", () => this.forget(context));
    this.spare = context.pages()[0];
    this.context = context;
    this.options.log.info({ profile: this.options.profileDir }, "navegador compartilhado aberto");
    this.publishSoon();
    return context;
  }

  /** O Chromium fechou (ociosidade, queda ou desligamento): tudo some. */
  private forget(context: BrowserContext): void {
    if (this.context !== context) return;
    this.context = undefined;
    this.spare = undefined;
    for (const tabId of this.tabs.keys()) this.endScreencast(tabId);
    this.tabs.clear();
    this.current.clear();
    this.publishSoon();
  }

  /** Uso agora: recomeça a contagem da ociosidade. */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.options.idleMs <= 0 || this.closed) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      // Com o painel aberto assistindo, não fecha (o usuário pode estar fazendo login).
      if (this.viewers > 0) return this.touch();
      if (!this.context) return;
      this.options.log.info("navegador compartilhado fechado por ociosidade");
      void this.context.close().catch(() => undefined);
    }, this.options.idleMs);
    this.idleTimer.unref();
  }

  /** Fecha o Chromium (server desligando ou workspace saindo). */
  async close(): Promise<void> {
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.publishTimer) clearTimeout(this.publishTimer);
    const context = this.context ?? (await this.starting?.catch(() => undefined));
    await context?.close().catch(() => undefined);
  }

  // ---------- Abas ----------

  private describe(tab: Tab): BrowserTab {
    const url = tab.page.url();
    return {
      id: tab.id,
      owner: tab.owner,
      ownerName: tab.owner === BROWSER_USER_OWNER ? "Você" : this.options.ownerName(tab.owner),
      url,
      title: this.titles.get(tab.id) || (url === "about:blank" ? "Nova aba" : ""),
      openedAt: tab.openedAt,
      lastActiveAt: tab.lastActiveAt,
    };
  }

  private readonly titles = new Map<string, string>();

  /** Avisa a interface (com um respiro: uma navegação dispara vários eventos). */
  private publishSoon(): void {
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      void this.refreshTitles().then(() => this.options.publish({ type: "browser:tabs", browser: this.state() }));
    }, 150);
    this.publishTimer.unref();
  }

  private async refreshTitles(): Promise<void> {
    await Promise.all(
      [...this.tabs.values()].map(async (tab) => {
        this.titles.set(tab.id, await tab.page.title().catch(() => ""));
      }),
    );
  }

  private ownedCount(owner: string): number {
    return [...this.tabs.values()].filter((tab) => tab.owner === owner).length;
  }

  private register(owner: string, page: Page): Tab {
    const at = this.options.now().toISOString();
    const tab: Tab = { id: `t${++this.tabSeq}`, owner, page, openedAt: at, lastActiveAt: at };
    this.tabs.set(tab.id, tab);
    this.current.set(owner, tab.id);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.publishSoon();
    });
    page.on("load", () => this.publishSoon());
    page.on("crash", () => {
      let url = "";
      try {
        url = page.url();
      } catch {
        // A página já morreu: sem URL.
      }
      this.options.log.warn({ tab: tab.id, owner, url }, "browser tab crashed (page out of memory?)");
      this.note("warn", "tab_crash", owner, { durationMs: Date.now() - Date.parse(tab.openedAt), data: { tab: tab.id, host: url ? browserHostLabel(url) : undefined } });
      this.crashed.set(
        tab.id,
        `Tab "${tab.id}" crashed (the page ran out of memory, usually after scrolling a long feed) and was closed. Reopen it with browser_open${url ? `("${url}")` : ""}; avoid scrolling much further than needed, and close tabs you no longer use.`,
      );
      this.crashed.set(`owner:${owner}`, this.crashed.get(tab.id)!);
      while (this.crashed.size > 50) this.crashed.delete(this.crashed.keys().next().value!);
      void page.close().catch(() => undefined);
    });
    page.on("close", () => {
      if (this.tabs.get(tab.id)?.page !== page) return;
      this.tabs.delete(tab.id);
      this.titles.delete(tab.id);
      if (this.current.get(owner) === tab.id) {
        const next = [...this.tabs.values()].reverse().find((candidate) => candidate.owner === owner);
        if (next) this.current.set(owner, next.id);
        else this.current.delete(owner);
      }
      this.endScreencast(tab.id);
      this.publishSoon();
    });
    this.publishSoon();
    return tab;
  }

  /** Aba aberta pela própria página (link com target=_blank, pop-up): do mesmo dono da que abriu. */
  private adoptPopup(page: Page): void {
    void (async () => {
      const opener = await page.opener().catch(() => null);
      const parent = opener ? [...this.tabs.values()].find((tab) => tab.page === opener) : undefined;
      if (!parent || [...this.tabs.values()].some((tab) => tab.page === page)) return;
      if (this.ownedCount(parent.owner) >= this.limits.tabsPerOwner || this.tabs.size >= this.limits.tabsTotal) {
        await page.close().catch(() => undefined);
        return;
      }
      this.register(parent.owner, page);
    })();
  }

  private async newTab(owner: string): Promise<Tab> {
    const context = await this.ensure();
    if (this.ownedCount(owner) >= this.limits.tabsPerOwner) {
      throw new BrowserError(`Tab limit reached (${this.limits.tabsPerOwner} per agent). Close one with browser_close_tab or reuse a tab (new_tab: false).`);
    }
    if (this.tabs.size >= this.limits.tabsTotal) throw new BrowserError(`The office browser is full (${this.limits.tabsTotal} tabs). Close one of your tabs first.`);
    const spare = this.spare && !this.spare.isClosed() ? this.spare : undefined;
    this.spare = undefined;
    return this.register(owner, spare ?? (await context.newPage()));
  }

  /** A aba que o dono usa: a pedida (precisa ser dele, menos para o usuário) ou a atual dele. */
  private tab(owner: string, tabId?: string): Tab {
    const id = tabId?.trim() || this.current.get(owner);
    const tab = id ? this.tabs.get(id) : undefined;
    if (!tab) {
      const key = id ?? `owner:${owner}`;
      const crash = this.crashed.get(key);
      if (crash) {
        this.crashed.delete(`owner:${owner}`);
        throw new BrowserError(crash);
      }
      throw new BrowserError(id ? `Tab "${id}" does not exist (anymore). See your tabs with browser_tabs or open one with browser_open.` : "You have no open tab. Open a page with browser_open(url).");
    }
    if (owner !== BROWSER_USER_OWNER && tab.owner !== owner) throw new BrowserError(`Tab "${tab.id}" belongs to someone else. Use your own tabs (browser_tabs) or open one with browser_open.`);
    tab.lastActiveAt = this.options.now().toISOString();
    this.current.set(owner, tab.id);
    this.touch();
    return tab;
  }

  /** Abas do dono (texto para o modelo). */
  listFor(owner: string): string {
    const mine = [...this.tabs.values()].filter((tab) => tab.owner === owner);
    const others = this.tabs.size - mine.length;
    if (mine.length === 0) return `You have no open tabs.${others ? ` (${others} tab(s) of others are open.)` : ""} Open one with browser_open(url).`;
    const current = this.current.get(owner);
    return [
      `Your tabs (${mine.length}/${this.limits.tabsPerOwner}):`,
      ...mine.map((tab) => `- ${tab.id}${tab.id === current ? " (current)" : ""}: ${this.titles.get(tab.id) || "(no title)"} · ${tab.page.url()}`),
      others ? `(${others} tab(s) of others are open; you cannot use them.)` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  // ---------- Ações dos agentes (e do usuário) ----------

  private activity(owner: string, tab: Tab, label: string): void {
    if (owner === BROWSER_USER_OWNER) return;
    this.options.publish({ type: "browser:activity", activity: { agentId: owner, tabId: tab.id, label, at: this.options.now().toISOString() } });
  }

  private async settle(page: Page): Promise<void> {
    await page.waitForTimeout(350).catch(() => undefined);
    await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
  }

  private async goto(tab: Tab, url: string): Promise<void> {
    const verdict = await this.options.policy.check(url);
    if (!verdict.ok) throw new BrowserError(verdict.reason);
    try {
      await tab.page.goto(verdict.url.href, { waitUntil: "domcontentloaded" });
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
      const blocked = /ERR_BLOCKED_BY_CLIENT/.test(message);
      if (blocked) throw new BrowserError("That address is blocked for the office browser (local network or blocked site).");
      if (/ERR_ABORTED/.test(message) && tab.page.url() !== "about:blank") return; // navegação trocada no meio (redirecionamento do próprio site)
      throw new BrowserError(`Could not open ${verdict.url.href}: ${message.replace(/^page\.goto:\s*/, "")}`);
    }
    await tab.page.waitForLoadState("load", { timeout: 6000 }).catch(() => undefined);
  }

  /** Cabeçalho + snapshot da página (o que volta para o modelo depois de cada ação). */
  async snapshot(owner: string, tabId?: string, part = 1, maxChars = SNAPSHOT_MAX_CHARS): Promise<string> {
    await this.ensure();
    const tab = this.tab(owner, tabId);
    const raw = await tab.page.ariaSnapshot({ mode: "ai", timeout: 10_000 }).catch((error: unknown) => {
      throw new BrowserError(`Could not read the page: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    });
    const title = await tab.page.title().catch(() => "");
    if (title) this.titles.set(tab.id, title);
    return [`Tab ${tab.id} · ${title || "(no title)"} · ${tab.page.url()}`, UNTRUSTED_NOTE, compactSnapshot(raw, maxChars, part)].join("\n");
  }

  async open(owner: string, url: string, newTab = false): Promise<string> {
    const verdict = await this.options.policy.check(url);
    if (!verdict.ok) throw new BrowserError(verdict.reason);
    await this.ensure();
    const existing = this.current.get(owner);
    const tab = newTab || !existing || !this.tabs.has(existing) ? await this.newTab(owner) : this.tab(owner, existing);
    await this.goto(tab, verdict.url.href);
    this.activity(owner, tab, `Abriu ${browserHostLabel(tab.page.url())}`);
    this.publishSoon();
    return this.snapshot(owner, tab.id);
  }

  /** Concede a repetição de uma ação que o usuário aprovou (vale uma vez, por 15 min). */
  grant(key: string): void {
    this.pending.delete(key);
    this.passes.set(key, Date.now() + PASS_TTL_MS);
  }

  /** O pedido de aprovação não foi aberto (ex.: sem tarefa): pode pedir de novo. */
  release(key: string): void {
    this.pending.delete(key);
  }

  /**
   * Ação sensível: precisa de aprovação (devolve o pedido) ou já foi aprovada (consome a
   * liberação). null = segue. Com a aprovação desligada no workspace, segue e só registra.
   */
  private gate(owner: string, tab: Tab, action: SensitiveAction, reason: string | null, verb: string): BrowserActionResult | null {
    if (!reason || owner === BROWSER_USER_OWNER) return null;
    const host = browserHostLabel(tab.page.url());
    const executed = (via: "aprovacao" | "rotina" | "automatico" | "livre", routineId?: string, usage?: string) => {
      try {
        this.options.onExecuted?.({ owner, host, label: action.target.label, actionKind: action.kind, via, ...(routineId ? { routineId } : {}), ...(usage ? { usage } : {}), ...pageUrl(tab.page.url()) });
      } catch (error) {
        this.options.log.warn({ err: error }, "falha ao registrar a execução da ação sensível");
      }
    };
    if (!this.options.approvalsRequired()) {
      executed("livre");
      return null;
    }
    const key = [owner, tab.id, action.kind, host, action.target.label.toLowerCase()].join("|");
    const pass = this.passes.get(key);
    if (pass !== undefined && pass > Date.now()) {
      this.passes.delete(key);
      executed("aprovacao");
      return null;
    }
    // Rotina "sem OK" do usuário: libera só o clique da lista do tipo dela, no site dela e dentro do teto diário.
    let grant: ReturnType<NonNullable<BrowserServiceOptions["routineGrant"]>> = null;
    try {
      grant = this.options.routineGrant?.(owner, host, action.target.label, action.kind) ?? null;
    } catch (error) {
      this.options.log.warn({ err: error }, "falha ao consultar a permissão da rotina (segue pedindo aprovação)");
    }
    if (grant?.allowed) {
      executed("rotina", grant.routineId);
      return null;
    }
    // Modo Automático do projeto (mesma ideia, por tipo de ação, site e teto do dia).
    let auto: ReturnType<NonNullable<BrowserServiceOptions["autoGrant"]>> = null;
    try {
      auto = this.options.autoGrant?.(owner, host, action.target.label, action.kind) ?? null;
    } catch (error) {
      this.options.log.warn({ err: error }, "falha ao consultar o Modo Automático (segue pedindo aprovação)");
    }
    if (auto?.allowed) {
      executed("automatico", undefined, auto.usage);
      return null;
    }
    const question = `Navegador: ${this.options.ownerName(owner)} quer ${verb} em ${host} (${reason}). Pode?`;
    const until = this.pending.get(key);
    if (until !== undefined && until > Date.now()) return { status: "needs_approval", key, question, reason: "already_pending" };
    this.pending.set(key, Date.now() + PASS_TTL_MS);
    return { status: "needs_approval", key, question, reason };
  }

  /**
   * O elemento: um ref do snapshot ("e12") ou um seletor CSS achado no HTML, no formato
   * `css=<seletor>` com `>> nth=<n>` opcional (veja browserElement). Só CSS: nada de outros motores
   * do Playwright (xpath, text, internal…) nem encadeamentos.
   */
  private ref(tab: Tab, ref: string): Locator {
    const css = parseCssTarget(ref);
    if (css) return tab.page.locator(`css=${css.selector}`).nth(css.nth);
    const clean = ref.trim().replace(/^\[?ref=/, "").replace(/\]$/, "");
    if (!/^[a-z]*\d+(?:[a-z]+\d+)*$/i.test(clean)) throw new BrowserError(`Invalid ref "${ref}". Use a ref from the last browser_snapshot (e.g. "e12").`);
    return tab.page.getByRef(clean);
  }

  private async target(locator: Locator, ref: string) {
    try {
      return await locator.evaluate(readTarget, undefined, { timeout: 4000 });
    } catch {
      throw new BrowserError(notFound(ref));
    }
  }

  private async loggedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (!/^https?:/.test(url)) return false;
    return looksLoggedIn(await page.context().cookies(url).catch(() => []));
  }

  async click(owner: string, ref: string, tabId?: string): Promise<BrowserActionResult> {
    await this.ensure();
    const tab = this.tab(owner, tabId);
    const locator = this.ref(tab, ref);
    const target = await this.target(locator, ref);
    const action: SensitiveAction = { kind: "click", target };
    const reason = sensitiveReason(action, await this.loggedIn(tab.page));
    const name = target.label ? `“${target.label}”` : `o elemento ${ref}`;
    const gate = this.gate(owner, tab, action, reason, `clicar em ${name}`);
    if (gate) return gate;
    await this.clearCopied(tab.page);
    await locator.click({ timeout: ACTION_TIMEOUT_MS }).catch((error: unknown) => {
      throw new BrowserError(`Could not click ${ref}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}. Take a new browser_snapshot.`);
    });
    await this.settle(tab.page);
    this.activity(owner, tab, `Clicou em ${name}${reason ? " (sem aprovação)" : ""}`);
    return { status: "done", text: await this.withCopied(tab.page, await this.snapshot(owner, tab.id)) };
  }

  async type(owner: string, ref: string, text: string, submit: boolean, tabId?: string): Promise<BrowserActionResult> {
    await this.ensure();
    const tab = this.tab(owner, tabId);
    const locator = this.ref(tab, ref);
    const target = await this.target(locator, ref);
    const action: SensitiveAction = { kind: "submit", target };
    const reason = submit ? sensitiveReason(action, await this.loggedIn(tab.page)) : null;
    const name = target.label ? `“${target.label}”` : ref;
    const gate = this.gate(owner, tab, action, reason, `digitar e enviar em ${name}`);
    if (gate) return gate;
    try {
      await locator.fill(text, { timeout: ACTION_TIMEOUT_MS });
    } catch {
      // Campo que não aceita `fill` (editor próprio do site): clica e digita tecla a tecla.
      await locator.click({ timeout: ACTION_TIMEOUT_MS }).catch(() => undefined);
      await tab.page.keyboard.type(text, { delay: 10 }).catch((error: unknown) => {
        throw new BrowserError(`Could not type into ${ref}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      });
    }
    if (submit) {
      await locator.press("Enter", { timeout: ACTION_TIMEOUT_MS }).catch(() => tab.page.keyboard.press("Enter"));
      await this.settle(tab.page);
    }
    this.activity(owner, tab, submit ? `Digitou e enviou em ${name}${reason ? " (sem aprovação)" : ""}` : `Digitou em ${name}`);
    return { status: "done", text: await this.snapshot(owner, tab.id) };
  }

  /**
   * Anexa arquivos da biblioteca de mídia a um campo de arquivo da página (`setInputFiles`). Só recebe
   * o que o servidor já leu da biblioteca: nunca um caminho qualquer. Anexar não publica nada: o clique
   * em "Publicar" continua passando pela aprovação.
   */
  async upload(owner: string, ref: string, files: { name: string; mimeType: string; path: string; buffer?: Buffer }[], tabId?: string): Promise<string> {
    await this.ensure();
    const tab = this.tab(owner, tabId);
    const locator = this.ref(tab, ref);
    const isFileInput = await locator.evaluate((el: { tagName: string; type?: string }) => el.tagName === "INPUT" && el.type === "file", undefined, { timeout: 4000 }).catch(() => {
      throw new BrowserError(notFound(ref));
    });
    if (!isFileInput) throw new BrowserError(`${ref} is not a file input. Click the page's "add photo/file" button first so the input appears, then target the <input type=file> (e.g. selector "input[type=file]").`);
    // Arquivo pequeno vai da memória com o nome original; o grande (vídeo) vai pelo caminho, sem copiar.
    const payload = files.map((file) => (file.buffer ? { name: file.name, mimeType: file.mimeType, buffer: file.buffer } : file.path));
    await locator.setInputFiles(payload as never, { timeout: ACTION_TIMEOUT_MS }).catch((error: unknown) => {
      throw new BrowserError(`Could not attach the file(s) to ${ref}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    });
    await this.settle(tab.page);
    this.activity(owner, tab, `Anexou ${files.length} arquivo(s) da biblioteca`);
    return await this.snapshot(owner, tab.id);
  }

  /** Renderiza HTML em imagem num contexto isolado (sem o perfil do workspace), com a mesma política de rede. */
  renderHtml(input: RenderInput): Promise<Buffer> {
    return renderHtml(input, this.options.policy, this.options.renderLauncher);
  }

  async press(owner: string, key: string, tabId?: string): Promise<BrowserActionResult> {
    await this.ensure();
    const tab = this.tab(owner, tabId);
    let reason: string | null = null;
    let action: SensitiveAction | undefined;
    if (/^(enter|numpadenter|(control|meta)\+enter)$/i.test(key.trim())) {
      const target = await tab.page.evaluate(readFocused).catch(() => readTargetFallback());
      action = { kind: "submit", target };
      reason = sensitiveReason(action, await this.loggedIn(tab.page));
    }
    if (action) {
      const gate = this.gate(owner, tab, action, reason, `apertar ${key}${action.target.label ? ` em “${action.target.label}”` : ""}`);
      if (gate) return gate;
    }
    await this.clearCopied(tab.page);
    await tab.page.keyboard.press(key.trim()).catch((error: unknown) => {
      throw new BrowserError(`Unknown key "${key}" (use names like Enter, Tab, Escape, ArrowDown, PageDown, Control+A): ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    });
    await this.settle(tab.page);
    this.activity(owner, tab, `Apertou ${key}${reason ? " (sem aprovação)" : ""}`);
    return { status: "done", text: await this.withCopied(tab.page, await this.snapshot(owner, tab.id)) };
  }

  /**
   * A URL da aba agora (sem snapshot: rápido e barato). Inclui o endereço canônico que a página
   * declara (<link rel="canonical">), quando é outro — costuma ser o link "limpo" para compartilhar.
   */
  async currentUrl(owner: string, tabId?: string): Promise<string> {
    await this.ensure();
    const tab = this.tab(owner, tabId);
    const url = tab.page.url();
    const title = await tab.page.title().catch(() => "");
    if (title) this.titles.set(tab.id, title);
    const canonical = await tab.page
      .evaluate(`(() => { const el = document.querySelector('link[rel="canonical"]'); try { return el ? new URL(el.getAttribute("href"), document.baseURI).href : null; } catch { return null; } })()`)
      .catch(() => null);
    const lines = [`Tab ${tab.id} · ${title || "(no title)"}`, `URL: ${url}`];
    if (typeof canonical === "string" && /^https?:/.test(canonical) && canonical !== url) lines.push(`Canonical URL (declared by the page): ${canonical}`);
    return lines.join("\n");
  }

  /**
   * Links de um elemento que o snapshot não mostra inteiros: o href completo, os links dentro dele
   * (ex.: um post inteiro), os identificadores em volta (qualquer site) e o permalink das receitas
   * do site (ex.: post do LinkedIn pelo urn no contêiner).
   */
  async links(owner: string, ref: string, tabId?: string): Promise<string> {
    await this.ensure();
    const tab = this.tab(owner, tabId);
    const locator = this.ref(tab, ref);
    const recipes = recipesFor(tab.page.url(), this.options.linkRecipes);
    let links;
    try {
      links = await locator.evaluate(readLinks, recipes.map((recipe) => recipe.pattern), { timeout: 4000 });
    } catch {
      throw new BrowserError(notFound(ref));
    }
    this.activity(owner, tab, `Pegou um link em ${browserHostLabel(tab.page.url())}`);
    return [`Tab ${tab.id} · ${tab.page.url()}`, UNTRUSTED_NOTE, describeLinks(ref, links, tab.page.url(), recipes)].join("\n");
  }

  /** Elementos que casam com um seletor CSS (só leitura): posição, atributos principais e texto. */
  async find(owner: string, selector: string, limit = FIND_DEFAULT_LIMIT, tabId?: string): Promise<string> {
    await this.ensure();
    const tab = this.tab(owner, tabId);
    const clean = selector.trim();
    if (!clean || clean.includes(">>") || clean.length > 500) throw new BrowserError(`Invalid selector "${clean.slice(0, 80)}". Use a plain CSS selector.`);
    const max = Math.min(Math.max(1, Math.floor(limit)), FIND_MAX_LIMIT);
    const result = await tab.page.evaluate(findElements, [clean, max] as [string, number]).catch((error: unknown) => {
      throw new BrowserError(`Could not search the page: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    });
    this.activity(owner, tab, `Procurou elementos em ${browserHostLabel(tab.page.url())}`);
    return [`Tab ${tab.id} · ${tab.page.url()}`, UNTRUSTED_NOTE, describeFind(clean, result)].join("\n");
  }

  /** HTML enxuto de um elemento, com todos os atributos (só leitura; veja inspect.ts). */
  async inspect(owner: string, ref: string, options: { depth?: number; maxChars?: number } = {}, tabId?: string): Promise<string> {
    await this.ensure();
    const tab = this.tab(owner, tabId);
    const locator = this.ref(tab, ref);
    const resolved = {
      depth: Math.min(Math.max(1, Math.floor(options.depth ?? INSPECT_DEFAULT_DEPTH)), INSPECT_MAX_DEPTH),
      maxChars: Math.min(Math.max(500, Math.floor(options.maxChars ?? INSPECT_DEFAULT_CHARS)), INSPECT_MAX_CHARS),
    };
    let result;
    try {
      result = await locator.evaluate(inspectElement, resolved, { timeout: 4000 });
    } catch {
      throw new BrowserError(notFound(ref));
    }
    this.activity(owner, tab, `Inspecionou um elemento em ${browserHostLabel(tab.page.url())}`);
    return [`Tab ${tab.id} · ${tab.page.url()}`, UNTRUSTED_NOTE, describeInspect(ref, result, resolved)].join("\n");
  }

  private async clearCopied(page: Page): Promise<void> {
    await page.evaluate(CLEAR_COPIED_SOURCE).catch(() => undefined);
  }

  /** Acrescenta ao resultado o que a página copiou na ação (ex.: "Copiar link"). */
  private async withCopied(page: Page, text: string): Promise<string> {
    const copied = await page.evaluate(TAKE_COPIED_SOURCE).catch(() => null);
    if (typeof copied !== "string" || !copied.trim()) return text;
    return `The page copied this to the clipboard (untrusted page data): ${copied.trim()}\n\n${text}`;
  }

  async scroll(owner: string, direction: "up" | "down", amount: number | undefined, tabId?: string): Promise<string> {
    await this.ensure();
    const tab = this.tab(owner, tabId);
    const pixels = Math.round((amount ?? 0.8) * BROWSER_VIEWPORT.height) * (direction === "up" ? -1 : 1);
    await tab.page.mouse.move(BROWSER_VIEWPORT.width / 2, BROWSER_VIEWPORT.height / 2).catch(() => undefined);
    await tab.page.mouse.wheel(0, pixels);
    await tab.page.waitForTimeout(400).catch(() => undefined);
    this.activity(owner, tab, direction === "up" ? "Rolou a página para cima" : "Rolou a página");
    return this.snapshot(owner, tab.id);
  }

  async back(owner: string, tabId?: string): Promise<string> {
    await this.ensure();
    const tab = this.tab(owner, tabId);
    const response = await tab.page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
    if (response === undefined) throw new BrowserError("Could not go back");
    this.activity(owner, tab, "Voltou uma página");
    return this.snapshot(owner, tab.id);
  }

  async screenshot(owner: string, tabId?: string, ref?: string): Promise<{ data: Buffer; caption: string }> {
    await this.ensure();
    const tab = this.tab(owner, tabId);
    // Com ref: só aquele elemento (ex.: um post), rolado até aparecer.
    const data = ref
      ? await this.ref(tab, ref)
          .screenshot({ type: "jpeg", quality: 75, timeout: 10_000 })
          .catch((error: unknown) => {
            throw new BrowserError(`Could not capture ${ref}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}. Take a new browser_snapshot.`);
          })
      : await tab.page.screenshot({ type: "jpeg", quality: 70, timeout: 10_000 });
    this.activity(owner, tab, `Olhou a tela de ${browserHostLabel(tab.page.url())}`);
    return { data, caption: `Tab ${tab.id} · ${await tab.page.title().catch(() => "")} · ${tab.page.url()}` };
  }

  async closeTab(owner: string, tabId: string): Promise<string> {
    const tab = this.tab(owner, tabId);
    await tab.page.close().catch(() => undefined);
    this.activity(owner, tab, "Fechou uma aba");
    return `Tab ${tab.id} closed.`;
  }

  /** Fecha as abas de um agente (removido do workspace). */
  async closeOwner(owner: string): Promise<void> {
    await Promise.all([...this.tabs.values()].filter((tab) => tab.owner === owner).map((tab) => tab.page.close().catch(() => undefined)));
  }

  // ---------- Painel do usuário (tela ao vivo e controle remoto) ----------

  /** Vai para a página inicial se (e só se) a aba está em about:blank; falha (política, rede) deixa em branco. */
  private async goHome(tab: Tab): Promise<void> {
    const home = this.options.homeUrl ?? DEFAULT_HOME_URL;
    if (!home || tab.page.url() !== "about:blank") return;
    await this.goto(tab, home).catch(() => undefined);
  }

  /** O usuário abre uma aba (sem endereço: a página inicial, google.com). */
  async userOpen(url?: string): Promise<BrowserTab> {
    if (url?.trim()) {
      const verdict = await this.options.policy.check(url);
      if (!verdict.ok) throw new BrowserError(verdict.reason);
    }
    const tab = await this.newTab(BROWSER_USER_OWNER);
    if (url?.trim()) await this.goto(tab, url);
    else await this.goHome(tab);
    await this.refreshTitles();
    return this.describe(tab);
  }

  async userClose(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new BrowserError(`A aba "${tabId}" não existe mais`);
    await tab.page.close().catch(() => undefined);
  }

  /** Uma ação do usuário no painel (clique, rolagem, digitação, endereço, voltar…). */
  async userInput(tabId: string, message: Exclude<BrowserClientMessage, { t: "watch" }>): Promise<void> {
    const tab = this.tab(BROWSER_USER_OWNER, tabId);
    const { page } = tab;
    const { width, height } = page.viewportSize() ?? BROWSER_VIEWPORT;
    switch (message.t) {
      case "click":
        await page.mouse.click(message.x * width, message.y * height, { button: message.button ?? "left", clickCount: message.double ? 2 : 1 });
        return;
      case "wheel":
        await page.mouse.move(message.x * width, message.y * height);
        await page.mouse.wheel(message.dx, message.dy);
        return;
      case "type":
        await page.keyboard.type(message.text);
        return;
      case "key":
        await page.keyboard.press(message.key);
        return;
      case "navigate":
        await this.goto(tab, message.url);
        return;
      case "back":
        await page.goBack({ timeout: 15_000 }).catch(() => undefined);
        return;
      case "forward":
        await page.goForward({ timeout: 15_000 }).catch(() => undefined);
        return;
      case "reload":
        await page.reload({ timeout: 15_000 }).catch(() => undefined);
        return;
    }
  }

  /** Painel aberto assistindo (enquanto houver, o Chromium não fecha por ociosidade). */
  viewerJoined(): () => void {
    this.viewers += 1;
    this.touch();
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.viewers = Math.max(0, this.viewers - 1);
      this.touch();
    };
  }

  /**
   * Tela ao vivo de uma aba (CDP screencast): `onFrame` a cada quadro novo, `onGone` se a aba fechar.
   * Devolve quem para de assistir. Uma sessão por aba, dividida entre os painéis.
   */
  async watch(tabId: string, onFrame: (frame: BrowserFrame) => void, onGone: () => void): Promise<() => void> {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new BrowserError(`A aba "${tabId}" não existe mais`);
    let cast = this.screencasts.get(tabId);
    if (!cast) {
      const session = await tab.page.context().newCDPSession(tab.page);
      const created: Screencast = { session, listeners: new Set(), gone: new Set() };
      cast = created;
      this.screencasts.set(tabId, created);
      session.on("Page.screencastFrame", (frame) => {
        void session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
        const out: BrowserFrame = { tab: tabId, data: frame.data, width: frame.metadata.deviceWidth ?? BROWSER_VIEWPORT.width, height: frame.metadata.deviceHeight ?? BROWSER_VIEWPORT.height };
        for (const listener of created.listeners) listener(out);
      });
      try {
        await session.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: BROWSER_VIEWPORT.width, maxHeight: BROWSER_VIEWPORT.height, everyNthFrame: 1 });
      } catch (error) {
        // Sem isto a sessão morta ficava no mapa e ninguém mais recebia quadros desta aba.
        if (this.screencasts.get(tabId) === created) this.screencasts.delete(tabId);
        void session.detach().catch(() => undefined);
        throw error;
      }
    }
    // Aba do usuário ainda em branco: começa na página inicial (nunca mexe numa aba de agente).
    if (tab.owner === BROWSER_USER_OWNER) void this.goHome(tab);
    const current = cast;
    current.listeners.add(onFrame);
    current.gone.add(onGone);
    // Primeiro quadro na hora (o screencast só manda quando a tela muda).
    void tab.page
      .screenshot({ type: "jpeg", quality: 60, timeout: 5000 })
      .then((buffer) => {
        if (current.listeners.has(onFrame)) onFrame({ tab: tabId, data: buffer.toString("base64"), width: BROWSER_VIEWPORT.width, height: BROWSER_VIEWPORT.height });
      })
      .catch(() => undefined);
    return () => {
      current.listeners.delete(onFrame);
      current.gone.delete(onGone);
      if (current.listeners.size === 0 && this.screencasts.get(tabId) === current) {
        this.screencasts.delete(tabId);
        void current.session.send("Page.stopScreencast").catch(() => undefined);
        void current.session.detach().catch(() => undefined);
      }
    };
  }

  private endScreencast(tabId: string): void {
    const cast = this.screencasts.get(tabId);
    if (!cast) return;
    this.screencasts.delete(tabId);
    for (const gone of cast.gone) gone();
    void cast.session.detach().catch(() => undefined);
  }
}

function readTargetFallback() {
  return { label: "", button: false, link: false, submits: false, searchForm: false, freeText: false };
}

export { BrowserError };

/** Endereço da página sem consulta nem âncora (pode levar token), para a Atividade. */
function pageUrl(raw: string): { url?: string } {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return {};
    return { url: `${url.origin}${url.pathname}` };
  } catch {
    return {};
  }
}
