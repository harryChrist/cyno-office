/**
 * Heurística das ações que PUBLICAM, ENVIAM ou COMPRAM (precisam da aprovação do usuário no "Para
 * você" antes de o agente fazer). Melhor pedir a mais do que publicar algo sozinho:
 * - clicar num BOTÃO (não num link) com texto tipo "Publicar", "Post", "Enviar", "Comprar", "Pagar",
 *   "Confirmar", "Conectar", "Seguir"…;
 * - enviar um formulário (botão de submit, Enter num campo) num site em que há sessão (login) — menos
 *   busca (formulário GET, role=search, campo de busca);
 * - Enter numa caixa de texto livre (textarea, contenteditable) num site com sessão (mensagens).
 */

/** O que a página diz do alvo de um clique ou do campo focado (lido dentro da página). */
export type TargetInfo = {
  /** Texto visível ou acessível do elemento (aria-label, value, innerText), curto. */
  label: string;
  /** É botão (button, role=button, input submit/button/image)? */
  button: boolean;
  /** É (ou está dentro de) um link? */
  link: boolean;
  /** Botão/campo que envia um formulário? */
  submits: boolean;
  /** Formulário de busca (GET, role=search, campo search/q)? */
  searchForm: boolean;
  /** Caixa de texto livre (textarea ou contenteditable)? */
  freeText: boolean;
  /** Só abre um menu (aria-haspopup=menu): nada sai da página; os itens do menu passam pela regra de novo. */
  opensMenu?: boolean;
};

const SENSITIVE_WORDS = [
  "publicar",
  "publique",
  "postar",
  "post",
  "repost",
  "tweet",
  "enviar",
  "envie",
  "send",
  "submit",
  "comprar",
  "compre",
  "buy",
  "purchase",
  "checkout",
  "pagar",
  "pay",
  "confirmar",
  "confirm",
  "finalizar compra",
  "finalizar pedido",
  "place order",
  "compartilhar",
  "share",
  "excluir",
  "delete",
  "apagar",
  "conectar",
  "connect",
  "seguir",
  "follow",
  "assinar",
  "subscribe",
  "doar",
  "donate",
  "transferir",
  "transfer",
  "candidatar",
  "apply",
];

const SENSITIVE_RE = new RegExp(`(^|[^\\p{L}])(${SENSITIVE_WORDS.join("|")})(?![\\p{L}])`, "iu");

/** O texto tem uma palavra de ação sensível ("Publicar agora", "Send", "Pagar R$ 10")? */
export function hasSensitiveWord(text: string): boolean {
  return SENSITIVE_RE.test(text.normalize("NFC"));
}

/**
 * Rótulos que só LEEM ou abrem algo, mesmo com palavra sensível no meio ("Open control menu for post
 * by Ana", "Copy link to post", "Copiar link da publicação", "Ver mais"): seguem sem aprovação.
 */
const SAFE_LABEL_RE =
  /^(open|abrir|abre|mostrar|show|ver|see|view|exibir)\b[^]*\b(menu|options|opções|op[cç][aã]o|more|mais)\b|\b(copy|copiar|copia)\b[^]*\b(link|url|endere[cç]o)\b|^(ver mais|see more|show more|mais op[cç][oõ]es|more options|more actions|mais a[cç][oõ]es)\b/iu;

/** O rótulo é de uma ação só de leitura (abrir menu, copiar link, ver mais)? */
export function isReadOnlyLabel(text: string): boolean {
  return SAFE_LABEL_RE.test(text.normalize("NFC").trim());
}

/** Cookies que costumam ser de sessão (login) — não os de preferência/analytics. */
const SESSION_COOKIE = /^(li_at|c_user|xs|sid|ssid|hsid|apisid|sapisid|__secure-[13]psid|__secure-next-auth\.session-token|ct0|auth_token|sessionid|session|_session|session_id|sessid|phpsessid|jsessionid|connect\.sid|user_session|_gh_sess|logged_in|remember_me|token|access_token|jwt)$/i;
const SESSION_PART = /(session|auth|login|token)/i;

