import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Raiz do monorepo (packages/server/src -> ../../..). */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Carrega o `.env` da raiz do repo, se existir (copie o `.env.example`). O que já está no ambiente
 * vale sobre o arquivo, então pm2, Docker e `VAR=valor npm run dev` continuam mandando.
 * Só os pontos de entrada chamam (index.ts e o CLI de senha): os testes não leem o `.env`.
 */
export function loadRootEnvFile(): void {
  try {
    process.loadEnvFile(path.join(REPO_ROOT, ".env"));
  } catch {
    // sem .env: valem os padrões
  }
}

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);
const optionalInt = (fallback: number, min: number, max: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(fallback));
const optionalRate = (fallback: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(1).default(fallback));

/**
 * Modo simulado (AGENT_RUNNER=mock): SÓ para testes, e2e e laboratório; sem a variável só há agentes
 * e Maestro reais. Os agentes reais não dependem disto: cada agente com
 * `engine: "claude"` ou `"gemini"` (Antigravity; depois Codex e OpenCode) roda num terminal de CLI.
 */
export const AGENT_RUNNERS = ["mock"] as const;
export type AgentRunnerKind = (typeof AGENT_RUNNERS)[number];

const envSchema = z.object({
  PORT: optionalInt(3001, 1, 65535),
  HOST: z.preprocess(emptyToUndefined, z.string().default("127.0.0.1")),
  DATA_DIR: z.preprocess(emptyToUndefined, z.string().optional()),
  LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(LOG_LEVELS).default("info")),
  AGENT_RUNNER: z.preprocess(emptyToUndefined, z.enum(AGENT_RUNNERS).optional()),
  MOCK_MIN_MS: optionalInt(3000, 0, 600_000),
  MOCK_MAX_MS: optionalInt(8000, 0, 600_000),
  MOCK_APPROVAL_RATE: optionalRate(0.2),
  MOCK_SUBAGENT_RATE: optionalRate(0.4),
  DONE_LINGER_MS: optionalInt(5000, 0, 600_000),
  APPROVAL_PARK_MS: optionalInt(120_000, 0, 3_600_000),
  CLAUDE_BIN: z.preprocess(emptyToUndefined, z.string().default("claude")),
  /** Esforço padrão dos agentes Claude sem `effort` ("none" = não passa --effort, fica o da CLI). */
  CLAUDE_EFFORT: z.preprocess(emptyToUndefined, z.enum(["low", "medium", "high", "xhigh", "max", "none"]).default("low")),
  /** `--autocompact` dos agentes Claude (tokens, 100000–1000000, ou "auto"; "none" = não passa a flag). */
  CLAUDE_AUTOCOMPACT: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .refine((value) => value === "auto" || value === "none" || (/^\d+$/.test(value) && Number(value) >= 100_000 && Number(value) <= 1_000_000), "use auto, none ou um número de tokens entre 100000 e 1000000")
      .default("auto"),
  ),
  /** Conversa do Maestro de CLI acima disto (tokens) é renovada com um resumo; 0 = nunca. */
  MAESTRO_ROTATE_TOKENS: optionalInt(0, 0, 1_000_000),
  /** Executável do Google Antigravity CLI (motor "gemini"). */
  AGY_BIN: z.preprocess(emptyToUndefined, z.string().default("agy")),
  TERMINAL_IDLE_MS: optionalInt(15 * 60_000, 0, 24 * 3_600_000),
  /** Ociosidade do Cyno antes de dormir (ms; 0 = o padrão de 10 min). Só para teste. */
  CYNO_IDLE_MS: optionalInt(0, 0, 24 * 3_600_000),
  /**
   * Como roda o Maestro de Claude Code: "pty" (padrão: o `claude` interativo num pseudo-terminal,
   * visível e usável no painel, com comandos `/` e Remote Control) ou "headless" (`claude -p`, como os
   * outros agentes).
   */
  MAESTRO_TERMINAL: z.preprocess(emptyToUndefined, z.enum(["pty", "headless"]).default("pty")),
  /** Remote Control do terminal do Maestro (a mesma sessão no app do Claude e em claude.ai/code): "0" desliga. */
  MAESTRO_REMOTE_CONTROL: z.preprocess(emptyToUndefined, z.enum(["0", "1"]).default("1")),
  TERMINAL_MAX_RETRIES: optionalInt(3, 0, 20),
  /** URL do servidor MCP que as CLIs usam (padrão: http://127.0.0.1:<PORT>/mcp). */
  OFFICE_MCP_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  WS_HEARTBEAT_MS: optionalInt(30_000, 1000, 600_000),
  /** Pasta de configuração do Claude Code (as conversas ficam em <ela>/projects); padrão ~/.claude. */
  CLAUDE_CONFIG_DIR: z.preprocess(emptyToUndefined, z.string().optional()),
  /**
   * Conectores stdio rodam um comando nesta máquina. A API não tem login e a interface fica na rede,
   * então ficam DESLIGADOS por padrão: "1" libera (só faça isso numa rede em que confia).
   */
  CONNECTORS_STDIO: z.preprocess(emptyToUndefined, z.enum(["0", "1"]).default("0")),
  /** Limpeza automática do histórico (boot + uma vez por dia): "0" desliga. */
  RETENTION_AUTO: z.preprocess(emptyToUndefined, z.enum(["0", "1"]).default("1")),
  /** Navegador compartilhado dos agentes (Chromium com perfil por workspace): "0" desliga. */
  BROWSER: z.preprocess(emptyToUndefined, z.enum(["0", "1"]).default("1")),
  /** Sem uso por tanto tempo (ms), o Chromium fecha; 0 = nunca. */
  BROWSER_IDLE_MS: optionalInt(10 * 60_000, 0, 24 * 3_600_000),
  /** Só para teste: de quanto em quanto tempo o vigia das rotinas confere (ms; padrão 10 min). */
  ROUTINE_TICK_MS: optionalInt(10 * 60_000, 1000, 3_600_000),
  /** Domínios que o navegador nunca abre (vírgulas), além da rede local: o endereço público do app. */
  BROWSER_BLOCKED_HOSTS: z.preprocess(emptyToUndefined, z.string().default("")),
  /** Intervalo da consulta do uso da conta Claude (ms); 0 desliga a consulta. */
  CLAUDE_USAGE_POLL_MS: optionalInt(3 * 60_000, 0, 24 * 3_600_000),
  /** Intervalo da consulta da cota da conta Google no Antigravity (`agy -p /usage`, ms); 0 desliga. */
  ANTIGRAVITY_USAGE_POLL_MS: optionalInt(5 * 60_000, 0, 24 * 3_600_000),
  /**
   * Só desenvolvimento e testes: "off" mantém o comportamento antigo (sem senha, o app fica aberto).
   * Sem ela (padrão), sem senha o app fica fechado até a configuração inicial pelo código do log.
   */
  CYNO_AUTH: z.preprocess(emptyToUndefined, z.enum(["on", "off"]).default("on")),
  /** Atividade do servidor (DATA_DIR/activity: boot, batimento, alertas): "0" desliga. */
  SYSTEM_LOG: z.preprocess(emptyToUndefined, z.enum(["0", "1"]).default("1")),
  /** Intervalo da amostra de memória e do batimento (ms); 0 desliga a amostra. */
  SYSTEM_LOG_SAMPLE_MS: optionalInt(60_000, 0, 3_600_000),
});

