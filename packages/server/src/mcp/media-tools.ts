import { MEDIA_LIMITS, MEDIA_STATUSES, type MediaItem } from "@cyno/shared";
import { z } from "zod";
import { RENDER_MAX_SIDE, type RenderInput } from "../workspace/browser/render";
import { MediaToolError, type MediaService } from "../workspace/media/media-service";
import { PREVIEW_SIDE, writePreview } from "../workspace/media/preview";
import { errorMessage } from "../util/text";
import { defineTool, type McpTool, type McpToolResult } from "./protocol";

/*
 * Biblioteca de mídia (contrato MCP em inglês). O agente cria imagens (HTML renderizado) ou guarda
 * arquivos que fez na própria pasta; depois anexa ao pedido de aprovação (`request_approval` com
 * `mediaIds`) e marca como publicado com o link. Apagar mídia é só do usuário.
 */

export type MediaToolsDeps = {
  media: Pick<MediaService, "list" | "find" | "update" | "addBuffer" | "importFile" | "fileOf" | "missing">;
  /** Pasta do agente (data/workspaces/<ws>/agents/<id>). */
  agentDir: (agentId: string) => string;
  /** Tarefa em curso do agente (a mídia nova fica ligada a ela). */
  currentTask: (agentId: string) => { id: string; projectId?: string } | undefined;
  /** Renderiza HTML em imagem (undefined = sem navegador neste servidor). */
  render?: (input: RenderInput) => Promise<Buffer>;
  /** Caminho do ffmpeg, se houver (quadros de vídeo na prévia). */
  ffmpeg?: () => string | undefined;
};

const ok = (text: string): McpToolResult => ({ text });
const fail = (text: string): McpToolResult => ({ text, isError: true });

