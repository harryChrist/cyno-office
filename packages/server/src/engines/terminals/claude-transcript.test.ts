import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { ClaudeTranscriptParser, claudeTranscriptDir, unwrapPasted, type TranscriptEvent } from "./claude-transcript";
import { TranscriptTail } from "./transcript-tail";

const tempDir = useTempDirs();
const line = (entry: Record<string, unknown>) => JSON.stringify({ isSidechain: false, sessionId: "s1", ...entry });
const usage = { input_tokens: 2, cache_creation_input_tokens: 5890, cache_read_input_tokens: 0, output_tokens: 291 };

/** Linhas no formato da conversa do Claude Code 2.1.x interativo (conferido com uma conversa real). */
const TRANSCRIPT = [
  { type: "mode", mode: "normal" },
  { type: "system", subtype: "bridge_status", content: "/remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_01ABC", url: "https://claude.ai/code/session_01ABC" },
  { type: "user", message: { role: "user", content: "<command-name>/help</command-name>\n<command-message>help</command-message>" } },
  { type: "user", message: { role: "user", content: "<local-command-caveat>The command below was run directly…</local-command-caveat>" }, isMeta: true },
  { type: "system", subtype: "local_command", content: "<command-name>/status</command-name>" },
  { type: "user", message: { role: "user", content: "Pedido 1: diga oi" }, promptSource: "typed" },
  { type: "attachment", attachment: { type: "session_context" } },
  { type: "assistant", message: { id: "msg_1", role: "assistant", content: [{ type: "thinking", thinking: "" }], stop_reason: "tool_use", usage } },
  { type: "assistant", message: { id: "msg_1", role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "mcp__office__get_team", input: {} }], stop_reason: "tool_use", usage } },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "## Quarto X" }] }] } },
  { type: "assistant", message: { id: "msg_2", role: "assistant", content: [{ type: "text", text: "Oi!" }], stop_reason: "end_turn", usage: { ...usage, cache_read_input_tokens: 6000, cache_creation_input_tokens: 10 } } },
  { type: "assistant", isSidechain: true, message: { id: "msg_x", role: "assistant", content: [{ type: "text", text: "de um subagente" }] } },
  { type: "system", subtype: "turn_duration", durationMs: 2087 },
  { type: "user", message: { role: "user", content: "<bash-input>echo oi</bash-input>" } },
  { type: "user", message: { role: "user", content: "outra coisa" } },
  { type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } },
  "{quebrado",
];

describe("ClaudeTranscriptParser", () => {
  it("traduz a conversa do TUI: prompts reais, ferramentas, fim de turno com tokens, Remote Control; ignora comandos, meta e subagentes", () => {
    const parser = new ClaudeTranscriptParser();
    const events: TranscriptEvent[] = TRANSCRIPT.flatMap((entry) => parser.parse(typeof entry === "string" ? entry : line(entry)));
    expect(events).toEqual([
      { type: "remote", remote: { active: true, url: "https://claude.ai/code/session_01ABC" } },
      { type: "prompt", text: "Pedido 1: diga oi" },
      { type: "tool_use", id: "toolu_1", name: "mcp__office__get_team", input: {} },
      { type: "tool_result", id: "toolu_1", ok: true, output: "## Quarto X" },
      { type: "text", text: "Oi!" },
      {
        type: "turn_end",
        ok: true,
        result: "Oi!",
        // msg_1 conta uma vez só (duas linhas com o mesmo id).
        usage: { inputTokens: 4, outputTokens: 582, cacheReadTokens: 6000, cacheCreationTokens: 5900 },
        contextTokens: 6012,
      },
      { type: "prompt", text: "outra coisa" },
      { type: "turn_end", ok: false, result: "Interrompido no terminal" },
    ]);
  });

  it("colagem longa: tira as marcas <pasted_content id=…> do prompt (para casar com a mensagem colada)", () => {
    const pasted = '\n\n<pasted_content id="352f">\nResultado da tarefa t1 de Beto:\n\nTexto\n\nPedido p1: siga.\n</pasted_content id="352f">\n';
    expect(unwrapPasted(pasted)).toBe("Resultado da tarefa t1 de Beto:\n\nTexto\n\nPedido p1: siga.");
    expect(unwrapPasted("oi <b>normal</b>")).toBe("oi <b>normal</b>");
    const parser = new ClaudeTranscriptParser();
    expect(parser.parse(JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: pasted } }))).toEqual([{ type: "prompt", text: "Resultado da tarefa t1 de Beto:\n\nTexto\n\nPedido p1: siga." }]);
  });

  it("pasta das conversas: o cwd com tudo que não é letra/número trocado por '-'", () => {
    expect(claudeTranscriptDir("/home/u/.claude/projects", "/home/u/maestri/data/workspaces/w_1/agents/maestro")).toBe(
      "/home/u/.claude/projects/-home-u-maestri-data-workspaces-w-1-agents-maestro",
    );
  });
});

describe("TranscriptTail", () => {
  it("entrega só as linhas completas novas; sessão retomada começa do fim; segue a conversa nova (/clear) e ignora o que as antigas já tinham", async () => {
    const dir = await tempDir();
    await mkdir(dir, { recursive: true });
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    const old = "33333333-3333-4333-8333-333333333333";
    await writeFile(path.join(dir, `${a}.jsonl`), "antiga-1\n");
    await writeFile(path.join(dir, `${old}.jsonl`), "velha-1\n");
    const seen: string[] = [];
    const switched: string[] = [];
    const tail = new TranscriptTail({ dir, sessionId: a, fromEnd: true, pollMs: 1000, onLine: (text, sessionId) => seen.push(`${sessionId.slice(0, 1)}:${text}`), onSession: (id) => switched.push(id) });
    await tail.prime();
    await tail.poll();
    expect(seen).toEqual([]);
    await appendFile(path.join(dir, `${a}.jsonl`), "nova-1\nmeia");
    await tail.poll();
    expect(seen).toEqual(["1:nova-1"]);
    await appendFile(path.join(dir, `${a}.jsonl`), "-linha\n");
    await tail.poll();
    expect(seen).toEqual(["1:nova-1", "1:meia-linha"]);
    // /clear: outra conversa nasce e cresce depois da atual.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(path.join(dir, `${b}.jsonl`), "b-1\n");
    for (let i = 0; i < 4; i++) await tail.poll();
    expect(switched).toEqual([b]);
    expect(tail.current()).toBe(b);
    expect(seen.at(-1)).toBe("2:b-1");
    // /resume numa antiga: só o que ela ganhou depois.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await appendFile(path.join(dir, `${old}.jsonl`), "velha-2\n");
    for (let i = 0; i < 4; i++) await tail.poll();
    expect(switched).toEqual([b, old]);
    expect(seen.filter((text) => text.startsWith("3:"))).toEqual(["3:velha-2"]);
    tail.stop();
  });
});
