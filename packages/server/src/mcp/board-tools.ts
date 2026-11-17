import { mkdir } from "node:fs/promises";
import path from "node:path";
import { BOARD_GUIDE, BOARD_LIMITS, type Board } from "@cyno/shared";
import { z } from "zod";
import { errorMessage } from "../util/text";
import { writeFileAtomic } from "../store/atomic-write";
import { BoardToolError, readBoardInputFile, type BoardService } from "../workspace/board/board-service";
import { defineTool, type McpTool, type McpToolResult } from "./protocol";

/*
 * Quadros (contrato MCP em inglês). O agente guarda os dados num JSON e escreve a página HTML que o dono vê.
 * As descrições ficam curtas (todo agente as carrega): o texto longo está em `board_guide`, lido só quando
 * o agente precisa. Apagar quadro é só do dono.
 */

export type BoardToolsDeps = {
  boards: Pick<BoardService, "list" | "find" | "create" | "save" | "setData" | "patchData" | "readData" | "readPage">;
  /** Pasta do agente (data/workspaces/<ws>/agents/<id>). */
  agentDir: (agentId: string) => string;
  /** Pastas de trabalho do workspace que este agente pode ler (caminhos absolutos); vazio = só a pasta dele. */
  readableFolders?: (agentId: string) => string[];
};

const ok = (text: string): McpToolResult => ({ text });
const fail = (text: string): McpToolResult => ({ text, isError: true });
const idField = z.string().trim().regex(/^Q-\d{4,}$/, 'Use the board id, e.g. "Q-0001"');
const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

