#!/usr/bin/env node
/**
 * CLI FALSA para os testes dos terminais (nunca chama o `claude` de verdade nem gasta assinatura).
 * Imita o Claude Code em `-p --input-format stream-json --output-format stream-json`: lê mensagens
 * JSON da entrada (uma por turno) e escreve eventos JSON (init, assistant, user/tool_result, result).
 *
 * Diretivas no texto da mensagem:
 * - [crash]       sai com código 1 no meio do turno (só na primeira vez: a mensagem reenviada passa);
 * - [subagente]   abre um subagente (Agent, sem `model`: vale o padrão) com mensagens `parent_tool_use_id` e fecha;
 * - [subagente-opus] abre outro subagente pedindo `model: "opus"` (a escolha do próprio agente);
 * - [cota]        (só na primeira vez) manda um rate_limit_event "rejected" (janela de 5 h a 100%,
 *                 volta em FAKE_CLI_RESETS_AT, segundos) e fecha o turno com erro de limite;
 * As diretivas são marcadores de teste (pt-BR); as ferramentas chamadas são as do contrato MCP (inglês).
 * - [entregar]    chama `report_progress` e a ferramenta MCP `submit_result` (servidor "office" do mcp.json);
 * - [aprovar]     chama `request_approval` e termina o turno (a decisão chega noutra mensagem);
 * - [abrir]       (Maestro) chama `open_request` (título = o resto da linha) antes do resto;
 * - [concluir]    junto com [abrir]: fecha o pedido aberto com `complete_request` no mesmo turno;
 * - [delegar:ID]  (Maestro) chama `delegate_task` para o agente ID com a tarefa "[entregar] <resto>" (com o
 *                 request_id do [abrir], se houve; numa conversa sem pedido, o erro do server vira o resultado);
 * - [motivo:TEXTO] junto com [delegar:ID]: passa TEXTO como `reason` do delegate_task;
 * - [parcial]    junto com [lento] ou [crash]: antes de ficar/cair, informa o uso de duas mensagens (a 1ª em duas
 *                 linhas da mesma id: saída 3 e depois 40; a 2ª com saída 7), que é o gasto parcial do turno cortado;
 * - [lento]       fica no turno até receber um interrupt (control_request) e então fecha com erro;
 * - [planejar:A,B] (Maestro, com [abrir]) chama `create_plan`: T1 (A: pesquisar) e T2 (A → B,
 *                 depende de T1); [etapa:X] põe a diretiva [X] na etapa de T1 (ex.: [etapa:info]);
 * - [perguntas]   (Maestro) chama `ask_user` com 2 perguntas (no pedido do [abrir], se houve);
 * - [perguntar]   (Maestro) termina o turno com uma pergunta ao usuário (sem complete_request);
 * - [info]        (agente) chama `ask_user` e termina o turno; "Respostas do usuário (" -> entrega;
 * - [ajuda]       (agente) chama `request_help` antes de entregar;
 * - [nota]        (agente) chama `search_notes` e `save_note` antes de entregar;
 * - [workspaces]  (Cyno) chama `list_workspaces`; [uso] chama `get_usage` (o resultado vira a resposta);
 * - [pedir:WS]    (Cyno) chama `send_request` para o workspace WS; [estado:ID] chama `get_request_status`;
 *                 [responder:A-0001] chama `answer_maestro`; [cancelar:ID] chama `cancel_request`;
 * - [ask-cyno]    (Maestro) chama `ask_cyno` com o resto da linha como pergunta;
 * - [antigo]      chama a ferramenta pelo nome antigo `entregar` (o server responde com erro apontando o novo);
 * - "o projeto terminou" / "Pedido <id>: Respostas do usuário" (Maestro) -> chama `complete_request`;
 * - "Resultado da tarefa" / "Decisão do usuário" (Maestro) -> chama `complete_request`;
 * - sem diretiva: responde "eco: <primeira linha>".
 * Também escreve uma linha que não é JSON (vira `raw`) e, depois do init, um `rate_limit_event`
 * (uso da assinatura: vira usage:updated, nunca log).
 *
 * O resumo que abre uma conversa nova do Maestro ("(Conversa nova…" ou "(Contexto do Cérebro…" até "\n\n---\n\n") e o diário no
 * topo de uma tarefa ("## O que você fez recentemente…" até "Tarefa ") são pulados antes das diretivas.
 *
 * Ambiente: FAKE_CLI_LOG (arquivo: uma linha JSON por subida com argv, cwd e as variáveis de
 * ambiente), FAKE_CLI_MESSAGES (arquivo: uma linha JSON por mensagem recebida, com a sessão e o
 * texto inteiro) e FAKE_CLI_STATE (pasta: sessões conhecidas e marcas de [crash]).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const arg = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
const stateDir = process.env.FAKE_CLI_STATE ?? path.join(process.cwd(), ".fake-cli");
mkdirSync(path.join(stateDir, "sessions"), { recursive: true });

if (process.env.FAKE_CLI_LOG) {
  appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify({ argv, cwd: process.cwd(), env: process.env })}\n`);
}

const resume = arg("--resume");
const sessionId = resume ?? arg("--session-id") ?? "sem-sessao";
if (resume && !existsSync(path.join(stateDir, "sessions", resume))) {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  process.exit(1);
}

const mcpFile = arg("--mcp-config");
const mcp = mcpFile && existsSync(mcpFile) ? JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers?.office : undefined;
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

const out = (event) => process.stdout.write(`${JSON.stringify({ ...event, session_id: sessionId })}\n`);
const assistant = (content, parent = null) => out({ type: "assistant", message: { role: "assistant", content }, parent_tool_use_id: parent });
/** Duas mensagens do modelo com uso: m1 (saída 3, depois 40 na mesma id) e m2 (saída 7). Total: 40 + 7 de saída. */
const partialMessages = () => {
  const usage = (output, cacheRead) => ({ input_tokens: 5, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 20 });
  const message = (id, output, cacheRead, text) => out({ type: "assistant", message: { id, role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text }], usage: usage(output, cacheRead) }, parent_tool_use_id: null });
  message("msg_p1", 3, 100, "começando");
  message("msg_p1", 40, 100, "começando e já escrevendo");
  message("msg_p2", 7, 400, "mais um passo");
};
const toolResult = (id, text, isError = false, parent = null) =>
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] }, parent_tool_use_id: parent });
let toolSeq = 0;
async function mcpTool(name, args) {
  const id = `toolu_fake${++toolSeq}`;
  assistant([{ type: "tool_use", id, name: `mcp__office__${name}`, input: args }]);
  const result = await callTool(name, args);
  toolResult(id, result.text, result.isError);
  return result;
}

