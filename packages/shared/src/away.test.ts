import { describe, expect, it } from "vitest";
import { awayDuration, awayLines, buildAwaySummary, type AwayWorkspaceInput } from "./away";
import type { ForYouItem } from "./for-you";
import type { Task } from "./types";

const SINCE = Date.parse("2026-11-12T12:00:00.000Z");
const UNTIL = Date.parse("2026-11-12T15:00:00.000Z");
const at = (hours: number, minutes = 0) => new Date(Date.parse("2026-11-12T12:00:00.000Z") + hours * 3_600_000 + minutes * 60_000).toISOString();

const task = (id: string, change: Partial<Task> = {}): Task =>
  ({ id, roomId: "r", teamId: "t", agentId: "eco", prompt: `Escrever ${id}\ncom detalhe`, status: "done", createdAt: at(0), updatedAt: at(1), ...change }) as Task;

const item = (id: string, change: Partial<ForYouItem> = {}): ForYouItem =>
  ({ id, agentId: "eco", roomId: "r", type: "post", kind: "aprovacao", status: "pendente", meta: {}, text: "Legenda do bolo", originalText: "Legenda do bolo", editedByUser: false, createdAt: at(1), title: `Post ${id}`, ...change }) as ForYouItem;

const ws = (change: Partial<AwayWorkspaceInput> = {}): AwayWorkspaceInput => ({ id: "ws", name: "Site novo", tasks: [], items: [], agents: [{ id: "eco", name: "Eco" }], ...change });
const build = (workspaces: AwayWorkspaceInput[], alerts: Parameters<typeof buildAwaySummary>[0]["alerts"] = []) => buildAwaySummary({ since: SINCE, until: UNTIL, workspaces, alerts });

