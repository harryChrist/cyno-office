import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MediaItem } from "@cyno/shared";
import type { RenderInput } from "../browser/render";

/**
 * Prévia de uma mídia para o AGENTE olhar. Os CLIs rodam em modo restrito (só leem a própria pasta) e o
 * arquivo da biblioteca fica fora dela; então a prévia é uma cópia REDUZIDA gravada em `<pasta do agente>/previa/`
 * (lado maior de 1024 px, para não gastar contexto) e o caminho relativo volta no resultado da ferramenta.
 * O modo restrito não é afrouxado e a pasta `media/` continua fora de alcance.
 */
export const PREVIEW_DIR = "previa";
export const PREVIEW_SIDE = 1024;
/** Quantas prévias ficam na pasta (as mais antigas saem a cada nova). */
export const PREVIEW_KEEP = 24;

export type PreviewDeps = {
  /** Renderiza HTML em imagem (reduz imagens grandes e SVG); sem ele, a imagem grande vai sem reduzir. */
  render?: (input: RenderInput) => Promise<Buffer>;
  /** Caminho do ffmpeg, se houver um neste servidor (quadros de vídeo). */
  ffmpeg?: () => string | undefined;
};

export type Preview = {
  /** Caminhos relativos à pasta do agente (ex.: "previa/M-0001.png"). */
  files: string[];
  /** Aviso para o agente (reduzida, sem ffmpeg, tipo sem prévia...). */
  note?: string;
};

const RASTER = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Tamanho final mantendo a proporção, com o lado maior em `side` (ou menor, se já couber). */
export function fitSide(width: number, height: number, side = PREVIEW_SIDE): { width: number; height: number } {
  const big = Math.max(width, height);
  if (big <= side) return { width, height };
  const k = side / big;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

function run(bin: string, args: string[]): Promise<{ stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      resolve({ stderr: String(stderr), code: error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0 });
    });
  });
}

/** Mantém só as `PREVIEW_KEEP` prévias mais novas (por data de modificação). */
async function prune(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(path.join(dir, name)).catch(() => undefined))?.mtimeMs ?? 0 })));
  dated.sort((a, b) => b.at - a.at);
  await Promise.all(dated.slice(PREVIEW_KEEP).map((entry) => rm(path.join(dir, entry.name), { force: true })));
}

/** Reduz uma imagem grande (ou SVG) pelo navegador; undefined = não precisa (ou não dá) e vale a cópia. */
async function shrinkImage(item: MediaItem, file: string, dir: string, deps: PreviewDeps): Promise<Preview | undefined> {
  const known = item.width && item.height ? { width: item.width, height: item.height } : undefined;
  const svg = item.mime === "image/svg+xml";
  const big = known ? Math.max(known.width, known.height) > PREVIEW_SIDE : svg || item.size > 400 * 1024;
  if (!big || !deps.render) return undefined;
  const target = known ? fitSide(known.width, known.height) : { width: PREVIEW_SIDE, height: PREVIEW_SIDE };
  const data = (await readFile(file)).toString("base64");
  const jpeg = item.mime === "image/jpeg";
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff"><img src="data:${item.mime};base64,${data}" style="display:block;width:${target.width}px;height:${target.height}px;object-fit:contain">`;
  const image = await deps.render({ html, width: target.width, height: target.height, format: jpeg ? "jpeg" : "png", scale: 1 });
  const name = `${item.id}${jpeg ? ".jpg" : ".png"}`;
  await writeFile(path.join(dir, name), image);
  return { files: [`${PREVIEW_DIR}/${name}`], note: `Reduced to ${target.width}x${target.height} for viewing${known ? ` (original ${known.width}x${known.height})` : ""}.` };
}

async function videoFrames(item: MediaItem, file: string, dir: string, deps: PreviewDeps): Promise<Preview> {
  const ffmpeg = deps.ffmpeg?.();
  if (!ffmpeg) return { files: [], note: "No video tool on this server to extract frames. If you made the video, look at its frames with your own video tools (e.g. ffmpeg-skill look)." };
  const probe = await run(ffmpeg, ["-hide_banner", "-i", file]);
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(probe.stderr);
  const seconds = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
  const times = seconds > 0.5 ? [0.1, seconds / 2, Math.max(0.1, seconds - 0.2)] : [0];
  const labels = times.length === 1 ? ["start"] : ["start", "middle", "end"];
  const files: string[] = [];
  for (const [index, time] of times.entries()) {
    const name = `${item.id}-${labels[index]}.jpg`;
    const result = await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", time.toFixed(2), "-i", file, "-frames:v", "1", "-vf", `scale='min(${PREVIEW_SIDE},iw)':-2`, "-q:v", "3", "-y", path.join(dir, name)]);
    if (result.code === 0) files.push(`${PREVIEW_DIR}/${name}`);
  }
  if (files.length === 0) return { files, note: "Could not extract frames from this video." };
  return { files, note: `${files.length} frame${files.length === 1 ? "" : "s"} (${labels.slice(0, files.length).join(", ")}) at up to ${PREVIEW_SIDE}px.` };
}

/**
 * Grava a prévia de `item` (arquivo `file` da biblioteca) em `<agentDir>/previa/`. Imagem: cópia, reduzida
 * se passar de 1024 px; vídeo: três quadros; o resto não tem prévia visual.
 */
export async function writePreview(item: MediaItem, file: string, agentDir: string, deps: PreviewDeps = {}): Promise<Preview> {
  if (item.kind !== "image" && item.kind !== "video") return { files: [], note: `A ${item.kind} cannot be viewed as an image (media_list shows its details).` };
  const dir = path.join(agentDir, PREVIEW_DIR);
  await mkdir(dir, { recursive: true });
  let preview: Preview | undefined;
  if (item.kind === "video") preview = await videoFrames(item, file, dir, deps);
  else {
    preview = await shrinkImage(item, file, dir, deps).catch(() => undefined);
    if (!preview) {
      if (!RASTER.has(item.mime) && item.mime !== "image/svg+xml") return { files: [], note: `Image type ${item.mime} cannot be previewed.` };
      const name = `${item.id}${path.extname(file) || ".png"}`;
      await copyFile(file, path.join(dir, name));
      preview = { files: [`${PREVIEW_DIR}/${name}`] };
    }
  }
  await prune(dir);
  return preview;
}
