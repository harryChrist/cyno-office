import {
  ENGINE_FALLBACK_MODELS,
  isOneShotEngineId,
  resumeTimeLabel,
  usageAgeLabel,
  type EnginePathSource,
  type EngineStatus,
  type EngineTestResult,
  type ModelChoice,
  type ModelDefaults,
  type SupportedEngineId,
} from "@cyno/shared";

/** Tela "Motores": o que dizer de cada estado detectado (as regras ficam aqui, a tela só desenha). */

export type EngineBadge = { tone: "success" | "danger" | "neutral" | "attention"; label: string };

/** O selo de estado: "Funcionando", "Instalado", "Sem login", "Sem cota · volta às 14:30", "Não instalado". */
export function engineStateBadge(engine: EngineStatus, now: number): EngineBadge {
  switch (engine.state) {
    case "working":
      return { tone: "success", label: "Funcionando" };
    case "installed":
      return engine.supported ? { tone: "neutral", label: isOneShotEngineId(engine.id) ? "Instalado · falta verificar" : "Instalado" } : { tone: "attention", label: "Instalado · em breve" };
    case "no_login":
      return { tone: "attention", label: isOneShotEngineId(engine.id) ? "Falta a chave do OpenRouter" : "Sem login" };
    case "no_quota":
      return { tone: "danger", label: engine.resetsAt ? `Sem cota · volta às ${resumeTimeLabel(engine.resetsAt, now)}` : "Sem cota" };
    default:
      return { tone: "neutral", label: engine.supported ? "Não instalado" : "Não instalado · em breve" };
  }
}

const SOURCE_LABELS: Record<EnginePathSource, string> = { config: "escolhido aqui", env: "variável de ambiente", path: "achado no PATH" };

/** "Versão 2.1.322 (Claude Code)" (e o caminho, quando houver, na linha de baixo). */
export function engineVersionLine(engine: EngineStatus): string {
  if (engine.state === "not_installed") return "Executável não encontrado.";
  return engine.version && !/^0(\.0)*(\s|$)/.test(engine.version.trim()) ? `Versão ${engine.version}` : engine.supported ? "Instalado (a CLI não disse a versão)." : "Instalado (versão não lida: o Cyno ainda não roda este motor).";
}

/** "/home/x/.local/bin/claude · achado no PATH". */
export function enginePathLine(engine: EngineStatus): string {
  if (!engine.path) return "";
  return engine.pathSource ? `${engine.path} · ${SOURCE_LABELS[engine.pathSource]}` : engine.path;
}

/** "Testado há 3 h · 1,8 s · 320 tokens" (ou o erro). */
export function engineTestLine(test: EngineTestResult, now: number): { ok: boolean; text: string } {
  const age = Math.max(0, Math.floor((now - Date.parse(test.at)) / 60_000));
  const when = `Testado ${usageAgeLabel(age)}`;
  const seconds = `${(test.ms / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: test.ms < 10_000 ? 1 : 0 })} s`;
  if (!test.ok) return { ok: false, text: `${when} · falhou: ${test.error ?? "sem resposta"}` };
  const parts = [when, seconds, ...(test.tokens ? [`${test.tokens.toLocaleString("pt-BR")} tokens`] : []), ...(test.model ? [test.model] : [])];
  return { ok: true, text: parts.join(" · ") };
}

export type DefaultTarget = "maestro" | "agentes" | "subagentes";
export const DEFAULT_TARGET_LABELS: Record<DefaultTarget, string> = { maestro: "Maestro", agentes: "Agentes", subagentes: "Subagentes" };

/** Para quais destinos o botão "Usar como padrão" existe neste motor (os subagentes só no Claude Code e no Antigravity). */
export function defaultTargetsFor(engine: Pick<EngineStatus, "id">): DefaultTarget[] {
  return engine.id === "freebuff" || isOneShotEngineId(engine.id) ? ["maestro", "agentes"] : ["maestro", "agentes", "subagentes"];
}

