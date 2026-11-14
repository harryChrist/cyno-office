import {
  parseConnectorToolName,
  type Connector,
  type ConnectorActivity,
  type ConnectorImportCandidate,
  type CreateConnectorBody,
  type CreateLibraryConnectorBody,
  type LibraryConnector,
  type ServerEvent,
  type UpdateConnectorBody,
  type UpdateLibraryConnectorBody,
} from "@cyno/shared";
import { CONNECTOR_BRANDS, type ConnectorBrand } from "./brands.generated";

/** Conectores do workspace atual; null = ainda não carregados (GET /connectors). */
export type ConnectorList = readonly Connector[] | null;

/** Aplica um evento connector:upserted/deleted (os outros devolvem a mesma lista). Antes do GET, ignora. */
export function applyConnectorEvent(list: ConnectorList, event: ServerEvent): ConnectorList {
  if (list === null) return list;
  if (event.type === "connector:deleted") return list.some((item) => item.id === event.id) ? list.filter((item) => item.id !== event.id) : list;
  if (event.type !== "connector:upserted") return list;
  const index = list.findIndex((item) => item.id === event.connector.id);
  if (index === -1) return [...list, event.connector];
  return list.map((item, i) => (i === index ? event.connector : item));
}

// ---------- Estado ----------

export type StatusTone = "success" | "attention" | "danger" | "neutral";

/** Selo do estado: cor + texto (o texto sempre aparece; a cor nunca é a única pista). */
export function connectorStatus(connector: Pick<Connector, "enabled" | "status">): { tone: StatusTone; label: string; dot: "ok" | "warn" | "error" | "off" } {
  if (!connector.enabled) return { tone: "neutral", label: "Desligado", dot: "off" };
  switch (connector.status.state) {
    case "connected":
      return { tone: "success", label: "Conectado", dot: "ok" };
    case "needs_auth":
      return { tone: "attention", label: "Precisa de login", dot: "warn" };
    case "error":
      return { tone: "danger", label: "Erro", dot: "error" };
    case "disabled":
      return { tone: "neutral", label: "Desligado", dot: "off" };
    default:
      return { tone: "neutral", label: "Não testado", dot: "off" };
  }
}

export function toolsLabel(count: number): string {
  return count === 0 ? "nenhuma ferramenta" : count === 1 ? "1 ferramenta" : `${count} ferramentas`;
}

export const KIND_LABELS: Record<LibraryConnector["kind"], string> = { http: "HTTP", stdio: "Local (stdio)", app: "App" };

// ---------- Ícone ----------

const BRANDS_BY_SLUG = new Map(CONNECTOR_BRANDS.map((brand) => [brand.slug, brand]));

export function brandOf(slug: string): ConnectorBrand | undefined {
  return BRANDS_BY_SLUG.get(slug);
}

/** Cores de fundo para o monograma (escuras o bastante para letra branca). */
export const MONOGRAM_COLORS = ["#6d5cf5", "#1d7a4a", "#c93a52", "#b4690e", "#2563eb", "#0e7490", "#9333ea", "#be185d"] as const;

function hashOf(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash;
}

/** Até duas letras: iniciais de duas palavras, ou as duas primeiras letras. */
export function monogram(name: string): string {
  const words = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}

