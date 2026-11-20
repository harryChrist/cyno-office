import { create } from "zustand";

/** Desenhos de botões da barra (ficam em hud/pageIcons.tsx). */
export type PageIconName = "brain";

/**
 * Páginas de cada workspace (o id vai no endereço: `#/<workspace>/trabalho`, então recarregar mantém a página).
 * O menu tem seis páginas: Cyno · Início, Escritório, Projetos e tarefas, Aprovações, Gestão e Biblioteca (os ids de rota não mudam). Gastos e Atividade são
 * abas da Gestão (`#/<ws>/gestao/gastos`); Mídia e Cérebro, abas da Biblioteca (`#/biblioteca/midia/<ws>`).
 */
export const PAGES = [
  { id: "office", label: "Escritório" },
  { id: "trabalho", label: "Projetos e tarefas" },
  { id: "para-voce", label: "Aprovações" },
  // O Quadro (`#/<ws>/quadro[/<id>]`): os dados que os agentes montam para o dono olhar; fica logo antes da Gestão.
  { id: "quadro", label: "Quadro" },
  { id: "gestao", label: "Gestão" },
] as const;
/** Páginas que não viram item da lista de workspace (botão, atalho ou página do app inteiro). */
export const EXTRA_PAGES = [
  { id: "configuracoes", label: "Configurações" },
  // O Cyno, o agente da plataforma, vive fora dos workspaces (endereço `#/cyno`, item no topo da barra lateral).
  { id: "cyno", label: "Cyno · Início" },
  // "Sua agenda": o tempo do dono, uma só para a plataforma (`#/agenda`, `#/agenda/<ws>` já filtrada). Atalho da barra e da página do Cyno.
  { id: "agenda", label: "Sua agenda" },
  // A Biblioteca da plataforma (`#/biblioteca/<aba>`): Apps, Conectores, Skills, Mídia e Cérebro.
  { id: "biblioteca", label: "Biblioteca" },
  // O navegador do workspace: atalho (botão no Office e no rodapé da barra), sem item de menu.
  { id: "navegador", label: "Navegador dos agentes" },
  // Os scripts que os agentes rodam (`#/<ws>/scripts[/<id>]`): atalho da barra e dos painéis dos agentes, sem item de menu.
  { id: "scripts", label: "Scripts dos agentes" },
  // Os arquivos das pastas do workspace, só leitura (`#/<ws>/arquivos[/<raiz>/<caminho>]`): item do grupo Trabalho, depois do Quadro.
  { id: "arquivos", label: "Arquivos" },
] as const;
export type PageId = (typeof PAGES)[number]["id"] | (typeof EXTRA_PAGES)[number]["id"];

/** Páginas do app inteiro: o endereço não leva workspace (`#/cyno`), mas o workspace atual continua lembrado. */
export const APP_WIDE_PAGES: readonly PageId[] = ["cyno", "agenda", "biblioteca"];

/** Nome de uma página (título da barra do celular, rótulos da barra lateral). */
export function pageLabel(id: PageId): string {
  return [...PAGES, ...EXTRA_PAGES].find((page) => page.id === id)?.label ?? "Escritório";
}

const IDS = new Set<string>([...PAGES, ...EXTRA_PAGES].map((page) => page.id));
const isPage = (id: string): id is PageId => IDS.has(id);

// ---------- Endereços antigos ----------

/**
 * Rotas que já existiram e para onde cada uma vai (o mapa único dos redirecionamentos; `ws` = o workspace
 * do endereço antigo, se havia). Ninguém com link salvo fica de fora.
 *  `#/<ws>/midia`                      -> `#/biblioteca/midia/<ws>`
 *  `#/<ws>/cerebro[/<cérebro>/<nota>]` -> `#/biblioteca/cerebro/<ws>[/<cérebro>/<nota>]`
 *  `#/<ws>/gastos`                     -> `#/<ws>/gestao/gastos`
 *  `#/<ws>/atividade`, `#/<ws>/logs`   -> `#/<ws>/gestao/atividade`  (sem workspace: `#/gestao/atividade`)
 *  `#/<ws>/calendario[/...]`           -> `#/agenda/<ws>`
 *  `#/<ws>/tarefas`                    -> `#/<ws>/trabalho`
 *  `#/[<ws>/]configuracoes/skills`     -> `#/biblioteca/skills[/<ws>]`
 */
