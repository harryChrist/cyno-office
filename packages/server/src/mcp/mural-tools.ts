import { MURAL_LIMITS, type MuralEntry } from "@cyno/shared";
import { z } from "zod";
import type { MuralService } from "../platform/mural/mural-service";
import { HttpError } from "../platform/http/errors";
import { errorMessage, shorten } from "../util/text";
import { findByRef } from "./structure-tools";
import { defineTool, type McpTool, type McpToolResult } from "./protocol";

/*
 * Mural da plataforma (contrato MCP em inglês). Um workspace compartilha uma mídia ou um resultado com a
 * plataforma; os outros workspaces ficam sabendo (o Maestro deles lê o aviso na próxima mensagem) e podem
 * TRAZER o item para a própria biblioteca com `mural_use`. Nenhum workspace lê arquivo de outro.
 */

export type MuralToolsDeps = {
  mural: Pick<MuralService, "share" | "list" | "find" | "use" | "retire">;
  /** O workspace do agente (as ferramentas dele agem sempre como ele mesmo). */
  workspace: string;
  /** Endereço de quem chama ("design/maestro") e o id do agente (autor da mídia copiada). */
  address: string;
  agentId: string;
  workspaceName: (id: string) => string | undefined;
};

const ok = (text: string): McpToolResult => ({ text });
const fail = (text: string): McpToolResult => ({ text, isError: true });

async function guarded(run: () => Promise<McpToolResult> | McpToolResult): Promise<McpToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HttpError) return fail(error.message);
    return fail(errorMessage(error));
  }
}

const KIND_EN: Record<MuralEntry["kind"], string> = { media: "media", deliverable: "result", note: "note" };

