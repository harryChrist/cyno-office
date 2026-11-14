#!/usr/bin/env node
/**
 * Hermes FALSO para os testes (nunca chama o `hermes` de verdade nem gasta conta). Imita
 * `hermes chat --query-file <arq> --oneshot -Q --format stream-json [-t ...] [--yolo] [--provider p] [-m m] [--resume id]`
 * com as linhas do programa de verdade (v0.23.1, conferido em 13/11; fixtures/hermes-*.jsonl): `system/init` (session_id vazio),
 * `text`, `tool_use`, `tool_result` e um `result` final (session_id `local-<hash>`, exit_code, text, tokens, duration_ms, error).
 * O servidor MCP vem do `mcp_servers.office` (url e Authorization) do config.yaml do HERMES_HOME do agente, como o de verdade;
 * `-t mcp-office` sem esse servidor é `invalid_params`, e as ferramentas do MCP chegam como `mcp__office__<nome>`.
 *
 * Diretivas na mensagem: [entregar] (report_progress + submit_result pelo MCP), [erro], [semconta], [cota],
 * [ferramentas] (tool_use/tool_result), [lento] (dorme 30 s), [teimoso] (ignora SIGTERM), [crash] (sai com código 1
 * sem nada), [semresult] (sai sem o `result`); sem diretiva: responde "eco: <primeira linha>".
 *
 * Ambiente: FAKE_CLI_LOG (uma linha JSON por execução com argv, cwd, env, config.yaml e a mensagem) e
 * FAKE_CLI_STATE (pasta: sessões conhecidas).
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isConversationText, maestroTurn } from "./fake-maestro.mjs";

const argv = process.argv.slice(2);
const arg = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
// `auth list` (somente leitura, formato do código-fonte: "provedor (N credentials):" e uma linha por credencial). O texto
// vem de fake-auth-list.txt no HERMES_HOME do Cyno ou, na pasta pessoal (sem HERMES_HOME), de FAKE_HERMES_PERSONAL_AUTH.
if (argv[0] === "auth" && argv[1] === "list") {
  const file = process.env.HERMES_HOME ? path.join(process.env.HERMES_HOME, "fake-auth-list.txt") : process.env.FAKE_HERMES_PERSONAL_AUTH;
  if (process.env.FAKE_CLI_LOG) appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify({ cli: "hermes", argv, env: process.env })}\n`);
  if (file && existsSync(file)) process.stdout.write(readFileSync(file, "utf8"));
  process.exit(0);
}
if (argv[0] !== "chat") {
  process.stderr.write(`fake-hermes: só entende "chat" e "auth list" (veio: ${argv.join(" ")})\n`);
  process.exit(2);
}
const message = arg("--query-file") ? readFileSync(arg("--query-file"), "utf8") : (arg("-q") ?? "");
const home = process.env.HERMES_HOME ?? process.env.FAKE_HERMES_PERSONAL_HOME ?? "";
const configFile = home ? path.join(home, "config.yaml") : "";
const config = configFile && existsSync(configFile) ? readFileSync(configFile, "utf8") : "";
const agentsFile = path.join(process.cwd(), "AGENTS.md");
if (process.env.FAKE_CLI_LOG) {
  appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify({ cli: "hermes", argv, cwd: process.cwd(), env: process.env, config, agents: existsSync(agentsFile) ? readFileSync(agentsFile, "utf8") : undefined, message })}\n`);
}
const stateDir = process.env.FAKE_CLI_STATE ?? path.join(process.cwd(), ".fake-cli");
mkdirSync(path.join(stateDir, "sessions"), { recursive: true });

const first = message.split("\n").find((line) => line.trim()) ?? "";
const resume = arg("--resume");
if (resume && !existsSync(path.join(stateDir, "sessions", resume))) {
  // Como o de verdade (fixtures/hermes-missing-session.jsonl): evento result com o erro e saída 1.
  const text = `No session found matching '${resume}'. Use 'hermes sessions list' to see available sessions, or pass -c <name> --create-if-missing to start a new session with that title.`;
  process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", model: "", session_id: "" })}\n${JSON.stringify({ type: "result", session_id: "", exit_code: 1, text: "", tokens: { input: 0, output: 0, total: 0, cache_read: 0, cache_write: 0 }, duration_ms: 35, error: text })}\n`);
  process.stderr.write(`Error: ${text}\n`);
  process.exit(1);
}
// MCP do agente: url e Authorization do config.yaml (o gateway de verdade os lê de lá).
const mcpUrl = /^\s+url:\s*"?([^"\n]+)"?/m.exec(config)?.[1];
const mcpAuth = /^\s+Authorization:\s*"?([^"\n]+)"?/m.exec(config)?.[1];
const toolsets = (arg("-t") ?? "").split(",");
if (toolsets.includes("mcp-office") && !mcpUrl) {
  process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", model: arg("-m") ?? "", session_id: "" })}\n${JSON.stringify({ type: "result", session_id: "", exit_code: 1, text: "", tokens: { input: 0, output: 0, total: 0, cache_read: 0, cache_write: 0 }, duration_ms: 134, error: "invalid_params" })}\n`);
  process.stderr.write("Error: invalid_params\n");
  process.exit(1);
}
const sessionId = resume ?? `local-${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
const out = (event) => process.stdout.write(`${JSON.stringify({ ...event, timestamp: Date.now() })}\n`);
const started = Date.now();
const result = (fields) => {
  writeFileSync(path.join(stateDir, "sessions", sessionId), "1");
  out({ type: "result", session_id: sessionId, exit_code: 0, text: "", tokens: { input: 90, output: 6, total: 96, cache_read: 10, cache_write: 0 }, duration_ms: Date.now() - started, ...fields });
};

let rpcId = 0;
async function callTool(name, args) {
  return (await callToolFull(name, args)).text;
}
async function callToolFull(name, args) {
  const url = mcpUrl;
  if (!url) return { text: "sem MCP", isError: true };
  try {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: mcpAuth ?? "" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await response.json();
  return { text: body.result?.content?.[0]?.text ?? JSON.stringify(body), isError: body.result?.isError === true };
  } catch (error) {
    return { text: `erro de rede: ${error}`, isError: true };
  }
}

if (message.includes("[crash]")) process.exit(1);
out({ type: "system", subtype: "init", model: arg("-m") ?? "fake/hermes", session_id: "" });
if (message.includes("[teimoso]")) {
  process.on("SIGTERM", () => undefined);
  setInterval(() => undefined, 1000);
  await new Promise(() => undefined);
}
if (message.includes("[lento]")) await new Promise((resolve) => setTimeout(resolve, 30_000));
if (message.includes("[semresult]")) process.exit(0);
if (message.includes("[semconta]")) {
  process.stderr.write("Error: no provider credentials found. Run `hermes setup` or `hermes auth add`.\n");
  process.exit(1);
}
if (message.includes("[cota]")) {
  result({ exit_code: 2, text: "", error: "429 rate limit exceeded: quota exhausted" });
  process.exit(2);
}
if (message.includes("[erro]")) {
  result({ exit_code: 2, text: "", error: "falha simulada do modelo" });
  process.exit(2);
}

let final = `eco: ${first}`;
// Maestro ou Cyno em Hermes: o mesmo roteiro do Claude falso (abrir, delegar, receber a entrega, responder ao dono).
let conversation = false;
const lastPart = message.split("\n\n---\n\n").at(-1) ?? message;
if (isConversationText(lastPart)) {
  const answer = await maestroTurn({ last: lastPart, whole: message, mcpTool: callToolFull });
  if (answer !== undefined) {
    final = answer;
    conversation = true;
  }
}
out({ type: "text", text: "Vou " });
out({ type: "text", text: "trabalhar. " });
if (message.includes("[ferramentas]")) {
  out({ type: "tool_use", name: "read_file", tool_call_id: "call_1", input: { path: "a.txt" } });
  out({ type: "tool_result", name: "read_file", tool_call_id: "call_1", output: "conteudo", duration_ms: 12, is_error: false });
}
if (!conversation && message.includes("[entregar]")) {
  out({ type: "tool_use", name: "mcp__office__report_progress", tool_call_id: "call_2", input: { percent: 50, message: "Metade feita (hermes)" } });
  await callTool("report_progress", { percent: 50, message: "Metade feita (hermes)" });
  out({ type: "tool_result", name: "mcp__office__report_progress", tool_call_id: "call_2", output: "ok", duration_ms: 5, is_error: false });
  out({ type: "tool_use", name: "mcp__office__submit_result", tool_call_id: "call_3", input: { result: `Feito pelo Hermes falso: ${first}` } });
  await callTool("submit_result", { result: `Feito pelo Hermes falso: ${first}` });
  out({ type: "tool_result", name: "mcp__office__submit_result", tool_call_id: "call_3", output: "ok", duration_ms: 5, is_error: false });
  final = "Entreguei.";
}
out({ type: "text", text: final });
result({ text: final });
