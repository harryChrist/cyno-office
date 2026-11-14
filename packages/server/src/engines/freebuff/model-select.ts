import type { FreebuffModel } from "@cyno/shared";
import {
  isEffortMenu,
  isModelPicker,
  isReadyScreen,
  modelsFromCards,
  parseEffortMenu,
  parseFooterModel,
  parseHours,
  parseModelPicker,
  type HoursReading,
  type PickerCard,
} from "./screen-reader";

/**
 * Como o Cyno mexe no seletor `/model` da TUI do Freebuff: abrir, ler a lista e os níveis de esforço,
 * escolher um modelo com as setas e o esforço com a Tab. Não existe opção de linha de comando para isso,
 * e a escolha fica no `settings.json` do Freebuff (global na máquina): por isso é uma só para a plataforma
 * e é feita pela própria TUI, no processo, ANTES da primeira mensagem (nada disto gasta hora).
 */

/** O mínimo que o seletor precisa do terminal: a tela, as teclas e uma pausa. */
export type TuiDriver = {
  /** A tela agora, como texto. */
  text(): string;
  write(keys: string): void;
  sleep(ms: number): Promise<void>;
  /** O processo ainda está vivo? */
  alive(): boolean;
};

export const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", tab: "\t", esc: "\x1b" } as const;

export type PickerOptions = {
  /** Pausa entre as teclas (a TUI redesenha). Padrão 300 ms. */
  settleMs?: number;
  /** Espera máxima por uma tela. Padrão 6 s. */
  waitMs?: number;
};

const settleOf = (options: PickerOptions) => options.settleMs ?? 300;

/** Espera a tela satisfazer o teste (até `timeoutMs`); devolve a tela ou undefined. */
export async function waitScreen(driver: TuiDriver, test: (text: string) => boolean, timeoutMs: number, stepMs = 40): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = driver.text();
    if (test(text)) return text;
    if (Date.now() >= deadline || !driver.alive()) return undefined;
    await driver.sleep(stepMs);
  }
}

/** Abre o `/model` (texto, uma pausa e Enter: um Enter junto do texto não é lido como envio). */
export async function openPicker(driver: TuiDriver, options: PickerOptions = {}): Promise<string> {
  driver.write("/model");
  await driver.sleep(settleOf(options));
  driver.write(KEY.enter);
  const text = await waitScreen(driver, isModelPicker, options.waitMs ?? 6000);
  if (!text) throw new Error("O seletor de modelos do Freebuff não abriu (a tela não respondeu ao /model)");
  return text;
}

/** Sai do seletor (Esc até a caixa de pedido voltar). */
export async function closePicker(driver: TuiDriver, options: PickerOptions = {}): Promise<void> {
  for (let attempt = 0; attempt < 4 && driver.alive(); attempt += 1) {
    if (isReadyScreen(driver.text()) && !isModelPicker(driver.text())) return;
    driver.write(KEY.esc);
    await driver.sleep(settleOf(options));
  }
}

/** Lê os níveis do submenu de esforço quando a tela parou de mudar (o cabeçalho aparece antes dos níveis). */
async function readEffortLevels(driver: TuiDriver, options: PickerOptions): Promise<ReturnType<typeof parseEffortMenu>> {
  let previous = parseEffortMenu(driver.text());
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await driver.sleep(Math.min(settleOf(options), 200));
    const next = parseEffortMenu(driver.text());
    if (next.levels.length > 0 && next.levels.join(",") === previous.levels.join(",")) return next;
    previous = next;
  }
  return previous;
}

/** Anda com a seleção até o cartão `index` (setas, conferindo a tela a cada passo). */
async function moveTo(driver: TuiDriver, index: number, options: PickerOptions): Promise<PickerCard[]> {
  let cards = parseModelPicker(driver.text());
  for (let step = 0; step < 80; step += 1) {
    const current = cards.findIndex((card) => card.selected);
    if (current === index) return cards;
    if (current === -1 && step > 3) break;
    driver.write(current === -1 || current < index ? KEY.down : KEY.up);
    await driver.sleep(settleOf(options));
    cards = parseModelPicker(driver.text());
  }
  throw new Error("Não consegui mover a seleção até o modelo na lista do Freebuff");
}

export type ModelListReading = { models: FreebuffModel[]; hours?: HoursReading; current?: { model: string; effort: string } };

/**
 * Lê a lista de modelos (nome, multiplicador, seção) e, com `efforts`, os níveis de esforço de cada um
 * (Tab sobre o cartão). Fecha o seletor sem escolher nada: não manda mensagem, não gasta hora.
 */
