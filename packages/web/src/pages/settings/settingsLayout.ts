import { useEffect, useState } from "react";

/**
 * Como a página de Configurações se arruma conforme a largura da janela. Os pontos de quebra (390, 768, 1280,
 * 1680 e 2200 px) ficam só aqui; o CSS lê o resultado pelos atributos `data-cols` e `data-split` da página.
 *
 * - até 767 px (celular): uma coluna, o índice vira uma faixa rolável;
 * - 768 a 1279 px: uma coluna de leitura, índice ao lado;
 * - 1280 a 1679 px: uma coluna mais larga; os motores abrem num painel AO LADO da lista (`split`);
 * - 1680 a 2199 px: os cartões de cada seção em duas colunas;
 * - 2200 px ou mais: três colunas, sempre com uma largura máxima para o texto não esticar.
 */
export type SettingsLayout = {
  /** Quantas colunas de cartões cabem nas seções. */
  columns: 1 | 2 | 3;
  /** Motores: o detalhe abre ao lado da lista (em vez de embaixo do motor clicado). */
  split: boolean;
  /** Largura máxima do conteúdo do painel, em px. */
  maxWidth: number;
};

export const SETTINGS_BREAKPOINTS = { phone: 768, split: 1280, two: 1680, three: 2200 } as const;

export function settingsLayout(width: number): SettingsLayout {
  const { split, two, three } = SETTINGS_BREAKPOINTS;
  if (width >= three) return { columns: 3, split: true, maxWidth: 1880 };
  if (width >= two) return { columns: 2, split: true, maxWidth: 1360 };
  if (width >= split) return { columns: 1, split: true, maxWidth: 1040 };
  return { columns: 1, split: false, maxWidth: 920 };
}

/** O arranjo da janela agora (acompanha o redimensionamento). */
export function useSettingsLayout(): SettingsLayout {
  const [layout, setLayout] = useState(() => settingsLayout(window.innerWidth));
  useEffect(() => {
    const update = () => setLayout((current) => {
      const next = settingsLayout(window.innerWidth);
      return next.columns === current.columns && next.split === current.split ? current : next;
    });
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return layout;
}

const PHONE_QUERY = `(max-width: ${SETTINGS_BREAKPOINTS.phone - 1}px)`;

/** Janela de celular (a mesma que o CSS das Configurações trata como "uma coluna"); acompanha o redimensionamento. */
export function useIsPhone(): boolean {
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches;
  const [phone, setPhone] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(PHONE_QUERY);
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
}