describe("buildAwaySummary: o cartão de ausência, por código", () => {
  it("nada aconteceu: vazio (o cartão não aparece)", () => {
    const summary = build([ws({ tasks: [task("velha", { updatedAt: at(-2) })], items: [item("antigo", { createdAt: at(-3), status: "aprovado", decidedAt: at(-3, 1) })] })]);
    expect(summary.empty).toBe(true);
    expect(summary.workspaces).toEqual([]);
    expect(summary.limits).toEqual([]);
    expect(awayLines(summary)).toEqual([]);
  });

  it("só uma espera antiga (item pendente de antes da ausência) não é novidade: o cartão não abre", () => {
    const summary = build([ws({ items: [item("antigo", { createdAt: at(-60) })] })]);
    expect(summary.empty).toBe(true);
    expect(summary.totals.waitedMs).toBeGreaterThan(0);
    expect(summary.workspaces).toEqual([]);
  });

  it("tarefas concluídas (com o título e a primeira linha do resultado, sem segredos) e falhas; cancelada não é falha; o registro do pedido não conta", () => {
    const summary = build([
      ws({
        tasks: [
          task("a", { result: "Post pronto com a chave sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\nsegunda linha" }),
          task("b", { updatedAt: at(2) }),
          task("c", { status: "failed", updatedAt: at(2, 10) }),
          task("d", { status: "failed", outcome: "cancelled" }),
          task("e", { role: "request" }),
          task("f", { status: "in_progress" }),
        ],
      }),
    ]);
    expect(summary.empty).toBe(false);
    const [workspace] = summary.workspaces;
    expect(workspace!.doneCount).toBe(2);
    expect(workspace!.done.map((ref) => ref.id)).toEqual(["b", "a"]);
    expect(workspace!.done[1]).toMatchObject({ title: "Escrever a", agentName: "Eco", target: { page: "trabalho", workspaceId: "ws", ref: "a" } });
    expect(workspace!.done[1]!.headline).not.toContain("sk-ant");
    expect(workspace!.failedCount).toBe(1);
    expect(workspace!.failed[0]!.id).toBe("c");
    expect(summary.totals).toMatchObject({ done: 2, failed: 1 });
    expect(awayLines(summary)).toEqual(["2 tarefas concluídas", "1 tarefa falhou"]);
  });

  it("aprovações novas esperando (só as pendentes que nasceram na ausência) e a espera acumulada", () => {
    const summary = build([
      ws({
        items: [
          item("novo", { createdAt: at(1) }),
          item("decidido", { createdAt: at(1), status: "aprovado", decidedAt: at(1, 30), decidedBy: "usuario" } as Partial<ForYouItem>),
          item("antes", { createdAt: at(-1) }),
        ],
      }),
    ]);
    const [workspace] = summary.workspaces;
    expect(workspace!.approvalsCount).toBe(1);
    expect(workspace!.approvals[0]).toMatchObject({ id: "novo", title: "Post novo", agentName: "Eco", target: { page: "para-voce", workspaceId: "ws", ref: "novo" } });
    expect(workspace!.oldestApprovalAt).toBe(at(1));
    // O item "novo" espera até o fim da janela (2 h); o "decidido", 30 min dentro dela; "antes" vem de antes mas toca a janela.
    expect(workspace!.waitedMs).toBeGreaterThan(2 * 3_600_000);
    expect(awayLines(summary)[0]).toContain("1 item novo espera você, a mais antiga há 2 h");
    expect(awayLines(summary).some((line) => line.startsWith("Os agentes ficaram"))).toBe(true);
  });

  it("agrupa por workspace e só traz os que têm novidade; soma os totais", () => {
    const summary = build([
      ws({ id: "a", name: "A", tasks: [task("t1")] }),
      ws({ id: "b", name: "B" }),
      ws({ id: "c", name: "C", tasks: [task("t2"), task("t3")], usage: { costUsd: 0.5, costBrl: 2.5, tokens: 1000, turns: 3, unmeasuredTurns: 0 } }),
    ]);
    expect(summary.workspaces.map((workspace) => workspace.id)).toEqual(["a", "c"]);
    expect(summary.totals).toMatchObject({ done: 3, costUsd: 0.5, tokens: 1000, turns: 3 });
    expect(awayLines(summary).at(-1)).toBe("Gasto no período: 1.000 tokens, US$ 0.50 equivalentes");
  });

  it("limita as listas em cinco e conta o resto", () => {
    const tasks = Array.from({ length: 8 }, (_, i) => task(`t${i}`, { updatedAt: at(1, i) }));
    const [workspace] = build([ws({ tasks })]).workspaces;
    expect(workspace!.doneCount).toBe(8);
    expect(workspace!.done).toHaveLength(5);
  });

  it("limites de uso e orçamento atingidos na ausência entram; outros tipos e os de fora da janela não", () => {
    const target = { page: "gestao" as const, ref: "gastos" };
    const summary = build(
      [],
      [
        { kind: "usage", level: "warn", text: "Claude Code: 5 h em 86%, volta às 15h", at: at(1), target },
        { kind: "budget", level: "alert", text: "Orçamento hoje estourado: US$ 5,00 de US$ 5,00 equiv.", at: at(2), target },
        { kind: "approval", level: "alert", text: "Eco tem uma aprovação", at: at(1), target },
        { kind: "usage", level: "warn", text: "velho", at: at(-1), target },
      ],
    );
    expect(summary.empty).toBe(false);
    expect(summary.limits.map((limit) => limit.kind)).toEqual(["usage", "budget"]);
    expect(awayLines(summary)).toEqual(["Claude Code: 5 h em 86%, volta às 15h", "Orçamento hoje estourado: US$ 5,00 de US$ 5,00 equiv."]);
  });

  it("a janela é aberta no começo e fechada no fim: o que aconteceu exatamente em `since` não conta", () => {
    expect(build([ws({ tasks: [task("na-borda", { updatedAt: at(0) })] })]).empty).toBe(true);
    expect(build([ws({ tasks: [task("no-fim", { updatedAt: at(3) })] })]).empty).toBe(false);
  });
});

describe("awayDuration", () => {
  it("formata a duração em português", () => {
    expect(awayDuration(30_000)).toBe("30 s");
    expect(awayDuration(45 * 60_000)).toBe("45 min");
    expect(awayDuration(80 * 60_000)).toBe("1 h 20 min");
    expect(awayDuration(2 * 3_600_000)).toBe("2 h");
    expect(awayDuration(26 * 3_600_000)).toBe("1 dia e 2 h");
  });
});
