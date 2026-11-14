// Testes do gancho de extras (arquivo nosso; ver PATCHES.md, patches 11 e 12).
import { describe, expect, it, vi } from 'vitest';
import { createExtras, extraAt, inExtraRect, type ExtraEntity } from './extras';

const extra = (id: string, y: number, over: Partial<ExtraEntity> = {}): ExtraEntity => ({
  id,
  y,
  visible: true,
  draw: () => undefined,
  hit: () => ({ x: 10, y: 10, w: 10, h: 10 }),
  ...over,
});

describe('extras do motor', () => {
  it('a área de clique inclui a borda de cima/esquerda e exclui a de baixo/direita', () => {
    const r = { x: 10, y: 10, w: 4, h: 4 };
    expect(inExtraRect(r, 10, 10)).toBe(true);
    expect(inExtraRect(r, 13.9, 13.9)).toBe(true);
    expect(inExtraRect(r, 14, 12)).toBe(false);
    expect(inExtraRect(r, 9.9, 12)).toBe(false);
  });

  it('no clique vence o extra mais à frente (maior y), ignora invisível e sem área', () => {
    const atras = extra('atras', 20);
    const frente = extra('frente', 30);
    const escondido = extra('escondido', 99, { visible: false });
    const semArea = extra('semArea', 100, { hit: undefined });
    expect(extraAt([atras, frente, escondido, semArea], 12, 12)?.id).toBe('frente');
    expect(extraAt([atras, frente], 50, 50)).toBeNull();
  });

  it('add registra e devolve quem remove; a lista é a mesma entregue ao renderer', () => {
    const host = createExtras();
    const lista = host.entities;
    const a = extra('a', 1);
    const remover = host.add(a);
    expect(lista).toEqual([a]);
    expect(host.list()).toBe(lista);
    remover();
    expect(lista).toEqual([]);
    remover();
    expect(lista).toEqual([]);
  });

  it('onFrame recebe cada quadro e para depois de desligado', () => {
    const host = createExtras();
    const cb = vi.fn();
    const off = host.onFrame(cb);
    host.frame({ dt: 0.016, now: 1000, playback: false });
    off();
    host.frame({ dt: 0.016, now: 2000, playback: false });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ dt: 0.016, now: 1000, playback: false });
  });

  it('o clique é despachado aos ouvintes: true se algum tratou, false se nenhum', () => {
    const host = createExtras();
    const e = extra('e', 1);
    expect(host.dispatchClick(e, { x: 1, y: 2 })).toBe(false);
    const recusa = vi.fn(() => false);
    const aceita = vi.fn(() => true);
    host.onClick(recusa);
    expect(host.dispatchClick(e, { x: 1, y: 2 })).toBe(false);
    host.onClick(aceita);
    expect(host.dispatchClick(e, { x: 3, y: 4 })).toBe(true);
    expect(aceita).toHaveBeenCalledWith(e, { x: 3, y: 4 });
  });
});