/** Luminância relativa (WCAG) de #rrggbb. */
export function luminance(hex: string): number {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1];
  if (!value) return 0;
  const channel = (offset: number) => {
    const c = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/**
 * Como desenhar o ícone: azulejo com a cor da marca e o símbolo em branco (ou preto, se a cor for
 * clara). Marcas pretas (GitHub, Notion, X) ficariam sumidas no fundo escuro: ganham um contorno.
 */
export function iconLook(connector: Pick<Connector, "id" | "name" | "icon" | "color">): { background: string; foreground: string; outlined: boolean; text?: string; brand?: ConnectorBrand } {
  const brand = connector.icon.kind === "brand" ? brandOf(connector.icon.slug) : undefined;
  const background = connector.color ?? brand?.hex ?? MONOGRAM_COLORS[hashOf(connector.id) % MONOGRAM_COLORS.length]!;
  const light = luminance(background) > 0.55;
  return {
    background,
    foreground: light ? "#111111" : "#ffffff",
    outlined: luminance(background) < 0.03,
    ...(brand ? { brand } : { text: monogram(connector.name) }),
  };
}

/** Normaliza para comparar nomes: minúsculas, sem acento e sem nada além de letras e números. */
const plain = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/**
 * Marca sugerida para um nome/URL (ex.: importar "claude.ai Google Drive" ou https://mcp.notion.com):
 * nome igual ao da marca, depois o domínio da URL contendo o slug.
 */
export function suggestBrand(name: string, url?: string): ConnectorBrand | undefined {
  const key = plain(name);
  const exact = CONNECTOR_BRANDS.find((brand) => plain(brand.title) === key || brand.slug === key);
  if (exact) return exact;
  if (url) {
    const host = URL.canParse(url) ? new URL(url).hostname.toLowerCase() : "";
    const parts = host.split(".");
    // O nome do domínio (mcp.notion.com → notion); evita "google" ganhar de "googledrive" pegando o mais longo.
    const byHost = [...CONNECTOR_BRANDS].sort((a, b) => b.slug.length - a.slug.length).find((brand) => parts.includes(brand.slug));
    if (byHost) return byHost;
  }
  if (key.length >= 4) return CONNECTOR_BRANDS.find((brand) => key.includes(brand.slug) && brand.slug.length >= 4);
  return undefined;
}

/** Busca de marcas para o seletor de ícone (vazio = todas, na ordem da lista). */
export function searchBrands(query: string): readonly ConnectorBrand[] {
  const key = plain(query);
  if (!key) return CONNECTOR_BRANDS;
  return CONNECTOR_BRANDS.filter((brand) => plain(brand.title).includes(key) || brand.slug.includes(key));
}

// ---------- Agentes e ferramentas ----------

/** Conectores ligados ao agente (ligados e desligados; quem desenha decide). */
export function connectorsOfAgent(list: ConnectorList, agentId: string): Connector[] {
  return (list ?? []).filter((connector) => connector.agentIds.includes(agentId));
}

/** Uma ferramenta do log é de conector? (`mcp__office__notion__create_page` → o conector Notion e "create_page") */
export function connectorForTool(list: ConnectorList, toolName: string): { connector: Connector; tool: string } | null {
  const parsed = parseConnectorToolName(toolName);
  if (!parsed || !list) return null;
  const connector = list.find((item) => item.toolPrefix === parsed.prefix);
  return connector ? { connector, tool: parsed.tool } : null;
}

// ---------- Atividade (pulso e balão) ----------

/** Quanto tempo o ícone pulsa e o balão fica sobre o agente depois de uma chamada (rodando: até terminar, no máximo 5 min). */
export const ACTIVITY_MS = 4000;
export const RUNNING_MAX_MS = 5 * 60_000;

/** `at`: número de ordem da marca (cada evento ganha um novo; serve de chave para reiniciar a animação). */
export type ActivityMark = { connectorId: string; agentId: string; tool: string; at: number; running: boolean };
export type ActivityState = { byConnector: Readonly<Record<string, ActivityMark>>; byAgent: Readonly<Record<string, ActivityMark>> };

/** Guarda a última atividade por conector e por agente. */
export function recordActivity(state: ActivityState, activity: ConnectorActivity, seq: number): { byConnector: Record<string, ActivityMark>; byAgent: Record<string, ActivityMark>; mark: ActivityMark } {
  const mark: ActivityMark = { connectorId: activity.connectorId, agentId: activity.agentId, tool: activity.tool, at: seq, running: activity.phase === "started" };
  return { byConnector: { ...state.byConnector, [activity.connectorId]: mark }, byAgent: { ...state.byAgent, [activity.agentId]: mark }, mark };
}

/** Tira a marca (se ainda for a mesma: outra chamada pode ter chegado depois). */
export function expireActivity(state: ActivityState, mark: ActivityMark): ActivityState {
  const byConnector = state.byConnector[mark.connectorId]?.at === mark.at ? omit(state.byConnector, mark.connectorId) : state.byConnector;
  const byAgent = state.byAgent[mark.agentId]?.at === mark.at ? omit(state.byAgent, mark.agentId) : state.byAgent;
  return byConnector === state.byConnector && byAgent === state.byAgent ? state : { byConnector, byAgent };
}

function omit<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

// ---------- Formulário ----------

export type SecretRow = { name: string; value: string; /** Já existe no server (o valor nunca vem). */ stored: boolean; remove: boolean };

export type ConnectorForm = {
  name: string;
  kind: Connector["kind"];
  url: string;
  /** URL atual (mascarada) para mostrar quando o campo fica vazio na edição. */
  urlPlaceholder: string;
  command: string;
  /** Um argumento por linha. */
  args: string;
  /** Token "Bearer" (vira o cabeçalho Authorization). Vazio na edição = mantém. */
  bearer: string;
  bearerStored: boolean;
  removeBearer: boolean;
  secrets: SecretRow[];
  iconKind: "brand" | "monogram" | "custom";
  brand: string;
  color: string;
  enabled: boolean;
  agentIds: string[];
  origin: "manual" | "claude-code";
  /** Só na Biblioteca: o que o conector faz, em uma linha. */
  description: string;
};

export const EMPTY_FORM: ConnectorForm = {
  name: "",
  kind: "http",
  url: "",
  urlPlaceholder: "https://…/mcp",
  command: "",
  args: "",
  bearer: "",
  bearerStored: false,
  removeBearer: false,
  secrets: [],
  iconKind: "monogram",
  brand: "",
  color: "",
  enabled: true,
  agentIds: [],
  origin: "manual",
  description: "",
};

const isAuthorization = (name: string) => name.toLowerCase() === "authorization";

/** Formulário de edição a partir do conector (sem valores de segredo: só os nomes). */
export function formFromConnector(connector: Connector): ConnectorForm {
  const names = connector.kind === "http" ? connector.secretHeaders : connector.secretEnv;
  return {
    ...EMPTY_FORM,
    name: connector.name,
    kind: connector.kind,
    url: "",
    urlPlaceholder: connector.url ?? EMPTY_FORM.urlPlaceholder,
    command: connector.command ?? "",
    args: (connector.args ?? []).join("\n"),
    bearerStored: connector.kind === "http" && names.some(isAuthorization),
    secrets: names.filter((name) => connector.kind !== "http" || !isAuthorization(name)).map((name) => ({ name, value: "", stored: true, remove: false })),
    iconKind: connector.icon.kind,
    brand: connector.icon.kind === "brand" ? connector.icon.slug : "",
    color: connector.color ?? "",
    enabled: connector.enabled,
    agentIds: [...connector.agentIds],
    origin: connector.origin,
  };
}

/** Formulário pré-preenchido com um servidor do Claude Code (os segredos o usuário digita). */
export function formFromCandidate(candidate: ConnectorImportCandidate): ConnectorForm {
  const brand = suggestBrand(candidate.name, candidate.url);
  return {
    ...EMPTY_FORM,
    name: candidate.name,
    kind: candidate.kind,
    url: candidate.urlMasked ? "" : (candidate.url ?? ""),
    urlPlaceholder: candidate.url ?? EMPTY_FORM.urlPlaceholder,
    command: candidate.command ?? "",
    args: (candidate.args ?? []).join("\n"),
    iconKind: brand ? "brand" : "monogram",
    brand: brand?.slug ?? "",
    origin: "claude-code",
  };
}

const splitArgs = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** Problemas do formulário (por campo), antes de mandar. */
export function formErrors(form: ConnectorForm, editing: boolean): Partial<Record<"name" | "url" | "command" | "secrets", string>> {
  const errors: Partial<Record<"name" | "url" | "command" | "secrets", string>> = {};
  if (!form.name.trim()) errors.name = "Dê um nome ao conector.";
  if (form.kind === "http") {
    const url = form.url.trim();
    if (!url && !editing) errors.url = "Cole a URL do servidor MCP.";
    else if (url && !/^https?:\/\/\S+$/i.test(url)) errors.url = "Use uma URL http:// ou https://.";
  } else if (!form.command.trim() && !editing) errors.command = "Diga o comando que sobe o servidor.";
  const names = form.secrets.filter((row) => !row.remove).map((row) => row.name.trim().toLowerCase());
  if (names.some((name) => !name) && form.secrets.some((row) => !row.remove && !row.stored && row.value && !row.name.trim())) errors.secrets = "Cada valor precisa de um nome.";
  if (new Set(names.filter(Boolean)).size !== names.filter(Boolean).length) errors.secrets = "Nomes repetidos.";
  return errors;
}

function secretsChange(form: ConnectorForm): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (form.kind === "http") {
    if (form.removeBearer) out.Authorization = null;
    else if (form.bearer.trim()) out.Authorization = /^\S+\s+\S/.test(form.bearer.trim()) ? form.bearer.trim() : `Bearer ${form.bearer.trim()}`;
  }
  for (const row of form.secrets) {
    const name = row.name.trim();
    if (!name) continue;
    if (row.remove) {
      if (row.stored) out[name] = null;
    } else if (row.value) out[name] = row.value;
  }
  return out;
}

