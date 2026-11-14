import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** TOTP (RFC 6238) com SHA-1, 6 dígitos e passo de 30 s: o que os apps autenticadores esperam. */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Tolerância de relógio: o passo anterior e o seguinte também valem. */
export const TOTP_WINDOW = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("base32 inválido");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Segredo novo: 20 bytes (160 bits, o tamanho do SHA-1) em base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** HOTP (RFC 4226) de um contador. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 15;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export const totpStep = (timeMs: number) => Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS);

/** O código TOTP de um instante (base32 do segredo). */
export function totpCode(secret: string, timeMs: number, digits = TOTP_DIGITS): string {
  return hotp(base32Decode(secret), totpStep(timeMs), digits);
}

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Confere o código na janela ±1. Devolve o passo que bateu, ou null. `lastStep`: o último passo já
 * usado; um código de um passo igual ou anterior é recusado (o mesmo código não vale duas vezes).
 */
export function verifyTotp(secret: string, code: string, timeMs: number, lastStep = -1): number | null {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const key = base32Decode(secret);
  const current = totpStep(timeMs);
  let found: number | null = null;
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    // Sem atalho: testa todos os passos para o tempo não revelar qual bateu.
    if (safeEqual(hotp(key, step), digits) && step > lastStep && (found === null || step > found)) found = step;
  }
  return found;
}

/** `otpauth://` que os apps leem pelo QR (ou digitando o segredo). */
export function otpauthUri(secret: string, label = "Cyno", issuer = "Cyno"): string {
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

/** Alfabeto dos códigos de recuperação: sem caracteres ambíguos. */
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const RECOVERY_CODE_COUNT = 10;

/** 10 códigos de uso único no formato XXXXX-XXXXX (50 bits cada). */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const pick = () => Array.from({ length: 5 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join("");
  return Array.from({ length: count }, () => `${pick()}-${pick()}`);
}

/** Forma canônica de um código de recuperação digitado (sem hífen/espaço, maiúsculas). */
export const normalizeRecoveryCode = (input: string) => input.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Só o hash fica guardado (os códigos têm entropia alta: sha256 basta). */
export const hashRecoveryCode = (code: string) => createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
