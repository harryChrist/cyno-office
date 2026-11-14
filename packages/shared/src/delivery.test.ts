import { describe, expect, it } from "vitest";
import type { AgentLogEntry } from "./agent-log";
import { deliveriesOf, deliveryOf, headlineAndSummary, headlineOf, summaryOf, type DeliveryTask } from "./delivery";
import type { MediaItem } from "./media";

// O texto de exemplo e as duas primeiras verificações vêm dos testes do Habblaud (MIT, Márcio Junior).
const REPLY = `**O relatório está pronto** e foi enviado. Veja [o PDF](/Users/ana/proj/relatorio.pdf) e ./telas/antes.png.

| a | b |
|---|---|

Em poucas palavras: o relatório de vendas agora mostra o último dia certo, e o PDF está na pasta do projeto para a BA conferir.`;

describe("manchete e resumo (do Habblaud)", () => {
  it("manchete = primeira frase sem markdown; resumo = último parágrafo corrido", () => {
    expect(headlineOf(REPLY)).toBe("O relatório está pronto e foi enviado.");
    expect(summaryOf(REPLY, headlineOf(REPLY))).toMatch(/^Em poucas palavras: o relatório de vendas agora mostra/);
    expect(summaryOf("Uma frase só, sem resumo nenhum aqui dentro.", "x")).toBeUndefined();
    expect(headlineOf("# Título\n\n" + "palavra ".repeat(60))).toMatch(/…$/);
  });

  it("o resumo exige 2 parágrafos de prosa, o último com 60 ou mais caracteres e diferente da manchete", () => {
    expect(summaryOf("Primeira frase aqui.\n\nCurto.", "Primeira frase aqui.")).toBeUndefined();
    const longo = "Este parágrafo final é longo o bastante para valer como resumo da entrega inteira.";
    expect(summaryOf(`Primeira frase aqui.\n\n${longo}`, "Primeira frase aqui.")).toBe(longo);
    expect(summaryOf(`${longo}\n\n${longo} E mais.`, headlineOf(longo))).toBeUndefined();
  });

  it("a manchete tira cerca de código, link, negrito e título; limita em 180", () => {
    expect(headlineOf("```js\nconsole.log(1)\n```\n\nFeito: [o link](http://x.com) com `código`.")).toBe("Feito: o link com código.");
    expect(headlineOf("## Resultado\n\nTudo certo.")).toBe("Tudo certo.");
    expect(headlineOf("a".repeat(400)).length).toBeLessThanOrEqual(180);
    expect(headlineOf("")).toBe("");
  });

  it("régua horizontal não vira manchete (resposta real do Gemini: título, citação e régua)", () => {
    const real = '### Frase de Boas-Vindas\n\n> **"Entre, puxe uma cadeira."**\n\n---\n\n### Detalhes da Criação\n- Contagem exata: 12 palavras';
    expect(headlineOf(real)).toBe("Frase de Boas-Vindas");
    expect(headlineOf("---\n\nTudo certo por aqui.\n\n***\n\nFim.")).toBe("Tudo certo por aqui.");
    expect(headlineAndSummary("---")).toBeNull();
  });

  it("headlineAndSummary: nada para texto vazio", () => {
    expect(headlineAndSummary(undefined)).toBeNull();
    expect(headlineAndSummary("  \n ")).toBeNull();
    expect(headlineAndSummary(REPLY)).toMatchObject({ headline: "O relatório está pronto e foi enviado." });
    expect(headlineAndSummary("Só uma frase.")).toEqual({ headline: "Só uma frase." });
  });
});

