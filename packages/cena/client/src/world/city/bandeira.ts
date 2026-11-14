// Arquivo nosso (não vem do Habblaud): o substituto mínimo de `cards.ts`, que ficou de fora (cartões de outros
// usuários). A cidade do Cyno é local e não tem país de dono; a função só existe para o `scene.ts` copiado.

/** Bandeira (emoji) de um código ISO-2; vazio se o código não tem o formato. */
export function flagEmoji(code: string | undefined | null): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return '';
  const up = code.toUpperCase();
  return String.fromCodePoint(0x1f1e6 + up.charCodeAt(0) - 65, 0x1f1e6 + up.charCodeAt(1) - 65);
}
