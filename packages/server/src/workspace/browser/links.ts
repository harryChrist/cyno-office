/**
 * Links que o agente não vê no snapshot: o que a página copia para a área de transferência (ex.:
 * "Copiar link" do LinkedIn) e o endereço completo/permalink de um elemento. Os trechos que rodam
 * na página são strings (como em sensitive.ts) para o transpilador não injetar helpers nelas.
 */

/** Nome da variável da página onde o script guarda a última cópia. */
const COPIED_KEY = "__agentOfficeCopied";

/**
 * Script de início de toda página: registra o que a página copia (navigator.clipboard.writeText/
 * write e o evento "copy" do execCommand) sem depender da área de transferência real (o Chromium
 * headless não tem uma útil). writeText sempre resolve, para o site mostrar "Link copiado".
 */
export const COPY_CAPTURE_SCRIPT = `(() => {
  const KEY = ${JSON.stringify(COPIED_KEY)};
  const save = (text) => {
    if (typeof text !== "string" || !text.trim()) return;
    try { Object.defineProperty(window, KEY, { value: { text: text.slice(0, 5000), at: Date.now() }, configurable: true, writable: true }); } catch {}
  };
  try {
    const clip = navigator.clipboard;
    if (clip) {
      const writeText = clip.writeText ? clip.writeText.bind(clip) : null;
      clip.writeText = (text) => { save(String(text)); return writeText ? writeText(text).catch(() => undefined) : Promise.resolve(); };
      const write = clip.write ? clip.write.bind(clip) : null;
      clip.write = async (items) => {
        try {
          for (const item of items || []) {
            if (item.types && item.types.includes("text/plain")) save(await (await item.getType("text/plain")).text());
          }
        } catch {}
        return write ? write(items).catch(() => undefined) : undefined;
      };
    }
  } catch {}
  // Fase de bolha na window: roda depois dos handlers do site, ainda com os dados acessíveis.
  window.addEventListener("copy", (event) => {
    let text = "";
    try { text = (event.clipboardData && event.clipboardData.getData("text/plain")) || ""; } catch {}
    if (!text && !event.defaultPrevented) { try { text = String(document.getSelection() || ""); } catch {} }
    save(text);
  });
})();`;

/** Lê e limpa a última cópia da página (`page.evaluate`). */
export const TAKE_COPIED_SOURCE = `(() => {
  const value = window[${JSON.stringify(COPIED_KEY)}];
  try { delete window[${JSON.stringify(COPIED_KEY)}]; } catch {}
  return value && typeof value.text === "string" ? value.text : null;
})()`;

/** Limpa a cópia anterior (antes de uma ação), para não confundir com a nova. */
export const CLEAR_COPIED_SOURCE = `(() => { try { delete window[${JSON.stringify(COPIED_KEY)}]; } catch {} })()`;

/**
 * Receita de permalink de um site: onde o identificador do item aparece (em atributos ou no HTML
 * dele) e como vira o endereço. Site novo = uma linha aqui (o agente também pode descobrir o padrão
 * com browser_inspect e guardar no Cérebro).
 */
export type LinkRecipe = {
  name: string;
  /** Vale nas páginas destes hosts (e subdomínios). */
  hosts: string[];
  /** Expressão do identificador (sem flags; procurada no texto decodificado). */
  pattern: string;
  /** Endereço a partir do trecho achado (match[0] e grupos). */
  url: (match: string[]) => string;
};

export const LINK_RECIPES: LinkRecipe[] = [
  {
    name: "LinkedIn post",
    hosts: ["linkedin.com"],
    pattern: String.raw`urn:li:(?:activity|ugcPost|share):\d+`,
    url: ([urn]) => `https://www.linkedin.com/feed/update/${urn}/`,
  },
  {
    name: "Reddit post",
    hosts: ["reddit.com"],
    pattern: String.raw`\bt3_([a-z0-9]{5,10})\b`,
    url: ([, id]) => `https://www.reddit.com/comments/${id}/`,
  },
];

/** As receitas que valem na página atual. */
export function recipesFor(pageUrl: string, recipes: LinkRecipe[] = LINK_RECIPES): LinkRecipe[] {
  let host: string;
  try {
    host = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return [];
  }
  return recipes.filter((recipe) => recipe.hosts.some((base) => host === base || host.endsWith(`.${base}`)));
}

export type ElementLinks = {
  /** Link do próprio elemento ou do <a> que o contém. */
  href: string | null;
  /** Links dentro do elemento (contêiner, ex.: um post inteiro), sem repetição. */
  inside: { text: string; href: string }[];
  /** Endereço canônico da PÁGINA (link rel=canonical / og:url), se houver. */
  canonical: string | null;
  /** Atributos com cara de identificador no elemento, em volta e dentro (qualquer site). */
  ids: { name: string; value: string; where: string }[];
  /** Trechos achados pelas receitas (índice da receita, grupos do match e de onde saiu). */
  matches: { recipe: number; match: string[]; source: string }[];
};