/** Os cookies do site indicam uma sessão aberta (o usuário fez login)? */
export function looksLoggedIn(cookies: readonly { name: string }[]): boolean {
  return cookies.some((cookie) => SESSION_COOKIE.test(cookie.name) || SESSION_PART.test(cookie.name));
}

export type SensitiveAction = { kind: "click"; target: TargetInfo } | { kind: "submit"; target: TargetInfo };

/** Motivo (pt-BR, para o usuário) se a ação precisa de aprovação; null = pode seguir. */
export function sensitiveReason(action: SensitiveAction, loggedIn: boolean): string | null {
  const { target } = action;
  if (action.kind === "click") {
    if (!target.submits && (target.opensMenu || isReadOnlyLabel(target.label))) return null;
    if (target.button && !target.link && hasSensitiveWord(target.label)) return `o botão “${target.label}” parece publicar, enviar ou comprar`;
    if (target.submits && loggedIn && !target.searchForm) return "envia um formulário num site em que você está logado";
    return null;
  }
  if (!loggedIn || target.searchForm) return null;
  if (target.submits) return "envia um formulário num site em que você está logado";
  if (target.freeText) return "Enter numa caixa de mensagem pode enviar o texto num site em que você está logado";
  return null;
}

/**
 * Lê o alvo dentro da página. É JavaScript puro num texto (não uma função do TypeScript): o tsx
 * acrescenta ajudantes (`__name`) às funções, que não existem dentro da página.
 */
const READ_TARGET_SOURCE = String.raw`(el) => {
  const empty = { label: "", button: false, link: false, submits: false, searchForm: false, freeText: false, opensMenu: false };
  if (!el || !el.tagName) return empty;
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const control = el.closest("button, [role=button], input[type=submit], input[type=button], input[type=image], a, [role=link]") || el;
  const tag = control.tagName.toLowerCase();
  const type = (control.getAttribute("type") || "").toLowerCase();
  const label =
    clean(control.getAttribute("aria-label")) ||
    clean(control.innerText) ||
    clean(tag === "input" ? control.value : "") ||
    clean(control.getAttribute("title")) ||
    clean(el.getAttribute("placeholder")) ||
    clean(el.getAttribute("aria-label"));
  const link = tag === "a" || control.getAttribute("role") === "link";
  const button = tag === "button" || control.getAttribute("role") === "button" || (tag === "input" && ["submit", "button", "image"].includes(type));
  const form = el.form || control.form || el.closest("form");
  const elTag = el.tagName.toLowerCase();
  const submits =
    !!form &&
    ((tag === "button" && (type === "" || type === "submit")) ||
      (tag === "input" && (type === "submit" || type === "image")) ||
      (elTag === "input" && !["checkbox", "radio", "button", "file"].includes(String(el.type || "").toLowerCase())));
  const searchForm =
    !!form &&
    ((form.getAttribute("method") || "").toLowerCase() === "get" ||
      form.getAttribute("role") === "search" ||
      !!form.closest("[role=search]") ||
      !!form.querySelector("input[type=search], input[name=q], input[name=query], input[name=search]"));
  const freeText = elTag === "textarea" || el.isContentEditable === true;
  const popup = (control.getAttribute("aria-haspopup") || "").toLowerCase();
  const opensMenu = popup === "menu" || popup === "true" || popup === "listbox";
  return { label, button, link, submits, searchForm, freeText, opensMenu };
}`;

/** `readTarget(el)` para `locator.evaluate` (recebe o elemento). */
export const readTarget = new Function("el", `return (${READ_TARGET_SOURCE})(el);`) as (el: unknown) => TargetInfo;

/** O campo focado na página (`page.evaluate(readFocused)`), descendo pelos shadow roots. */
export const readFocused = new Function(
  `let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return (${READ_TARGET_SOURCE})(el && el !== document.body ? el : null);`,
) as () => TargetInfo;

