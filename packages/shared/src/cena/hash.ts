/** Hash FNV-1a de 32 bits (o mesmo do motor): determinístico, serve de semente visual e de desempate estável. */
export function hash32(entrada: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < entrada.length; i++) {
    h ^= entrada.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
