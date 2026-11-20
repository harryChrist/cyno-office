#!/usr/bin/env node
/**
 * TUI FALSA DO FREEBUFF para os testes (nunca chama o `freebuff` de verdade nem gasta hora). Imita o que o
 * experimento de 12/11 mediu, num pseudoterminal:
 * - desenha o banner de horas, a caixa "Enter a coding task" e o rodapé "<modelo> • <esforço> · <pasta> · /model to change";
 * - lê as teclas em modo raw: texto colado (bracketed paste) e digitado vai para a caixa; um Enter que chega NO MESMO
 *   pedaço do texto não envia (como o real); `/model` abre o seletor (setas, Tab = esforço, Enter, Esc);
 * - a hora começa na PRIMEIRA MENSAGEM do processo e custa o multiplicador do modelo; reabrir dentro da hora (sem
 *   processo vivo da mesma pasta) volta na mesma hora e não cobra de novo; no fim da hora a barra some, o arquivo da
 *   sessão é apagado e o processo continua vivo (não fecha sozinho);
 * - grava `projects/<última pasta do caminho>/chats/<id>/log.jsonl` (+ `chat-messages.json`) no formato do real:
 *   `[send-message]` ao ler a mensagem, um passo por ferramenta e o último com `shouldEndTurn: true`; e o
 *   `freebuff-live-<pid>.json` (`ownerPid`, `expiresAt`) enquanto há hora aberta;
 * - `--continue <id>` restaura o chat (sem id não restaura); chat que não existe sai com erro.
 *
 * Diretivas no pedido: [ferramenta] um passo com write_file; [submit] chama `submit_result` pelo MCP "office" do
 * `.agents/mcp.json` (cabeçalho Authorization ou ?t= da URL); [lento] demora 500 ms; [muito-lento] 2,5 s;
 * [queda] sai com código 3 no meio do turno (só na primeira vez); [trava] para de escrever o registro e nunca
 * termina (só na primeira vez); [sem-leitura] ignora a mensagem (não loga `[send-message]`) na primeira vez.
 *
 * Ambiente: FAKE_FB_HOME (o `~/.config/manicode` de mentira; obrigatório), FAKE_FB_LOG (uma linha JSON por subida),
 * FAKE_FB_STATE (marcas das diretivas de uma vez só), FAKE_FB_HOUR_MS (duração da hora; padrão 1 h), FAKE_FB_TOTAL
 * (horas do dia; padrão 21), FAKE_FB_WALLET (horas na carteira; padrão 25), FAKE_FB_NO_READY=1 (nunca mostra a caixa), FAKE_FB_REWRITE=1 (regrava o fim da hora 300 ms depois da primeira mensagem), FAKE_FB_DEFAULT_MODEL.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isConversationText, maestroTurn } from "../terminals/fake-maestro.mjs";

const argv = process.argv.slice(2);
const arg = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
const home = process.env.FAKE_FB_HOME;
if (!home) {
  process.stdout.write("FAKE_FB_HOME ausente\r\n");
  process.exit(2);
}
mkdirSync(home, { recursive: true });
if (process.env.FAKE_FB_LOG) appendFileSync(process.env.FAKE_FB_LOG, `${JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid })}\n`);
const stateDir = process.env.FAKE_FB_STATE ?? path.join(home, ".fake-state");
mkdirSync(stateDir, { recursive: true });
const once = (name) => {
  const mark = path.join(stateDir, name);
  if (existsSync(mark)) return false;
  writeFileSync(mark, "1");
  return true;
};

const HOUR_MS = Number(process.env.FAKE_FB_HOUR_MS ?? 3_600_000);
const TOTAL = Number(process.env.FAKE_FB_TOTAL ?? 21);
const cwd = process.cwd();
const folder = path.basename(cwd);
const chatsDir = path.join(home, "projects", folder, "chats");
mkdirSync(chatsDir, { recursive: true });

// ---- modelos ----
const MODELS = [
  { name: "DeepSeek V4.1 Flash Slow", efforts: ["low"], effort: "low", mult: 1, section: "STANDARD", notes: "Slow · cheapest · Promotional" },
  { name: "Beam 1.0", efforts: ["high"], effort: "high", mult: 1, section: "STANDARD", notes: "Reflection · coding" },
  { name: "Solar Mini 4", efforts: [], effort: "", mult: 1, section: "STANDARD", notes: "Fast and light · Promotional" },
  { name: "DeepSeek V4.1 Flash", efforts: ["low", "high"], effort: "high", mult: 2, section: "PREMIUM", notes: "Steady speed · Images" },
  { name: "Muse Spark 1.3", efforts: ["low", "medium", "high"], effort: "high", mult: 3, section: "PREMIUM", notes: "Falls back when busy" },
  { name: "Claude Haiku 5.5 · 100k context", efforts: [], effort: "medium", mult: 6, section: "POWERFUL", notes: "Anthropic · fast" },
];
const settingsFile = path.join(home, "fake-settings.json");
const loadSettings = () => {
  try {
    return JSON.parse(readFileSync(settingsFile, "utf8"));
  } catch {
    return { model: process.env.FAKE_FB_DEFAULT_MODEL ?? "DeepSeek V4.1 Flash", effort: "high" };
  }
};
let chosen = loadSettings();
const saveSettings = () => {
  writeFileSync(settingsFile, JSON.stringify(chosen));
  // o `freebuffModelKey` do real: uma chave opaca
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ freebuffModelKey: `m-${Buffer.from(chosen.model).toString("hex").slice(0, 10)}` }));
};
const modelInfo = (name) => MODELS.find((model) => model.name === name) ?? MODELS[3];

// ---- horas (a conta, em disco: vale entre processos) ----
const hoursFile = path.join(home, "fake-hours.json");
const loadHours = () => {
  try {
    return JSON.parse(readFileSync(hoursFile, "utf8"));
  } catch {
    return { remaining: TOTAL, wallet: Number(process.env.FAKE_FB_WALLET ?? 25), sessions: {} };
  }
};
const saveHours = (hours) => writeFileSync(hoursFile, JSON.stringify(hours));
const liveFile = path.join(home, `freebuff-live-${process.pid}.json`);
let sessionEnds = 0; // ms; 0 = sem hora aberta neste processo
let hourTimer;

function openOrJoinHour() {
  const hours = loadHours();
  const known = hours.sessions[folder];
  if (known && known > Date.now()) sessionEnds = known; // reabriu dentro da hora: a mesma, sem cobrar
  else {
    sessionEnds = Date.now() + HOUR_MS;
    hours.sessions[folder] = sessionEnds;
    hours.remaining = Math.max(0, hours.remaining - modelInfo(chosen.model).mult);
    saveHours(hours);
  }
  writeFileSync(liveFile, JSON.stringify({ instanceId: `cli:${process.pid}`, model: "m-fake", tokenKey: "x", ownerPid: process.pid, expiresAt: sessionEnds }));
  if (process.env.FAKE_FB_REWRITE === "1") {
    // Como no real: o processo novo retoma a hora que outro deixou e, na primeira mensagem, abre outra e regrava o arquivo.
    setTimeout(() => {
      sessionEnds += 60_000;
      writeFileSync(liveFile, JSON.stringify({ instanceId: `cli:${process.pid}`, model: "m-fake", tokenKey: "x", ownerPid: process.pid, expiresAt: sessionEnds }));
    }, 300);
  }
  clearTimeout(hourTimer);
  hourTimer = setTimeout(() => {
    // fim da hora: a barra some, o arquivo é apagado e o processo continua vivo
    sessionEnds = 0;
    rmSync(liveFile, { force: true });
    render();
  }, Math.max(0, sessionEnds - Date.now()));
}

// ---- chat ----
const resume = arg("--continue");
let chatId;
if (resume) {
  if (!existsSync(path.join(chatsDir, resume))) {
    process.stdout.write(`Chat not found: ${resume}\r\n`);
    process.exit(1);
  }
  chatId = resume;
} else {
  chatId = `${new Date().toISOString().replace(/:/g, "-")}`;
  // nunca igual ao anterior
  while (existsSync(path.join(chatsDir, chatId))) chatId += "1";
  mkdirSync(path.join(chatsDir, chatId), { recursive: true });
}
const chatDir = path.join(chatsDir, chatId);
const messagesFile = path.join(chatDir, "chat-messages.json");
const logFile = path.join(chatDir, "log.jsonl");
let messages = existsSync(messagesFile) ? JSON.parse(readFileSync(messagesFile, "utf8")) : [];
const log = (level, msg, data) => appendFileSync(logFile, `${JSON.stringify({ level, timestamp: new Date().toISOString(), ...(data ? { data } : {}), msg })}\n`);
if (existsSync(path.join(home, "fake-hours.json"))) {
  const known = loadHours().sessions[folder];
  if (resume && known && known > Date.now()) {
    // reaberto com o chat dentro da hora: ainda não conta como sessão deste processo até a primeira mensagem
  }
}

// ---- tela ----
const out = (text) => process.stdout.write(text);
let mode = "chat"; // chat | picker | effort
let box = "";
let working = false;
let pickIndex = 0;
let effortIndex = 0;

function minutesLeft() {
  const ms = sessionEnds - Date.now();
  const total = Math.max(0, Math.ceil(ms / 60_000));
  return total >= 60 ? `${Math.floor(total / 60)}h ${total % 60}m left` : `${total}m left`;
}

function modelLines() {
  const lines = [" ↑↓ choose model · Tab reasoning · Enter select · Esc cancel"];
  let section = "";
  MODELS.forEach((model, index) => {
    if (model.section !== section) {
      section = model.section;
      lines.push(section === "STANDARD" ? " STANDARD · 1x usage (21 hours per day)" : section === "PREMIUM" ? " PREMIUM · 2–3x cost · lower usage (7–10 hours per day)" : " POWERFUL · Frontier models included with your plan");
    }
    const mark = index === pickIndex ? "›" : " ";
    const current = model.name === chosen.model ? chosen.effort : model.effort;
    const head = `${model.name}${current ? ` • ${current}` : ""} · ${model.notes}`;
    lines.push(" ┌" + "─".repeat(78) + "┐", ` │ ${mark} ${head}`.padEnd(80) + "│", ` │${`${model.mult}x`.padStart(40)}`.padEnd(80) + "│", " └" + "─".repeat(78) + "┘");
  });
  const hours = loadHours();
  lines.push(` STARTER · ${hours.remaining}/${TOTAL} hours daily · resets in 11h 57m · ${hours.wallet} hours in wallet`);
  return lines;
}

function render() {
  const lines = [];
  lines.push(" ███████████   Freebuff (falso)", "");
  const hours = loadHours();
  lines.push(" ┌" + "─".repeat(66) + "┐");
  lines.push(` │ ${sessionEnds ? "Session active" : "Your first message starts the session."}`.padEnd(68) + "│");
  lines.push(` │ ${hours.remaining}/${TOTAL} hours remaining`.padEnd(68) + "│");
  lines.push(" │ Starter plan".padEnd(68) + "│", " └" + "─".repeat(66) + "┘", "");
  if (mode === "picker") lines.push(...modelLines());
  else if (mode === "effort") {
    const model = MODELS[pickIndex];
    lines.push(` ${model.name} • Reasoning`, "  ↑↓ choose · Enter save · Esc back");
    model.efforts.forEach((level, index) => lines.push(`${index === effortIndex ? "  › " : "    "}${level}${level === model.effort ? " (default)" : ""}`));
  } else {
    lines.push("");
    if (sessionEnds) lines.push(` ${minutesLeft()} · 13.9K (1%)                                    ✕ End session`);
    if (working) lines.push(" thinking...                                                     1s  ■ Esc");
    lines.push("╭" + "─".repeat(120) + "╮");
    if (box) for (const line of box.split("\n")) lines.push(`│  ${line}`);
    else if (process.env.FAKE_FB_NO_READY !== "1") lines.push(`│  ▍${working ? "Add to the current task (/ for commands)" : "Enter a coding task or / for commands"}`);
    else lines.push("│  carregando...");
    lines.push("╰" + "─".repeat(120) + "╯");
  }
  const info = modelInfo(chosen.model);
  lines.push(` ${chosen.model}${chosen.effort ? ` • ${chosen.effort}` : ""} · ${cwd} · /model to change · Chat: ${messages.find((m) => m.variant === "user")?.content?.slice(0, 40) ?? "New chat"}`, " ← for history · ? for help");
  void info;
  out("\x1b[2J\x1b[H" + lines.join("\r\n"));
}

// ---- turno ----
async function callTool(name, args) {
  let mcp;
  try {
    mcp = JSON.parse(readFileSync(path.join(cwd, ".agents", "mcp.json"), "utf8")).mcpServers?.office;
  } catch {
    mcp = undefined;
  }
  if (!mcp) return { text: "sem MCP", isError: true };
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", ...(process.env.FAKE_FB_NO_HEADERS === "1" ? {} : mcp.headers) };
  const response = await fetch(mcp.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const body = await response.json().catch(() => ({ status: response.status }));
  return { text: body.result?.content?.[0]?.text ?? JSON.stringify(body), isError: body.result?.isError === true || response.status >= 400 };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let iteration = 0;
// Como o Freebuff de verdade: uma linha "Start agent" com o contexto lido e uma "End agent" com a resposta e os créditos do passo.
const step = (shouldEndTurn, fullResponse, toolCalls = [], toolResults = []) => {
  iteration += 1;
  log("DEBUG", `Start agent fake-agent step ${iteration}`, { iteration, contextTokenCount: 1000 + iteration * 100, systemTokens: 500, messageCount: iteration });
  log("DEBUG", `End agent fake-agent step ${iteration}`, { iteration, agentId: "main-agent", shouldEndTurn, duration: 5, fullResponse, toolCalls, toolResults, stepCreditsUsed: 0 });
};

async function turn(text) {
  working = true;
  render();
  messages.push({ id: `user-${Date.now()}`, variant: "user", content: text, timestamp: "now" });
  if (text.includes("[sem-leitura]") && once("sem-leitura")) {
    working = false;
    render();
    return; // a mensagem não é lida
  }
  openOrJoinHour();
  log("INFO", "[send-message] Sending message with sdk run config", { runConfig: { agent: "base3-free-catalog", promptLength: text.length } });
  if (text.includes("[queda]") && once("queda")) process.exit(3);
  if (text.includes("[trava]") && once("trava")) {
    render();
    return; // nunca termina e não escreve mais nada
  }
  if (text.includes("[lento]")) await sleep(500);
  if (text.includes("[muito-lento]")) await sleep(2500);
  if (text.includes("[ferramenta]")) {
    step(false, "", [{ toolName: "write_file", input: { path: "ola.txt", content: "olá\n" }, toolCallId: "t1" }], [{ role: "tool", toolName: "write_file", toolCallId: "t1", content: [{ type: "json", value: { file: "ola.txt", message: "Created file successfully." } }] }]);
    await sleep(30);
  }
  let final = `Feito: ${text.split("\n")[0].slice(0, 40)}`;
  if (text.includes("[submit]")) {
    const result = await callTool("submit_result", { result: `Entregue pelo falso: ${text.split("\n")[0].slice(0, 40)}` });
    step(false, "", [{ toolName: "office__submit_result", input: { result: "..." }, toolCallId: "t2" }], [{ role: "tool", toolName: "office__submit_result", toolCallId: "t2", content: [{ type: "json", value: result.isError ? { error: result.text } : result.text }] }]);
    final = result.isError ? `Falhou o submit: ${result.text}` : "Resultado entregue.";
    await sleep(30);
  }
  // Maestro ou Cyno em Freebuff: o mesmo roteiro do Claude falso (abrir, delegar, receber a entrega, responder ao dono).
  const lastPart = text.split("\n\n---\n\n").at(-1) ?? text;
  if (isConversationText(lastPart)) {
    const answer = await maestroTurn({ last: lastPart, whole: text, mcpTool: callTool });
    if (answer !== undefined) final = answer;
  }
  step(true, final);
  messages.push({ id: `ai-${Date.now()}`, variant: "ai", content: "", blocks: [{ type: "text", content: final, textType: "text" }], isComplete: true, completionTime: "1s", credits: 0 });
  writeFileSync(messagesFile, JSON.stringify(messages));
  working = false;
  render();
}

// ---- entrada ----
function submit() {
  const text = box.trim();
  box = "";
  if (!text) return render();
  if (text === "/model") {
    mode = "picker";
    pickIndex = Math.max(0, MODELS.findIndex((model) => model.name === chosen.model));
    return render();
  }
  void turn(text);
}

let pasting = false;
process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  if (process.env.FAKE_FB_NO_READY === "1") return;
  let chunk = data;
  while (chunk.length > 0) {
    if (pasting) {
      const end = chunk.indexOf("\x1b[201~");
      const piece = end === -1 ? chunk : chunk.slice(0, end);
      box += piece.replace(/\r\n?/g, "\n");
      if (end === -1) return render();
      pasting = false;
      chunk = chunk.slice(end + 6);
      continue;
    }
    if (chunk.startsWith("\x1b[200~")) {
      pasting = true;
      chunk = chunk.slice(6);
      continue;
    }
    if (mode === "chat") {
      // Um Enter que chega junto do texto NÃO envia (como o Freebuff de verdade).
      const hadText = [...data].some((c) => c !== "\r" && c !== "\n" && c !== "\x1b" && c !== "\x03") && data.length > 1 && !data.startsWith("\x1b");
      const ch = chunk[0];
      chunk = chunk.slice(1);
      if (ch === "\r") {
        if (!hadText) submit();
      } else if (ch === "\x1b") {
        if (working) log("INFO", "interrupted");
      } else if (ch >= " ") box += ch;
      continue;
    }
    const key = chunk.startsWith("\x1b[A") ? "up" : chunk.startsWith("\x1b[B") ? "down" : chunk[0] === "\t" ? "tab" : chunk[0] === "\r" ? "enter" : chunk[0] === "\x1b" ? "esc" : "";
    chunk = chunk.slice(key === "up" || key === "down" ? 3 : 1);
    if (mode === "picker") {
      if (key === "up") pickIndex = Math.max(0, pickIndex - 1);
      else if (key === "down") pickIndex = Math.min(MODELS.length - 1, pickIndex + 1);
      else if (key === "tab") {
        const model = MODELS[pickIndex];
        if (model.efforts.length > 0) {
          mode = "effort";
          const current = model.name === chosen.model ? chosen.effort : model.effort;
          effortIndex = Math.max(0, model.efforts.indexOf(current));
        }
      } else if (key === "enter") {
        const model = MODELS[pickIndex];
        chosen = { model: model.name, effort: model.name === chosen.model ? chosen.effort : model.effort };
        saveSettings();
        mode = "chat";
      } else if (key === "esc") mode = "chat";
    } else if (mode === "effort") {
      const model = MODELS[pickIndex];
      if (key === "up") effortIndex = Math.max(0, effortIndex - 1);
      else if (key === "down") effortIndex = Math.min(model.efforts.length - 1, effortIndex + 1);
      else if (key === "enter") {
        chosen = { model: model.name, effort: model.efforts[effortIndex] };
        saveSettings();
        mode = "picker";
      } else if (key === "esc") mode = "picker";
    }
    render();
  }
  render();
});

process.on("SIGHUP", () => {
  rmSync(liveFile, { force: true });
  process.exit(0);
});
process.on("SIGTERM", () => {
  rmSync(liveFile, { force: true });
  process.exit(0);
});
void readdirSync;
render();