const AT = "2026-11-12T12:00:00.000Z";
const END = "2026-11-12T12:05:00.000Z";
const task = (patch: Partial<DeliveryTask> = {}): DeliveryTask => ({ id: "t1", agentId: "rafa", prompt: "Corrija o **relatório** de vendas\nmais detalhes aqui", status: "done", result: REPLY, createdAt: AT, updatedAt: END, ...patch });
let seq = 0;
const entry = (body: Record<string, unknown>, extra: Partial<AgentLogEntry> = {}): AgentLogEntry => ({ id: `e${++seq}`, taskId: "t1", agentId: "rafa", at: "2026-11-12T12:01:00.000Z", ...body, ...extra }) as AgentLogEntry;
const tool = (name: string, input?: Record<string, unknown>) => entry({ kind: "tool", toolUseId: `u${seq}`, name, summary: "", status: "ok", ...(input ? { input } : {}) });
const media = (id: string, taskId?: string): MediaItem =>
  ({ id, kind: "image", mime: "image/png", fileName: `${id}.png`, title: `Imagem ${id}`, size: 1, createdAt: AT, createdBy: "rafa", origin: "arquivo", status: "rascunho", ...(taskId ? { taskId } : {}) }) as MediaItem;

describe("deliveryOf", () => {
  it("monta o cartão: pedido sem markdown, manchete, resumo, texto inteiro, horários", () => {
    const card = deliveryOf({ task: task() });
    expect(card).toMatchObject({ id: "t1", taskId: "t1", agentId: "rafa", request: "Corrija o relatório de vendas", headline: "O relatório está pronto e foi enviado.", text: REPLY, finishedAt: END, tools: 0, edited: 0, media: [] });
    expect(card?.summary).toMatch(/^Em poucas palavras/);
  });

  it("sem resumo quando só há um parágrafo", () => {
    expect(deliveryOf({ task: task({ result: "Pronto, tudo feito." }) })?.summary).toBeUndefined();
  });

  it("não é entrega: sem resultado, em andamento, falha, cancelada, sem agente", () => {
    expect(deliveryOf({ task: task({ result: undefined }) })).toBeNull();
    expect(deliveryOf({ task: task({ result: "  " }) })).toBeNull();
    expect(deliveryOf({ task: task({ status: "in_progress" }) })).toBeNull();
    expect(deliveryOf({ task: task({ status: "failed" }) })).toBeNull();
    expect(deliveryOf({ task: task({ outcome: "cancelled" }) })).toBeNull();
    expect(deliveryOf({ task: task({ agentId: undefined }) })).toBeNull();
  });

  it("conta ferramentas e arquivos distintos editados (nomes dos dois motores), só da tarefa e sem subagente", () => {
    const entries = [
      tool("Read", { file_path: "a.ts" }),
      tool("Edit", { file_path: "src/x.ts" }),
      tool("Edit", { file_path: "src/x.ts" }),
      tool("Write", { file_path: "src/y.ts" }),
      tool("replace_file_content", { TargetFile: "src/z.ts" }),
      entry({ kind: "tool", toolUseId: "s", name: "Edit", summary: "", status: "ok", input: { file_path: "src/sub.ts" } }, { thread: "s1" }),
      entry({ kind: "tool", toolUseId: "o", name: "Edit", summary: "", status: "ok", input: { file_path: "outra.ts" } }, { taskId: "t2" }),
      entry({ kind: "text", text: "oi" }),
    ];
    const card = deliveryOf({ task: task(), entries });
    expect(card?.tools).toBe(5);
    expect(card?.edited).toBe(3);
    expect(card?.startedAt).toBe("2026-11-12T12:01:00.000Z");
  });

  it("anexa só a mídia ligada à tarefa", () => {
    const card = deliveryOf({ task: task(), media: [media("M-0001", "t1"), media("M-0002", "outra"), media("M-0003")] });
    expect(card?.media).toEqual([{ id: "M-0001", kind: "image", title: "Imagem M-0001", fileName: "M-0001.png" }]);
  });

  it("tarefa de rotina entra como as outras", () => {
    expect(deliveryOf({ task: task({ projectId: "p1" }) })).toMatchObject({ projectId: "p1" });
  });

  it("deliveriesOf: só as do agente, a mais nova primeiro", () => {
    const cards = deliveriesOf({
      agentId: "rafa",
      tasks: [task({ id: "a", updatedAt: "2026-11-12T10:00:00.000Z" }), task({ id: "b", updatedAt: "2026-11-12T11:00:00.000Z" }), task({ id: "c", agentId: "lia" }), task({ id: "d", status: "failed" })],
    });
    expect(cards.map((card) => card.id)).toEqual(["b", "a"]);
  });
});
