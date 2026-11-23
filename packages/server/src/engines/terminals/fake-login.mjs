#!/usr/bin/env node
/**
 * CLI FALSA de login para os testes (nunca chama o `claude` nem o `agy` reais nem acessa a rede).
 *
 * Modos:
 * - `--version`: imprime "fake-login 1.0.0" e sai com 0;
 * - `auth status`: imita `claude auth status`, imprimindo `{"loggedIn": true|false}` conforme a
 *   existência de `<CLAUDE_CONFIG_DIR>/.credentials.json` (ou `<HOME>/.claude/.credentials.json`);
 * - `auth login` (Claude) ou sem argumentos (Antigravity): imprime um link de login, lê uma linha
 *   (o "código") da entrada, grava o arquivo de login falso na pasta do ambiente e imprime "Logged in".
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);

function claudeCredentialsPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || process.cwd(), ".claude");
  return path.join(dir, ".credentials.json");
}

function agyTokenPath() {
  const home = process.env.HOME || process.cwd();
  return path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

if (argv.includes("--version")) {
  process.stdout.write("fake-login 1.0.0\n");
  process.exit(0);
}

if (argv[0] === "auth" && argv[1] === "status") {
  const loggedIn = existsSync(claudeCredentialsPath());
  process.stdout.write(`${JSON.stringify({ loggedIn })}\n`);
  process.exit(loggedIn ? 0 : 1);
}

const isClaude = (argv[0] === "auth" && argv[1] === "login") || Boolean(process.env.CLAUDE_CONFIG_DIR);
const loginUrl = isClaude
  ? "https://claude.ai/oauth/authorize?code_challenge=FAKE_CLAUDE_CHALLENGE_123"
  : "https://accounts.google.com/o/oauth2/auth?code_challenge=FAKE_AGY_CHALLENGE_456";

process.stdout.write(`Authentication required. Please visit the URL to log in: ${loginUrl}\n`);
process.stdout.write("Paste code: ");

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const code = line.trim();
  if (!code) return;
  const target = isClaude ? claudeCredentialsPath() : agyTokenPath();
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const content = isClaude
    ? `${JSON.stringify({ claudeAiOauth: { accessToken: "fake-access-token" } })}\n`
    : "fake-oauth-token\n";
  writeFileSync(target, content, { mode: 0o600 });
  process.stdout.write("Logged in\n");
  rl.close();
  if (process.env.FAKE_LOGIN_EXIT === "1") {
    process.exit(0);
  }
});

// Mantém vivo até SIGTERM (para o poller de login detectar e encerrar) a menos que FAKE_LOGIN_EXIT=1.
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
