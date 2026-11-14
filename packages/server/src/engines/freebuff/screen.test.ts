import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { interpretLogEntry, freebuffToolName } from "./chat-log";
import { ScreenBuffer } from "./screen";
import { isEffortMenu, isModelPicker, isReadyScreen, isSettledScreen, isWorkingScreen, modelsFromCards, parseEffortMenu, parseFooterModel, parseHours, parseModelPicker, parseTimeLeft } from "./screen-reader";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

describe("ScreenBuffer", () => {
  it("segue o cursor, apaga e sobrescreve como a TUI faz", () => {
    const screen = new ScreenBuffer(20, 5);
    screen.write("linha um\r\nlinha dois");
    screen.write("\x1b[2;1H\x1b[2Kcurta");
    screen.write("\x1b[1;1H\x1b[5Cmeio");
    expect(screen.lines().slice(0, 2)).toEqual(["linhameio", "curta"]);
  });

  it("limpa a tela, rola e entende acentos e blocos largos", () => {
    const screen = new ScreenBuffer(12, 3);
    screen.write("a\r\nb\r\nc\r\nd");
    expect(screen.lines()).toEqual(["b", "c", "d"]);
    screen.write("\x1b[2J\x1b[Holá ▍");
    expect(screen.lines()[0]).toBe("olá ▍");
  });

  it("responde ao que a TUI pergunta ao terminal (posição do cursor, tipo de terminal)", () => {
    const screen = new ScreenBuffer(20, 5);
    screen.write("abc");
    expect(screen.write("\x1b[6n\x1b[c")).toEqual(["\x1b[1;4R", "\x1b[?62;c"]);
  });

  it("sequências cortadas no meio do pedaço esperam o resto", () => {
    const screen = new ScreenBuffer(20, 3);
    screen.write("\x1b[2");
    screen.write("J\x1b[1;1Hok");
    expect(screen.lines()[0]).toBe("ok");
  });
});

describe("leitura da tela do Freebuff (telas reais de 12/11)", () => {
  it("tela de abertura: caixa livre, banner de horas e rodapé com o modelo", () => {
    const text = fixture("aberto.txt");
    expect(isReadyScreen(text)).toBe(true);
    expect(isSettledScreen(text)).toBe(true);
    expect(isWorkingScreen(text)).toBe(false);
    expect(parseHours(text)).toEqual({ remaining: 21, total: 21 });
    expect(parseFooterModel(text)).toEqual({ model: "DeepSeek V4.1 Flash", effort: "high" });
  });

  it("o seletor do /model: nome, esforço padrão, multiplicador e seção de cada modelo; o banner de cima não vira modelo", () => {
    const text = fixture("model-picker.txt");
    expect(isModelPicker(text)).toBe(true);
    const cards = parseModelPicker(text);
    expect(cards.map((card) => card.name)).toEqual([
      "DeepSeek V4.1 Flash Slow",
      "Beam 1.0",
      "Nemotron 3.5 Lightning",
      "Glyph Cluster",
      "Solar Pro 4",
      "Solar Mini 4",
      "DeepSeek V4.1 Flash",
      "Muse Spark 1.3",
      "DeepSeek V4.1 Flash Fast",
      "GPT-6 Luna",
      "Claude Haiku 5.5 · 100k context",
      "Muse Ember",
    ]);
    expect(cards.find((card) => card.selected)?.name).toBe("DeepSeek V4.1 Flash");
    const models = modelsFromCards(cards);
    expect(models.find((model) => model.name === "DeepSeek V4.1 Flash")).toMatchObject({ multiplier: 2, defaultEffort: "high", section: "PREMIUM" });
    expect(models.find((model) => model.name === "DeepSeek V4.1 Flash Slow")).toMatchObject({ multiplier: 1, defaultEffort: "low", section: "STANDARD" });
    expect(models.find((model) => model.name === "Solar Pro 4")).toMatchObject({ multiplier: 1, efforts: [] });
    expect(models.find((model) => model.name === "Claude Haiku 5.5 · 100k context")).toMatchObject({ multiplier: 6, defaultEffort: "medium" });
    // O rodapé do seletor: restante/total do dia, quando vira e a carteira.
    expect(parseHours(text)).toEqual({ remaining: 17, total: 21, wallet: 25, resetsInMs: (11 * 60 + 57) * 60_000 });
  });

  it("o submenu de esforço: os níveis na ordem, o marcado e o padrão", () => {
    const text = [" ↑↓ choose model · Tab reasoning · Enter select · Esc cancel", "  Muse Spark 1.3 • Reasoning", "  ↑↓ choose · Enter save · Esc back", "    low", "    medium", "  › high (default)", " DeepSeek V4.1 Flash • high · /pasta · /model to change"].join("\n");
    expect(isEffortMenu(text)).toBe(true);
    expect(parseEffortMenu(text)).toEqual({ levels: ["low", "medium", "high"], selected: "high", defaultLevel: "high" });
  });

  it("a barra da sessão: minutos que faltam", () => {
    expect(parseTimeLeft(" 42m left · 64 (1%)     ✕ End session")).toBe(42);
    expect(parseTimeLeft(" 1h 1m left")).toBe(61);
    expect(parseTimeLeft(" 1h left")).toBe(60);
    expect(parseTimeLeft(" 0:26 left")).toBeCloseTo(0.43, 1);
    expect(parseTimeLeft("Your first message starts the session.")).toBeUndefined();
  });

  it("antes de o catálogo carregar (só a caixa), a tela ainda não está pronta para escolher modelo", () => {
    const text = [" MiMo v2.6 Flash Fast · /pasta · /model to change", "│  ▍Enter a coding task or / for commands"].join("\n");
    expect(isReadyScreen(text)).toBe(true);
    expect(isSettledScreen(text)).toBe(false);
  });
});

