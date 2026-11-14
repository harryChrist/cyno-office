import { isOneShotEngineId, type EngineStatus, type ModelDefaults, type SupportedEngineId } from "@cyno/shared";
import { engineDefaultFor, engineStateBadge, type DefaultTarget, type EngineBadge } from "./enginesView";

/** Resumo dos motores (a lista do topo da seção Motores): o que dá para bater o olho, em uma linha por motor. */

export type EngineSummary = {
  id: string;
  label: string;
  tone: EngineBadge["tone"];
  /** "Funcionando", "Falta a conta", "Não instalado", "Com erro"... */
  stateLabel: string;
  /** Um símbolo curto (além da cor, para quem não distingue cores). */
  icon: "✓" | "!" | "✕" | "●" | "○";
  account: string;
  model: string;
  usedFor: DefaultTarget[];
  /** O gasto (OpenClaw e Hermes) ou as horas do dia (Freebuff), quando houver. */
  extra?: string;
};

const usd = (value: number) => `US$ ${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A conta do motor, em uma frase curta. */
export function engineAccountLine(engine: EngineStatus): string {
  if (engine.state === "not_installed") return "Sem conta (instale primeiro)";
  if (isOneShotEngineId(engine.id)) {
    if (engine.account?.mode === "program") return `Configuração do programa (${engine.account.location === "personal" ? "pasta pessoal" : "pasta do Cyno"})`;
    return engine.openrouterKey?.configured ? `Chave do OpenRouter${engine.openrouterKey.last4 ? ` …${engine.openrouterKey.last4}` : ""}` : "Falta a chave do OpenRouter";
  }
  if (engine.id === "freebuff") return "Conta do próprio Freebuff";
  return engine.state === "no_login" ? "Falta entrar na conta" : "Assinatura, conta da CLI";
}

/** O modelo que o motor vai usar, em uma frase curta. */
export function engineModelLine(engine: EngineStatus, defaults: ModelDefaults | null): string {
  if (engine.id === "freebuff") return engine.freebuff ? `${engine.freebuff.settings.model} · ${engine.freebuff.settings.effort}` : "Modelo da plataforma";
  if (isOneShotEngineId(engine.id)) return engine.choices?.model ?? engine.program?.defaultModel ?? "Falta escolher o modelo";
  if (!defaults) return "…";
  const id = engine.id as SupportedEngineId;
  const model = defaults.agentes.engine === id ? defaults.agentes.model : defaults.maestro.engine === id ? defaults.maestro.model : defaults.subagentes[id]?.model;
  return model ? model : "Padrão da CLI";
}

/** O resumo de um motor para a lista: as mesmas regras do cartão, em uma linha. */
export function engineSummary(engine: EngineStatus, defaults: ModelDefaults | null, now: number): EngineSummary {
  const badge = engineStateBadge(engine, now);
  const failed = engine.state !== "not_installed" && (engine.verify?.ok === false || (engine.lastTest !== undefined && !engine.lastTest.ok));
  const oneShotNoModel = isOneShotEngineId(engine.id) && engine.state === "installed" && !engine.choices?.model;
  const icon: EngineSummary["icon"] = failed || engine.state === "no_quota" ? "✕" : engine.state === "working" ? "✓" : engine.state === "no_login" || oneShotNoModel ? "!" : engine.state === "installed" ? "●" : "○";
  const usedFor = engine.supported ? engineDefaultFor(defaults, engine.id as SupportedEngineId | "freebuff" | "openclaw" | "hermes") : [];
  const hours = engine.freebuff?.hours;
  const extra =
    isOneShotEngineId(engine.id) && engine.spent
      ? `Gasto ${usd(engine.spent.usd)}`
      : engine.id === "freebuff" && hours?.remaining !== undefined
        ? `Restam ${hours.remaining}${hours.total !== undefined ? `/${hours.total}` : ""} h hoje`
        : undefined;
  return {
    id: engine.id,
    label: engine.label,
    tone: failed ? "danger" : badge.tone,
    stateLabel: failed ? "Com erro" : badge.label,
    icon,
    account: engineAccountLine(engine),
    model: engineModelLine(engine, defaults),
    usedFor,
    ...(extra ? { extra } : {}),
  };
}

/** Qual motor abre sozinho em tela larga: o primeiro que pede atenção (erro, sem conta, sem cota); sem nenhum, o primeiro. */
export function engineToOpenFirst(engines: readonly EngineStatus[], defaults: ModelDefaults | null, now: number): string | null {
  const needs = engines.find((engine) => {
    const tone = engineSummary(engine, defaults, now).tone;
    return engine.state !== "not_installed" && (tone === "danger" || tone === "attention");
  });
  return (needs ?? engines[0])?.id ?? null;
}
