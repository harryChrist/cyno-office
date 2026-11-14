/**
 * Ambiente dos processos de CLI: só a assinatura (login da CLI) pode ser usada, nunca uma API paga.
 * Saem do ambiente herdado do server:
 * - tudo que começa com ANTHROPIC_ (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL…);
 * - chaves de API de outros provedores (GEMINI_*, GOOGLE_API_KEY, OPENAI_*…), as credenciais/projeto
 *   do Google Cloud (que trocariam o Antigravity para Vertex/API paga) e as variáveis que trocam o
 *   Claude Code para Bedrock/Vertex/Foundry;
 * - as variáveis de uma sessão do Claude Code em que o server possa estar rodando (CLAUDECODE,
 *   CLAUDE_CODE_*), menos CLAUDE_CODE_OAUTH_TOKEN, que é o token da assinatura (`claude setup-token`).
 */
const STRIP_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_", "AWS_BEARER_TOKEN_BEDROCK", "VERTEX_", "GEMINI_", "OPENAI_", "GOOGLE_GENAI_"];

const STRIP_EXACT = new Set([
  "CLAUDECODE",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "OPENROUTER_API_KEY",
  "MCP_TOOL_TIMEOUT",
]);

/** Sobrevive mesmo com o prefixo da lista acima (é a assinatura, não uma chave de API). */
const KEEP = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

/** Nomes que nunca podem chegar ao processo (para conferir nos testes e no log). */
export function isStrippedEnvName(name: string): boolean {
  if (KEEP.has(name)) return false;
  return STRIP_EXACT.has(name) || STRIP_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Nomes que `extra` também não pode pôr de volta (chaves de API; CLAUDE_CODE_* de configuração pode). */
const isApiKeyName = (name: string) => name !== "CLAUDE_CODE_OAUTH_TOKEN" && isStrippedEnvName(name) && !name.startsWith("CLAUDE_CODE_");

/** Cópia do ambiente sem as chaves de API e variáveis de sessão, mais `extra` por cima. */
export function sanitizeChildEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || isStrippedEnvName(name)) continue;
    out[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    // `extra` também não pode reintroduzir uma chave de API.
    if (isApiKeyName(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Nomes que um programa de agente com configuração PRÓPRIA (OpenClaw e Hermes na pasta do Cyno) precisa do ambiente do
 * server. Todo o resto fica de fora: esses programas adotam sozinhos qualquer chave de provedor que achem no ambiente
 * (XAI_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY…), e uma lista negra de prefixos (`sanitizeChildEnv`) nunca cobre todos.
 * `FAKE_*` passa: são os controles das CLIs falsas dos testes (nunca existem no ambiente de verdade).
 */
const MINIMAL_ENV_NAMES = new Set(["PATH", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TERM", "USER", "LOGNAME", "SHELL", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]);

/** Só o necessário para o programa rodar (PATH, idioma, proxy) mais `extra`; nenhuma chave de API, login ou pasta de configuração do dono. */
export function minimalChildEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (MINIMAL_ENV_NAMES.has(name) || name.startsWith("LC_") || name.startsWith("FAKE_")) out[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) out[name] = value;
  return out;
}