export async function readModelList(driver: TuiDriver, options: PickerOptions & { efforts?: boolean } = {}): Promise<ModelListReading> {
  const first = await openPicker(driver, options);
  const hours = parseHours(first);
  const current = parseFooterModel(first);
  let cards = parseModelPicker(first);
  if (cards.length === 0) {
    await closePicker(driver, options);
    throw new Error("O seletor abriu, mas não consegui ler a lista de modelos");
  }
  const models = modelsFromCards(cards);
  if (options.efforts) {
    for (let index = 0; index < cards.length; index += 1) {
      if (!driver.alive()) break;
      const name = cards[index]!.name;
      const model = models.find((candidate) => candidate.name === name);
      if (!model || model.efforts.length > 1) continue;
      try {
        cards = await moveTo(driver, index, options);
      } catch {
        break;
      }
      driver.write(KEY.tab);
      const opened = await waitScreen(driver, isEffortMenu, Math.min(options.waitMs ?? 6000, 1200));
      if (!opened) continue; // modelo sem níveis de esforço: a Tab não abre nada
      const levels = await readEffortLevels(driver, options);
      if (levels.levels.length > 0) {
        model.efforts = levels.levels;
        if (levels.defaultLevel) model.defaultEffort = levels.defaultLevel;
      }
      driver.write(KEY.esc);
      await driver.sleep(settleOf(options));
    }
  }
  await closePicker(driver, options);
  return { models, ...(hours ? { hours } : {}), ...(current ? { current } : {}) };
}

export type ChooseResult = { ok: true; changed: boolean; multiplier?: number } | { ok: false; error: string };

/**
 * Garante que a próxima mensagem vai com `want` (modelo e esforço): se o rodapé já mostra, não mexe;
 * senão abre o `/model`, vai até o modelo, ajusta o esforço com a Tab e confirma com Enter. Confere o
 * rodapé no fim. Só vale ANTES da primeira mensagem da hora (mudar no meio pode cobrar de novo).
 */
export async function chooseModel(driver: TuiDriver, want: { model: string; effort?: string }, options: PickerOptions = {}): Promise<ChooseResult> {
  const matches = () => {
    const footer = parseFooterModel(driver.text());
    return footer !== undefined && footer.model === want.model && (!want.effort || footer.effort === want.effort);
  };
  if (matches()) return { ok: true, changed: false };
  try {
    const first = await openPicker(driver, options);
    let cards = parseModelPicker(first);
    const index = cards.findIndex((card) => card.name === want.model);
    if (index === -1) {
      await closePicker(driver, options);
      return { ok: false, error: `O modelo "${want.model}" não está na lista do Freebuff (use "Atualizar modelos" na tela Motores).` };
    }
    cards = await moveTo(driver, index, options);
    const card = cards[index]!;
    if (want.effort && card.effort !== want.effort) {
      driver.write(KEY.tab);
      const menu = await waitScreen(driver, isEffortMenu, options.waitMs ?? 6000);
      if (!menu) {
        await closePicker(driver, options);
        return { ok: false, error: `O modelo "${want.model}" não tem o esforço "${want.effort}".` };
      }
      const levels = await readEffortLevels(driver, options);
      const target = levels.levels.indexOf(want.effort);
      if (target === -1) {
        await closePicker(driver, options);
        return { ok: false, error: `O modelo "${want.model}" não tem o esforço "${want.effort}" (tem: ${levels.levels.join(", ")}).` };
      }
      let at = levels.selected ? levels.levels.indexOf(levels.selected) : (levels.defaultLevel ? levels.levels.indexOf(levels.defaultLevel) : 0);
      for (let guard = 0; at !== target && guard < 12; guard += 1) {
        driver.write(at < target ? KEY.down : KEY.up);
        at += at < target ? 1 : -1;
        await driver.sleep(settleOf(options));
      }
      driver.write(KEY.enter); // salvar o esforço
      await driver.sleep(settleOf(options));
    }
    if (isModelPicker(driver.text())) {
      driver.write(KEY.enter); // escolher o modelo
      await driver.sleep(settleOf(options));
    }
    const done = await waitScreen(driver, (text) => isReadyScreen(text) && !isModelPicker(text), options.waitMs ?? 6000);
    if (!done) return { ok: false, error: "A tela do Freebuff não voltou depois de escolher o modelo." };
    // O rodapé leva um instante para mostrar a escolha.
    const deadline = Date.now() + 2000;
    while (!matches() && Date.now() < deadline) await driver.sleep(60);
    if (!matches()) {
      const footer = parseFooterModel(driver.text());
      return { ok: false, error: `Escolhi "${want.model}${want.effort ? ` · ${want.effort}` : ""}", mas o rodapé do Freebuff mostra "${footer ? `${footer.model}${footer.effort ? ` · ${footer.effort}` : ""}` : "?"}".` };
    }
    return { ok: true, changed: true, ...(card.multiplier !== undefined ? { multiplier: card.multiplier } : {}) };
  } catch (error) {
    await closePicker(driver, options).catch(() => undefined);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