export type AppConfig = {
  port: number;
  host: string;
  /** Pasta de dados de runtime (absoluta). */
  dataDir: string;
  logLevel: (typeof LOG_LEVELS)[number];
  /** Ausente = modo simulado desligado (produção). */
  agentRunner: AgentRunnerKind | undefined;
  /**
   * MockRunner: duração total de cada tarefa (ms), chance (0..1) de pedir aprovação e chance de
   * dividir um passo entre 2–3 subagentes em paralelo.
   */
  mock: { minMs: number; maxMs: number; approvalRate: number; subagentRate: number };
  /** Quanto tempo o agente fica "done" antes de voltar a idle ou pegar a próxima tarefa. */
  doneLingerMs: number;
  /** Quanto uma tarefa que espera o usuário segura a vaga do agente antes de soltá-la (0 = solta na hora). */
  approvalParkMs: number;
  /** Intervalo do ping do WebSocket; quem não responder até o próximo ping é desconectado. */
  wsHeartbeatMs: number;
  /**
   * Terminais de CLI dos agentes reais (motores "claude" e "gemini"): executáveis, esforço padrão, ociosidade
   * (para o processo; a próxima ordem retoma a sessão), quedas antes de desistir e a URL do MCP.
   */
  terminals: {
    claudeBin: string;
    claudeEffort: string;
    /** `--autocompact` dos agentes Claude ("" = sem a flag). */
    claudeAutocompact: string;
    agyBin: string;
    idleMs: number;
    maxRetries: number;
    mcpUrl: string;
    maestroRotateTokens: number;
    /** Maestro de Claude Code no terminal interativo (pty) e com Remote Control? */
    maestroPty: boolean;
    maestroRemoteControl: boolean;
    /** Ociosidade do Cyno antes de dormir (ms); 0 = o padrão (10 min). */
    cynoIdleMs: number;
  };
  /**
   * Consulta do uso da CONTA Claude (endpoint não documentado da Anthropic, com o login do Claude
   * Code): intervalo em ms; 0 = desligada.
   */
  claudeUsagePollMs: number;
  /** Consulta da cota da conta Google no Antigravity (`agy -p /usage`): intervalo em ms; 0 = desligada. */
  antigravityUsagePollMs: number;
  /**
   * Retenção do histórico: onde o Claude Code guarda as conversas (só as pastas dos nossos agentes
   * são tocadas) e se a limpeza roda sozinha (boot + diária).
   */
  retention: { claudeProjectsDir: string; autoRun: boolean };
  /** Conectores stdio (comando local) liberados? Padrão: não (CONNECTORS_STDIO=1 libera). */
  connectorsStdio: boolean;
  /** Navegador compartilhado: ligado, ociosidade e domínios sempre bloqueados. */
  browser: { enabled: boolean; idleMs: number; blockedHosts: string[] };
  /** Intervalo do vigia das rotinas (ms); só muda em teste (ROUTINE_TICK_MS). */
  routineTickMs: number;
  /** CYNO_AUTH=off: sem senha o app fica aberto (só desenvolvimento e testes). */
  authOff: boolean;
  /** Atividade do servidor: ligada e intervalo da amostra de recursos (a retenção é a da limpeza do histórico). */
  systemLog: { enabled: boolean; sampleMs: number };
};