const iconChoice = (form: ConnectorForm) => (form.iconKind === "brand" && form.brand ? { kind: "brand" as const, slug: form.brand } : { kind: "monogram" as const });

/** Corpo do POST (conector novo). */
export function createBody(form: ConnectorForm): CreateConnectorBody {
  const secrets = Object.fromEntries(Object.entries(secretsChange(form)).filter((entry): entry is [string, string] => entry[1] !== null));
  return {
    name: form.name.trim(),
    kind: form.kind,
    ...(form.kind === "http" ? { url: form.url.trim(), ...(Object.keys(secrets).length ? { headers: secrets } : {}) } : { command: form.command.trim(), args: splitArgs(form.args), ...(Object.keys(secrets).length ? { env: secrets } : {}) }),
    icon: iconChoice(form),
    ...(form.color ? { color: form.color } : {}),
    enabled: form.enabled,
    agentIds: form.agentIds,
    origin: form.origin,
  };
}

/** Corpo do PATCH: só o que mudou (segredos: valor novo troca, "apagar" manda null, vazio mantém). */
export function patchBody(before: Connector, form: ConnectorForm): UpdateConnectorBody {
  const patch: UpdateConnectorBody = {};
  if (form.name.trim() !== before.name) patch.name = form.name.trim();
  if (form.kind === "http" && form.url.trim()) patch.url = form.url.trim();
  if (form.kind === "stdio") {
    if (form.command.trim() && form.command.trim() !== before.command) patch.command = form.command.trim();
    const args = splitArgs(form.args);
    if (JSON.stringify(args) !== JSON.stringify(before.args ?? [])) patch.args = args;
  }
  const secrets = secretsChange(form);
  if (Object.keys(secrets).length > 0) {
    if (form.kind === "http") patch.headers = secrets;
    else patch.env = secrets;
  }
  if (form.iconKind !== "custom") {
    const icon = iconChoice(form);
    if (JSON.stringify(icon) !== JSON.stringify(before.icon)) patch.icon = icon;
  }
  if ((form.color || undefined) !== before.color) patch.color = form.color || null;
  if (form.enabled !== before.enabled) patch.enabled = form.enabled;
  if (JSON.stringify([...form.agentIds].sort()) !== JSON.stringify([...before.agentIds].sort())) patch.agentIds = form.agentIds;
  return patch;
}