export const LEGACY_ROUTES: Readonly<Record<string, (ws: string | null, rest: string[]) => string[]>> = {
  midia: (ws) => ["biblioteca", "midia", ...(ws ? [ws] : [])],
  cerebro: (ws, rest) => ["biblioteca", "cerebro", ...(ws ? [ws, ...rest] : [])],
  gastos: (ws) => [...(ws ? [ws] : []), "gestao", "gastos"],
  atividade: (ws) => [...(ws ? [ws] : []), "gestao", "atividade"],
  logs: (ws) => [...(ws ? [ws] : []), "gestao", "atividade"],
  tarefas: (ws) => [...(ws ? [ws] : []), "trabalho"],
  calendario: (ws) => ["agenda", ...(ws ? [ws] : [])],
};

const safeDecode = (part: string | undefined): string => {
  try {
    return decodeURIComponent(part ?? "");
  } catch {
    return part ?? "";
  }
};

/** O endereço novo de um endereço antigo (`null` = o endereço já é o novo). O `?query` é mantido. */
export function migrateLegacyHash(hash: string): string | null {
  const [path = "", ...query] = hash.split("?");
  const parts = path.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [first = "", second = ""] = [safeDecode(parts[0]), safeDecode(parts[1])];
  let next: string[] | null = null;
  const legacy = (name: string) => Object.hasOwn(LEGACY_ROUTES, name);
  if (legacy(second) && !isPage(first)) next = LEGACY_ROUTES[second]!(parts[0]!, parts.slice(2));
  else if (legacy(first) && !isPage(second)) next = LEGACY_ROUTES[first]!(null, []);
  else if (second === "configuracoes" && safeDecode(parts[2]) === "skills") next = ["biblioteca", "skills", parts[0]!];
  else if (first === "configuracoes" && second === "skills") next = ["biblioteca", "skills"];
  if (!next) return null;
  return `#/${next.join("/")}${query.length > 0 ? `?${query.join("?")}` : ""}`;
}

/** Onde o usuário está: workspace (null = ainda não escolhido), página e, quando a página tem abas, a aba (`gastos`, `midia/<ws>`...). */
export type Location = { workspaceId: string | null; page: PageId; sub?: string };

/** O workspace que a aba da Biblioteca carrega no endereço (`midia/<ws>`, `cerebro/<ws>/...`). */
export function subWorkspace(page: PageId, sub: string | undefined): string | null {
  if (page !== "biblioteca" || !sub) return null;
  const [tab, ws] = sub.split("/");
  return (tab === "midia" || tab === "cerebro") && ws ? safeDecode(ws) : null;
}

/**
 * Lê o endereço `#/<workspace>/<página>[/<aba>]` (ex.: `#/principal/gestao/gastos`). Aceita também o endereço
 * só com a página (`#/trabalho`, `#/biblioteca/skills`): aí o workspace fica null (é o formato
 * de quando não há workspace nenhum). Página desconhecida = Office. Endereços antigos são lidos como os novos.
 */
