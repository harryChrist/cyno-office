/**
 * `browser_inspect`: o HTML de um elemento (só leitura), com TODOS os atributos (data-*, id,
 * componentkey…) que a árvore de acessibilidade descarta. Enxuto e sem segredos: tira script/style,
 * resume SVG, apaga o que foi digitado em campos, mascara atributos com cara de token e corta
 * valores e profundidade. Nada de JS arbitrário: o percurso é fixo (string, como em sensitive.ts).
 */

export const INSPECT_DEFAULT_DEPTH = 6;
export const INSPECT_MAX_DEPTH = 20;
export const INSPECT_DEFAULT_CHARS = 8000;
export const INSPECT_MAX_CHARS = 30_000;

export type InspectOptions = { depth: number; maxChars: number };
export type InspectResult = { html: string; truncated: boolean; nodes: number };

const INSPECT_SOURCE = String.raw`(el, options) => {
  const SECRET_NAME = /(csrf|xsrf|token|nonce|secret|passw|session|auth|credential|api[-_]?key)/i;
  const SKIP = new Set(["script", "style", "noscript", "template", "link", "meta"]);
  const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "source", "track", "wbr"]);
  const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escAttr = (text) => esc(text).replace(/"/g, "&quot;");
  let nodes = 0;
  let out = "";
  let truncated = false;
  const limit = options.maxChars;
  const write = (text) => {
    if (truncated) return;
    if (out.length + text.length > limit) {
      out += text.slice(0, Math.max(0, limit - out.length));
      truncated = true;
    } else out += text;
  };
  const attrs = (node) => {
    const tag = node.tagName.toLowerCase();
    let text = "";
    for (const attr of node.attributes) {
      const name = attr.name;
      let value = attr.value;
      if (/^on/i.test(name)) continue;
      if ((tag === "input" || tag === "textarea" || tag === "select" || tag === "option") && (name === "value" || name === "checked" || name === "selected")) continue;
      if (SECRET_NAME.test(name)) value = "[redacted]";
      else if (/^data:/i.test(value) && value.length > 80) value = value.slice(0, 40) + "…[data URI]";
      else if (value.length > 300) value = value.slice(0, 300) + "…";
      text += value === "" ? " " + name : " " + name + '="' + escAttr(value) + '"';
    }
    return text;
  };
  const walk = (node, depth) => {
    if (truncated) return;
    if (node.nodeType === 3) {
      const text = node.nodeValue.replace(/\s+/g, " ");
      if (text.trim()) write(esc(text.length > 400 ? text.slice(0, 400) + "…" : text));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (SKIP.has(tag)) return;
    nodes += 1;
    write("<" + tag + attrs(node) + ">");
    if (VOID.has(tag)) return;
    if (tag === "svg") write("…");
    else if (tag === "textarea") write("");
    else if (depth >= options.depth) {
      if (node.childNodes.length > 0) write("…");
    } else {
      const kids = node.shadowRoot ? [...node.shadowRoot.childNodes, ...node.childNodes] : node.childNodes;
      for (const child of kids) walk(child, depth + 1);
    }
    write("</" + tag + ">");
  };
  walk(el, 0);
  return { html: out, truncated, nodes };
}`;

/** `inspectElement(el, options)` para `locator.evaluate`. */
export const inspectElement = new Function("el", "options", `return (${INSPECT_SOURCE})(el, options);`) as (el: unknown, options: InspectOptions) => InspectResult;

/** Texto para o modelo. */
export function describeInspect(ref: string, result: InspectResult, options: InspectOptions): string {
  const notes = [`HTML of ${ref} (${result.nodes} elements, depth ≤ ${options.depth}; scripts/styles removed, typed values and token-like attributes hidden; "…" = cut)`];
  if (result.truncated) notes.push(`(cut at ${options.maxChars} characters: inspect a smaller element, or pass a lower depth / higher max_chars)`);
  return [...notes, result.html || "(empty element)"].join("\n");
}

export const FIND_DEFAULT_LIMIT = 15;
export const FIND_MAX_LIMIT = 50;

export type FoundElement = { index: number; tag: string; attrs: string; text: string; visible: boolean };
export type FindResult = { total: number; items: FoundElement[] } | { error: string };

const FIND_SOURCE = String.raw`(selector, limit) => {
  const SECRET_NAME = /(csrf|xsrf|token|nonce|secret|passw|session|auth|credential|api[-_]?key)/i;
  const KEEP = /^(id|class|role|aria-[\w-]+|name|type|href|src|alt|title|placeholder|for|componentkey|itemid|data-[\w-]+)$/i;
  let list;
  try {
    list = document.querySelectorAll(selector);
  } catch (error) {
    return { error: String(error && error.message ? error.message : error).split("\n")[0] };
  }
  const items = [];
  for (let index = 0; index < list.length && items.length < limit; index += 1) {
    const el = list[index];
    const tag = el.tagName.toLowerCase();
    let attrs = "";
    let count = 0;
    for (const attr of el.attributes) {
      if (!KEEP.test(attr.name) || count >= 10) continue;
      let value = attr.value;
      if (SECRET_NAME.test(attr.name)) value = "[redacted]";
      else if (attr.name === "class") value = value.split(/\s+/).filter(Boolean).slice(0, 4).join(" ");
      else if (attr.name === "href" || attr.name === "src") { try { value = new URL(value, document.baseURI).href; } catch {} }
      if (value.length > 200) value = value.slice(0, 200) + "…";
      attrs += " " + attr.name + '="' + value.replace(/"/g, "&quot;") + '"';
      count += 1;
    }
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    const typed = tag === "input" || tag === "textarea" || tag === "select";
    const text = typed ? "" : String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
    items.push({ index, tag, attrs, text, visible });
  }
  return { total: list.length, items };
}`;

/** `findElements(selector, limit)` para `page.evaluate` (recebe [selector, limit]). */
export const findElements = new Function("args", `return (${FIND_SOURCE})(args[0], args[1]);`) as (args: [string, number]) => FindResult;

/** Texto para o modelo: cada achado com a posição (nth) para usar nas ações. */
export function describeFind(selector: string, result: FindResult): string {
  if ("error" in result) return `Invalid CSS selector "${selector}": ${result.error}`;
  if (result.total === 0) return `No element matches "${selector}".`;
  const lines = [`${result.total} element(s) match "${selector}"${result.total > result.items.length ? ` (showing ${result.items.length})` : ""}. Act on one with selector + nth (e.g. browser_click({ selector: ${JSON.stringify(selector)}, nth: 0 })):`];
  for (const item of result.items) lines.push(`[nth=${item.index}] <${item.tag}${item.attrs}>${item.text ? ` "${item.text}"` : ""}${item.visible ? "" : " (hidden)"}`);
  return lines.join("\n");
}
