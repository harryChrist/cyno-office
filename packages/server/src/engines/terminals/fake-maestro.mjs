/**
 * O "cérebro" de Maestro/Cyno das CLIs falsas de um processo por turno (OpenClaw e Hermes falsos): o mesmo roteiro de
 * diretivas do fake-cli.mjs (o Claude falso), em funções para as duas reaproveitarem.
 *
 * - [abrir]      chama `open_request` (título = o resto da linha) antes do resto;
 * - [concluir]   junto com [abrir]: fecha o pedido aberto com `complete_request` no mesmo turno;
 * - [delegar:ID] chama `delegate_task` para o agente ID com a tarefa "[entregar] <resto>" (com o request_id do [abrir]);
 * - "Resultado da tarefa" / "A tarefa … falhou": chama `complete_request` (o aviso da entrega);
 * - [workspaces] chama `list_workspaces` (o Cyno) e devolve o texto;
 * - [memoria]    responde com o começo do que veio antes da mensagem (o resumo corrido que o OpenClaw leva).
 *
 * `mcpTool(nome, argumentos)` devolve `{ text, isError }`. `maestroTurn` devolve o texto final do turno ou `undefined`
 * quando a mensagem não é de Maestro/Cyno (aí a CLI falsa segue com o roteiro de agente de time).
 */
export function isConversationText(text) {
  return /\[(abrir|delegar:[a-z0-9-]+|workspaces|memoria|conversar)\]/.test(text) || text.startsWith("Resultado da tarefa") || text.startsWith("A tarefa ") || /^\[(abrir|delegar|workspaces|memoria|conversar)/.test(text);
}

export async function maestroTurn({ last, whole, mcpTool }) {
  const text = last;
  const first = text.split("\n").find((line) => line.trim()) ?? "";
  if (text.includes("[memoria]")) {
    // O que veio ANTES da mensagem (o resumo corrido), só o começo, para o teste conferir que a conversa foi junto.
    const before = whole.slice(0, Math.max(0, whole.length - last.length));
    return `memoria: ${before.replace(/\s+/g, " ").slice(-600)}`;
  }
  if (text.includes("[workspaces]")) return (await mcpTool("list_workspaces", {})).text;
  const delegate = /\[delegar:([a-z0-9-]+)\]/.exec(text);
  let pedidoId;
  let result;
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
  const toMaestro = text.startsWith("Resultado da tarefa") || text.startsWith("A tarefa ");
  if (toMaestro) {
    if (!text.includes("[sem-concluir]")) await mcpTool("complete_request", { text: `Resposta final do Maestro. ${first}` });
    return "ok";
  }
  if (delegate) {
    const rest = first.replace(/^Pedido [^:]+: /, "").replace(delegate[0], "").replace("[abrir]", "").trim();
    const delegated = await mcpTool("delegate_task", { agent_id: delegate[1], task: `[entregar] [submit] ${rest}`, ...(pedidoId ? { request_id: pedidoId } : {}) });
    return delegated.isError ? `Erro: ${delegated.text}` : "Delegado; esperando.";
  }
  if (text.includes("[conversar]")) return `Conversei: ${first.replace("[conversar]", "").trim()}`;
  return result;
}
