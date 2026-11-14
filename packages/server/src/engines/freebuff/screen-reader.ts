import type { FreebuffModel } from "@cyno/shared";

/**
 * Leitura da tela da TUI do Freebuff (já desenhada pela ScreenBuffer): o rodapé com o modelo, o banner
 * de horas, a caixa de pedido e o seletor do `/model`. Os textos são os vistos em 12/11 (Freebuff 0.2.36).
 */

/** A caixa de pedido está livre (nada em andamento): "Enter a coding task or / for commands". */
export function isReadyScreen(text: string): boolean {
  return /Enter a coding task/.test(text);
}

/** Um turno em andamento: a barra "thinking..."/"working..." com "■ Esc", ou a caixa "Add to the current task". */
export function isWorkingScreen(text: string): boolean {
  return /(thinking|working)\.\.\./.test(text) || /Add to the current task/.test(text);
}

/** O seletor do `/model` está aberto. */
export function isModelPicker(text: string): boolean {
  return /choose model/.test(text);
}

/** O submenu de esforço está aberto. */
export function isEffortMenu(text: string): boolean {
  return /Enter save/.test(text) && /Reasoning/.test(text);
}

/** "DeepSeek V4.1 Flash • high · <pasta> · /model to change": o modelo e o esforço que valem para a próxima mensagem. */
export function parseFooterModel(text: string): { model: string; effort: string } | undefined {
  for (const line of text.split("\n").reverse()) {
    const match = /^\s*(.+?) • (\w+) · .*\/model to change/.exec(line);
    if (match) return { model: match[1]!.trim(), effort: match[2]! };
    const bare = /^\s*(.+?) · .*\/model to change/.exec(line);
    if (bare) return { model: bare[1]!.trim(), effort: "" };
  }
  return undefined;
}

export type HoursReading = { remaining: number; total: number; wallet?: number; resetsInMs?: number };

/**
 * As horas do dia: o banner "17/21 hours remaining" (antes e durante a sessão) ou o rodapé do `/model`
 * "STARTER · 17/21 hours daily · resets in 11h 57m · 25 hours in wallet". Os dois dizem restante/total.
 */
export function parseHours(text: string): HoursReading | undefined {
  const banner = /(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?) hours (?:remaining|daily)/.exec(text);
  if (!banner) return undefined;
  const reading: HoursReading = { remaining: Number(banner[1]), total: Number(banner[2]) };
  const wallet = /(\d+(?:\.\d+)?) hours? in wallet/.exec(text);
  if (wallet) reading.wallet = Number(wallet[1]);
  const resets = /resets in (?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m)?/.exec(text);
  if (resets && (resets[1] || resets[2] || resets[3])) {
    reading.resetsInMs = ((Number(resets[1] ?? 0) * 24 + Number(resets[2] ?? 0)) * 60 + Number(resets[3] ?? 0)) * 60_000;
  }
  return reading;
}

/** "42m left" / "1h 1m left" / "0:26 left" da barra da sessão (minutos que faltam; undefined = sem sessão na tela). */
export function parseTimeLeft(text: string): number | undefined {
  const hours = /(\d+)h(?: (\d+)m)? left\b/.exec(text);
  if (hours) return Number(hours[1]) * 60 + Number(hours[2] ?? 0);
  const minutes = /(\d+)m left\b/.exec(text);
  if (minutes) return Number(minutes[1]);
  const clock = /(\d+):(\d{2}) left\b/.exec(text);
  if (clock) return Number(clock[1]) + Number(clock[2]) / 60;
  return undefined;
}

/**
 * A caixa de pedido apareceu E o Freebuff já carregou o catálogo e a sessão (o banner de horas ou a barra
 * da sessão aparecem ~1 s depois da caixa): antes disso o rodapé mostra o modelo embutido (de uma lista
 * antiga), não o escolhido, e o `/model` abre com essa lista antiga.
 */
export function isSettledScreen(text: string): boolean {
  return isReadyScreen(text) && (parseHours(text) !== undefined || parseTimeLeft(text) !== undefined);
}

export type PickerCard = { name: string; effort?: string; multiplier?: number; section?: string; selected: boolean };

