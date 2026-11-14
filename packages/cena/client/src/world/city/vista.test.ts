// Teste nosso: os limites que a vista enquadra e o estado que o `aplicar` alimenta (sem canvas).
import { describe, expect, it } from 'vitest';
import { TILE } from '../../art/api';
import { lotOrigin, LOT } from '../../../../shared/world/city';
import { limitesDaCidade } from './vista';
import { CityState } from './state';
import { facadeModel } from './facade';
import { PRACA_VAZIA } from './praca';

const lote = (x: number, y: number) => ({ lot: { district: 'cyno', x, y } });

describe('limitesDaCidade', () => {
  it('sem prédios enquadra só a praça', () => {
    const r = limitesDaCidade([]);
    expect(r.x).toBe(0);
    expect(r.w).toBe(42 * TILE);
    expect(r.h).toBeGreaterThan(24 * TILE);
  });

  it('cresce até o último lote usado', () => {
    const r = limitesDaCidade([lote(3, 0), lote(5, 1)]);
    const o = lotOrigin({ x: 5, y: 1 });
    expect(r.x + r.w).toBeGreaterThanOrEqual((o.x + LOT.w) * TILE);
    expect(r.y + r.h).toBeGreaterThanOrEqual((o.y + LOT.h) * TILE);
  });

  it('sem a praça, enquadra só os lotes usados', () => {
    const r = limitesDaCidade([lote(3, 0), lote(5, 1)], false);
    expect(r.x).toBe(lotOrigin({ x: 3, y: 0 }).x * TILE);
    expect(r.x).toBeGreaterThan(0);
    expect(limitesDaCidade([], false).x).toBe(0);
  });

  it('o núcleo corta o gramado de cima e de baixo da praça e segue a altura da fachada mais alta', () => {
    const cheio = limitesDaCidade([lote(3, 0)]);
    const nucleo = limitesDaCidade([{ ...lote(3, 0), floors: 4 }], true, true);
    // Mesma largura, bem menos altura: os prédios crescem numa faixa baixa e larga.
    expect(nucleo.x).toBe(cheio.x);
    expect(nucleo.w).toBe(cheio.w);
    expect(nucleo.h).toBeLessThan(cheio.h);
    // A folga ao norte acompanha os andares (2 por tile, de 2 a 6): 4 andares = 2 tiles; 24 andares = 6 tiles.
    const alto = limitesDaCidade([{ ...lote(3, 0), floors: 24 }], true, true);
    expect(alto.h - nucleo.h).toBe(4 * TILE);
    // Sem prédios o núcleo não muda a conta da folga (só a praça).
    expect(limitesDaCidade([], true, true).h).toBeLessThan(limitesDaCidade([]).h);
  });

  it('um lote a oeste da praça puxa o limite para a esquerda', () => {
    const r = limitesDaCidade([lote(-3, 0)]);
    expect(r.x).toBeLessThan(0);
  });
});

describe('a cidade sem rede', () => {
  it('o estado guarda o prédio pelo lote', () => {
    const estado = new CityState();
    const b = { id: 'ws1', lot: { district: 'cyno', x: 3, y: 0 }, owner: { id: 'ws1', name: 'Loja' }, state: 'online', theme: 'none', floors: 1, rev: 1, likes: 0, sinceMonth: '2026-11' } as const;
    estado.applySnapshot({ stream: 'cyno', connected: true, viewing: true, afk: false, chunks: [{ chunk: 'cyno:0,0', rev: 1, buildings: [b] }], players: [], minimap: null }, 0);
    expect(estado.buildingAt({ x: 3, y: 0 })?.id).toBe('ws1');
    expect(estado.buildingAt({ x: 4, y: 0 })).toBeUndefined();
  });

  it('a praça vazia não tem meta nem prédios acesos', () => {
    expect(PRACA_VAZIA).toEqual({ acesos: 0, agentes: 0, meta: null });
  });

  it('o modelo da fachada acende pelo número de agentes trabalhando', () => {
    const m = facadeModel({ floors: 1, state: 'online', theme: 'none', agents: { total: 4, working: 2, waiting: 1, idle: 1 } }, 'front', 1);
    expect(m.lit.length).toBeGreaterThan(0);
    expect(m.waiting.length).toBeGreaterThan(0);
  });
});
