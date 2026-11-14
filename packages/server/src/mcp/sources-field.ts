import { FOR_YOU_SOURCE_KINDS, FOR_YOU_SOURCE_LIMITS as L, type ForYouSource } from "@cyno/shared";
import { z } from "zod";

/*
 * `sources` do request_approval / update_pending_item: o contexto do cartão (o que o rascunho
 * analisou). O schema aceita folga e o servidor CORTA o que passa do limite (normalizeSources) em vez
 * de recusar: um post um pouco longo não deve derrubar o pedido.
 */

const mediaId = z.string().trim().regex(/^M-\d{4,}$/, 'Use media ids like "M-0001"');

export const sourceField = z.object({
  kind: z.enum(FOR_YOU_SOURCE_KINDS).describe("post, profile, article, message, page or other"),
  url: z.string().max(L.url * 3).optional().describe("Exact link of the original (use browser_get_link for posts)"),
  title: z.string().max(L.title * 3).optional().describe('E.g. "Post de Mayk Brito"'),
  author: z.string().max(L.author * 3).optional(),
  authorDetail: z.string().max(L.authorDetail * 3).optional().describe("Headline, role, followers…"),
  postedAt: z.string().max(L.postedAt * 3).optional().describe('As the site shows it ("hoje", "08/11") or ISO'),
  content: z.string().max(L.content * 10).optional().describe(`The FULL text of what you analysed (post text, profile About/headline…). Longer than ${L.content} characters is cut.`),
  summary: z.string().max(L.summary * 5).optional().describe(`1 to 3 sentences (max ${L.summary} characters)`),
  facts: z
    .array(z.object({ label: z.string().max(L.factLabel * 3), value: z.string().max(L.factValue * 3) }))
    .max(L.facts * 3)
    .optional()
    .describe(`Up to ${L.facts} short facts, e.g. {label:"Conexões em comum", value:"22"}`),
  mediaIds: z.array(mediaId).max(L.mediaIds * 3).optional().describe("Media library ids, e.g. a browser_screenshot(saveToMedia) of the original post"),
});

export const sourcesField = z.array(sourceField).max(L.sources * 2);

/** Texto fixo das descrições: o que as fontes precisam trazer. */
export const SOURCES_RULE =
  "ALWAYS include `sources` with what the draft is based on, so the user decides with full context: for a comment/reply, the FULL original post text (content) + author + link + a 1–3 sentence summary (and a browser_screenshot with saveToMedia: true of it in mediaIds); for a connection invite, the profile (headline, location, why this person, mutual connections as facts); for a post/article, the references used. Keep `question` short: the detail goes in sources.";

export type SourcesInput = z.output<typeof sourcesField>;

/** O que o tipo da ferramenta entrega vira ForYouSource (os campos são os mesmos). */
export const asSources = (input: SourcesInput | undefined): ForYouSource[] | undefined => input as ForYouSource[] | undefined;

/** Erro (para o modelo) se alguma mídia citada não existe na biblioteca; undefined = tudo certo. */
export function attachmentError(media: { missing(ids: readonly string[]): string[] } | undefined, mediaIds: readonly string[] | undefined, sources: SourcesInput | undefined): string | undefined {
  const ids = [...(mediaIds ?? []), ...(sources ?? []).flatMap((source) => source.mediaIds ?? [])];
  if (ids.length === 0) return undefined;
  if (!media) return "The media library is not available in this workspace: remove mediaIds.";
  const missing = media.missing([...new Set(ids)]);
  return missing.length > 0 ? `Media not found in this workspace: ${missing.join(", ")} (see media_list). Nothing was created: fix the ids and call again.` : undefined;
}
