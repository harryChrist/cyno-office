// Teste nosso (não vem do Habblaud): o substituto do tr() mantém o português e a interpolação.
import { describe, expect, it } from 'vitest';
import { getLocale, intlLocale, normalizeLocale, serverLocale, tr } from './i18n';

describe('tr() (substituto pt-BR)', () => {
  it('devolve o texto sem argumentos', () => {
    expect(tr('Aprovado')).toBe('Aprovado');
    expect(tr('Aprovado', [])).toBe('Aprovado');
  });

  it('troca as lacunas numeradas, em qualquer ordem e repetidas', () => {
    expect(tr('{0} abriu o PR #{1}', ['Ana', 12])).toBe('Ana abriu o PR #12');
    expect(tr('{1} depois de {0}; {0} de novo', ['a', 'b'])).toBe('b depois de a; a de novo');
  });

  it('deixa a lacuna sem argumento como está e converte valores não textuais', () => {
    expect(tr('{0} e {1}', ['x'])).toBe('x e {1}');
    expect(tr('{0}', [0])).toBe('0');
    expect(tr('{0}', [null])).toBe('null');
  });

  it('o idioma é sempre pt-BR', () => {
    expect(getLocale()).toBe('pt-BR');
    expect(intlLocale()).toBe('pt-BR');
    expect(normalizeLocale('fr-FR')).toBe('pt-BR');
    expect(serverLocale({ LANG: 'fr_FR.UTF-8' })).toBe('pt-BR');
  });
});
