import type { Board } from "../board";
import { BOARD_KIT_CSS } from "./css";
import { BOARD_KIT_JS } from "./js";

/**
 * Documento completo de um Quadro, para o `srcdoc` de um iframe ISOLADO:
 *
 *   <iframe sandbox="allow-scripts" srcDoc={buildBoardDocument({ html, data, meta })} />
 *
 * (sem `allow-same-origin`: a página não alcança cookies, localStorage nem a API do app.)
 *
 * Passo a passo para a tela:
 * 1. Busque a página (`GET /boards/:id/page`, texto) e os dados (`GET /boards/:id/data`, JSON).
 * 2. Monte o `srcdoc` com esta função. A página inteira é recarregada só quando `html` muda.
 * 3. Atualização ao vivo dos dados (evento `board:upserted` com `changed` incluindo "data"): busque os dados de
 *    novo e mande, SEM recarregar o iframe:
 *      iframe.contentWindow.postMessage({ type: "quadro:data", data, meta }, "*");
 *    O kit troca `Quadro.data` e chama de novo os `Quadro.onData(fn)` da página. Use "*" como targetOrigin
 *    (a origem de um iframe sandbox sem same-origin é "null").
 * 4. A página avisa a mãe por `window.postMessage` (confira `event.source === iframe.contentWindow`):
 *    `{ type: "quadro:ready" }` quando carregou (se os dados mudaram nesse meio tempo, mande de novo),
 *    `{ type: "quadro:height", height }` com a altura do conteúdo (opcional: ajuste a altura do iframe) e
 *    `{ type: "quadro:error", message }` quando o script da página do agente falha (opcional: mostre um aviso).
 *
 * Ordem do documento: doctype, charset, viewport, CSP (sem rede), CSS do kit, JSON embutido (`quadro-data`),
 * JS do kit e, por fim, o HTML do agente (os scripts dele já encontram `window.Quadro`).
 */

/** Sem rede: nada de fetch/XHR/WebSocket/formulário; imagens só https/data/blob; fonte só data:. */
export const BOARD_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data: blob:; font-src data:; base-uri 'none'; form-action 'none'";

/**
 * A CSP do documento servido como PÁGINA (o link público), no cabeçalho HTTP: `sandbox allow-scripts` dá à página uma
 * origem opaca (sem cookies e sem acesso ao app, como o iframe da tela), o que um `<meta>` não consegue fazer.
 */
export const BOARD_CSP_HEADER = `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; ${BOARD_CSP}`;

/** O que a página enxerga em `Quadro.meta` (um recorte do Board: tudo opcional, para pré-visualizações). */
export type BoardMeta = Partial<Pick<Board, "id" | "title" | "description" | "source" | "createdBy" | "createdAt" | "pageUpdatedAt" | "dataUpdatedAt" | "pageBytes" | "dataBytes">>;

export type BuildBoardDocumentInput = { html: string; data: unknown; meta?: BoardMeta };

/** JSON seguro dentro de uma tag <script>: nada de "<" (fecharia a tag com </script> ou abriria <!--), nem U+2028/2029. */
export function jsonForScript(value: unknown): string {
  const text = JSON.stringify(value === undefined ? null : value) ?? "null";
  return text.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const escapeText = (text: string): string => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function buildBoardDocument({ html, data, meta }: BuildBoardDocumentInput): string {
  const envelope = jsonForScript({ data: data ?? {}, meta: meta ?? {} });
  return [
    "<!doctype html>",
    '<html lang="pt-BR">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${BOARD_CSP}">`,
    `<title>${escapeText(meta?.title ?? "Quadro")}</title>`,
    `<style id="quadro-kit">${BOARD_KIT_CSS}</style>`,
    "</head>",
    "<body>",
    `<script id="quadro-data" type="application/json">${envelope}</script>`,
    `<script id="quadro-kit-js">${BOARD_KIT_JS}</script>`,
    html,
    "</body>",
    "</html>",
  ].join("\n");
}
