#!/usr/bin/env node
// Provedor de IA FALSO, compatível com a API de chat da OpenAI (`/v1/chat/completions`, com e sem fluxo SSE e com
// chamadas de ferramenta). Serve para rodar os programas de verdade (OpenClaw, Hermes) sem conta e sem rede externa.
//
// Uso: node fake-openai-provider.mjs --port 6402 --log-dir /tmp/pasta [--slow-ms 60000]
//
// Cada requisição é gravada em `<log-dir>/requests.jsonl` (corpo inteiro, cabeçalhos SEM o valor de autorização:
// só `authorization: "<presente: Bearer, N caracteres>"`). O roteiro depende da última mensagem do usuário:
//   - contém "[[lento]]": espera `--slow-ms` antes de responder (tempo estourado / interrupção);
//   - contém "[[ler:<caminho>]]": chama a ferramenta de LER arquivo com esse caminho e responde "RESULTADO: <o que a ferramenta devolveu>"
//     (prova do alcance das ferramentas de arquivo: o texto devolvido mostra se leu ou se foi recusado);
//   - contém "[[escrever:<caminho>]]": idem com a ferramenta de GRAVAR (conteúdo "ISCA-ESCRITA");
//   - contém "[[terminal:<comando>]]": chama a ferramenta de TERMINAL (`terminal` no Hermes, `exec` no OpenClaw) com esse comando e responde "RESULTADO: <a saída>"
//     (prova de que os comandos do agente também ficam dentro da cerca de arquivos);
//   - contém "[[sequencia:N]]": N chamadas seguidas da ferramenta de ler, cada resposta demorando `--step-ms` (prova de que o
//     agente continua chamando ferramentas depois que o cliente morre: cada requisição fica no registro);
//   - contém "ola.txt": 1) chama a ferramenta de gravar arquivo, 2) chama `submit_result` (se existir), 3) texto final;
//   - qualquer outra: texto "ECO: <pedido>" (e `HISTORICO: n` com quantas mensagens anteriores vieram).
// As ferramentas são achadas na lista `tools` da própria requisição, pelo nome (a ideia é justamente descobrir o nome
// que cada programa dá a elas).
import { createServer } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const port = Number(opt("port", process.env.FAKE_PORT ?? "6402"));
const logDir = opt("log-dir", process.env.FAKE_LOG_DIR ?? "");
const slowMs = Number(opt("slow-ms", process.env.FAKE_SLOW_MS ?? "60000"));
const stepMs = Number(opt("step-ms", process.env.FAKE_STEP_MS ?? "3000"));
if (logDir) mkdirSync(logDir, { recursive: true });
let counter = 0;

const toolNames = (body) =>
  (body.tools ?? []).map((tool) => tool?.function?.name ?? tool?.name).filter((name) => typeof name === "string");

const messageText = (message) => {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.map((part) => (typeof part === "string" ? part : (part?.text ?? ""))).join("\n");
  return "";
};

/** Argumentos plausíveis para uma ferramenta, pelo esquema dela. */
function fillArguments(tool, hints) {
  const schema = tool?.function?.parameters ?? tool?.parameters ?? tool?.input_schema ?? {};
  const props = schema.properties ?? {};
  const out = {};
  for (const [key, def] of Object.entries(props)) {
    const lower = key.toLowerCase();
    // Só texto recebe texto (um parâmetro booleano chamado `awaitResults` não é um "resultado" em texto).
    if ((def?.type ?? "string") !== "string") {
      if (def?.type === "boolean" && (schema.required ?? []).includes(key)) out[key] = true;
      else if (def?.type === "array" && (schema.required ?? []).includes(key)) out[key] = [];
      continue;
    }
    if (/path|file|name/.test(lower) && (def?.type ?? "string") === "string") out[key] = hints.path;
    else if (/content|text|body|data/.test(lower)) out[key] = hints.content;
    else if (/summary|result|message|answer/.test(lower)) out[key] = hints.summary;
    else if ((def?.type ?? "string") === "string" && (schema.required ?? []).includes(key)) out[key] = hints.summary;
    else if (def?.type === "boolean" && (schema.required ?? []).includes(key)) out[key] = true;
    else if (def?.type === "array" && (schema.required ?? []).includes(key)) out[key] = [];
  }
  return out;
}

/** O começo do turno atual: depois da última resposta do assistente que não chamou ferramenta. */
function turnOf(messages) {
  let boundary = -1;
  messages.forEach((m, index) => {
    if (m.role === "assistant" && !(m.tool_calls?.length)) boundary = index;
  });
  const after = messages.slice(boundary + 1);
  const users = after.filter((m) => m.role === "user").map(messageText).filter((text) => !/^OpenClaw runtime context/.test(text));
  const before = messages.slice(0, boundary + 1).filter((m) => m.role === "user" || m.role === "assistant").filter((m) => !/^OpenClaw runtime context/.test(messageText(m))).length;
  return { user: users.join("\n"), toolResults: after.filter((m) => m.role === "tool" || m.role === "function").length, before };
}

