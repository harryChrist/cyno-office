/**
 * Máscara de segredos (chaves, tokens, senhas) para todo texto de ferramenta mostrado ao dono.
 *
 * Origem: os 21 padrões e `maskSecrets` vêm do Habblaud (`shared/activity.ts`,
 * github.com/marmottajr/habblaud, commit faa1a01), licença MIT, Copyright (c) 2026 Márcio Junior.
 * Texto da licença em `THIRD_PARTY/habblaud-LICENSE.txt`. Adaptação nossa: o texto do bloco PEM
 * em pt-BR fixo (sem i18n) e `maskDeep`.
 */

/**
 * Padrões de segredos mascarados em textos e detalhes (comandos, prompts, respostas, erros).
 * Os detalhes vão para o navegador e para o feed: um token colado num `curl` não pode aparecer lá.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // 1. Blocos de chave privada (PEM).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[chave privada]"],
  // 2. Cabeçalhos com credenciais: Authorization, Cookie, X-Api-Key...
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|private-token)(\s*:\s*)[^'"\n]+/gi, "$1$2***"],
  // 3. Bearer/Basic <valor> soltos.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g, "$1 ***"],
  // 4. URL com usuário:senha.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+:)[^\s@/'"]+@/gi, "$1***@"],
  // 5-7. Webhook: o host fica, o caminho com o segredo sai.
  [/(\bhttps?:\/\/hooks\.slack\.com\/services\/)T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/gi, "$1***"],
  [/(\bhttps?:\/\/(?:discordapp|discord)\.com\/api\/webhooks\/)\d+\/[A-Za-z0-9_-]+/gi, "$1***"],
  [/(\bhttps?:\/\/api\.telegram\.org\/bot)\d+:[A-Za-z0-9_-]+/gi, "$1***"],
  // 8. curl -u usuario:senha / --user usuario:senha.
  [/((?:^|\s)(?:-u|--user)\s+['"]?[^\s:'"]+:)[^\s'"]+/g, "$1***"],
  // 9. --token X, --password=X, --api-key X...
  [/((?:^|\s)--?(?:token|password|passwd|pass|secret|api-key|apikey|access-token|auth-token)(?:\s+|=))(['"]?)[^\s'"]+\2/gi, "$1$2***$2"],
  // 10. NOME_SENSIVEL=valor / "password": "valor" (GITHUB_TOKEN, DB_PASSWORD, client_secret, api_key...).
  [
    /\b([A-Za-z0-9_.-]*?(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|_key|credentials?))(["']?\s*[=:]\s*)(["']?)([^\s"'&;|,}]+)\3/gi,
    "$1$2$3***$3",
  ],
  // 11-18. Chaves com prefixo conhecido.
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}/g, "sk-***"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "gh*_***"],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, "github_pat_***"],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, "glpat-***"],
  [/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, "xox*-***"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "AKIA***"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "AIza***"],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, "sk_***"],
  // 19-20. Token solto do npm e do Hugging Face (tamanho de token real; "npm test" e "hf" ficam).
  [/\bnpm_[A-Za-z0-9]{30,}/g, "npm_***"],
  [/\bhf_[A-Za-z0-9]{30,}/g, "hf_***"],
  // 21. JWT.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "eyJ***"],
];

/** Quantos padrões existem (o teste confere um caso positivo e um negativo de cada). */
export const SECRET_PATTERN_COUNT = SECRET_PATTERNS.length;

/** Mascara segredos comuns (tokens, senhas, chaves) num texto livre. */
export function maskSecrets(s: string): string {
  let out = s;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Aplica `maskSecrets` a todo texto dentro de um valor JSON (objeto, lista ou texto). Nossa. */
export function maskDeep<T>(value: T): T {
  if (typeof value === "string") return maskSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => maskDeep(item)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskDeep(item)])) as T;
  return value;
}