const describe = (item: MediaItem): string =>
  [
    `${item.id} “${item.title}” — ${item.kind} ${item.mime}${item.width ? ` ${item.width}x${item.height}` : ""}, ${Math.round(item.size / 1024)} KB`,
    `status ${item.status}`,
    `by ${item.createdBy}`,
    item.taskId ? `task ${item.taskId}` : "",
    item.forYouIds?.length ? `approval ${item.forYouIds.join(",")}` : "",
    item.where ? `where: ${item.where}` : "",
    item.publishedUrl ? `published at ${item.publishedUrl}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

/** Ferramentas `media_*` de um agente (Maestro ou de time). */
export function mediaTools(agentId: string, deps: MediaToolsDeps): McpTool[] {
  const link = () => {
    const task = deps.currentTask(agentId);
    return task ? { taskId: task.id, rootTaskId: task.projectId ?? task.id } : {};
  };
  const guard = async (run: () => Promise<McpToolResult> | McpToolResult): Promise<McpToolResult> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof MediaToolError) return fail(error.message);
      throw error instanceof Error ? error : new Error(errorMessage(error));
    }
  };
  /** Grava a prévia reduzida na pasta do agente e diz como abrir (nunca derruba a ferramenta que a pediu). */
  const previewText = async (item: MediaItem): Promise<string> => {
    try {
      const preview = await writePreview(item, deps.media.fileOf(item), deps.agentDir(agentId), { ...(deps.render ? { render: deps.render } : {}), ...(deps.ffmpeg ? { ffmpeg: deps.ffmpeg } : {}) });
      if (preview.files.length === 0) return preview.note ?? "";
      return `LOOK AT IT: open ${preview.files.map((file) => `"${file}"`).join(", ")} with your file-reading tool (path relative to your folder). ${preview.note ?? ""}`.trim();
    } catch (error) {
      return `Preview not available (${errorMessage(error)}); try media_view("${item.id}").`;
    }
  };
  const tools: McpTool[] = [];
  if (deps.render) {
    const render = deps.render;
    tools.push(
      defineTool({
        name: "media_render_html",
        description: [
          "Renders HTML+CSS to an image (e.g. a LinkedIn post image, a cover, a card) and saves it in the workspace media library, linked to your current task. Returns the media id (use it in request_approval mediaIds). The library file is outside your folder, so the result also saves a reduced preview (max 1024 px) in your folder (previa/<id>.png) and gives its relative path: ALWAYS open it with your file-reading tool and check the layout (text size, cut-offs, contrast) before sending it for approval; if it looks bad, render again. media_view re-opens any library item later.",
          `Rendered in an isolated, clean browser: JavaScript is disabled (use plain HTML/CSS only), no logins, local network blocked; the internet is allowed so web fonts and images load (e.g. a Google Fonts <link>). Width/height are the image size in px (max ${RENDER_MAX_SIDE}); scale 2 doubles the pixels for sharpness.`,
          "Pass a complete HTML document and size the layout to exactly width x height (e.g. body margin 0). If the layout needs fixing, render again (the new image gets its own id).",
        ].join(" "),
        input: z.object({
          html: z.string().min(1).max(300_000).describe("Complete HTML document (inline CSS; no scripts)"),
          width: z.number().int().min(16).max(RENDER_MAX_SIDE).describe("Image width in px (LinkedIn post: 1200)"),
          height: z.number().int().min(16).max(RENDER_MAX_SIDE).describe("Image height in px (LinkedIn post: 627 or 1200)"),
          title: z.string().trim().min(1).max(MEDIA_LIMITS.title).describe("Short title in Brazilian Portuguese (shown in the gallery)"),
          format: z.enum(["png", "jpeg"]).optional().describe("png (default, sharp text) or jpeg (smaller photos)"),
          scale: z.union([z.literal(1), z.literal(2)]).optional().describe("Pixel density: 1 (default) or 2"),
        }),
        call: ({ html, width, height, title, format, scale }) =>
          guard(async () => {
            const fmt = format ?? "png";
            let image: Buffer;
            try {
              image = await render({ html, width, height, format: fmt, scale: scale ?? 1 });
            } catch (error) {
              return fail(`Could not render the HTML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
            }
            const item = await deps.media.addBuffer(image, fmt === "png" ? "image/png" : "image/jpeg", { title, createdBy: agentId, origin: "html", fileName: `${title}.${fmt === "png" ? "png" : "jpg"}`, ...link() });
            return ok(`Saved ${item.id} “${item.title}” (${item.width ?? width}x${item.height ?? height}, ${Math.round(item.size / 1024)} KB). ${await previewText(item)} Attach it to the approval with request_approval(mediaIds: ["${item.id}"]).`);
          }),
      }),
    );
  }
  tools.push(
    defineTool({
      name: "media_save_file",
      description: `Copies a file you made (in YOUR OWN agent folder, your working directory) into the workspace media library, linked to your current task. Returns the media id (use it in request_approval mediaIds). Accepted: png, jpg, webp, gif, svg, mp4, webm, mov, mp3, wav, ogg, pdf, txt, md, csv, json, html. Limits: image 25 MB, video 300 MB, audio 50 MB, other 50 MB. Files outside your folder (or links leaving it) are refused.`,
      input: z.object({
        path: z.string().trim().min(1).max(500).describe("Path of the file, relative to your folder (or absolute inside it)"),
        title: z.string().trim().min(1).max(MEDIA_LIMITS.title).describe("Short title in Brazilian Portuguese"),
        note: z.string().trim().max(MEDIA_LIMITS.note).optional().describe("Optional note about the file"),
      }),
      call: ({ path: file, title, note }) =>
        guard(async () => {
          const item = await deps.media.importFile(deps.agentDir(agentId), file, { title, createdBy: agentId, ...(note ? { note } : {}), ...link() });
          return ok(`Saved ${item.id} “${item.title}” (${item.kind}, ${Math.round(item.size / 1024)} KB). Attach it to the approval with request_approval(mediaIds: ["${item.id}"]).`);
        }),
    }),
    defineTool({
      name: "media_view",
      description: `Lets you LOOK at an item of the workspace media library (image, or a video's start/middle/end frames). The library folder is outside your folder, so this saves a reduced copy (max ${PREVIEW_SIDE} px) in your folder (previa/<id>.png) and returns its relative path: open it with your file-reading tool. Use it to review your own work or any item from media_list.`,
      input: z.object({ id: z.string().trim().regex(/^M-\d{4,}$/, 'Use the media id, e.g. "M-0001"') }),
      call: ({ id }) =>
        guard(async () => {
          const item = deps.media.find(id);
          if (!item) return fail(`Media ${id} does not exist (see media_list).`);
          return ok(`${describe(item)}\n${await previewText(item)}`);
        }),
    }),
    defineTool({
      name: "media_list",
      description: "Lists items of the workspace media library (newest first): id, title, kind, status, who made it, task, approval and where it was published. Filter by task, kind or status.",
      input: z.object({
        taskId: z.string().trim().max(80).optional().describe("Only media linked to this task (or its request)"),
        kind: z.enum(["image", "video", "audio", "document", "other"]).optional(),
        status: z.enum(MEDIA_STATUSES).optional().describe("rascunho (draft), aprovado (approved), publicado (published), descartado (discarded)"),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
      }),
      call: ({ taskId, kind, status, limit }) => {
        const items = deps.media.list({ ...(taskId ? { taskId } : {}), ...(kind ? { kind } : {}), ...(status ? { status } : {}), limit: limit ?? 20 });
        return ok(items.length === 0 ? "No media found." : items.map(describe).join("\n"));
      },
    }),
    defineTool({
      name: "media_update",
      description: `Updates a media item, e.g. after publishing: set status "publicado" with the post URL (publishedUrl) and where (e.g. "Post no LinkedIn"). You cannot set "aprovado" (that comes from the user's approval) and cannot delete media (only the user can).`,
      input: z.object({
        id: z.string().trim().regex(/^M-\d{4,}$/, 'Use the media id, e.g. "M-0001"'),
        title: z.string().trim().min(1).max(MEDIA_LIMITS.title).optional(),
        status: z.enum(["rascunho", "publicado", "descartado"]).optional().describe("publicado = published, descartado = discarded, rascunho = draft"),
        publishedUrl: z.string().trim().max(MEDIA_LIMITS.url).optional().describe("Full link of where it was published"),
        where: z.string().trim().max(MEDIA_LIMITS.where).optional().describe('Where it was published/used, in Brazilian Portuguese (e.g. "Post no LinkedIn")'),
        note: z.string().trim().max(MEDIA_LIMITS.note).optional(),
      }),
      call: ({ id, ...patch }) => {
        if (!deps.media.find(id)) return fail(`Media ${id} does not exist (see media_list).`);
        if (Object.values(patch).every((value) => value === undefined)) return fail("Nothing to change: pass title, status, publishedUrl, where or note.");
        const item = deps.media.update(id, patch);
        return ok(`Updated: ${describe(item)}`);
      },
    }),
  );
  return tools;
}
