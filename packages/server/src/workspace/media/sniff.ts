import { MEDIA_EXT_MIME } from "@cyno/shared";
import path from "node:path";

/** Dimensões de uma imagem lidas só do cabeçalho (png, jpeg, webp, gif). undefined = não deu para ler. */
export function imageSize(buf: Buffer): { width: number; height: number } | undefined {
  const valid = (width: number, height: number) => (width > 0 && height > 0 && width < 100_000 && height < 100_000 ? { width, height } : undefined);
  // PNG: assinatura de 8 bytes, depois o chunk IHDR (largura e altura em big-endian).
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString("ascii", 12, 16) === "IHDR") return valid(buf.readUInt32BE(16), buf.readUInt32BE(20));
  // GIF: "GIF8" e largura/altura em little-endian logo depois.
  if (buf.length >= 10 && buf.toString("ascii", 0, 4) === "GIF8") return valid(buf.readUInt16LE(6), buf.readUInt16LE(8));
  // WebP: RIFF....WEBP com VP8 (lossy), VP8L (lossless) ou VP8X (estendido).
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const type = buf.toString("ascii", 12, 16);
    if (type === "VP8X") return valid(1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3));
    if (type === "VP8L") {
      const bits = buf.readUInt32LE(21);
      return valid(1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff));
    }
    if (type === "VP8 ") return valid(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
    return undefined;
  }
  // JPEG: percorre os marcadores até um SOF (0xC0..0xCF, menos DHT/JPG/DAC).
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buf[offset + 1]!;
      if (marker === 0xff) {
        offset++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = buf.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return valid(buf.readUInt16BE(offset + 7), buf.readUInt16BE(offset + 5));
      if (length < 2) return undefined;
      offset += 2 + length;
    }
  }
  return undefined;
}

/** Mime pelo "número mágico" (só os formatos binários); undefined = sem assinatura conhecida. */
export function sniffMime(buf: Buffer): string | undefined {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF") {
    const kind = buf.toString("ascii", 8, 12);
    if (kind === "WEBP") return "image/webp";
    if (kind === "WAVE") return "audio/wav";
  }
  if (buf.length >= 5 && buf.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp") return buf.toString("ascii", 8, 10) === "qt" ? "video/quicktime" : "video/mp4";
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3) return "video/webm";
  if (buf.length >= 4 && buf.toString("ascii", 0, 4) === "OggS") return "audio/ogg";
  if (buf.length >= 3 && buf.toString("ascii", 0, 3) === "ID3") return "audio/mpeg";
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) return "audio/mpeg";
  return undefined;
}

/** Mime pela extensão do nome (undefined = extensão fora da tabela; quem chama decide o genérico). */
export function mimeOfFileName(fileName: string): string | undefined {
  return MEDIA_EXT_MIME[path.extname(fileName).slice(1).toLowerCase()];
}

/** Famílias com assinatura que o app confere; qualquer outro tipo entra sem conferência de conteúdo. */
const ZIP_FAMILY = new Set([
  "application/zip",
  "application/epub+zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
]);
const SIGNED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "audio/wav", "application/pdf", "video/mp4", "video/quicktime", "video/webm", "audio/ogg", "audio/mpeg"]);

/**
 * O conteúdo bate com o mime declarado? Só os tipos com assinatura conhecida são conferidos (imagem, vídeo, áudio, PDF e
 * os formatos zip: docx, xlsx, pptx, odt, ods, epub, zip); textos não podem ter bytes nulos; SVG precisa ter "<svg".
 * Todos os outros tipos entram sem conferência.
 */
export function contentMatchesMime(mime: string, head: Buffer): boolean {
  if (mime === "image/svg+xml") return head.toString("utf8").includes("<svg");
  if (mime.startsWith("text/") || mime === "application/json") return !head.includes(0);
  if (ZIP_FAMILY.has(mime)) return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05) && (head[3] === 0x04 || head[3] === 0x06);
  if (!SIGNED.has(mime)) return true;
  const sniffed = sniffMime(head);
  if (!sniffed) return false;
  // O container Ogg também guarda vídeo; WebM/MP4/MOV são "irmãos" no mesmo tipo de assinatura.
  if ((mime === "video/mp4" || mime === "video/quicktime") && (sniffed === "video/mp4" || sniffed === "video/quicktime")) return true;
  return sniffed === mime;
}