describe("registro do chat (log.jsonl)", () => {
  it("o passo com ferramenta vira tool_use + tool_result; o último passo fecha o turno com a resposta", () => {
    const step = {
      level: "DEBUG",
      data: {
        iteration: 1,
        agentId: "main-agent",
        shouldEndTurn: false,
        fullResponse: "",
        toolCalls: [{ toolName: "write_file", input: { path: "ola.txt" }, toolCallId: "t1" }, { toolName: "suggest_followups", input: {}, toolCallId: "t2" }],
        toolResults: [{ role: "tool", toolName: "write_file", toolCallId: "t1", content: [{ type: "json", value: { file: "ola.txt", message: "Created file successfully." } }] }],
      },
    };
    expect(interpretLogEntry(step)).toEqual([
      { kind: "tool_use", id: "t1", name: "write_file", input: { path: "ola.txt" } },
      { kind: "tool_result", id: "t1", ok: true, output: '{"file":"ola.txt","message":"Created file successfully."}' },
    ]);
    const last = { data: { agentId: "main-agent", shouldEndTurn: true, fullResponse: "Pronto.", toolCalls: [], toolResults: [] } };
    expect(interpretLogEntry(last)).toEqual([{ kind: "turn_end", result: "Pronto." }]);
  });

  it("MCP: office__submit_result vira mcp__office__submit_result (o nome do log dos outros motores); erro do servidor vira ok=false", () => {
    expect(freebuffToolName("office__submit_result")).toBe("mcp__office__submit_result");
    expect(freebuffToolName("write_file")).toBe("write_file");
    const entry = {
      data: {
        agentId: "main-agent",
        shouldEndTurn: false,
        fullResponse: "pensando",
        toolCalls: [{ toolName: "office__submit_result", input: { result: "x" }, toolCallId: "m1" }],
        toolResults: [{ toolCallId: "m1", content: [{ type: "json", value: { error: "sem tarefa" } }] }],
      },
    };
    expect(interpretLogEntry(entry)).toEqual([
      { kind: "text", text: "pensando" },
      { kind: "tool_use", id: "m1", name: "mcp__office__submit_result", input: { result: "x" } },
      { kind: "tool_result", id: "m1", ok: false, output: '{"error":"sem tarefa"}' },
    ]);
  });

  it("a leitura da mensagem e o que não interessa: sinal de envio, subagentes e linhas soltas", () => {
    expect(interpretLogEntry({ level: "INFO", msg: "[send-message] Sending message with sdk run config" })).toEqual([{ kind: "sent" }]);
    expect(interpretLogEntry({ level: "DEBUG", msg: "Failed to get git branch" })).toEqual([]);
    expect(interpretLogEntry({ data: { agentId: "sub-agent-1", shouldEndTurn: true, fullResponse: "x" } })).toEqual([]);
    expect(interpretLogEntry("lixo")).toEqual([]);
  });
});