const READ_LINKS_SOURCE = String.raw`function (el, patterns) {
  const abs = (value) => { try { return new URL(value, document.baseURI).href; } catch { return null; } };
  const ok = (href) => href && /^https?:/i.test(href);
  const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();
  const own = el.closest ? el.closest("a[href]") : null;
  const href = own ? abs(own.getAttribute("href")) : null;
  const inside = [];
  const seen = new Set(href ? [href] : []);
  for (const a of el.querySelectorAll ? el.querySelectorAll("a[href]") : []) {
    const link = abs(a.getAttribute("href"));
    if (!ok(link) || seen.has(link)) continue;
    seen.add(link);
    inside.push({ text: clean(a.innerText || a.getAttribute("aria-label")).slice(0, 80), href: link });
    if (inside.length >= 30) break;
  }
  const meta = document.querySelector('link[rel="canonical"]')?.getAttribute("href") || document.querySelector('meta[property="og:url"]')?.getAttribute("content");
  const canonical = meta ? abs(meta) : null;

  const decode = (value) => { let text = String(value); try { text = decodeURIComponent(text); } catch { text = text.replace(/%3A/gi, ":").replace(/%2F/gi, "/"); } return text; };
  const describe = (node) => {
    const tag = node.tagName.toLowerCase();
    const role = node.getAttribute("role");
    return "<" + tag + (role ? " role=" + role : "") + ">";
  };
  // Nós na ordem de busca: o elemento e os ancestrais (o contêiner mais próximo primeiro), depois os filhos.
  const order = [];
  for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 40; node = node.parentElement, depth += 1) {
    order.push([node, depth === 0 ? "the element itself" : "an ancestor of the element", depth]);
  }
  let visited = 0;
  for (const node of el.querySelectorAll ? el.querySelectorAll("*") : []) {
    if ((visited += 1) > 5000) break;
    order.push([node, "inside the element", -1]);
  }

  // Genérico: atributos com nome e valor de identificador (qualquer site).
  const ID_NAME = /^(id|key|componentkey|itemid|data-urn|data-id|data-[\w-]*(?:-id|_id|id|urn|uuid|key|permalink|uri|url|href|slug))$/i;
  const ids = [];
  const idSeen = new Set();
  for (const [node, where, depth] of order) {
    if (ids.length >= 15) break;
    if (depth > 6) continue;
    for (const attr of node.attributes || []) {
      if (!ID_NAME.test(attr.name)) continue;
      const value = decode(attr.value).trim();
      if (value.length < 4 || value.length > 240 || !/\d|urn:|\//.test(value) || /^(ember|react|radix|mui|headlessui|:r)/i.test(value) || idSeen.has(value)) continue;
      idSeen.add(value);
      ids.push({ name: attr.name, value, where: describe(node) + " (" + where + ")" });
      if (ids.length >= 15) break;
    }
  }

  // Receitas do site: o identificador em QUALQUER atributo (também codificado) e, por último, no HTML.
  const matches = [];
  patterns.forEach((pattern, recipe) => {
    const re = new RegExp(pattern, "gi");
    const found = [];
    const add = (match, source) => { if (found.length < 5 && !found.some((item) => item.match[0] === match[0])) found.push({ recipe, match: [...match], source }); };
    let ancestorHit = false;
    for (const [node, where, depth] of order) {
      if (found.length >= 5 || (ancestorHit && depth === -1)) break;
      for (const attr of node.attributes || []) {
        if (!attr.value || attr.value.length > 20000) continue;
        for (const match of decode(attr.value).matchAll(re)) {
          add(match, "attribute " + attr.name + " of " + describe(node) + " (" + where + ")");
          if (depth >= 0) ancestorHit = true;
        }
      }
      if (ancestorHit && depth >= 0) break;
    }
    if (found.length === 0 && el.outerHTML && el.outerHTML.length < 3000000) {
      for (const match of decode(el.outerHTML.replace(/&quot;/g, '"')).matchAll(re)) add(match, "the element's HTML");
    }
    matches.push(...found);
  });
  return { href: ok(href) ? href : null, inside, canonical: ok(canonical) ? canonical : null, ids, matches };
}`;

/** `readLinks(el, patterns)` para `locator.evaluate` (patterns = as expressões das receitas que valem na página). */
export const readLinks = new Function("el", "patterns", `return (${READ_LINKS_SOURCE})(el, patterns);`) as (el: unknown, patterns: string[]) => ElementLinks;

/** Texto para o modelo com os links do elemento. */
export function describeLinks(ref: string, links: ElementLinks, pageUrl: string, recipes: LinkRecipe[]): string {
  const lines: string[] = [];
  const built = links.matches.flatMap(({ recipe, match, source }) => {
    const rule = recipes[recipe];
    return rule ? [{ name: rule.name, url: rule.url(match), id: match[0], source }] : [];
  });
  if (built.length > 0) {
    lines.push(built.length > 1 ? "Item permalinks (the first is the closest to the element):" : "Item permalink:");
    for (const item of built) lines.push(`- ${item.url} (${item.name}; id ${item.id}, from ${item.source})`);
  }
  if (links.href) lines.push(`Link of ${ref}: ${links.href}`);
  if (links.inside.length > 0) {
    lines.push(`Links inside ${ref}:`);
    for (const link of links.inside) lines.push(`- ${link.text ? `${link.text}: ` : ""}${link.href}`);
  }
  if (links.ids.length > 0) {
    lines.push(`Identifiers on/around ${ref} (to build the item's URL with the site's pattern when no link above is the item itself):`);
    for (const id of links.ids) lines.push(`- ${id.name}="${id.value}" on ${id.where}`);
  }
  if (lines.length === 0) {
    lines.push(
      `No link or identifier found on ${ref} or around it. Try the ref of the item's container (e.g. the whole post), browser_inspect to read its HTML, or its "..." / share menu → "Copy link" (browser_click returns what the page copied).`,
    );
  }
  if (links.canonical && links.canonical !== pageUrl) lines.push(`Page canonical URL: ${links.canonical}`);
  lines.push(`Current page: ${pageUrl}`);
  return lines.join("\n");
}
