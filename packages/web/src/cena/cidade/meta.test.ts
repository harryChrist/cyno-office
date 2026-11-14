import type { ActivitySummary } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { acabouDeBater, ALVO_MAX, ALVO_PADRAO, alvoValido, guardarAlvo, jaFestejou, lerAlvo, marcarFestejada, metaDaSemana, pracaDaCidade, semanaDe } from "./meta";
import { tarefasDaSemana } from "./useMetaDaSemana";

const memoria = () => {
  const mem = new Map<string, string>();
  return { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
};

describe("a semana", () => {
  // Instantes em UTC; São Paulo é UTC-3. 12/11/2026 é quinta-feira.
  it("vai de segunda a domingo, em qualquer dia dela", () => {
    expect(semanaDe(new Date("2026-11-12T18:00:00Z"))).toEqual({ from: "2026-11-09", to: "2026-11-15", chave: "2026-11-09" });
    expect(semanaDe(new Date("2026-11-09T03:05:00Z")).from).toBe("2026-11-09");
    expect(semanaDe(new Date("2026-11-16T02:59:00Z")).from).toBe("2026-11-09");
    expect(semanaDe(new Date("2026-11-16T11:00:00Z")).from).toBe("2026-11-16");
  });

  it("atravessa o fim do mês e do ano", () => {
    expect(semanaDe(new Date("2026-12-31T15:00:00Z"))).toEqual({ from: "2026-12-28", to: "2027-01-03", chave: "2026-12-28" });
  });

  it("usa a semana de São Paulo, não a do fuso do navegador: domingo à noite lá já é segunda em fuso adiantado", () => {
    // 02:30 UTC de segunda 16/11 = 23:30 de domingo 15/11 em São Paulo: ainda é a semana de 09/11.
    expect(semanaDe(new Date("2026-11-16T02:30:00Z"))).toEqual({ from: "2026-11-09", to: "2026-11-15", chave: "2026-11-09" });
    // 02:59 UTC de segunda 09/11 = 23:59 de domingo 08/11 em São Paulo: semana de 02/11.
    expect(semanaDe(new Date("2026-11-09T02:59:00Z")).from).toBe("2026-11-02");
  });
});

describe("a meta", () => {
  it("o termômetro: porcentagem, rótulo e progresso", () => {
    expect(metaDaSemana(5, 20)).toMatchObject({ pct: 0.25, pctText: "25%", label: "20 tarefas concluídas na semana", progressText: "5 de 20", reached: 0 });
    expect(metaDaSemana(20, 20)).toMatchObject({ pct: 1, pctText: "100%", progressText: "Meta batida!", reached: 1 });
    expect(metaDaSemana(35, 20).pct).toBe(1);
    expect(metaDaSemana(0, 1).label).toBe("1 tarefa concluída na semana");
    expect(metaDaSemana(-3, 10).pct).toBe(0);
  });

  it("o alvo válido é inteiro de 1 a 9999; lixo vira o padrão", () => {
    expect(alvoValido(30)).toBe(30);
    expect(alvoValido("45")).toBe(45);
    expect(alvoValido(0)).toBe(1);
    expect(alvoValido(1e9)).toBe(ALVO_MAX);
    expect(alvoValido(7.6)).toBe(8);
    expect(alvoValido("abc")).toBe(ALVO_PADRAO);
    expect(alvoValido(Number.NaN)).toBe(ALVO_PADRAO);
  });

  it("guarda e lê o alvo", () => {
    const m = memoria();
    expect(lerAlvo(m)).toBe(ALVO_PADRAO);
    expect(guardarAlvo(50, m)).toBe(50);
    expect(lerAlvo(m)).toBe(50);
    expect(guardarAlvo(-4, m)).toBe(1);
  });

  it("bate só ao cruzar o alvo para cima, e não na primeira leitura", () => {
    expect(acabouDeBater(null, 25, 20)).toBe(false);
    expect(acabouDeBater(18, 20, 20)).toBe(true);
    expect(acabouDeBater(18, 19, 20)).toBe(false);
    expect(acabouDeBater(20, 22, 20)).toBe(false);
  });

  it("não festeja duas vezes na mesma semana", () => {
    const m = memoria();
    expect(jaFestejou("2026-11-09", m)).toBe(false);
    marcarFestejada("2026-11-09", m);
    expect(jaFestejou("2026-11-09", m)).toBe(true);
    expect(jaFestejou("2026-11-16", m)).toBe(false);
  });

  it("a praça leva os acesos, os agentes e a meta", () => {
    const meta = metaDaSemana(3, 10);
    expect(pracaDaCidade({ acesos: 2, trabalhando: 5 }, meta)).toMatchObject({ acesos: 2, agentes: 5, meta });
    expect(pracaDaCidade({ acesos: 0, trabalhando: 0 }).meta).toBeNull();
  });
});

describe("a soma da semana", () => {
  const resumo = (tasksDone: number) => ({ tasksDone }) as ActivitySummary;

  it("soma as tarefas de cada workspace pela rota dele", async () => {
    const chamadas: string[] = [];
    const total = await tarefasDaSemana(
      ["a", "b c"],
      { from: "2026-11-09", to: "2026-11-15" },
      async (caminho) => {
        chamadas.push(caminho);
        return resumo(caminho.includes("/a/") ? 4 : 3);
      },
    );
    expect(total).toBe(7);
    expect(chamadas).toEqual(["/api/w/a/activity/summary?from=2026-11-09&to=2026-11-15", "/api/w/b%20c/activity/summary?from=2026-11-09&to=2026-11-15"]);
  });

  it("um workspace que falha conta zero e não derruba a soma", async () => {
    const total = await tarefasDaSemana(["a", "b"], { from: "x", to: "y" }, async (c) => {
      if (c.includes("/b/")) throw new Error("caiu");
      return resumo(2);
    });
    expect(total).toBe(2);
  });
});
