import { describe, expect, it } from "vitest";
import { batchPlan, hasIndividualApproval, hasPendingEdit, type ForYouItem } from "./index";

let counter = 0;
function item(extra: Partial<ForYouItem> = {}): ForYouItem {
  counter += 1;
  return { id: `A-${String(counter).padStart(4, "0")}`, agentId: "clara", roomId: "r", type: "comentario", status: "pendente", meta: {}, text: "Texto", originalText: "Texto", editedByUser: false, createdAt: "2026-11-11T12:00:00.000Z", ...extra };
}

describe("batchPlan (aprovar em lote)", () => {
  it("deixa entrar aprovações de texto pendentes, sem edição, e junta o tipo", () => {
    const list = [item(), item(), item()];
    const plan = batchPlan(list, list.map((entry) => entry.id));
    expect(plan.eligible).toHaveLength(3);
    expect(plan.excluded).toEqual([]);
    expect(plan.types).toEqual(["comentario"]);
  });

  it("deixa de fora, com o motivo, o que não existe, já foi decidido, não é aprovação e tem edição pendente", () => {
    const edited = item({ text: "Editado", editedByUser: true });
    const swapped = item({ text: "Rascunho novo", originalText: "Rascunho velho" });
    const decided = item({ status: "aprovado" });
    const plan = item({ kind: "plano" });
    const ok = item();
    const result = batchPlan([edited, swapped, decided, plan, ok], [edited.id, swapped.id, decided.id, plan.id, ok.id, "A-9999"]);
    expect(result.eligible.map((entry) => entry.id)).toEqual([ok.id]);
    expect(Object.fromEntries(result.excluded.map((entry) => [entry.id, entry.reason]))).toEqual({
      [edited.id]: "edited",
      [swapped.id]: "edited",
      [decided.id]: "not_pending",
      [plan.id]: "not_approval",
      "A-9999": "missing",
    });
  });

  it("convite e post só entram se o agente já tem uma aprovação individual desse tipo; lote, Automático e outro agente não contam", () => {
    const pending = item({ type: "convite", agentId: "clara" });
    const viaBatch = item({ type: "convite", agentId: "clara", status: "aprovado", decidedBy: "usuario", viaBatch: true });
    const auto = item({ type: "convite", agentId: "clara", status: "aprovado", decidedBy: "automatico" });
    const other = item({ type: "convite", agentId: "eco", status: "aprovado", decidedBy: "usuario" });
    const wrongType = item({ type: "comentario", agentId: "clara", status: "aprovado", decidedBy: "usuario" });
    const all = [pending, viaBatch, auto, other, wrongType];
    expect(batchPlan(all, [pending.id]).excluded[0]?.reason).toBe("no_history");
    expect(hasIndividualApproval(all, "clara", "convite")).toBe(false);
    const individual = item({ type: "convite", agentId: "clara", status: "aprovado", decidedBy: "usuario" });
    expect(batchPlan([...all, individual], [pending.id]).eligible).toHaveLength(1);
    // Tipo que não é de fora não pede histórico.
    const comment = item({ type: "comentario", agentId: "novo" });
    expect(batchPlan([comment], [comment.id]).eligible).toHaveLength(1);
    const post = item({ type: "post", agentId: "novo" });
    expect(batchPlan([post], [post.id]).excluded[0]?.reason).toBe("no_history");
  });

  it("mostra mais de um tipo em types (o servidor recusa) e pendência de edição olha texto e rascunho", () => {
    const a = item({ type: "comentario" });
    const b = item({ type: "resposta" });
    expect(batchPlan([a, b], [a.id, b.id]).types).toEqual(["comentario", "resposta"]);
    expect(hasPendingEdit(item())).toBe(false);
    expect(hasPendingEdit(item({ text: "x", originalText: "y" }))).toBe(true);
  });
});
