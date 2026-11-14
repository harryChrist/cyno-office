#!/usr/bin/env node
/**
 * Antigravity CLI FALSO para os testes (nunca chama o `agy` de verdade nem gasta assinatura).
 * Imita o `agy --input-format stream-json --output-format stream-json` 1.5.3 (formato capturado em
 * fixtures/agy-stream-json.jsonl): lê `{"event":"user","message":{"content":…}}` da entrada (um
 * turno por linha) e escreve `init` (uma vez), `step_update` e `result`. O servidor MCP vem do
 * `.agents/mcp_config.json` da pasta (cwd), como no agy.
 *
 * Diretivas no texto: [entregar] (report_progress + submit_result), [delegar:ID] (Maestro), [crash] (sai com
 * código 1 na primeira vez), "Resultado da tarefa" (Maestro: complete_request); sem diretiva:
 * responde "eco: <primeira linha>". Um control_request encerra com código 2, como no agy.
 *
 * Ambiente: FAKE_CLI_LOG (uma linha JSON por subida com argv, cwd e env) e FAKE_CLI_STATE (pasta:
 * conversas conhecidas e marcas de [crash]).
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const arg = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
const stateDir = process.env.FAKE_CLI_STATE ?? path.join(process.cwd(), ".fake-cli");
mkdirSync(path.join(stateDir, "conversations"), { recursive: true });
if (process.env.FAKE_CLI_LOG) {
  appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify({ cli: "agy", argv, cwd: process.cwd(), env: process.env })}\n`);
}

// Como a CLI de verdade: nos modelos Gemini o nível vai no nome do modelo e `--effort` é recusado.
if (argv.includes("--effort") && /^gemini-/i.test(arg("--model") ?? "")) {
  process.stderr.write(`error: --effort is not supported for model ${arg("--model")}\n`);
  process.exit(2);
}

let conversationId = arg("--conversation");
if (conversationId && !existsSync(path.join(stateDir, "conversations", conversationId))) {
  process.stderr.write(`warning: conversation "${conversationId}" not found\n`);
  conversationId = undefined;
}
conversationId ??= randomUUID();

const mcpFile = path.join(process.cwd(), ".agents", "mcp_config.json");
const mcp = existsSync(mcpFile) ? JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers?.office : undefined;
let rpcId = 0;
async function callTool(name, args) {
  if (!mcp) return { text: "sem MCP", isError: true };
  const response = await fetch(mcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...mcp.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await response.json();
  return { text: body.result?.content?.[0]?.text ?? JSON.stringify(body), isError: body.result?.isError === true };
}

const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
let step = 0;
let turns = 0;
const update = (fields) => out({ event: "step_update", step_update: { conversation_id: conversationId, ...fields } });

async function mcpTool(name, args) {
  const index = step++;
  const tool_info = { name: "call_mcp_tool", parameters: { Arguments: args, ServerName: "office", ToolName: name } };
  update({ step_index: index, state: "ACTIVE", step_type: "tool", tool_name: "call_mcp_tool", tool_info });
  const result = await callTool(name, args);
  update({
    step_index: index,
    state: "DONE",
    step_type: "tool",
    tool_name: "call_mcp_tool",
    duration_seconds: 0.01,
    tool_info: { ...tool_info, ...(result.isError ? { error: { type: "MCP_ERROR", message: result.text } } : { output: result.text }) },
  });
}

function say(text) {
  const index = step++;
  const half = Math.ceil(text.length / 2);
  update({ step_index: index, state: "ACTIVE", step_type: "agent_response", text_delta: text.slice(0, half) });
  update({ step_index: index, state: "DONE", step_type: "agent_response", text_delta: text.slice(half), usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } });
}

let initialized = false;
let queue = Promise.resolve();

async function turn(text) {
  if (!initialized) {
    initialized = true;
    out({ event: "init", conversation_id: conversationId, init: { model: arg("--model") ?? "fake-gemini", cwd: process.cwd(), tools: ["call_mcp_tool", "view_file", "write_to_file"], permission_mode: "request-review" } });
  }
  process.stdout.write("linha que não é JSON\n");
  update({ step_index: step++, state: "DONE", step_type: "user_input" });
  const first = text.split("\n")[0];
  if (text.includes("[crash]")) {
    const marker = path.join(stateDir, `agy-crash-${Buffer.from(first).toString("hex").slice(0, 60)}`);
    if (!existsSync(marker)) {
      writeFileSync(marker, "1");
      process.exit(1);
    }
  }
  const delegate = /\[delegar:([a-z0-9-]+)\]/.exec(text);
  let response = `eco: ${first}`;
  if (text.startsWith("Resultado da tarefa")) {
    await mcpTool("complete_request", { text: `Resposta final do Maestro Gemini. ${first}` });
    response = "";
  } else if (delegate) {
    const rest = first.replace(/^Pedido [^:]+: /, "").replace(delegate[0], "").trim();
    await mcpTool("delegate_task", { agent_id: delegate[1], task: `[entregar] ${rest}` });
    response = "";
  } else if (text.includes("[entregar]")) {
    await mcpTool("report_progress", { percent: 50, message: "Metade feita (agy)" });
    await mcpTool("submit_result", { result: `Feito pelo agy falso: ${first}` });
    response = "Entreguei.";
  }
  if (response) say(response);
  turns += 1;
  writeFileSync(path.join(stateDir, "conversations", conversationId), "1");
  out({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response, duration_seconds: 0.1, num_turns: turns, usage: { total_tokens: 12 } } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    out({ event: "result", result: { conversation_id: conversationId, status: "ERROR", response: "", error: "invalid JSON" } });
    process.exit(1);
  }
  if (message.type === "control_request" || message.event === "control_request") process.exit(2);
  if (message.event !== "user") {
    process.stderr.write(`warning: skipping unknown event ${message.event}\n`);
    return;
  }
  const content = message.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((block) => block.text ?? "").join("\n") : "";
  queue = queue.then(() => turn(text));
});
process.stdin.on("end", () => void queue.then(() => process.exit(0)));