function decide(body) {
  const messages = body.messages ?? [];
  const { user, toolResults: toolCalls, before: prior } = turnOf(messages);
  const names = toolNames(body);
  const find = (re) => (body.tools ?? []).find((tool) => re.test(tool?.function?.name ?? tool?.name ?? ""));
  if (/\[\[lento\]\]/.test(user)) return { kind: "slow" };
  const lastTool = [...messages].reverse().find((m) => m.role === "tool" || m.role === "function");
  const read = find(/^(read|read_file|file_read)$/i) ?? find(/read/i);
  const reading = /\[\[ler:([^\]]+)\]\]/.exec(user);
  if (reading) {
    if (toolCalls === 0 && read) return { kind: "tool", tool: read, args: fillArguments(read, { path: reading[1], content: "", summary: reading[1] }) };
    return { kind: "text", text: `RESULTADO: ${messageText(lastTool).slice(0, 600)}` };
  }
  const writing = /\[\[escrever:([^\]]+)\]\]/.exec(user);
  if (writing) {
    const write = find(/^(write|write_file|file_write|create_file)$/i) ?? find(/write/i);
    if (toolCalls === 0 && write) return { kind: "tool", tool: write, args: fillArguments(write, { path: writing[1], content: "ISCA-ESCRITA", summary: writing[1] }) };
    return { kind: "text", text: `RESULTADO: ${messageText(lastTool).slice(0, 600)}` };
  }
  const terminal = /\[\[terminal:([^\]]+)\]\]/.exec(user);
  if (terminal) {
    const run = find(/^(terminal|exec|bash|shell)$/i);
    if (toolCalls === 0 && run) return { kind: "tool", tool: run, args: fillArguments(run, { path: "-", content: "-", summary: terminal[1] }) };
    return { kind: "text", text: `RESULTADO: ${messageText(lastTool).slice(0, 1500)}` };
  }
  const sequence = /\[\[sequencia:(\d+)\]\]/.exec(user);
  if (sequence) {
    if (toolCalls < Number(sequence[1]) && read) return { kind: "tool", tool: read, args: fillArguments(read, { path: "AGENTS.md", content: "", summary: "AGENTS.md" }), delayMs: stepMs };
    return { kind: "text", text: `Sequência terminou: ${toolCalls} chamadas.` };
  }
  if (/ola\.txt/.test(user)) {
    const hints = { path: "ola.txt", content: "olá", summary: "Criei o arquivo ola.txt com a palavra olá." };
    if (toolCalls === 0) {
      const write = find(/^(write|write_file|file_write|create_file)$/i) ?? find(/write/i);
      if (write) return { kind: "tool", tool: write, args: fillArguments(write, hints) };
    }
    if (toolCalls <= 1) {
      const submit = find(/submit_result/i);
      if (submit) return { kind: "tool", tool: submit, args: fillArguments(submit, hints) };
    }
    return { kind: "text", text: "Pronto: ola.txt criado e resultado entregue." };
  }
  const clean = user.replace(/^\[[^\]]*\]\s*/, "").replace(/\s+/g, " ");
  return { kind: "text", text: `ECO: ${clean.slice(0, 600)}\nTAMANHO: ${clean.length}\nHISTORICO: ${prior}\nFERRAMENTAS: ${names.length}` };
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

function headersForLog(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/^(authorization|x-api-key|api-key|proxy-authorization)$/i.test(key)) {
      const text = String(value);
      out[key.toLowerCase()] = `<presente${/^bearer /i.test(text) ? ": Bearer" : ""}, ${text.length} caracteres>`;
    } else out[key.toLowerCase()] = value;
  }
  return out;
}

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    // corpo que não é JSON
  }
  const url = req.url ?? "/";
  const n = ++counter;
  const record = { n, at: new Date().toISOString(), method: req.method, url, headers: headersForLog(req.headers), body };
  if (logDir) appendFileSync(path.join(logDir, "requests.jsonl"), `${JSON.stringify(record)}\n`);
  const json = (code, payload) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  if (req.method === "GET" && /\/models(\?|$)/.test(url)) {
    return json(200, { object: "list", data: [{ id: "fake-model", object: "model", owned_by: "fake" }] });
  }
  if (req.method === "GET" && url === "/__health") return json(200, { ok: true, requests: counter });
  if (req.method !== "POST" || !/\/chat\/completions/.test(url)) return json(404, { error: { message: `rota desconhecida: ${req.method} ${url}`, type: "not_found" } });

  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const plan = decide(body);
  if (plan.kind === "slow") {
    await sleep(slowMs, abort.signal);
    if (abort.signal.aborted) return;
  }
  if (plan.delayMs) {
    await sleep(plan.delayMs, abort.signal);
    if (abort.signal.aborted) return;
  }
  const model = body.model ?? "fake-model";
  const id = `chatcmpl-fake-${n}`;
  const created = Math.floor(Date.now() / 1000);
  const toolCall =
    plan.kind === "tool" ? { id: `call_fake_${n}`, type: "function", function: { name: plan.tool?.function?.name ?? plan.tool?.name, arguments: JSON.stringify(plan.args) } } : undefined;
  const text = plan.kind === "tool" ? null : plan.kind === "slow" ? "demorei, mas respondi." : plan.text;
  const usage = { prompt_tokens: 120 + n, completion_tokens: 17, total_tokens: 137 + n };
  const finish = toolCall ? "tool_calls" : "stop";
  if (!body.stream) {
    return json(200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: text, ...(toolCall ? { tool_calls: [toolCall] } : {}) } }],
      usage,
    });
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (delta, finishReason = null, extra = {}) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra })}\n\n`);
  send({ role: "assistant", content: "" });
  if (toolCall) {
    send({ tool_calls: [{ index: 0, id: toolCall.id, type: "function", function: { name: toolCall.function.name, arguments: "" } }] });
    const argText = toolCall.function.arguments;
    const half = Math.ceil(argText.length / 2);
    send({ tool_calls: [{ index: 0, function: { arguments: argText.slice(0, half) } }] });
    send({ tool_calls: [{ index: 0, function: { arguments: argText.slice(half) } }] });
  } else {
    const words = String(text).split(/(\s+)/);
    for (const word of words) if (word) send({ content: word });
  }
  send({}, finish);
  if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`fake-openai-provider em http://127.0.0.1:${port}/v1 (log: ${logDir || "nenhum"})\n`);
});
