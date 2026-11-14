/** Junta espaços e corta com "…" se passar de `max` caracteres. */
export function shorten(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
