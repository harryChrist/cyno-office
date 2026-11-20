#!/usr/bin/env node
/**
 * CLI INTERATIVA FALSA para os testes do terminal do Maestro (nunca chama o `claude` de verdade nem
 * gasta assinatura). Imita o Claude Code interativo num pseudo-terminal:
 * - desenha um cabeçalho e o prompt "❯ "; com --remote-control, mostra o link e grava `bridge_status`;
 * - lê as teclas em modo raw: texto colado (bracketed paste) e digitado vai para a caixa; Enter envia;
 * - comandos `/help`, `/status` (só imprimem), `/clear` (sessão nova), `/rename <nome>` e `/exit`;
 * - qualquer outro texto é um pedido: grava na conversa (`<projetos>/<cwd codificado>/<sessão>.jsonl`,
 *   como o Claude Code) a mensagem do usuário, a resposta e o `turn_duration`, e mostra na tela;
 * - diretivas no pedido: [crash] sai com código 3 no meio do turno (só na primeira vez); [ferramenta]
 *   grava um tool_use + tool_result; [lento] demora 400 ms; "Pedido <id>" chama `complete_request`
 *   no MCP "office" (do mcp.json) com a resposta, como o Maestro faria; o contexto que o server põe
 *   antes da 1ª mensagem de uma conversa nova ("(…" até "\n\n---\n\n") é pulado.
 *
 * Ambiente: FAKE_TUI_PROJECTS (pasta de projetos; padrão ~/.claude/projects NUNCA: obrigatória),
 * FAKE_TUI_LOG (arquivo: uma linha JSON por subida com argv e cwd), FAKE_TUI_TRUST=1 (mostra o
 * diálogo de confiança na pasta antes do prompt) ou FAKE_TUI_TRUST=add-dir (mostra o diálogo "Adding a new
 * directory", das pastas de trabalho, com "No, exit" marcado), FAKE_TUI_FAIL_START=1 (sai com código 1 na hora) e
 * FAKE_TUI_STATE (pasta: marcas de [crash]).
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
if (argv[0] === "--version") {
  process.stdout.write("2.1.319 (Fake Claude Code)\n");
  process.exit(0);
}
const projects = process.env.FAKE_TUI_PROJECTS;
if (!projects) {
  process.stdout.write("FAKE_TUI_PROJECTS ausente\r\n");
  process.exit(2);
}
if (process.env.FAKE_TUI_LOG) appendFileSync(process.env.FAKE_TUI_LOG, `${JSON.stringify({ argv, cwd: process.cwd(), cols: process.stdout.columns })}\n`);
if (process.env.FAKE_TUI_FAIL_START === "1") {
  process.stdout.write("falha ao subir\r\n");
  process.exit(1);
}

const dir = path.join(projects, path.resolve(process.cwd()).replace(/[^a-zA-Z0-9]/g, "-"));
mkdirSync(dir, { recursive: true });
const resume = arg("--resume");
let sessionId = resume ?? arg("--session-id") ?? randomUUID();
if (resume && !existsSync(path.join(dir, `${resume}.jsonl`))) {
  process.stdout.write(`No conversation found with session ID: ${resume}\r\n`);
  process.exit(1);
}
const transcript = (entry) =>
  appendFileSync(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ isSidechain: false, sessionId, timestamp: new Date().toISOString(), uuid: randomUUID(), ...entry })}\n`);

const out = (text) => process.stdout.write(text.replace(/\n/g, "\r\n"));
const prompt = () => out("\x1b[2K\r❯ ");

const mcpFile = arg("--mcp-config");
const mcp = mcpFile && existsSync(mcpFile) ? JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers?.office : undefined;
async function callTool(name, args) {
  if (!mcp) return { text: "sem MCP", isError: true };
  const response = await fetch(mcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...mcp.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await response.json();
  return { text: body.result?.content?.[0]?.text ?? JSON.stringify(body), isError: body.result?.isError === true };
}

let msgSeq = 0;
const assistant = (content, usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }) =>
  transcript({ type: "assistant", message: { id: `msg_fake${++msgSeq}`, role: "assistant", content, stop_reason: "end_turn", usage } });

let busy = false;
async function turn(received) {
  busy = true;
  transcript({ type: "user", message: { role: "user", content: received }, promptSource: "typed" });
  out(`\n> ${received.split("\n")[0]}\n`);
  // O contexto do Cérebro (ou o resumo) que o server põe antes da 1ª mensagem de uma conversa nova é pulado.
  const separator = "\n\n---\n\n";
  const text = received.startsWith("(") && received.includes(separator) ? received.slice(received.indexOf(separator) + separator.length) : received;
  const first = text.split("\n")[0];
  const stateDir = process.env.FAKE_TUI_STATE ?? path.join(process.cwd(), ".fake-tui");
  if (text.includes("[crash]")) {
    mkdirSync(stateDir, { recursive: true });
    const mark = path.join(stateDir, "crashed");
    if (!existsSync(mark)) {
      writeFileSync(mark, "1");
      process.exit(3);
    }
  }
  if (text.includes("[lento]")) await new Promise((resolve) => setTimeout(resolve, 400));
  if (text.includes("[ferramenta]")) {
    assistant([{ type: "tool_use", id: "toolu_fake1", name: "Read", input: { file_path: "CLAUDE.md" } }]);
    transcript({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fake1", content: "conteúdo" }] } });
  }
  const pedido = /^Pedido ([0-9a-f-]{36}):/.exec(text);
  let answer = `ok: ${first}`;
  if (pedido) {
    answer = `Resposta do Maestro (terminal): ${first.slice(pedido[0].length).trim()}`;
    assistant([{ type: "tool_use", id: "toolu_fake2", name: "mcp__office__complete_request", input: { text: answer, request_id: pedido[1] } }]);
    const result = await callTool("complete_request", { text: answer, request_id: pedido[1] });
    transcript({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fake2", content: result.text, is_error: result.isError }] } });
  }
  assistant([{ type: "text", text: answer }]);
  transcript({ type: "system", subtype: "turn_duration", durationMs: 12 });
  out(`● ${answer}\n`);
  busy = false;
  prompt();
}

function command(text) {
  const name = text.trim().split(/\s+/)[0];
  transcript({ type: "system", subtype: "local_command", content: `<command-name>${name}</command-name>` });
  if (name === "/exit") {
    out("\nAté mais!\n");
    process.exit(0);
  }
  if (name === "/clear") {
    sessionId = randomUUID();
    out("\n(conversa limpa)\n");
  } else if (name === "/rename") {
    // Como o Claude Code 2.1: renomeia a conversa (e a sessão do Remote Control) sem gastar turno.
    out(`\nSession renamed to: ${text.trim().slice(name.length).trim()}\n`);
  } else if (name === "/help" || name === "/status") out(`\nComandos: /help /status /clear /exit · sessão ${sessionId}\n`);
  else out(`\nUnknown command: ${name}\n`);
  prompt();
}

function start() {
  out(`Fake Claude Code · modelo ${arg("--model") ?? "padrão"} · sessão ${sessionId}\n`);
  const remote = arg("--remote-control");
  if (remote) {
    const url = "https://claude.ai/code/session_FAKE123";
    out(`/remote-control is active · ${remote} · ${url}\n`);
    transcript({ type: "system", subtype: "bridge_status", content: `/remote-control is active · Continue here, on your phone, or at ${url}`, url });
  }
  prompt();
}

const trustMode = process.env.FAKE_TUI_TRUST === "add-dir" ? "add-dir" : "folder";
let trusting = process.env.FAKE_TUI_TRUST === "1" || process.env.FAKE_TUI_TRUST === "add-dir";
let input = "";
let pasting = false;
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.on("SIGHUP", () => process.exit(0));

/** Diálogo de confiança como o do Claude Code: "❯" na opção escolhida; teclas antes de 300 ms são ignoradas. */
let trustSelection = 0;
let trustReadyAt = 0;
function drawTrust() {
  // Como o TUI de verdade: as palavras separadas por movimento de cursor (CSI 1 C), não por espaços.
  const mark = (index) => (trustSelection === index ? "❯" : " ");
  if (trustMode === "add-dir") {
    out(`\x1b[2J\x1b[HAdding\x1b[1Ca\x1b[1Cnew\x1b[1Cdirectory:\n\n/tmp/pasta-de-trabalho\n\nThis\x1b[1Csession\x1b[1Chasn't\x1b[1Cworked\x1b[1Chere\x1b[1Cbefore.\x1b[1CIs\x1b[1Cthis\x1b[1Ca\x1b[1Cdirectory\x1b[1Cyou\x1b[1Ccreated\x1b[1Cor\x1b[1Cone\x1b[1Cyou\x1b[1Ctrust?\n\n${mark(0)}\x1b[1CNo,\x1b[1Cexit\n${mark(1)}\x1b[1CYes,\x1b[1Cadd\x1b[1Cit\n`);
    return;
  }
  out(`\x1b[2J\x1b[HQuick\x1b[1Csafety\x1b[1Ccheck:\x1b[1CIs\x1b[1Cthis\x1b[1Ca\x1b[1Cproject?\n\x1b[1C${mark(0)}\x1b[1CNo,\x1b[1Cexit\n`);
  out(`\x1b[1C${mark(1)}\x1b[1CYes,\x1b[1CI\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder\n`);
}
if (trusting) {
  drawTrust();
  trustReadyAt = Date.now() + 300;
} else start();

