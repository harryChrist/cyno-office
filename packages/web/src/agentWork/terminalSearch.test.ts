import { conversationLogId, type AgentLogEntry } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { entriesToTerminalLines } from "./agentTerminal";
import {
  collapsePreview,
  copyDetailOf,
  copyTextOf,
  filterLines,
  finalAnswerIds,
  findMatches,
  foldQuery,
  foldText,
  globalIndex,
  hiddenAt,
  hitCounts,
  moreLabel,
  refAt,
  searchCounter,
  splitByRanges,
  stepMatch,
} from "./terminalSearch";

const AT = "2026-11-12T12:00:00.000Z";
const TASK = "11111111-2222-3333-4444-555555555555";
const CONVERSA = conversationLogId("rafa", AT);
let seq = 0;
const entry = (body: Record<string, unknown>, extra: Partial<AgentLogEntry> = {}): AgentLogEntry =>
  ({ id: `e${String(++seq).padStart(4, "0")}`, taskId: TASK, agentId: "rafa", at: AT, ...body, ...extra }) as AgentLogEntry;
const tool = (summary: string, output?: string) => entry({ kind: "tool", toolUseId: `t${seq}`, name: "Read", summary, status: "ok", ...(output ? { output } : {}) });
const lines = (entries: AgentLogEntry[]) => entriesToTerminalLines(entries, { agentName: "Rafa" });

describe("busca sem acento nem maiúsculas", () => {
  it("foldText guarda de onde veio cada letra", () => {
    expect(foldText("Ação")).toMatchObject({ text: "acao" });
    expect(foldText("abc")).toEqual({ text: "abc" });
    expect(foldQuery("  Ação ")).toBe("acao");
    expect(foldQuery("   ")).toBe("");
  });

  it("findMatches devolve trechos do texto ORIGINAL, sem sobreposição", () => {
    expect(findMatches("Ação e ACAO e acao", "acao")).toEqual([
      [0, 4],
      [7, 11],
      [14, 18],
    ]);
    expect(findMatches("aaaa", "aa")).toEqual([
      [0, 2],
      [2, 4],
    ]);
    expect(findMatches("abc", "")).toEqual([]);
    expect(findMatches("São Paulo", "sao")).toEqual([[0, 3]]);
  });

  it("acento solto (e + U+0301) entra no destaque da letra anterior", () => {
    expect(findMatches("café bom", "cafe")).toEqual([[0, 5]]);
  });

  it("stepMatch dá a volta nos dois sentidos", () => {
    expect(stepMatch(-1, 3, 1)).toBe(0);
    expect(stepMatch(-1, 3, -1)).toBe(2);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });

  it("contador, índice global e referência (ordem da tela)", () => {
    const counts = [
      ["a", 2],
      ["b", 3],
    ] as const;
    expect(globalIndex(counts, { key: "b", index: 1 })).toBe(3);
    expect(globalIndex(counts, { key: "b", index: 3 })).toBe(-1);
    expect(globalIndex(counts, null)).toBe(-1);
    expect(refAt(counts, 0)).toEqual({ key: "a", index: 0 });
    expect(refAt(counts, 4)).toEqual({ key: "b", index: 2 });
    expect(refAt(counts, 5)).toBeNull();
    expect(searchCounter(2, 17)).toBe("3 de 17");
    expect(searchCounter(-1, 17)).toBe("0 de 17");
  });

  it("hitCounts conta texto e detalhe, pula seções e linhas sem resultado, na ordem", () => {
    const all = lines([entry({ kind: "text", text: "Público jovem e publico velho" }), tool("x", "o publico\nachou publico"), entry({ kind: "text", text: "nada" })]);
    const counts = hitCounts(all, foldQuery("PÚBLICO"));
    expect(counts.map(([, n]) => n)).toEqual([2, 2]);
    expect(hitCounts(all, "")).toEqual([]);
  });

  it("splitByRanges parte o texto sem perder nada", () => {
    const pieces = splitByRanges("a Ação b", [[2, 6]]);
    expect(pieces).toEqual([{ text: "a " }, { text: "Ação", hit: 0 }, { text: " b" }]);
    expect(pieces.map((piece) => piece.text).join("")).toBe("a Ação b");
    expect(splitByRanges("abc", [])).toEqual([{ text: "abc" }]);
  });
});

