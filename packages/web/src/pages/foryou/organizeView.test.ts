import type { BrainOrganizeAction, BrainOrganizePlan } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { actionPreview, actionTitle, appliedCount, appliedSummary, applyCount, applyLabel, beforeAfterLine, failedRows, fileLabel, formatChars, groupOrganizeActions, mergeTitles, skipList } from "./organizeView";

const actions: BrainOrganizeAction[] = [
  { type: "archive", file: "etapa-1.md", title: "Etapa 1" },
  { type: "make_rule", file: "estilo.md", content: "Sem emoji." },
  { type: "archive", file: "historico/antiga.md" },
  { type: "set_rules", content: "- a\n- b" },
  { type: "merge", files: ["a.md", "b.md"], titles: ["Nota A"], title: "Resumo", content: "Texto" },
  { type: "agent_rule", agentId: "lia", agentName: "Lia", text: "Sempre pt-BR" },
  { type: "rewrite", file: "longa.md", content: "Curta" },
];

describe("organizeView", () => {
  it("agrupa na ordem do cartão e guarda o índice original de cada ação", () => {
    const groups = groupOrganizeActions(actions);
    expect(groups.map((group) => group.type)).toEqual(["set_rules", "make_rule", "agent_rule", "merge", "rewrite", "archive"]);
    expect(groups.map((group) => group.label)).toEqual(["Regras da sala", "Vira regra", "Regra de um agente", "Juntar num resumo", "Encurtar", "Vai para o histórico"]);
    expect(groups.at(-1)!.rows.map((row) => row.index)).toEqual([0, 2]);
    expect(groupOrganizeActions([actions[0]!]).map((group) => group.type)).toEqual(["archive"]);
  });

  it("títulos: título da nota, nome do arquivo sem .md, agente, resumo", () => {
    expect(actionTitle(actions[0]!)).toBe("Etapa 1");
    expect(actionTitle(actions[2]!)).toBe("antiga");
    expect(actionTitle(actions[3]!)).toBe("Regras da sala");
    expect(actionTitle(actions[4]!)).toBe("Resumo");
    expect(actionTitle(actions[5]!)).toBe("Lia");
    expect(actionTitle({ type: "agent_rule", agentId: "x1", text: "texto" })).toBe("x1");
    expect(fileLabel("historico/x.md")).toBe("x");
    expect(mergeTitles(actions[4] as Extract<BrainOrganizeAction, { type: "merge" }>)).toEqual(["Nota A", "b"]);
  });

  it("a prévia só existe quando a ação traz texto", () => {
    expect(actionPreview(actions[0]!)).toBeNull();
    expect(actionPreview({ type: "make_rule", file: "x.md" })).toBeNull();
    expect(actionPreview(actions[1]!)).toBe("Sem emoji.");
    expect(actionPreview(actions[3]!)).toBe("- a\n- b");
    expect(actionPreview(actions[4]!)).toBe("Texto");
    expect(actionPreview(actions[5]!)).toBe("Sempre pt-BR");
    expect(actionPreview(actions[6]!)).toBe("Curta");
  });

  it("formata caracteres e a linha de antes e depois", () => {
    expect(formatChars(850)).toBe("850 caracteres");
    expect(formatChars(2400)).toBe("2,4 mil caracteres");
    expect(formatChars(70_400)).toBe("70 mil caracteres");
    expect(beforeAfterLine({ notes: 12, chars: 70_000, rules: 1 }, { notes: 1, chars: 3000, rules: 9 })).toBe(
      "Hoje: 12 notas de referência (70 mil caracteres) e 1 regra. Depois: 1 nota e 9 regras.",
    );
  });

  it("contagem, skip e rótulo do botão", () => {
    const skipped = new Set([3, 1, 99]);
    expect(applyCount(7, skipped)).toBe(5);
    expect(skipList(skipped, 7)).toEqual([1, 3]);
    expect(applyLabel(1)).toBe("Aplicar 1 mudança");
    expect(applyLabel(0)).toBe("Aplicar 0 mudanças");
  });

  it("depois de aprovado: aplicadas, desmarcadas e as que falharam", () => {
    const plan = { actions, skipped: [0, 1], failed: [{ index: 4, error: "A nota sumiu" }] } as Pick<BrainOrganizePlan, "actions" | "skipped" | "failed">;
    expect(appliedCount(plan)).toBe(4);
    expect(appliedSummary(plan)).toEqual(["Aplicado: 4 mudanças", "2 desmarcadas"]);
    expect(appliedSummary({ actions, skipped: undefined, failed: undefined })).toEqual(["Aplicado: 7 mudanças"]);
    expect(failedRows(plan)).toEqual([{ index: 4, title: "Resumo", error: "A nota sumiu" }]);
  });
});
