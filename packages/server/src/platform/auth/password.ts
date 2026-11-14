import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { z } from "zod";

/** Parâmetros do scrypt gravados junto do hash (um dia podem subir sem invalidar a senha antiga). */
const scryptParams = z.object({ N: z.number().int().min(1024), r: z.number().int().min(1), p: z.number().int().min(1), keylen: z.number().int().min(16).max(128) });

export const passwordHashSchema = z.object({
  algo: z.literal("scrypt"),
  params: scryptParams,
  salt: z.string().min(1),
  hash: z.string().min(1),
});
export type PasswordHash = z.infer<typeof passwordHashSchema>;

/** N = 2^17 (≈128 MB e algumas centenas de ms por hash). Hashes antigos (N = 2^14) seguem valendo: os parâmetros ficam gravados. */
export const DEFAULT_PARAMS = { N: 131072, r: 8, p: 1, keylen: 64 } as const;

/** No máximo 2 hashes ao mesmo tempo (cada um usa ~128 MB): um flood de tentativas espera na fila em vez de estourar a memória. */
const MAX_CONCURRENT = 2;
let running = 0;
const waiting: Array<() => void> = [];
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function derive(password: string, salt: Buffer, params: PasswordHash["params"]): Promise<Buffer> {
  const options: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r + 1024 * 1024 };
  return slot(() => new Promise<Buffer>((resolve, reject) => scrypt(password.normalize("NFKC"), salt, params.keylen, options, (error, key) => (error ? reject(error) : resolve(key)))));
}

/** Hash scrypt com sal aleatório. A senha em texto nunca é guardada nem logada. */
export async function hashPassword(password: string, params: PasswordHash["params"] = DEFAULT_PARAMS): Promise<PasswordHash> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, params);
  return { algo: "scrypt", params: { ...params }, salt: salt.toString("base64"), hash: key.toString("base64") };
}

/** Confere a senha comparando os hashes em tempo constante. */
export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const expected = Buffer.from(stored.hash, "base64");
  const key = await derive(password, Buffer.from(stored.salt, "base64"), stored.params);
  return key.length === expected.length && timingSafeEqual(key, expected);
}