process.stdin.on("data", (chunk) => {
  let data = chunk;
  if (trusting) {
    if (Date.now() < trustReadyAt) return;
    if (data.includes("\x1b[B") || data.includes("\x1bOB")) {
      trustSelection = 1;
      drawTrust();
    } else if (data.includes("\r")) {
      if (trustSelection === 0) process.exit(1); // "No, exit"
      trusting = false;
      start();
    }
    return;
  }
  while (data.length > 0) {
    if (data.startsWith("\x1b[200~")) {
      pasting = true;
      data = data.slice(6);
      continue;
    }
    if (data.startsWith("\x1b[201~")) {
      pasting = false;
      data = data.slice(6);
      continue;
    }
    if (data.startsWith("\x1b")) {
      // Esc sozinho (interromper) ou sequência que a falsa não conhece: ignora.
      data = data.slice(1);
      continue;
    }
    const char = data[0];
    data = data.slice(1);
    if (pasting) {
      input += char === "\r" ? "\n" : char;
      continue;
    }
    if (char === "\r") {
      const text = input;
      input = "";
      if (busy || !text.trim()) continue;
      if (text.trim().startsWith("/")) command(text);
      else void turn(text);
    } else if (char === "\x15") input = "";
    else if (char === "\x7f") input = input.slice(0, -1);
    else if (char === "\x03") process.exit(130);
    else {
      input += char;
      out(char);
    }
  }
});