export function parseHash(hash: string): Location {
  const [pathPart = "", ...queryParts] = (migrateLegacyHash(hash) ?? hash).replace(/^#\/?/, "").split("?");
  const query = queryParts.join("?");
  const raw = pathPart.split("/").filter(Boolean);
  const [first = "", second = ""] = [safeDecode(raw[0]), safeDecode(raw[1])];
  let location: Location;
  if (isPage(first) && !isPage(second)) location = { workspaceId: null, page: first, ...(raw.length > 1 ? { sub: raw.slice(1).join("/") } : {}) };
  else if (isPage(second)) location = { workspaceId: first || null, page: second, ...(raw.length > 2 ? { sub: raw.slice(2).join("/") } : {}) };
  else location = { workspaceId: first || null, page: "office" };
  // Só "Projetos e tarefas" guarda os filtros no endereço (`trabalho/tarefas?sprint=ativa`): o resto ignora o `?`.
  if (location.page === "trabalho" && query) location = { ...location, sub: `${location.sub ?? ""}?${query}` };
  const fromSub = subWorkspace(location.page, location.sub);
  return fromSub ? { ...location, workspaceId: fromSub } : location;
}

/** Página a partir do hash; qualquer outra coisa é o Office. */
export function pageFromHash(hash: string): PageId {
  return parseHash(hash).page;
}

/** Endereço de uma página num workspace. */
export function hashFor(location: Location): string {
  const sub = location.sub ? `/${location.sub}` : "";
  if (APP_WIDE_PAGES.includes(location.page)) return `#/${location.page}${sub}`;
  return location.workspaceId ? `#/${encodeURIComponent(location.workspaceId)}/${location.page}${sub}` : `#/${location.page}${sub}`;
}

/** Último workspace usado (localStorage pode faltar ou falhar: aí só não lembra). */
const LAST_WORKSPACE_KEY = "agent-office:workspace";

export function rememberWorkspace(id: string): void {
  try {
    window.localStorage.setItem(LAST_WORKSPACE_KEY, id);
  } catch {
    // Sem armazenamento: tudo funciona, só não lembra o último workspace.
  }
}

export function lastWorkspace(): string | null {
  try {
    return window.localStorage.getItem(LAST_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

type NavState = Omit<Location, "sub"> & {
  /** A aba da página (`gastos`, `midia/<ws>`...); vazia quando a página não tem abas. */
  sub: string;
  /** Abre uma página (e a aba dela, se tiver). `replace` troca a entrada do histórico em vez de empilhar (redirecionamentos). */
  go: (page: PageId, sub?: string, replace?: boolean) => void;
  /** Troca de workspace (mantém a página). */
  setWorkspace: (workspaceId: string) => void;
  /**
   * Sem workspace (todos excluídos, ou o do endereço não existe mais): o endereço perde o
   * workspace; só as páginas do app inteiro continuam abertas, o resto volta ao Office (o estado vazio).
   */
  clearWorkspace: () => void;
};

/** Endereço vazio (`""`, `#`, `#/`): o app abre na página do Cyno, a página inicial. Os links antigos (`#/<ws>/<página>`) continuam valendo. */
export function isHomeHash(hash: string): boolean {
  return hash.replace(/^#\/?/, "").split("?")[0] === "";
}

function initialLocation(): Location & { sub: string } {
  if (typeof window === "undefined") return { workspaceId: null, page: "office", sub: "" };
  // Sem endereço: a página do Cyno. O último workspace continua lembrado (o seletor e o "Entrar" usam).
  if (isHomeHash(window.location.hash)) return { workspaceId: lastWorkspace(), page: "cyno", sub: "" };
  const migrated = migrateLegacyHash(window.location.hash);
  if (migrated) window.history.replaceState(null, "", migrated);
  const location = parseHash(window.location.hash);
  return { ...location, sub: location.sub ?? "", workspaceId: location.workspaceId ?? lastWorkspace() };
}

/** O que vem depois de `#/<workspace>/<página>` (ex.: a nota aberta no Cérebro). */
export function hashSuffix(hash: string): string {
  const parts = hash.replace(/^#\/?/, "").split("/");
  return parts.length > 2 ? `/${parts.slice(2).join("/")}` : "";
}

function writeHash(location: Location, replace = false): void {
  if (typeof window === "undefined") return;
  const hash = hashFor(location);
  if (window.location.hash === hash) return;
  if (replace) window.history.replaceState(null, "", hash);
  else window.history.pushState(null, "", hash);
}

/** A aba que sobra ao trocar de workspace: a Gestão mantém a aba, a Biblioteca troca o workspace da aba (Mídia, Cérebro), as outras páginas recomeçam. */
export function subForWorkspace(page: PageId, sub: string, workspaceId: string): string {
  if (page === "gestao") return sub;
  if (page === "biblioteca") {
    const [tab = ""] = sub.split("/");
    return tab === "midia" || tab === "cerebro" ? `${tab}/${encodeURIComponent(workspaceId)}` : sub;
  }
  if (page === "agenda") return sub ? encodeURIComponent(workspaceId) : "";
  return "";
}

/** A página do app inteiro que não depende de workspace continua aberta sem ele. */
function staysWithoutWorkspace(page: PageId, sub: string): boolean {
  return page === "configuracoes" || page === "cyno" || page === "agenda" || page === "biblioteca" || (page === "gestao" && sub === "atividade");
}

/** Quem tem trabalho por salvar (a página Arquivos, com edição aberta) pede para a troca de workspace esperar: devolve false para ficar. */
let workspaceGuard: ((next: string) => boolean) | null = null;
export function setWorkspaceGuard(guard: ((next: string) => boolean) | null): void {
  workspaceGuard = guard;
}

export const useNavStore = create<NavState>()((set, get) => ({
  ...initialLocation(),
  go: (page, sub = "", replace = false) => {
    const fromSub = subWorkspace(page, sub);
    const workspaceId = fromSub ?? get().workspaceId;
    writeHash({ workspaceId, page, sub }, replace);
    if (fromSub && typeof window !== "undefined") rememberWorkspace(fromSub);
    set({ page, sub, workspaceId });
  },
  setWorkspace: (workspaceId) => {
    const { page, workspaceId: current } = get();
    if (current !== null && current !== workspaceId && workspaceGuard && !workspaceGuard(workspaceId)) return;
    // Primeira escolha (sem workspace no endereço) só completa o endereço, sem criar histórico,
    // e mantém o resto dele (ex.: a nota aberta no Cérebro, a seção das Configurações).
    const same = current === null || current === workspaceId;
    const live = typeof window === "undefined" ? get().sub : (parseHash(window.location.hash).sub ?? "");
    const sub = same ? live : page === "configuracoes" ? "" : subForWorkspace(page, live, workspaceId);
    writeHash({ workspaceId, page, sub }, same);
    if (typeof window !== "undefined") rememberWorkspace(workspaceId);
    set({ ...(current !== workspaceId ? { workspaceId } : {}), sub });
  },
  clearWorkspace: () => {
    // As páginas do app inteiro (Configurações, Cyno, Agenda, Biblioteca e a Atividade do sistema) continuam abertas.
    const { page: current } = get();
    const liveSub = typeof window === "undefined" ? get().sub : (parseHash(window.location.hash).sub ?? get().sub);
    const keep = staysWithoutWorkspace(current, liveSub);
    const page: PageId = keep ? current : "office";
    // O workspace que a aba Mídia/Cérebro carregava no endereço some junto.
    const sub = keep ? (subWorkspace(current, liveSub) ? liveSub.split("/")[0]! : liveSub) : "";
    writeHash({ workspaceId: null, page, sub }, true);
    set({ workspaceId: null, page, sub });
  },
}));

/** Voltar/avançar do navegador troca de página (e de workspace, se o endereço mudar). */
export function syncNavWithHistory(): () => void {
  const onPop = () => {
    // Voltar até o endereço vazio (a primeira entrada do histórico) é voltar para a página do Cyno.
    // Um endereço antigo digitado na barra (ou colado) troca pelo novo, sem empilhar histórico.
    const migrated = migrateLegacyHash(window.location.hash);
    if (migrated) window.history.replaceState(null, "", migrated);
    const location: Location = isHomeHash(window.location.hash) ? { workspaceId: null, page: "cyno" } : parseHash(window.location.hash);
    const { workspaceId } = useNavStore.getState();
    useNavStore.setState({ page: location.page, sub: location.sub ?? "", workspaceId: location.workspaceId ?? workspaceId });
  };
  window.addEventListener("popstate", onPop);
  window.addEventListener("hashchange", onPop);
  return () => {
    window.removeEventListener("popstate", onPop);
    window.removeEventListener("hashchange", onPop);
  };
}