// ---------- Biblioteca (conectores da plataforma: sem `agentIds`, com a descrição) ----------

/** O conector da Biblioteca na forma que os formulários conhecem (`app` vira stdio só para o formulário). */
const asFormConnector = (connector: LibraryConnector, agentIds: string[] = []): Connector => ({
  ...connector,
  kind: connector.kind === "app" ? "stdio" : connector.kind,
  origin: connector.origin === "app" ? "manual" : connector.origin,
  agentIds,
});

export function formFromLibraryConnector(connector: LibraryConnector): ConnectorForm {
  return { ...formFromConnector(asFormConnector(connector)), description: connector.description };
}

/** Corpo do POST /api/library/connectors (sem agentes: quem recebe se escolhe em "Liberar"). */
export function libraryCreateBody(form: ConnectorForm): CreateLibraryConnectorBody {
  const { agentIds: _agentIds, ...body } = createBody(form);
  return { ...body, ...(form.description.trim() ? { description: form.description.trim() } : {}) };
}

/** Corpo do PATCH /api/library/connectors/:id: só o que mudou. */
export function libraryPatchBody(before: LibraryConnector, form: ConnectorForm): UpdateLibraryConnectorBody {
  const { agentIds: _agentIds, ...rest } = patchBody(asFormConnector(before, form.agentIds), form);
  const patch: UpdateLibraryConnectorBody = rest;
  if (form.description.trim() !== before.description) patch.description = form.description.trim();
  return patch;
}
