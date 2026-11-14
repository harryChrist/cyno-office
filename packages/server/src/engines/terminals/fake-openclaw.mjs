#!/usr/bin/env node
/**
 * OpenClaw FALSO para os testes (nunca chama o `openclaw` de verdade nem gasta conta). Imita só
 * `openclaw agent exec --message-file <arq> --cwd <pasta> --config <json> --state-dir <pasta> --timeout <s> --json
 * [--model m] [--thinking nivel]`: lê a mensagem do arquivo, lê `mcp.servers.office` da configuração e imprime UM
 * envelope JSON (formato do programa de verdade, conferido em 13/11 contra o OpenClaw 2026.11.3: ok, status, final, payloads,
 * usage{input,output,cacheRead,cacheWrite,total,cost{total}}, toolSummary{calls,tools,failures}, model, provider, sessionId,
 * error{message,kind}; os de verdade estão em fixtures/openclaw-*.json) e as ferramentas do MCP chegam como `office__<nome>`.
 *
 * Diretivas na mensagem (a última parte, depois do último "---"): [entregar] (report_progress + submit_result pelo
 * MCP), [erro], [semconta], [cota], [custo] (usage.cost.total 0.37), [ferramentas] (toolSummary), [lento] (dorme 30 s),
 * [teimoso] (ignora SIGTERM, dorme), [crash] (sai com código 1 sem envelope), [tempo] (status "timeout"); sem
 * diretiva: responde "eco: <primeira linha>".
 *
 * Ambiente: FAKE_CLI_LOG (uma linha JSON por execução com argv, cwd, env, config e o texto da mensagem).
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isConversationText, maestroTurn } from "./fake-maestro.mjs";

const argv = process.argv.slice(2);
const arg = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
// Comandos de ESTADO (somente leitura), como o programa de verdade: `models status --json` e `models list --all --json`.
// O JSON vem de um arquivo ao lado da configuração do Cyno (OPENCLAW_CONFIG_PATH → fake-status.json) ou, na pasta
// pessoal (sem OPENCLAW_*), de FAKE_OC_PERSONAL_STATUS. Os rótulos trazem uma "chave" falsa para o teste de máscara.
if (argv[0] === "models") {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  const file = configPath ? path.join(path.dirname(configPath), "fake-status.json") : process.env.FAKE_OC_PERSONAL_STATUS;
  const data = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { providers: [] };
  if (process.env.FAKE_CLI_LOG) appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify({ cli: "openclaw", argv, env: process.env })}\n`);
  if (argv[1] === "status") {
    const providers = (data.providers ?? []).map((item) => ({
      provider: item.provider,
      effective: { kind: item.count ? "profiles" : "missing", detail: item.count ? "profiles=sk-or-v1-FAKEKEY0000000000000000" : "missing" },
      profiles: { count: item.count ?? 0, oauth: item.oauth ?? 0, token: item.token ?? 0, apiKey: item.apiKey ?? 0, labels: item.count ? ["openrouter:default (api_key) sk-or-v1-FAKEKEY0000000000000000"] : [] },
    }));
    process.stderr.write("(node:1) [DEP_PLUGIN_SDK] DeprecationWarning: Plugin SDK\n");
    process.stdout.write(`${JSON.stringify({ configPath: "/x/openclaw.json", defaultModel: data.defaultModel ?? "openai/gpt-6-astra", resolvedDefault: data.defaultModel ?? "openai/gpt-6-astra", auth: { storePath: "/x/auth.json", providersWithOAuth: [], missingProvidersInUse: data.missing ?? [], providers } }, null, 2)}\n`);
    process.exit(data.statusFails ? 1 : 0);
  }
  if (argv[1] === "list") {
    process.stdout.write(`${JSON.stringify({ count: (data.models ?? []).length, models: (data.models ?? []).map((id) => ({ key: id, name: id.split("/").at(-1) })) })}\n`);
    process.exit(0);
  }
  process.exit(2);
}
if (argv[0] !== "agent" || argv[1] !== "exec") {
  process.stderr.write(`fake-openclaw: só entende "agent exec" e "models" (veio: ${argv.join(" ")})\n`);
  process.exit(2);
}
const messageFile = arg("--message-file");
const message = messageFile ? readFileSync(messageFile, "utf8") : "";
let config = {};
try {
  config = JSON.parse(readFileSync(arg("--config"), "utf8"));
} catch {
  // sem configuração
}
if (process.env.FAKE_CLI_LOG) appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify({ cli: "openclaw", argv, cwd: process.cwd(), env: process.env, config, message })}\n`);

const parts = message.split("\n\n---\n\n");
const last = parts.at(-1) ?? message;
const first = last.split("\n").find((line) => line.trim()) ?? "";
const sessionId = randomUUID();
const model = arg("--model") ?? "openai/gpt-6-astra";
const [provider, ...rest] = model.includes("/") ? model.split("/") : ["fake", model];
const modelName = rest.join("/");

const print = (envelope) => process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
const failure = (messageText, status = "error") =>
  print({ ok: false, status, final: "", payloads: [], model: null, provider: null, sessionId, error: { message: messageText, kind: "exception" } });

// Como o programa de verdade: o `--state-dir` tem de existir (ele não cria a pasta).
const stateDir = arg("--state-dir");
if (stateDir && !existsSync(stateDir)) {
  failure(`State directory does not exist: ${stateDir} | ENOENT: no such file or directory, stat '${stateDir}' | ENOENT`);
  process.exit(1);
}

const mcp = config.mcp?.servers?.office;
let rpcId = 0;
async function callTool(name, args) {
  return (await callToolFull(name, args)).text;
}
async function callToolFull(name, args) {
  if (!mcp) return { text: "sem MCP", isError: true };
  try {
  const response = await fetch(mcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...mcp.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await response.json();
  return { text: body.result?.content?.[0]?.text ?? JSON.stringify(body), isError: body.result?.isError === true };
  } catch (error) {
    return { text: `erro de rede: ${error}`, isError: true };
  }
}

if (last.includes("[crash]")) process.exit(1);
if (last.includes("[teimoso]")) {
  process.on("SIGTERM", () => undefined);
  setInterval(() => undefined, 1000);
  await new Promise(() => undefined);
}
if (last.includes("[lento]")) await new Promise((resolve) => setTimeout(resolve, 30_000));
if (last.includes("[semconta]")) {
  failure("No route-compatible authentication source is configured for openai.");
  process.exit(1);
}
if (last.includes("[cota]")) {
  failure("429 rate limit exceeded: you exceeded your current quota");
  process.exit(1);
}
if (last.includes("[erro]")) {
  failure("falha simulada do modelo");
  process.exit(1);
}
if (last.includes("[tempo]")) {
  // O envelope de tempo estourado de verdade (fixtures/openclaw-timeout.json): status "timeout", payload de erro e kind "timeout".
  const text = "Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.";
  print({ ok: false, status: "timeout", final: "", payloads: [{ text, mediaUrl: null, isError: true }], codeModeEngaged: false, assistantTurns: 1, model: modelName, provider, sessionId, error: { message: text, kind: "timeout" } });
  process.exit(2);
}

const tools = [];
let final = `eco: ${first}`;
// Maestro ou Cyno em OpenClaw: o mesmo roteiro do Claude falso (abrir, delegar, receber a entrega, responder ao dono).
let conversation = false;
if (isConversationText(last)) {
  const answer = await maestroTurn({ last, whole: message, mcpTool: callToolFull });
  if (answer !== undefined) {
    final = answer;
    conversation = true;
  }
}
if (!conversation && last.includes("[entregar]")) {
  await callTool("report_progress", { percent: 50, message: "Metade feita (openclaw)" });
  await callTool("submit_result", { result: `Feito pelo OpenClaw falso: ${first}` });
  tools.push("office__report_progress", "office__submit_result");
  final = "Entreguei.";
}
if (last.includes("[ferramentas]")) tools.push("read", "write");
const costTotal = last.includes("[custo]") ? 0.37 : 0;
print({
  ok: true,
  status: "ok",
  final,
  payloads: [{ text: final }],
  usage: { usageReport: { state: "available" }, input: 120, output: 8, cacheRead: 0, cacheWrite: 0, total: 128, cost: { total: costTotal } },
  codeModeEngaged: false,
  assistantTurns: 1 + tools.length,
  toolSummary: { calls: tools.length, tools, failures: 0 },
  model: modelName,
  provider,
  sessionId,
});