let initialized = false;
let interrupted;
let queue = Promise.resolve();

async function turn(received) {
  if (process.env.FAKE_CLI_MESSAGES) appendFileSync(process.env.FAKE_CLI_MESSAGES, `${JSON.stringify({ sessionId, text: received })}\n`);
  let text = received;
  if ((text.startsWith("(Conversa nova") || text.startsWith("(Contexto do Cérebro") || text.startsWith("[Platform context")) && text.includes("\n\n---\n\n")) text = text.slice(text.indexOf("\n\n---\n\n") + 7);
  if (text.startsWith("## O que você fez recentemente") && text.includes("\nTarefa ")) text = text.slice(text.indexOf("\nTarefa ") + 1);
  if (!initialized) {
    initialized = true;
    out({
      type: "system",
      subtype: "init",
      model: "fake-model",
      tools: ["Read", "Write", "Edit", "Glob", "Grep", "mcp__office__submit_result"],
      mcp_servers: [{ name: "office", status: mcp ? "connected" : "failed" }],
      apiKeySource: "none",
    });
    out({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1794105600,
        rateLimitType: "five_hour",
        overageStatus: "rejected",
        unifiedWindows: {
          five_hour: { utilization: 0.27, resetsAt: 1794105600, status: "allowed" },
          seven_day: { utilization: 0.44, resetsAt: 1794600000, status: "allowed" },
        },
      },
    });
  }
  process.stdout.write("linha que não é JSON\n");
  const first = text.split("\n")[0];
  let result = `eco: ${first}`;
  let isError = false;

  if (text.includes("[crash]")) {
    const crashLine = text.split("\n").find((candidate) => candidate.includes("[crash]")) ?? first;
    const marker = path.join(stateDir, `crash-${Buffer.from(crashLine).toString("hex").slice(0, 60)}`);
    if (!existsSync(marker)) {
      writeFileSync(marker, "1");
      if (text.includes("[parcial]")) partialMessages();
      assistant([{ type: "text", text: "vou cair" }]);
      process.exit(1);
    }
  }
  if (text.includes("[cota]")) {
    const marker = path.join(stateDir, `cota-${Buffer.from(first).toString("hex").slice(0, 60)}`);
    if (!existsSync(marker)) {
      writeFileSync(marker, "1");
      const resetsAt = Number(process.env.FAKE_CLI_RESETS_AT ?? 1794105600);
      out({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", unifiedWindows: { five_hour: { utilization: 1, resetsAt, status: "rejected" } } },
      });
      writeFileSync(path.join(stateDir, "sessions", sessionId), "1");
      out({ type: "result", subtype: "error_during_execution", is_error: true, result: "You've hit your limit", num_turns: 1 });
      return;
    }
  }
  if (text.includes("[subagente]")) {
    assistant([{ type: "tool_use", id: "toolu_sub1", name: "Agent", input: { description: "Pesquisa rápida", prompt: "Pesquise X", subagent_type: "general-purpose" } }]);
    out({ type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_sub1", description: "Pesquisa rápida" });
    assistant([{ type: "text", text: "Pesquisando dentro do subagente" }], "toolu_sub1");
    assistant([{ type: "tool_use", id: "toolu_read1", name: "Read", input: { file_path: "notas.md" } }], "toolu_sub1");
    toolResult("toolu_read1", "conteúdo das notas", false, "toolu_sub1");
    toolResult("toolu_sub1", [{ type: "text", text: "Achei X" }]);
  }
  if (text.includes("[subagente-opus]")) {
    assistant([{ type: "tool_use", id: "toolu_sub2", name: "Agent", input: { description: "Revisão difícil", prompt: "Revise Y", model: "opus" } }]);
    assistant([{ type: "text", text: "Revisando" }], "toolu_sub2");
    toolResult("toolu_sub2", [{ type: "text", text: "Revisado" }]);
  }
  if (text.includes("[lento]")) {
    if (text.includes("[parcial]")) partialMessages();
    assistant([{ type: "text", text: "trabalhando devagar…" }]);
    await new Promise((resolve) => (interrupted = resolve));
    result = "Interrompido";
    isError = true;
  }
  if (text.includes("[workspaces]")) result = (await mcpTool("list_workspaces", {})).text;
  if (text.includes("[uso]")) result = (await mcpTool("get_usage", {})).text;
  const pedir = /\[pedir:([a-z0-9-]+)\]/.exec(text);
  if (pedir) {
    result = (await mcpTool("send_request", { workspace: pedir[1], title: "Post sobre café", brief: "Escrever um post curto sobre café para o LinkedIn, tom leve, com revisão antes de publicar. Entregar só o texto final.", kind: "task", suggested_agents: ["Clara"], done_when: ["até 600 caracteres"] })).text;
  }
  const estado = /\[estado:([0-9a-f-]+)\]/.exec(text);
  if (estado) result = (await mcpTool("get_request_status", { request_id: estado[1] })).text;
  const cancelar = /\[cancelar:([0-9a-f-]+)\]/.exec(text);
  if (cancelar) result = (await mcpTool("cancel_request", { request_id: cancelar[1], reason: "O dono desistiu" })).text;
  const responder = /\[responder:(A-\d+)\]/.exec(text);
  if (responder) result = (await mcpTool("answer_maestro", { ask_id: responder[1], message: "Use a imagem M-0001 do workspace Design." })).text;
  if (text.includes("[ask-cyno]")) result = (await mcpTool("ask_cyno", { question: first.replace("[ask-cyno]", "").trim() })).text;
  const delegate = /\[delegar:([a-z0-9-]+)\]/.exec(text);
  let pedidoId;
  if (text.includes("[abrir]")) {
    const titulo = first.replace(/\[[^\]]*\]/g, "").trim() || "Pedido do fake";
    const opened = await mcpTool("open_request", { title: titulo, description: `Briefing: ${titulo}`, user_quote: first });
    pedidoId = /Request ([0-9a-f-]{36})/.exec(opened.text)?.[1];
    result = opened.text;
    if (pedidoId && text.includes("[concluir]")) {
      await mcpTool("complete_request", { text: `Feito direto pelo Maestro: ${titulo}`, request_id: pedidoId });
      result = "Abri e concluí.";
    }
  }
  const planAgents = /\[planejar:([a-z0-9-]+),([a-z0-9-]+)\]/.exec(text);
  if (planAgents && pedidoId) {
    const [, a, b] = planAgents;
    const extra = /\[etapa:([a-z]+)\]/.exec(text)?.[1];
    const planned = await mcpTool("create_plan", {
      request_id: pedidoId,
      summary: "Plano do fake",
      tasks: [
        { ref: "T1", title: "Pesquisa", briefing: "Pesquisar o tema", owner: a, steps: [{ agent: a, does: `[entregar] ${extra ? `[${extra}] ` : ""}pesquisar` }] },
        { ref: "T2", title: "Texto", briefing: "Escrever o texto", owner: b, steps: [{ agent: a, does: "[entregar] separar pontos" }, { agent: b, does: "[entregar] escrever" }], depends_on: ["T1"] },
      ],
    });
    result = planned.isError ? `Erro: ${planned.text}` : "Mandei o plano para você aprovar.";
  }
  if (text.includes("[perguntas]")) {
    const asked = await mcpTool("ask_user", {
      ...(pedidoId ? { request_id: pedidoId } : {}),
      title: "Detalhes",
      questions: [{ question: "Qual o público?", options: ["devs", "gestores"], default: "devs" }, { question: "Qual o tom?" }],
    });
    result = asked.isError ? `Erro: ${asked.text}` : "Mandei as perguntas.";
  }
  if (text.includes("[perguntar]")) result = "Antes de seguir: qual tom você prefere?";
  if (text.includes("[ajuda]") && text.startsWith("Tarefa ")) await mcpTool("request_help", { what: "Falta alguém de design", suggested_agent: "lia" });
  if (text.includes("[nota]") && text.startsWith("Tarefa ")) {
    await mcpTool("search_notes", { query: "briefing" });
    await mcpTool("save_note", { title: "Aprendizado do fake", content: "O fake aprendeu algo durável.", kind: "learning" });
  }
  if (text.includes("[antigo]")) {
    const old = await mcpTool("entregar", { resultado: "pelo nome antigo" });
    result = old.text;
  }
  const toMaestro =
    text.startsWith("Resultado da tarefa") ||
    text.startsWith("A tarefa ") ||
    (text.startsWith("Decisão do usuário") && text.includes("complete_request")) ||
    text.includes("o projeto terminou") || text.includes("o plano terminou") ||
    /^Pedido [0-9a-f-]{36}: Respostas do usuário/.test(text);
  if (toMaestro) {
    if (!text.includes("[sem-concluir]")) await mcpTool("complete_request", { text: `Resposta final do Maestro. ${first}` });
    result = "ok";
  } else if (delegate) {
    const motivo = /\[motivo:([^\]]+)\]/.exec(first);
    const rest = first.replace(/^Pedido [^:]+: /, "").replace(delegate[0], "").replace(motivo?.[0] ?? "", "").replace("[abrir]", "").trim();
    const delegated = await mcpTool("delegate_task", { agent_id: delegate[1], task: `[entregar] ${rest}`, ...(motivo ? { reason: motivo[1] } : {}), ...(pedidoId ? { request_id: pedidoId } : {}) });
    result = delegated.isError ? `Erro: ${delegated.text}` : "Delegado; esperando.";
  } else if (text.includes("[aprovar]") && !text.startsWith("Decisão")) {
    await mcpTool("request_approval", { question: "Posso publicar?", approval_type: "post", text: "Rascunho do fake" });
    result = "Esperando a decisão.";
  } else if (text.includes("[info]") && text.startsWith("Tarefa ")) {
    await mcpTool("ask_user", { title: "Dúvidas da pesquisa", questions: [{ question: "Qual a fonte preferida?" }] });
    result = "Esperando as respostas.";
  } else if (text.includes("[entregar]") || text.startsWith("Decisão do usuário") || text.startsWith("Respostas do usuário (")) {
    await mcpTool("report_progress", { percent: 50, message: "Metade feita" });
    await mcpTool("submit_result", { result: `Feito pelo fake: ${first}` });
    result = "Entreguei.";
  }
  if (!text.includes("[lento]")) assistant([{ type: "text", text: "Olá do fake" }]);
  writeFileSync(path.join(stateDir, "sessions", sessionId), "1");
  const usage = { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 3000, cache_creation_input_tokens: 40 };
  out({ type: "result", subtype: isError ? "error_during_execution" : "success", is_error: isError, result, num_turns: 1, usage });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === "control_request" && message.request?.subtype === "interrupt") {
    out({ type: "control_response", response: { subtype: "success", request_id: message.request_id } });
    interrupted?.();
    return;
  }
  if (message.type !== "user") return;
  const content = message.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((block) => block.text ?? "").join("\n") : "";
  queue = queue.then(() => turn(text));
});
process.stdin.on("end", () => void queue.then(() => process.exit(0)));
