// CYNO-PATCH 4: substituto do i18n do Habblaud. O Cyno é só pt-BR: tr() devolve o texto em português,
// trocando as lacunas {0}, {1}... por `args` (mesma semântica do original). Os dicionários (en, es, fr)
// não vêm. Para voltar a ter outros idiomas, restaurar o shared/i18n.ts original e shared/locales/.

export type Locale = 'pt-BR' | 'en' | 'es' | 'fr';

export const LOCALES: { id: Locale; name: string }[] = [{ id: 'pt-BR', name: 'Português' }];

export const LOCALE_STORAGE_KEY = 'cyno:locale';

export function normalizeLocale(_v: string | null | undefined): Locale | undefined {
  return 'pt-BR';
}

export function serverLocale(_env: Record<string, string | undefined>, _intl?: string): Locale {
  return 'pt-BR';
}

export function registerDictionary(_l: Locale, _dict: Readonly<Record<string, string>>): void {}

export function getLocale(): Locale {
  return 'pt-BR';
}

export function setLocale(_l: Locale): void {}

/** Devolve o texto em PT, com as lacunas numeradas trocadas por `args`; lacuna sem argumento fica como está. */
export function tr(src: string, args?: readonly unknown[]): string {
  if (!args || args.length === 0) return src;
  return src.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m));
}

export function intlLocale(): string {
  return 'pt-BR';
}
