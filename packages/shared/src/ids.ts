/** Id fixo do lobby (espaço especial, não é um Room). */
export const LOBBY_ID = "lobby";
/** Id da pasta do Cérebro global (data/brains/global/). */
export const GLOBAL_BRAIN_ID = "global";
/** Ids que nenhum quarto pode usar. */
export const RESERVED_ROOM_IDS: readonly string[] = [LOBBY_ID, GLOBAL_BRAIN_ID];

export const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const MAX_ID_LENGTH = 64;

/** Id seguro para usar em URLs e nomes de pasta. */
export function isSafeId(id: string): boolean {
  return id.length <= MAX_ID_LENGTH && SAFE_ID_PATTERN.test(id);
}

export function isReservedRoomId(id: string): boolean {
  return RESERVED_ROOM_IDS.includes(id);
}

/** "Conteúdo & Revisão" -> "conteudo-revisao". Retorna `fallback` se nada sobrar. */
export function slugify(input: string, fallback = "item"): string {
  const slug = input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ID_LENGTH - 4)
    .replace(/-+$/g, "");
  return slug || fallback;
}

/**
 * Gera um id seguro a partir de um nome, sem colidir com `taken` nem `reserved`:
 * "lia", "lia-2", "lia-3"...
 */
export function uniqueSlug(
  name: string,
  taken: Iterable<string>,
  reserved: readonly string[] = [],
): string {
  const used = new Set(taken);
  const base = slugify(name);
  const isFree = (id: string) => !used.has(id) && !reserved.includes(id);
  if (isFree(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (isFree(candidate)) return candidate;
  }
}
