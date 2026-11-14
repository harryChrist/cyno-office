import { inflateRawSync } from "node:zlib";
import { SKILL_LIMITS, skillSizeLabel, type SkillCeiling } from "@cyno/shared";
import { HttpError } from "../../platform/http/errors";
import type { SkillFile } from "./validate";


/**
 * Lê um .zip simples (diretório central, entradas "stored" ou "deflate"). Sem biblioteca: o formato
 * que as skills usam é só isso. Links simbólicos, arquivos com senha e conteúdo grande demais são recusados.
 */
export function readZip(buffer: Buffer, ceiling: SkillCeiling = SKILL_LIMITS): SkillFile[] {
  /** Soma máxima descompactada (contra "zip bomb"): o próprio teto técnico da skill. */
  const MAX_UNPACKED = ceiling.maxBytes;
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65_535); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new HttpError(400, "O arquivo não parece um .zip válido.");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  if (count > ceiling.maxFiles + 40) throw new HttpError(413, `O .zip tem arquivos demais (${count}; o teto técnico de segurança é ${ceiling.maxFiles}).`);
  const files: SkillFile[] = [];
  let unpacked = 0;
  for (let n = 0; n < count; n++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new HttpError(400, "O .zip está corrompido.");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttrs = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue; // pasta
    if (name.startsWith("__MACOSX/")) continue;
    if ((flags & 1) !== 0) throw new HttpError(400, "O .zip tem arquivos protegidos por senha.");
    if (((externalAttrs >>> 16) & 0o170000) === 0o120000) throw new HttpError(400, `O .zip tem um link simbólico ("${name}"): não é permitido.`);
    unpacked += size;
    if (unpacked > MAX_UNPACKED) throw new HttpError(413, `O conteúdo do .zip passa do teto técnico de segurança (${skillSizeLabel(MAX_UNPACKED)} descompactado).`);
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new HttpError(400, "O .zip está corrompido.");
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.min(MAX_UNPACKED, size + 1) });
      } catch {
        throw new HttpError(400, `Não consegui descompactar "${name}".`);
      }
    } else throw new HttpError(400, `O .zip usa um método de compactação não suportado em "${name}".`);
    files.push({ path: name, data });
  }
  return files;
}
