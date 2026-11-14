// Parte dos casos vem do `activity.test.ts` do Habblaud (github.com/marmottajr/habblaud, MIT,
// Copyright (c) 2026 Márcio Junior; licença em THIRD_PARTY/habblaud-LICENSE.txt), adaptada.
import { describe, expect, it } from "vitest";
import { maskDeep, maskSecrets, SECRET_PATTERN_COUNT } from "./secrets";

// Montado em partes: o URL inteiro no fonte dispara o push protection do GitHub.
const SLACK = ["https://hooks.slack.com/services", "T00000000", "B00000000", "X".repeat(24)].join("/");

/** Um caso positivo (o segredo some) e um negativo (texto comum fica igual) para cada um dos 21 padrões. */
const CASES: Array<{ name: string; secret: string; masked: string; plain: string }> = [
  { name: "bloco de chave privada", secret: "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----", masked: "[chave privada]", plain: "uma chave pública BEGIN PUBLIC KEY" },
  { name: "cabeçalho Authorization", secret: "Authorization: Basic dXNlcjpwYXNz", masked: "Authorization: ***", plain: "a autorização foi pedida" },
  { name: "Bearer solto", secret: "Bearer abcdef123456", masked: "Bearer ***", plain: "Bearer of bad news" },
  { name: "URL com usuário e senha", secret: "postgres://user:pa55word@db.host:5432/app", masked: "postgres://user:***@db.host:5432/app", plain: "https://example.com:8080/app" },
  { name: "webhook do Slack", secret: SLACK, masked: "https://hooks.slack.com/services/***", plain: "https://hooks.slack.com/docs" },
  { name: "webhook do Discord", secret: "https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz-_0123456789", masked: "https://discord.com/api/webhooks/***", plain: "https://discord.com/channels/1/2" },
  { name: "bot do Telegram", secret: "https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX/sendMessage", masked: "https://api.telegram.org/bot***/sendMessage", plain: "https://api.telegram.org/docs" },
  { name: "curl -u", secret: "curl -u admin:s3cr3t https://x.com/api", masked: "curl -u admin:*** https://x.com/api", plain: "curl -s https://x.com/api" },
  { name: "--password", secret: "tool --password hunter2 --x", masked: "tool --password *** --x", plain: "tool --passthrough ok" },
  { name: "NOME=valor sensível", secret: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456 gh pr list", masked: "GITHUB_TOKEN=*** gh pr list", plain: "max_tokens deve ser 100 e NODE_ENV=production" },
  { name: "chave sk-", secret: "x sk-ant-api03-abcdefghijklmnop y", masked: "x sk-*** y", plain: "o sk-curto fica" },  { name: "token do GitHub (ghp_)", secret: "ghs_abcdefghijklmnopqrstuvwx", masked: "gh*_***", plain: "ghp_curto" },
  { name: "github_pat_", secret: "github_pat_11ABCDEFG0abcdefghijklmnop", masked: "github_pat_***", plain: "github_pat_ curto" },
  { name: "glpat-", secret: "glpat-abcdefghijklmnopqrstuvwx", masked: "glpat-***", plain: "glpat-curto" },
  { name: "xox (Slack)", secret: "xoxb-1234567890-abcdefghij", masked: "xox*-***", plain: "xoxo para vocês" },
  { name: "AWS AKIA", secret: "AKIAABCDEFGHIJKLMNOP", masked: "AKIA***", plain: "AKIA curto" },
  { name: "Google AIza", secret: "AIzaSyA1234567890abcdefghijklmnopqrstuv", masked: "AIza***", plain: "AIza curto" },
  { name: "Stripe sk_live", secret: "sk_live_abcdefghij1234", masked: "sk_***", plain: "sk_live_curto" },
  { name: "token npm_", secret: "usa npm_1234567890abcdef1234567890abcdef1234 no ci", masked: "usa npm_*** no ci", plain: "rode npm test e npm run build com npm_config_cache" },
  { name: "token hf_", secret: "chave hf_abcdefghijklmnopqrstuvwxyz01234567 solta", masked: "chave hf_*** solta", plain: "o modelo hf da huggingface" },
  { name: "JWT", secret: "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4f", masked: "eyJ***", plain: "eyJ sozinho" },
];

describe("maskSecrets", () => {
  it("tem os 21 padrões do Habblaud e um caso para cada", () => {
    expect(SECRET_PATTERN_COUNT).toBe(21);
    expect(CASES).toHaveLength(21);
  });

  it.each(CASES)("$name: o segredo some", ({ secret, masked }) => {
    expect(maskSecrets(secret)).toBe(masked);
  });

  it.each(CASES)("$name: texto comum fica igual", ({ plain }) => {
    expect(maskSecrets(plain)).toBe(plain);
  });

  it("casos do Habblaud em frase corrida", () => {
    expect(maskSecrets('curl -sS -H "Authorization: Bearer FAKE_TOKEN_123" https://api.example.com/v1')).toBe('curl -sS -H "Authorization: ***" https://api.example.com/v1');
    expect(maskSecrets('curl "https://x.com/?token=abc&x=1" --password hunter2')).toBe('curl "https://x.com/?token=***&x=1" --password ***');
    expect(maskSecrets('{"password": "x", "max_tokens": 100}')).toBe('{"password": "***", "max_tokens": 100}');
    expect(maskSecrets("AKIAABCDEFGHIJKLMNOP eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4f")).toBe("AKIA*** eyJ***");
    expect(maskSecrets("usa a chave sk-proj-0123456789abcdef pra testar")).toBe("usa a chave sk-*** pra testar");
  });

  it("a chave do OpenRouter (sk-or-v1-…) também é mascarada", () => {
    const masked = maskSecrets("key sk-or-v1-0123456789abcdef0123456789abcdef z");
    expect(masked).toBe("key sk-*** z");
    expect(masked).not.toContain("0123456789");
  });

  it("a chave de teste do laboratório", () => {
    expect(maskSecrets("CHAVE=sk-ant-api03-TESTE-0000000000000000000000000000")).not.toContain("TESTE");
  });
});

describe("maskDeep", () => {
  it("mascara texto em objetos e listas sem mexer no resto", () => {
    const value = { a: "token sk-ant-api03-abcdefghijklmnop", n: 3, ok: true, nested: [{ b: "Bearer abcdef123456" }, null], none: undefined };
    expect(maskDeep(value)).toEqual({ a: "token sk-***", n: 3, ok: true, nested: [{ b: "Bearer ***" }, null], none: undefined });
  });
});