describe("filtros", () => {
  const entries = () => [
    entry({ kind: "chat", from: "user", text: "faça o post" }),
    entry({ kind: "text", text: "Vou ler o briefing." }),
    tool("briefing.md", "conteúdo"),
    entry({ kind: "subagent", phase: "started", subagentId: "s1", label: "Pesquisa", goal: "x" }),
    entry({ kind: "text", text: "dentro do subagente" }, { thread: "s1" }),
    entry({ kind: "text", text: "Pronto, o post está feito." }),
    entry({ kind: "result", text: "## Resultado final" }),
  ];

  it("a resposta final é o texto sem ferramenta depois; o do meio não", () => {
    const all = lines(entries());
    const finals = finalAnswerIds(all);
    const texts = all.filter((line) => line.kind === "text" && !line.thread);
    expect(texts.map((line) => finals.has(line.id))).toEqual([false, true]);
  });

  it("Só conversa: fala do dono, resposta final e resultado", () => {
    const shown = filterLines(lines(entries()), "talk").filter((line) => line.kind !== "section");
    expect(shown.map((line) => line.text)).toEqual(["faça o post", "Pronto, o post está feito.", "## Resultado final"]);
  });

  it("Sem ferramentas: tira ferramentas e subagentes, mantém o resto", () => {
    const shown = filterLines(lines(entries()), "noTools").filter((line) => line.kind !== "section");
    expect(shown.map((line) => line.kind)).toEqual(["chat", "text", "text", "result"]);
  });

  it("Tudo mantém tudo; seção que ficou vazia some", () => {
    const outra = "99999999-2222-3333-4444-555555555555";
    const all = lines([...entries(), entry({ kind: "status", status: "started", message: "outra" }, { taskId: outra })]);
    expect(filterLines(all, "all")).toHaveLength(all.length);
    const talk = filterLines(all, "talk");
    expect(talk.filter((line) => line.kind === "section")).toHaveLength(1);
    expect(talk.at(-1)?.kind).not.toBe("section");
  });

  it("na conversa direta o chat do agente conta como conversa", () => {
    const shown = filterLines(lines([entry({ kind: "chat", from: "user", text: "oi" }, { taskId: CONVERSA }), entry({ kind: "chat", from: "agent", text: "olá" }, { taskId: CONVERSA })]), "talk");
    expect(shown.filter((line) => line.kind === "chat")).toHaveLength(2);
  });
});

describe("recolhimento", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `linha ${i + 1}`).join("\n");

  it("só recolhe com pelo menos 3 linhas escondidas", () => {
    expect(collapsePreview(many(8), 6)).toBeNull();
    expect(collapsePreview(many(9), 6)).toMatchObject({ hiddenLines: 3, cutMidLine: false, shown: many(6) });
    expect(collapsePreview(many(100), 6)?.hiddenLines).toBe(94);
  });

  it("linha muito comprida corta no meio e vira 'mostrar tudo'", () => {
    const preview = collapsePreview("x".repeat(2000), 6);
    expect(preview).toMatchObject({ cutMidLine: true, hiddenLines: 0 });
    expect(preview?.shown).toHaveLength(1200);
    expect(moreLabel(preview!)).toBe("… mostrar tudo");
  });

  it("rótulos", () => {
    expect(moreLabel(collapsePreview(many(20), 6)!)).toBe("… +14 linhas");
    expect(moreLabel({ shown: "", hiddenLines: 1, cutMidLine: false })).toBe("… +1 linha");
  });

  it("hiddenAt diz se o resultado está no trecho escondido (a busca abre o bloco)", () => {
    const text = many(30);
    expect(hiddenAt(text, 6, text.indexOf("linha 2"))).toBe(false);
    expect(hiddenAt(text, 6, text.indexOf("linha 25"))).toBe(true);
    expect(hiddenAt("curto", 6, 2)).toBe(false);
  });
});

describe("copiar", () => {
  it("o comando/resposta e o bloco de baixo, sem os espaços do fim", () => {
    const [, line] = lines([tool("a.ts", "saída\n\n")]);
    expect(copyTextOf(line!)).toBe("Read(a.ts)");
    expect(copyDetailOf(line!)).toBe("saída");
    const [, answer] = lines([entry({ kind: "text", text: "Oi  \n" })]);
    expect(copyTextOf(answer!)).toBe("Oi");
    expect(copyDetailOf(answer!)).toBe("");
  });
});