/** Para quais destinos este motor já é o padrão (o Maestro e os agentes pelo motor; os subagentes se há modelo definido para ele). */
export function engineDefaultFor(defaults: ModelDefaults | null, engine: SupportedEngineId | "freebuff" | "openclaw" | "hermes"): DefaultTarget[] {
  if (!defaults) return [];
  // Freebuff, OpenClaw e Hermes: o Maestro e os agentes (os subagentes, não).
  if (engine === "openclaw" || engine === "hermes" || engine === "freebuff") return [...(defaults.maestro.engine === engine ? (["maestro"] as const) : []), ...(defaults.agentes.engine === engine ? (["agentes"] as const) : [])];
  return [
    ...(defaults.maestro.engine === engine ? (["maestro"] as const) : []),
    ...(defaults.agentes.engine === engine ? (["agentes"] as const) : []),
    ...(defaults.subagentes[engine]?.model ? (["subagentes"] as const) : []),
  ];
}

/**
 * Os padrões depois de "Usar como padrão para <destino>": o Maestro e os agentes trocam de motor (mantendo
 * o modelo se já era o mesmo motor; senão o modelo inicial dele); nos subagentes, o motor ganha o modelo
 * leve inicial dele. É a mesma regra dos Modelos padrão (ENGINE_FALLBACK_MODELS), sem copiar a tabela.
 */
export function defaultsWithEngine(defaults: ModelDefaults, engine: SupportedEngineId | "freebuff" | "openclaw" | "hermes", target: DefaultTarget, picked?: { model?: string; effort?: ModelChoice["effort"] }): ModelDefaults {
  if (engine === "openclaw" || engine === "hermes") {
    // O modelo é o escolhido no passo a passo (`provedor/modelo`); o Hermes não tem esforço.
    const next = JSON.parse(JSON.stringify(defaults)) as ModelDefaults;
    const choice: ModelChoice = { engine, ...(picked?.model ? { model: picked.model } : {}), ...(engine === "openclaw" && picked?.effort ? { effort: picked.effort } : {}) };
    if (target === "agentes") next.agentes = choice;
    else if (target === "maestro") next.maestro = choice;
    return next;
  }
  if (engine === "freebuff") {
    // O modelo do Freebuff é um só para a plataforma (Configurações › Motores): o padrão dos agentes guarda só o motor.
    const next = JSON.parse(JSON.stringify(defaults)) as ModelDefaults;
    if (target === "agentes") next.agentes = { engine: "freebuff" };
    else if (target === "maestro") next.maestro = { engine: "freebuff" };
    return next;
  }
  const fallback = ENGINE_FALLBACK_MODELS[engine];
  const next: ModelDefaults = JSON.parse(JSON.stringify(defaults)) as ModelDefaults;
  const choice = (current: ModelChoice): ModelChoice => (current.engine === engine ? current : { engine, model: fallback.model, ...(fallback.effort ? { effort: fallback.effort } : {}) });
  if (target === "maestro") next.maestro = choice(defaults.maestro);
  else if (target === "agentes") next.agentes = choice(defaults.agentes);
  else next.subagentes = { ...next.subagentes, [engine]: defaults.subagentes[engine] ?? { model: fallback.model, ...(fallback.effort ? { effort: fallback.effort } : {}) } };
  return next;
}

/** O "Usar como padrão" está liberado? Só com o motor instalado, com login e (para testar) sem cota acabada. */
export function canUseAsDefault(engine: EngineStatus): { ok: boolean; reason?: string } {
  if (!engine.supported) return { ok: false, reason: "O suporte chega numa próxima entrega." };
  if (engine.state === "not_installed") return { ok: false, reason: "Instale o motor primeiro." };
  if (engine.state === "no_login") return { ok: false, reason: isOneShotEngineId(engine.id) ? (engine.account?.mode === "program" ? "Ligue um provedor no programa primeiro (passo Conta)." : "Guarde a chave do OpenRouter primeiro.") : "Entre na conta do motor primeiro." };
  // Com a chave do OpenRouter basta ter o modelo escolhido: o "Verificar" é o que confirma que tudo funciona.
  if (isOneShotEngineId(engine.id) && !engine.choices?.model && !(engine.account?.mode === "program" && engine.program?.defaultModel)) return { ok: false, reason: "Escolha o modelo no passo a passo primeiro." };
  return { ok: true };
}

/** "Para entrar, rode no terminal: claude". */
export function loginInstruction(engine: EngineStatus): string | null {
  if (!engine.loginCommand || engine.state === "not_installed") return null;
  if (!engine.supported) return null;
  return engine.loginCommand;
}
