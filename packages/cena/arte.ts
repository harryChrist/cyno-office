// Porta de entrada só da arte do motor (arquivo nosso): desenhar o personagem e as cores dos temas fora da cena
// (painéis, listas, editor de avatar), sem puxar o mundo inteiro.
export { appearanceFromSeed, characterSprite, avatarCanvas, roomTheme } from './client/src/art';
export { THEME_COUNT } from './client/src/art/theme';
export type { Appearance, RoomTheme, Sprite } from './client/src/art/api';
// Peças puras da arte (buffer de pixels e cores) para quem desenha sprites nossos fora do motor: os bichos do Cyno.
export { PixelBuf } from './client/src/art/core/pixbuf';
export { mix, ramp, shade, withAlpha } from './client/src/art/core/color';
export type { Ramp } from './client/src/art/core/color';
export { TILE } from './client/src/art/api';
export { FURNITURE } from './client/src/art/api';
