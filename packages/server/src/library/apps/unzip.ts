import { createWriteStream } from "node:fs";
import { chmod, mkdir, open, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";
import { isInside } from "./paths";

/** Limites contra "zip bomb" (o maior arquivo do Chrome Headless Shell tem ~190 MB). */
export const UNZIP_LIMITS = { maxEntries: 5000, maxFileBytes: 600 * 1024 * 1024, maxTotalBytes: 1500 * 1024 * 1024 };

type Entry = { name: string; method: number; compressed: number; size: number; offset: number; mode: number };

/** Lê o diretório central do .zip (sem zip64: os pacotes que usamos têm menos de 4 GB). */
async function readEntries(file: string): Promise<Entry[]> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const tailSize = Math.min(size, 22 + 65_535);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, size - tailSize);
    let end = -1;
    for (let i = tailSize - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error("o arquivo não parece um .zip válido");
    const count = tail.readUInt16LE(end + 10);
    const centralSize = tail.readUInt32LE(end + 12);
    const centralOffset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || centralOffset === 0xffffffff) throw new Error("zip64 não é suportado");
    if (count > UNZIP_LIMITS.maxEntries) throw new Error(`o .zip tem arquivos demais (${count})`);
    const central = Buffer.alloc(centralSize);
    await handle.read(central, 0, centralSize, centralOffset);
    const entries: Entry[] = [];
    let at = 0;
    for (let n = 0; n < count; n++) {
      if (at + 46 > central.length || central.readUInt32LE(at) !== 0x02014b50) throw new Error("o .zip está corrompido");
      const flags = central.readUInt16LE(at + 8);
      const method = central.readUInt16LE(at + 10);
      const compressed = central.readUInt32LE(at + 20);
      const original = central.readUInt32LE(at + 24);
      const nameLen = central.readUInt16LE(at + 28);
      const extraLen = central.readUInt16LE(at + 30);
      const commentLen = central.readUInt16LE(at + 32);
      const hostOs = central.readUInt16LE(at + 4) >> 8;
      const attrs = central.readUInt32LE(at + 38);
      const offset = central.readUInt32LE(at + 42);
      const name = central.subarray(at + 46, at + 46 + nameLen).toString("utf8");
      if (flags & 1) throw new Error("o .zip tem arquivo com senha");
      entries.push({ name, method, compressed, size: original, offset, mode: hostOs === 3 ? (attrs >>> 16) & 0o177777 : 0 });
      at += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/**
 * Descompacta um .zip dentro de `dest` (sem biblioteca e sem `unzip`): tira `strip` níveis de pasta,
 * mantém o bit de execução e recusa caminho que escape da pasta, link simbólico, arquivo grande
 * demais e soma acima do limite. Cada arquivo vai em fluxo (não carrega o pacote na memória).
 */
export async function unzipTo(zipFile: string, dest: string, options: { strip?: number; signal?: AbortSignal } = {}): Promise<{ files: number; bytes: number }> {
  const strip = options.strip ?? 0;
  const entries = await readEntries(zipFile);
  const base = path.resolve(dest);
  await mkdir(base, { recursive: true });
  const handle = await open(zipFile, "r");
  let files = 0;
  let bytes = 0;
  try {
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      const parts = entry.name.split("/").filter((part) => part !== "");
      if (parts.some((part) => part === ".." || part.includes("\0")) || entry.name.startsWith("/")) throw new Error(`caminho suspeito no .zip: ${entry.name}`);
      const kept = parts.slice(strip);
      if (kept.length === 0) continue;
      const target = path.join(base, ...kept);
      if (!isInside(target, [base])) throw new Error(`caminho suspeito no .zip: ${entry.name}`);
      const type = entry.mode & 0o170000;
      if (type === 0o120000) throw new Error(`link simbólico no .zip (recusado): ${entry.name}`);
      if (entry.name.endsWith("/")) {
        await mkdir(target, { recursive: true });
        continue;
      }
      if (entry.size > UNZIP_LIMITS.maxFileBytes) throw new Error(`arquivo grande demais no .zip: ${entry.name}`);
      bytes += entry.size;
      if (bytes > UNZIP_LIMITS.maxTotalBytes) throw new Error("o conteúdo do .zip passa do limite");
      const local = Buffer.alloc(30);
      await handle.read(local, 0, 30, entry.offset);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error("o .zip está corrompido");
      const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      await mkdir(path.dirname(target), { recursive: true });
      if (entry.method !== 0 && entry.method !== 8) throw new Error(`método de compressão não suportado (${entry.method}) em ${entry.name}`);
      const source = Readable.from(readRange(handle, start, entry.compressed));
      if (entry.method === 8) await pipeline(source, createInflateRaw(), createWriteStream(target));
      else await pipeline(source, createWriteStream(target));
      const written = (await stat(target)).size;
      if (written !== entry.size) throw new Error(`tamanho inesperado em ${entry.name} (${written} em vez de ${entry.size})`);
      await chmod(target, entry.mode & 0o111 ? 0o755 : 0o644);
      files++;
    }
  } finally {
    await handle.close();
  }
  return { files, bytes };
}

async function* readRange(handle: Awaited<ReturnType<typeof open>>, start: number, length: number): AsyncGenerator<Buffer> {
  const chunk = 1024 * 1024;
  let done = 0;
  while (done < length) {
    const size = Math.min(chunk, length - done);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, start + done);
    if (bytesRead === 0) throw new Error("o .zip termina antes do esperado");
    yield buffer.subarray(0, bytesRead);
    done += bytesRead;
  }
}