/** Lê as variáveis de ambiente. DATA_DIR relativo é resolvido a partir da raiz do repo. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  if (parsed.MOCK_MAX_MS < parsed.MOCK_MIN_MS) {
    throw new Error("MOCK_MAX_MS precisa ser maior ou igual a MOCK_MIN_MS");
  }
  return {
    port: parsed.PORT,
    host: parsed.HOST,
    dataDir: path.resolve(REPO_ROOT, parsed.DATA_DIR ?? "data"),
    logLevel: parsed.LOG_LEVEL,
    agentRunner: parsed.AGENT_RUNNER,
    mock: { minMs: parsed.MOCK_MIN_MS, maxMs: parsed.MOCK_MAX_MS, approvalRate: parsed.MOCK_APPROVAL_RATE, subagentRate: parsed.MOCK_SUBAGENT_RATE },
    doneLingerMs: parsed.DONE_LINGER_MS,
    approvalParkMs: parsed.APPROVAL_PARK_MS,
    wsHeartbeatMs: parsed.WS_HEARTBEAT_MS,
    terminals: {
      claudeBin: parsed.CLAUDE_BIN,
      claudeEffort: parsed.CLAUDE_EFFORT === "none" ? "" : parsed.CLAUDE_EFFORT,
      claudeAutocompact: parsed.CLAUDE_AUTOCOMPACT === "none" ? "" : parsed.CLAUDE_AUTOCOMPACT,
      maestroRotateTokens: parsed.MAESTRO_ROTATE_TOKENS,
      agyBin: parsed.AGY_BIN,
      idleMs: parsed.TERMINAL_IDLE_MS,
      maxRetries: parsed.TERMINAL_MAX_RETRIES,
      mcpUrl: parsed.OFFICE_MCP_URL ?? `http://127.0.0.1:${parsed.PORT}/mcp`,
      maestroPty: parsed.MAESTRO_TERMINAL === "pty",
      maestroRemoteControl: parsed.MAESTRO_REMOTE_CONTROL === "1",
      cynoIdleMs: parsed.CYNO_IDLE_MS,
    },
    claudeUsagePollMs: parsed.CLAUDE_USAGE_POLL_MS,
    antigravityUsagePollMs: parsed.ANTIGRAVITY_USAGE_POLL_MS,
    retention: {
      claudeProjectsDir: path.join(path.resolve(parsed.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")), "projects"),
      autoRun: parsed.RETENTION_AUTO === "1",
    },
    connectorsStdio: parsed.CONNECTORS_STDIO === "1",
    browser: {
      enabled: parsed.BROWSER === "1",
      idleMs: parsed.BROWSER_IDLE_MS,
      blockedHosts: parsed.BROWSER_BLOCKED_HOSTS.split(",").map((host) => host.trim()).filter(Boolean),
    },
    routineTickMs: parsed.ROUTINE_TICK_MS,
    authOff: parsed.CYNO_AUTH === "off",
    systemLog: { enabled: parsed.SYSTEM_LOG === "1", sampleMs: parsed.SYSTEM_LOG_SAMPLE_MS },
  };
}
