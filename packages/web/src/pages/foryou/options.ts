/**
 * Opções dentro de um texto só ("OPÇÃO 1 · PIX … --- OPÇÃO 2 · …"). Só apresentação: o texto
 * continua sendo um campo único; aqui ele é fatiado em opções para a tela mostrar uma por vez e
 * remontado igualzinho (byte a byte) quando uma delas é editada.
 */

export type TextOptions = {
  /** O que vem antes da primeira opção (só espaços; do contrário o texto não é tratado como opções). */
  prefix: string;
  /** Cada opção: o corpo (do título "OPÇÃO N" até o fim do texto dela) e o que a separa da próxima (espaços e `---`). */
  parts: { label: string; body: string; separator: string }[];
};

/** Título de opção no começo da linha: "OPÇÃO 1 · PIX", "Opcao 2", "## Opção 3 - …", "**OPÇÃO 4**". */
const HEADING = /^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?OP[ÇC][ÃA]O[ \t]*(\d+)\b[ \t]*(?:[·:\-–—|.)]+[ \t]*([^\n*]*))?/gim;
/** Final de uma opção: uma linha só de `---` e os espaços depois dela (sem `---`, o corpo vai até o fim). */
const TRAILING = /(?:^|\n)[ \t]*-{3,}[ \t]*\s*$/;

/** Separa o texto em opções; `null` quando ele não tem o padrão (2 ou mais títulos "OPÇÃO N"). */
export function splitOptions(text: string): TextOptions | null {
  const heads = [...text.matchAll(HEADING)];
  if (heads.length < 2) return null;
  const prefix = text.slice(0, heads[0]!.index);
  if (prefix.trim() !== "") return null;
  const parts = heads.map((head, index) => {
    const start = head.index!;
    const end = index + 1 < heads.length ? heads[index + 1]!.index! : text.length;
    const raw = text.slice(start, end);
    const tail = TRAILING.exec(raw);
    const cut = tail ? tail.index : raw.length;
    const title = (head[2] ?? "").trim().replace(/\*+$/, "").trim();
    const label = `Opção ${head[1]}`;
    return { label: title ? `${label} · ${title}` : label, body: raw.slice(0, cut), separator: raw.slice(cut) };
  });
  return { prefix, parts };
}

/** Rótulo curto da aba: "Opção 1" (o título longo fica para o tooltip). */
export function shortOptionLabel(label: string): string {
  return label.split(" · ")[0]!;
}

/** O texto inteiro de volta, trocando o corpo da opção `index` por `body`. Sem trocar nada, devolve o original. */
export function joinOptions(options: TextOptions, index?: number, body?: string): string {
  return (
    options.prefix +
    options.parts.map((part, position) => (position === index && body !== undefined ? body : part.body) + part.separator).join("")
  );
}
