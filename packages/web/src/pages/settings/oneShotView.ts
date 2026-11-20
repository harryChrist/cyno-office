import { usageAgeLabel, type EngineCheck, type EngineStatus, type EngineStep, type ModelPrice, type OneShotEngineId, type OpenRouterKeyInfo } from "@cyno/shared";

/** OpenClaw e Hermes na tela Motores: o passo a passo, os modelos do OpenRouter e o Verificar (as regras ficam aqui, a tela só desenha). */

export const ONE_SHOT_IDS: readonly OneShotEngineId[] = ["openclaw", "hermes"];
export const isOneShotEngine = (id: string): id is OneShotEngineId => (ONE_SHOT_IDS as readonly string[]).includes(id);

/** Só o que a documentação do OpenRouter diz (openrouter.ai/docs/api-reference/limits); nenhum número inventado. */
export const FREE_LIMIT_NOTE = "Os modelos gratuitos têm limite de pedidos: segundo a documentação do OpenRouter, 20 por minuto e 50 por dia (1.000 por dia depois de comprar 10 créditos).";

export const KEY_SAFETY_NOTE = "A chave fica só neste servidor, em arquivo com acesso só seu, vai só ao OpenClaw e ao Hermes e nunca volta para esta tela.";

export const PROGRAM_ACCOUNT_NOTE = "O programa usa a configuração que você fez nele: assinatura, chaves de API ou modelos locais. O custo sai de onde ele estiver ligado.";

const GLYPH: Record<EngineStep["state"], string> = { done: "✓", todo: "○", error: "✗", current: "▶" };
export const stepGlyph = (state: EngineStep["state"]) => GLYPH[state];

export const STEP_STATE_LABEL: Record<EngineStep["state"], string> = { done: "feito", todo: "falta", error: "com erro", current: "agora" };

/** "Configurada · termina em …abcd · guardada há 3 min". */
export function keyLine(info: OpenRouterKeyInfo | undefined, now: number): string {
  if (!info?.configured) return "Nenhuma chave configurada.";
  const age = info.savedAt ? Math.max(0, Math.floor((now - Date.parse(info.savedAt)) / 60_000)) : undefined;
  return ["Configurada", `termina em …${info.last4 ?? "????"}`, ...(age !== undefined && Number.isFinite(age) ? [`guardada ${usageAgeLabel(age)}`] : [])].join(" · ");
}

const dollars = (value: number) => value.toLocaleString("pt-BR", { maximumFractionDigits: 4 });

/** "gratuito" ou "US$ 0,09/M de entrada · US$ 0,18/M de saída". */
export function priceLine(price: ModelPrice | undefined): string {
  if (!price) return "preço não lido (use Atualizar modelos)";
  if (price.free) return "gratuito";
  return `US$ ${price.promptPerM === undefined ? "?" : dollars(price.promptPerM)}/M de entrada · US$ ${price.completionPerM === undefined ? "?" : dollars(price.completionPerM)}/M de saída`;
}

/** O aviso do modelo pago ("este modelo cobra do seu saldo do OpenRouter"); gratuito e sem escolha: nada. */
export function paidModelWarning(engine: Pick<EngineStatus, "modelPrice" | "choices">): string | null {
  if (!engine.choices?.model || !engine.modelPrice || engine.modelPrice.free) return null;
  return "Este modelo cobra do seu saldo do OpenRouter (o custo aparece em Gastos).";
}

/** "Custo informado pelo programa: US$ 0,0012 (último turno há 5 min)". Informação, não alerta. */
export function spentLine(spent: EngineStatus["spent"], now: number): string | null {
  if (!spent || spent.usd <= 0) return null;
  const age = Math.max(0, Math.floor((now - Date.parse(spent.at)) / 60_000));
  return `Custo informado pelo programa: US$ ${dollars(spent.usd)} no total (último turno ${usageAgeLabel(age)}).`;
}

const CHECK_GLYPH = (check: EngineCheck) => (check.ok === true ? "✓" : check.ok === false ? "✗" : "–");
export const checkGlyph = CHECK_GLYPH;

/** "Verificado há 3 min · tudo certo" / "Verificado há 3 min · falta resolver 2 itens". */
export function verifyHeadline(verify: NonNullable<EngineStatus["verify"]>, now: number): string {
  const age = Math.max(0, Math.floor((now - Date.parse(verify.at)) / 60_000));
  const failed = verify.checks.filter((check) => check.ok === false).length;
  const when = `Verificado ${usageAgeLabel(age)}`;
  if (verify.ok) return `${when} · tudo certo`;
  if (verify.pendingTurn) return `${when} · falta só o turno de teste (pede a sua confirmação)`;
  return failed > 0 ? `${when} · ${failed === 1 ? "1 item falhou" : `${failed} itens falharam`}` : `${when} · incompleto`;
}

/** A etapa que o passo a passo mostra como a da vez. */
export function currentStep(steps: readonly EngineStep[] | undefined): EngineStep | undefined {
  return steps?.find((step) => step.state === "error") ?? steps?.find((step) => step.state === "current");
}

/**
 * Como cada etapa se mostra: a da vez e a com erro ficam abertas; as feitas recolhem numa linha com ✓ e o resumo
 * (o dono pode reabrir); as próximas ficam esmaecidas e fechadas. `reopened`: o dono clicou na etapa.
 */
export type StepView = "open" | "folded" | "dim";
export function stepView(step: Pick<EngineStep, "id" | "state">, currentId: string | undefined, reopened: boolean): StepView {
  if (reopened) return "open";
  if (step.state === "error" || step.state === "current" || step.id === currentId) return "open";
  return step.state === "done" ? "folded" : "dim";
}

/** O que mostrar do Verificar: o que falhou (primeiro, com o "o que fazer"), o que não deu para checar e o que passou. */
export function verifyGroups(checks: readonly EngineCheck[]): { failed: EngineCheck[]; skipped: EngineCheck[]; passed: EngineCheck[] } {
  return { failed: checks.filter((check) => check.ok === false), skipped: checks.filter((check) => check.ok === null), passed: checks.filter((check) => check.ok === true) };
}

/** O selo de estado do cartão dos dois motores. */
export function oneShotBadge(engine: Pick<EngineStatus, "state" | "account">): { tone: "success" | "attention" | "neutral" | "danger"; label: string } | null {
  switch (engine.state) {
    case "no_login":
      return { tone: "attention", label: engine.account?.mode === "program" ? "Falta ligar um provedor no programa" : "Falta a chave do OpenRouter" };
    case "installed":
      return { tone: "neutral", label: "Instalado · falta verificar" };
    default:
      return null;
  }
}