const SECTION = /^\s*(STANDARD|PREMIUM|POWERFUL)\b(.*)$/;

/**
 * Os cartões do seletor do `/model`, na ordem da tela. Cada cartão é uma caixa (┌ ... └): a primeira
 * linha tem "Nome • esforço · notas" (sem esforço: "Nome · notas") e a seguinte o multiplicador ("2x").
 * O multiplicador sem número no cartão vem do cabeçalho da seção ("STANDARD · 1x usage").
 */
export function parseModelPicker(text: string): PickerCard[] {
  const cards: PickerCard[] = [];
  let section: string | undefined;
  let sectionMultiplier: number | undefined;
  let box: string[] | undefined;
  // Só depois do cabeçalho do seletor (o banner de horas e o anúncio, acima, também são caixas).
  const all = text.split("\n");
  const start = all.findIndex((line) => /choose model/.test(line));
  for (const line of start === -1 ? all : all.slice(start + 1)) {
    const heading = SECTION.exec(line);
    if (heading && !box) {
      section = heading[1];
      const single = /\b(\d+(?:\.\d+)?)x\b(?!\s*[–-])/.exec(heading[2] ?? "");
      sectionMultiplier = single && !/\d[–-]\d+(?:\.\d+)?x/.test(heading[2] ?? "") ? Number(single[1]) : undefined;
      continue;
    }
    if (/^\s*┌─+┐\s*$/.test(line)) {
      box = [];
      continue;
    }
    if (/^\s*└─+┘\s*$/.test(line)) {
      if (box && box.length > 0) {
        const first = box[0]!;
        const selected = /^›/.test(first);
        const head = first.replace(/^[›\s]+/, "").trim();
        const withEffort = /^(.*?) • ([A-Za-z]+)\b/.exec(head);
        const name = (withEffort ? withEffort[1]! : head.split(" · ")[0]!).trim();
        const rest = box.slice(1).join(" ");
        const multiplier = /(?:^|[\s·])(\d+(?:\.\d+)?)x(?:\s|$|·)/.exec(` ${rest} `)?.[1];
        cards.push({
          name,
          ...(withEffort ? { effort: withEffort[2]! } : {}),
          ...(multiplier !== undefined ? { multiplier: Number(multiplier) } : sectionMultiplier !== undefined ? { multiplier: sectionMultiplier } : {}),
          ...(section ? { section } : {}),
          selected,
        });
      }
      box = undefined;
      continue;
    }
    if (box) {
      const inner = /^\s*│(.*)│\s*$/.exec(line);
      if (inner) box.push(inner[1]!.replace(/\s+/g, " ").trim().replace(/^ ?› ?/, "› ").replace(/^›\s+/, "›"));
    }
  }
  return cards;
}

/** Os níveis do submenu de esforço ("low", "medium", "high (default)"), na ordem, e qual está marcado. */
export function parseEffortMenu(text: string): { levels: string[]; selected?: string; defaultLevel?: string } {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /Enter save/.test(line));
  const levels: string[] = [];
  let selected: string | undefined;
  let defaultLevel: string | undefined;
  for (const line of lines.slice(start + 1)) {
    const match = /^\s+(›\s*)?([a-z]+)( \(default\))?\s*$/.exec(line);
    if (!match) {
      if (levels.length > 0) break;
      continue;
    }
    levels.push(match[2]!);
    if (match[1]) selected = match[2]!;
    if (match[3]) defaultLevel = match[2]!;
  }
  return { levels, ...(selected ? { selected } : {}), ...(defaultLevel ? { defaultLevel } : {}) };
}

/** Os cartões viram a lista de modelos do Cyno (o primeiro cartão de cada nome fica; a chave opaca da TUI não importa). */
export function modelsFromCards(cards: readonly PickerCard[]): FreebuffModel[] {
  const seen = new Set<string>();
  const models: FreebuffModel[] = [];
  for (const card of cards) {
    if (seen.has(card.name)) continue;
    seen.add(card.name);
    models.push({ name: card.name, multiplier: card.multiplier ?? 1, efforts: card.effort ? [card.effort] : [], ...(card.effort ? { defaultEffort: card.effort } : {}), ...(card.section ? { section: card.section } : {}) });
  }
  return models;
}