const describeBoard = (board: Board): string =>
  [
    `${board.id} “${board.title}” — ${board.description || "(no description)"}`,
    `page ${kb(board.pageBytes)} (updated ${board.pageUpdatedAt})`,
    `data ${kb(board.dataBytes)} (updated ${board.dataUpdatedAt})`,
    `by ${board.createdBy}`,
    board.source ? `source: ${board.source}` : "source: (not set)",
  ].join(" · ");

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Resumo do formato de um JSON (chaves, tamanhos das listas, um item de amostra) para o agente não ler tudo. */
export function summarizeJson(value: unknown): string {
  const sample = (item: unknown) => clip(JSON.stringify(item) ?? "null", 300);
  const kind = (item: unknown): string => {
    if (Array.isArray(item)) return `list of ${item.length} item${item.length === 1 ? "" : "s"}${item.length > 0 ? `; first item: ${sample(item[0])}` : ""}`;
    if (item !== null && typeof item === "object") {
      const keys = Object.keys(item);
      return `object with ${keys.length} key${keys.length === 1 ? "" : "s"}${keys.length > 0 ? `; first entry "${keys[0]}": ${sample((item as Record<string, unknown>)[keys[0]!])}` : ""}`;
    }
    return sample(item);
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return `Top level: ${kind(value)}`;
  const keys = Object.keys(value);
  if (keys.length === 0) return "Top level: empty object (no data yet).";
  const lines = keys.slice(0, 25).map((key) => `- ${key}: ${kind((value as Record<string, unknown>)[key])}`);
  if (keys.length > 25) lines.push(`- … and ${keys.length - 25} more keys`);
  return `Top level: object with ${keys.length} key${keys.length === 1 ? "" : "s"}\n${lines.join("\n")}`;
}

/** Ferramentas `board_*` de um agente (Maestro ou de time). */
export function boardTools(agentId: string, deps: BoardToolsDeps): McpTool[] {
  const guard = async (run: () => Promise<McpToolResult> | McpToolResult): Promise<McpToolResult> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof BoardToolError) return fail(error.message);
      throw error instanceof Error ? error : new Error(errorMessage(error));
    }
  };
  const readFileArg = (file: string, maxBytes: number) => readBoardInputFile(deps.agentDir(agentId), deps.readableFolders?.(agentId) ?? [], file, maxBytes);
  const exists = (id: string): Board => {
    const board = deps.boards.find(id);
    if (!board) throw new BoardToolError(`Board ${id} does not exist (see board_list).`);
    return board;
  };
  return [
    defineTool({
      name: "board_guide",
      description: "Returns the Board guide: what a Board is, the page contract, the optional kit (CSS classes, tables, charts, formatting) and two full examples. Read it BEFORE your first board_save.",
      input: z.object({}),
      call: () => ok(BOARD_GUIDE),
    }),
    defineTool({
      name: "board_list",
      description: "Lists this workspace's boards (id, title, description, sizes, dates, how the data is refreshed).",
      input: z.object({}),
      call: () => {
        const boards = deps.boards.list();
        return ok(boards.length === 0 ? "No boards yet." : boards.map(describeBoard).join("\n"));
      },
    }),
    defineTool({
      name: "board_save",
      description: "Creates a board (no id; needs title, description and the page) or updates one (id: new page and/or details). The page is HTML (max 1 MB) read from `html` or from a file via `html_path`; it shows the board data through Quadro.data (see board_guide). Returns the id.",
      input: z.object({
        id: idField.optional().describe("Omit to create a new board"),
        title: z.string().trim().min(1).max(BOARD_LIMITS.title).optional().describe("Short title in Brazilian Portuguese (required on create)"),
        description: z.string().trim().max(BOARD_LIMITS.description).optional().describe("One line, in Brazilian Portuguese: what the board shows (required on create)"),
        source: z.string().trim().max(BOARD_LIMITS.source).optional().describe('How the data is refreshed, for any agent to redo it later (e.g. "run python3 sync.py in folder Obras, then board_set_data"); "" clears it'),
        html: z.string().max(BOARD_LIMITS.pageBytes).optional().describe("The page HTML (a fragment is fine; <style> and <script> allowed)"),
        html_path: z.string().trim().min(1).max(500).optional().describe("Alternative to html: path of an HTML file in your folder (or an absolute path in a work folder you can read)"),
      }),
      call: ({ id, title, description, source, html, html_path }) =>
        guard(async () => {
          if (html !== undefined && html_path !== undefined) return fail("Pass html OR html_path, not both.");
          const page = html_path !== undefined ? await readFileArg(html_path, BOARD_LIMITS.pageBytes) : html;
          if (id === undefined) {
            if (!title) return fail("title is required to create a board.");
            if (description === undefined) return fail("description is required to create a board (one line: what it shows).");
            if (page === undefined) return fail("The page is required to create a board: pass html or html_path (read board_guide first).");
            const board = await deps.boards.create({ title, description, ...(source ? { source } : {}), html: page, createdBy: agentId });
            return ok(`Created ${board.id} “${board.title}” (page ${kb(board.pageBytes)}). Its data is empty: send it with board_set_data({ id: "${board.id}", json | path }).`);
          }
          exists(id);
          if (title === undefined && description === undefined && source === undefined && page === undefined) return fail("Nothing to change: pass title, description, source, html or html_path.");
          const board = await deps.boards.save(id, { ...(title !== undefined ? { title } : {}), ...(description !== undefined ? { description } : {}), ...(source !== undefined ? { source } : {}), ...(page !== undefined ? { html: page } : {}) });
          return ok(`Updated ${describeBoard(board)}`);
        }),
    }),
    defineTool({
      name: "board_set_data",
      description: "Replaces ALL the data of a board with JSON (any shape), given as text in `json` or as a JSON file via `path` (e.g. the output of your script; in your folder or an absolute path in a work folder you can read). Max 20 MB. The owner's page redraws live.",
      input: z.object({
        id: idField,
        json: z.string().max(BOARD_LIMITS.dataBytes).optional().describe("The data as JSON text"),
        path: z.string().trim().min(1).max(500).optional().describe("Alternative to json: path of a .json file"),
      }),
      call: ({ id, json, path: file }) =>
        guard(async () => {
          if ((json === undefined) === (file === undefined)) return fail("Pass exactly one of json or path.");
          exists(id);
          const text = file !== undefined ? await readFileArg(file, BOARD_LIMITS.dataBytes * 2) : json!;
          const board = await deps.boards.setData(id, { text });
          return ok(`Data of ${board.id} replaced (${kb(board.dataBytes)}). The page shows it now.`);
        }),
    }),
    defineTool({
      name: "board_patch_data",
      description: "Updates part of a board's data without resending everything: JSON Merge Patch (RFC 7396). Objects merge key by key, null deletes a key, arrays and other values replace the old one whole. Example: { \"works\": { \"w12\": { \"lastChapter\": 80 }, \"w13\": null } }.",
      input: z.object({
        id: idField,
        patch: z.union([z.record(z.string(), z.unknown()), z.string()]).describe("The patch, as an object or as JSON text"),
      }),
      call: ({ id, patch }) =>
        guard(async () => {
          exists(id);
          let value: unknown = patch;
          if (typeof patch === "string") {
            try {
              value = JSON.parse(patch);
            } catch (error) {
              return fail(`Invalid JSON in patch: ${error instanceof Error ? error.message : String(error)}.`);
            }
          }
          if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("The patch must be a JSON object (use board_set_data to replace everything).");
          const board = await deps.boards.patchData(id, value);
          return ok(`Data of ${board.id} patched (now ${kb(board.dataBytes)}). The page shows it now.`);
        }),
    }),
    defineTool({
      name: "board_read_data",
      description: "Saves the board's current data to a file in your folder (quadro/<id>.data.json) and returns its path plus a short summary of the format (keys, list sizes, a sample), so you do not read everything. With include_page, also saves the current page (quadro/<id>.page.html) so you can edit it and send it back with board_save(html_path).",
      input: z.object({
        id: idField,
        include_page: z.boolean().optional().describe("Also save the page HTML"),
      }),
      call: ({ id, include_page }) =>
        guard(async () => {
          const board = exists(id);
          const dir = path.join(deps.agentDir(agentId), "quadro");
          await mkdir(dir, { recursive: true });
          const raw = await deps.boards.readData(id);
          let value: unknown = {};
          let summary: string;
          try {
            value = JSON.parse(raw);
            summary = summarizeJson(value);
          } catch {
            summary = "The stored data is not valid JSON; replace it with board_set_data.";
          }
          const dataFile = `quadro/${id}.data.json`;
          await writeFileAtomic(path.join(dir, `${id}.data.json`), raw.length < 1024 * 1024 && value !== undefined ? `${JSON.stringify(value, null, 2)}\n` : raw);
          const lines = [`${describeBoard(board)}`, `Data saved to ${dataFile} (relative to your folder; ${kb(board.dataBytes)}).`, summary];
          if (include_page) {
            await writeFileAtomic(path.join(dir, `${id}.page.html`), await deps.boards.readPage(id));
            lines.push(`Page saved to quadro/${id}.page.html (${kb(board.pageBytes)}). Edit it, then call board_save({ id: "${id}", html_path: "quadro/${id}.page.html" }).`);
          }
          return ok(lines.join("\n"));
        }),
    }),
  ];
}

