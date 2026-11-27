/** Pedaço de texto: texto puro ou um link (http/https) achado nele. */
export type TextPart = { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
/** Pontuação que costuma colar no fim da URL na escrita ("veja https://x.com/a." ou "(https://x.com/a)"). */
const TRAILING = /[.,;:!?…»”’]+$/;

/** Tira do fim da URL a pontuação da frase e o ")" sem par (o "(" de uma URL da Wikipedia fica). */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const before = url;
    url = url.replace(TRAILING, "");
    if (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
    if (url.endsWith("]") && !url.includes("[")) url = url.slice(0, -1);
    if (url === before) return url;
  }
}

/** Divide o texto em pedaços, com as URLs http/https viradas em links. Sem URL: um pedaço só. */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index;
    const url = trimUrl(match[0]);
    if (!/^https?:\/\/[^/\s]+\.[^/\s]/i.test(url) && !/^https?:\/\/localhost\b/i.test(url)) continue;
    if (start > last) parts.push({ kind: "text", text: text.slice(last, start) });
    parts.push({ kind: "link", text: url, href: url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts.length > 0 ? parts : [{ kind: "text", text }];
}
