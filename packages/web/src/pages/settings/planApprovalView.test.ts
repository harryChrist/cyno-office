import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlanApprovalCardView } from "./PlanApprovalSettings";
import {
  DEFAULT_PLAN_APPROVAL_RULE,
  formatLocalDayMonth,
  formatPlanApprovalNote,
  PLAN_APPROVAL_OPTIONS,
  PLAN_APPROVAL_RESET_LABEL,
  planApprovalOption,
} from "./planApprovalView";

const localIso = (year: number, month: number, day: number) => new Date(year, month - 1, day, 12, 0, 0).toISOString();

describe("planApprovalView (opções, textos e nota)", () => {
  it("padrão é 'maestro' e as três opções têm os textos esperados sem travessão longo nem setas", () => {
    expect(DEFAULT_PLAN_APPROVAL_RULE).toBe("maestro");
    expect(PLAN_APPROVAL_OPTIONS.map((option) => option.rule)).toEqual(["maestro", "always", "never"]);
    expect(planApprovalOption("maestro")).toEqual({
      rule: "maestro",
      label: "O Maestro decide",
      description: "Ele pede sua aprovação quando a estrutura vale ser confirmada e começa direto quando você já disse como quer.",
    });
    expect(planApprovalOption("always")).toEqual({
      rule: "always",
      label: "Sempre pedir",
      description: "Todo projeto novo espera o seu OK antes de começar.",
    });
    expect(planApprovalOption("never")).toEqual({
      rule: "never",
      label: "Nunca pedir",
      description: "Projetos, módulos e tarefas começam sem pedir. Você ainda pode pausar, segurar ou apagar.",
    });
    expect(planApprovalOption(undefined).rule).toBe("maestro");
    for (const option of PLAN_APPROVAL_OPTIONS) {
      expect(`${option.label} ${option.description}`).not.toMatch(/[—→]|->/);
    }
  });

  it("formata a data local DD/MM e a nota do Maestro com a frase", () => {
    const at = localIso(2026, 11, 21);
    expect(formatLocalDayMonth(at)).toBe("21/11");
    expect(formatLocalDayMonth("invalida")).toBe("");
    expect(formatPlanApprovalNote(undefined)).toBeNull();
    expect(formatPlanApprovalNote({ by: "maestro", at, quote: "pode tocar direto sem me perguntar" })).toBe(
      "Definido pelo Maestro em 21/11, a seu pedido: «pode tocar direto sem me perguntar»",
    );
    expect(formatPlanApprovalNote({ by: "dono", at, quote: "prefiro assim" })).toBe("Definido por você em 21/11: «prefiro assim»");
    expect(formatPlanApprovalNote({ by: "maestro", at: "invalida", quote: "  direto  " })).toBe("Definido pelo Maestro, a seu pedido: «direto»");
  });
});

describe("PlanApprovalCardView (renderização)", () => {
  const render = (props: Partial<Parameters<typeof PlanApprovalCardView>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(PlanApprovalCardView, {
        value: { rule: "maestro" },
        loading: false,
        saving: false,
        saved: false,
        error: null,
        onSelect: () => undefined,
        ...props,
      }),
    );

  it("renderiza as três opções de rádio e o selo do estado atual", () => {
    const html = render({ value: { rule: "always" } });
    expect(html).toContain("Aprovação de planos");
    expect(html).toContain("O Maestro decide");
    expect(html).toContain("Sempre pedir");
    expect(html).toContain("Nunca pedir");
    expect(html).toContain('data-testid="settings-plan-approval-always"');
    expect(html).not.toContain('data-testid="settings-plan-approval-note"');
    expect(html).not.toContain(PLAN_APPROVAL_RESET_LABEL);
  });

  it("quando existe nota, mostra a frase formatada e o botão para voltar ao Maestro decide", () => {
    const html = render({
      value: { rule: "never", note: { by: "maestro", at: localIso(2026, 11, 21), quote: "não precisa me pedir OK" } },
    });
    expect(html).toContain('data-testid="settings-plan-approval-note"');
    expect(html).toContain("Definido pelo Maestro em 21/11, a seu pedido: «não precisa me pedir OK»");
    expect(html).toContain(PLAN_APPROVAL_RESET_LABEL);
    expect(html).toContain('data-testid="settings-plan-approval-reset"');
  });

  it("mostra feedback de salvamento e erro em pt-BR", () => {
    expect(render({ saving: true })).toContain("Salvando…");
    expect(render({ saved: true })).toContain("Salvo.");
    const withError = render({ error: "Não foi possível falar com o servidor.", saved: true });
    expect(withError).toContain("Não foi possível falar com o servidor.");
    expect(withError).not.toContain('data-testid="settings-plan-approval-status"');
  });
});
