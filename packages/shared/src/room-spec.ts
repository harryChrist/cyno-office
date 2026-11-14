/**
 * Contrato da geração de salas: tamanhos (piso inicial, com quantas mesas cabem mais ou menos),
 * tipos de sala (função do time, que decide os móveis) e a semente do layout. O layout (web,
 * `office/layout`) começa no piso do tamanho e cresce se os times precisarem.
 */

/** Semente do layout procedural: o mesmo quarto + a mesma semente = o mesmo layout. */
export const LAYOUT_SEED_MAX = 2 ** 31 - 1;

/** "auto" = a sala cresce com os times/agentes (padrão; comportamento dos quartos antigos). */
export const ROOM_SIZES = ["auto", "p", "m", "g", "gg"] as const;
export type RoomSize = (typeof ROOM_SIZES)[number];

/**
 * Um tamanho fixo é só o piso INICIAL (mínimo) da sala: se os times precisarem de mais espaço, a
 * sala cresce sozinha além dele. Não há limite de times nem de mesas (nada é recusado).
 */
export type RoomSizeSpec = {
  label: string;
  /** Texto curto para o seletor ("10×10 · cabem ~4 mesas"). */
  hint: string;
  /** Piso inicial em tiles (largura × profundidade); null em "auto". */
  tiles: { w: number; h: number } | null;
  /**
   * Mesas que cabem (aprox.) nesse piso sem a sala crescer: só informação, nunca um limite (o nome
   * ficou do contrato antigo); null em "auto".
   */
  maxDesks: number | null;
};

export const ROOM_SIZE_SPECS: Record<RoomSize, RoomSizeSpec> = {
  auto: { label: "Automático", hint: "cresce conforme os times e agentes", tiles: null, maxDesks: null },
  p: { label: "Pequena", hint: "10×11 · cabem ~4 mesas", tiles: { w: 10, h: 11 }, maxDesks: 4 },
  m: { label: "Média", hint: "13×12 · cabem ~8 mesas", tiles: { w: 13, h: 12 }, maxDesks: 8 },
  g: { label: "Grande", hint: "16×14 · cabem ~12 mesas", tiles: { w: 16, h: 14 }, maxDesks: 12 },
  gg: { label: "Enorme", hint: "20×16 · cabem ~18 mesas", tiles: { w: 20, h: 16 }, maxDesks: 18 },
};

export function isRoomSize(value: unknown): value is RoomSize {
  return typeof value === "string" && (ROOM_SIZES as readonly string[]).includes(value);
}

/**
 * Só informação: `desks` mesas cabem no piso inicial desse tamanho sem a sala crescer? ("auto"
 * sempre cabe.) Nada é bloqueado por isso: a sala cresce sozinha.
 */
export function fitsInitialSize(size: RoomSize, desks: number): boolean {
  const spec = ROOM_SIZE_SPECS[size];
  return spec.maxDesks === null || desks <= spec.maxDesks;
}

/** Sugestão: menor tamanho fixo cujo piso inicial já comporta `desks` mesas (null se nem o maior). */
export function suggestedRoomSize(desks: number): Exclude<RoomSize, "auto"> | null {
  for (const size of ["p", "m", "g", "gg"] as const) if (fitsInitialSize(size, desks)) return size;
  return null;
}

/** Função da sala: decide os móveis (o layout das mesas é o mesmo; o resto da sala muda). */
export const ROOM_PURPOSES = ["geral", "dev", "pesquisa", "design", "conteudo", "reuniao"] as const;
export type RoomPurpose = (typeof ROOM_PURPOSES)[number];

export const ROOM_PURPOSE_SPECS: Record<RoomPurpose, { label: string; description: string }> = {
  geral: { label: "Geral", description: "Escritório padrão: mesas, quadro, café, estante e sofá." },
  dev: { label: "Desenvolvimento", description: "Mais monitores por mesa, quadro de tarefas e servidor/rack." },
  pesquisa: { label: "Pesquisa", description: "Mais estantes e uma mesa de leitura com poltronas." },
  design: { label: "Design e vídeo", description: "Mesa de criação, câmera/tripé, iluminação e mural de referências." },
  conteudo: { label: "Conteúdo", description: "Mesas de redação, mural de pautas e cantinho de gravação." },
  reuniao: { label: "Reunião", description: "Mesa grande de reunião com cadeiras e TV na parede; poucas mesas individuais." },
};

export function isRoomPurpose(value: unknown): value is RoomPurpose {
  return typeof value === "string" && (ROOM_PURPOSES as readonly string[]).includes(value);
}