/** Uma linha por item do mural (para o `mural_list`). */
export function describeMural(entry: MuralEntry, nameOf: (id: string) => string | undefined, viewer?: string): string {
  const from = viewer && entry.workspace === viewer ? "YOUR workspace" : `${nameOf(entry.workspace) ?? entry.workspace} (${entry.workspace})`;
  return [
    `${entry.id} “${shorten(entry.title, 90)}” — ${KIND_EN[entry.kind]} from ${from}, ${entry.createdAt.slice(0, 16).replace("T", " ")}`,
    entry.note ? `note: ${shorten(entry.note, 160)}` : "",
    entry.text ? `text: ${shorten(entry.text.replace(/\s+/g, " "), 200)}` : "",
    entry.usedBy.length > 0 ? `used by ${entry.usedBy.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function listText(entries: MuralEntry[], deps: { workspaceName: (id: string) => string | undefined }, viewer?: string): string {
  return entries.length === 0 ? "The mural is empty (nothing shared right now)." : entries.map((entry) => describeMural(entry, deps.workspaceName, viewer)).join("\n");
}

const useText = (id: string, result: { mediaId?: string; text?: string }): string =>
  result.mediaId
    ? `Brought ${id} to your media library as ${result.mediaId} (draft; the note records where it came from). Use it like any of your media, e.g. request_approval(mediaIds: ["${result.mediaId}"]).`
    : `${id} is text, not a file. Here it is:\n${result.text ?? "(empty)"}`;

const shareFields = {
  media_id: z.string().trim().regex(/^M-\d{4,}$/, 'Use the media id, e.g. "M-0001"').optional().describe("A media item of your library (media_list) to share"),
  result: z.string().trim().min(1).max(MURAL_LIMITS.text).optional().describe(`A result or text to share instead of a file (up to ${MURAL_LIMITS.text} characters)`),
  project_id: z.string().trim().max(80).optional().describe("The project this result belongs to (optional)"),
  title: z.string().trim().min(1).max(MURAL_LIMITS.title).describe("Short title in Brazilian Portuguese"),
  note: z.string().trim().max(MURAL_LIMITS.note).optional().describe("What it is and when to use it, in Brazilian Portuguese (shown to the other workspaces)"),
};

/** `mural_share`, `mural_list`, `mural_use`, `mural_unshare` de um Maestro ou agente de time. */
export function muralTools(deps: MuralToolsDeps): McpTool[] {
  return [
    defineTool({
      name: "mural_share",
      description:
        "Shares something GOOD you made with the platform mural so the OTHER workspaces can reuse it (e.g. a great image or video the Design workspace made, that LinkedIn and Instagram could use). Pass a media_id from your media library, or a `result` text. The other workspaces' Maestros are told the next time they wake up; nobody is woken for this. Share only what is genuinely reusable: at most 10 items per day. Sharing the same media again just updates its title and note.",
      input: z.object(shareFields),
      call: ({ media_id, result, project_id, title, note }) =>
        guarded(() => {
          if (!media_id && !result) return fail("Pass media_id (a media of your library) or result (a text).");
          const entry = deps.mural.share({ workspace: deps.workspace, by: deps.address, ...(media_id ? { mediaId: media_id } : {}), ...(result ? { text: result } : {}), ...(project_id ? { projectId: project_id } : {}), title, ...(note ? { note } : {}) });
          return ok(`Shared as ${entry.id} “${entry.title}”. The other workspaces will be told when their Maestro next wakes up. To take it back: mural_unshare("${entry.id}").`);
        }),
    }),
    defineTool({
      name: "mural_list",
      description: "Lists what the workspaces shared on the platform mural (newest first): id, title, who made it, note, who used it. `since` (ISO date) shows only newer items; `query` searches title, note and text. To use an item in this workspace call mural_use.",
      input: z.object({ query: z.string().trim().max(120).optional(), since: z.string().trim().max(40).optional().describe("ISO date: only items shared after it") }),
      call: ({ query, since }) => ok(listText(deps.mural.list({ ...(query ? { query } : {}), ...(since ? { since } : {}), limit: 30 }), deps, deps.workspace)),
    }),
    defineTool({
      name: "mural_use",
      description: "Brings a mural item into THIS workspace: a media item is copied into your media library (draft, with its origin in the note) so you can attach or publish it; a result/note is returned as text. You cannot read another workspace's files any other way. Use the id from mural_list or from the 'Novo no mural' notice.",
      input: z.object({ item_id: z.string().trim().regex(/^N-\d{4,}$/, 'Use the mural id, e.g. "N-0001"') }),
      call: ({ item_id }) => guarded(async () => ok(useText(item_id, await deps.mural.use(item_id, deps.workspace, deps.address, deps.agentId)))),
    }),
    defineTool({
      name: "mural_unshare",
      description: "Takes back an item YOUR workspace shared on the mural (it stops appearing for the others; copies already made stay).",
      input: z.object({ item_id: z.string().trim().regex(/^N-\d{4,}$/, 'Use the mural id, e.g. "N-0001"') }),
      call: ({ item_id }) =>
        guarded(() => {
          deps.mural.retire(item_id, deps.address, deps.workspace);
          return ok(`${item_id} was removed from the mural.`);
        }),
    }),
  ];
}

export type CynoMuralDeps = {
  mural: Pick<MuralService, "share" | "list" | "find" | "use" | "retire">;
  workspaces: () => { id: string; name: string }[];
  workspaceName: (id: string) => string | undefined;
};

/** As mesmas ferramentas para o Cyno: vê tudo e age em nome de um workspace (`workspace`). */
export function cynoMuralTools(deps: CynoMuralDeps): McpTool[] {
  const resolve = (ref: string): string => {
    const found = findByRef(deps.workspaces(), ref);
    if (!found) throw new Error(`No workspace "${ref}". Use list_workspaces.`);
    return found.id;
  };
  const workspaceField = z.string().trim().min(1).max(120).describe("Workspace id or name (see list_workspaces)");
  return [
    defineTool({
      name: "mural_share",
      description: "Shares a media item or a text of ONE workspace (on its behalf) with the platform mural, so the other workspaces can reuse it. media_id is an id of THAT workspace's library (the get_request_status deliveries list them). The other Maestros are told the next time they wake up; nobody is woken now. At most 10 items per day per workspace.",
      input: z.object({ workspace: workspaceField, ...shareFields }),
      call: ({ workspace, media_id, result, project_id, title, note }) =>
        guarded(() => {
          if (!media_id && !result) return fail("Pass media_id (a media of that workspace) or result (a text).");
          const entry = deps.mural.share({ workspace: resolve(workspace), by: "cyno", ...(media_id ? { mediaId: media_id } : {}), ...(result ? { text: result } : {}), ...(project_id ? { projectId: project_id } : {}), title, ...(note ? { note } : {}) });
          return ok(`Shared as ${entry.id} “${entry.title}” on behalf of ${entry.workspace}.`);
        }),
    }),
    defineTool({
      name: "mural_list",
      description: "Lists everything on the platform mural (newest first), with who shared it and who used it. `since` (ISO date) and `query` filter.",
      input: z.object({ query: z.string().trim().max(120).optional(), since: z.string().trim().max(40).optional() }),
      call: ({ query, since }) => ok(listText(deps.mural.list({ ...(query ? { query } : {}), ...(since ? { since } : {}), limit: 40 }), deps)),
    }),
    defineTool({
      name: "mural_use",
      description: "Copies a mural item into the media library of a workspace (on its behalf), with the origin recorded. Use it when the owner asks to put something from the mural in a workspace.",
      input: z.object({ workspace: workspaceField, item_id: z.string().trim().regex(/^N-\d{4,}$/, 'Use the mural id, e.g. "N-0001"') }),
      call: ({ workspace, item_id }) => guarded(async () => ok(useText(item_id, await deps.mural.use(item_id, resolve(workspace), "cyno", "cyno")))),
    }),
    defineTool({
      name: "mural_unshare",
      description: "Removes any item from the platform mural (copies already made stay in the workspaces).",
      input: z.object({ item_id: z.string().trim().regex(/^N-\d{4,}$/, 'Use the mural id, e.g. "N-0001"') }),
      call: ({ item_id }) =>
        guarded(() => {
          deps.mural.retire(item_id, "cyno");
          return ok(`${item_id} was removed from the mural.`);
        }),
    }),
  ];
}
