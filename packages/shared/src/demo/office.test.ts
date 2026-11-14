import { describe, expect, it } from "vitest";
import { applyChanges, emptyFrame, frameOf } from "../timeline";
import { totalMs } from "../day-stats";
import { DemoOffice } from "./office";

const NOW = Date.parse("2026-11-12T17:30:00.000Z"); // 14:30 em São Paulo

const resumo = (o: DemoOffice) => ({
  tasks: o.tasks.map((t) => [t.id, t.agentId, t.status, t.updatedAt]),
  forYou: o.forYou.map((i) => [i.id, i.status]),
  usage: o.usage.map((u) => [u.id, u.tokens]),
  timeline: o.dayRecords().length,
});

describe("DemoOffice", { timeout: 30_000 }, () => {
  it("a mesma semente dá o mesmo escritório; outra semente dá outro", () => {
    const a = new DemoOffice({ seed: 7, now: NOW });
    const b = new DemoOffice({ seed: 7, now: NOW });
    const c = new DemoOffice({ seed: 8, now: NOW });
    expect(resumo(a)).toEqual(resumo(b));
    expect(a.dayStats()).toEqual(b.dayStats());
    expect(resumo(c)).not.toEqual(resumo(a));
  });

  it("a mesma semente dá a mesma vida por cima do tempo (tick de 1 s em 1 s ou de uma vez)", () => {
    const a = new DemoOffice({ seed: 7, now: NOW });
    const b = new DemoOffice({ seed: 7, now: NOW });
    const eventosA = [];
    for (let s = 1; s <= 120; s++) eventosA.push(...a.tick(NOW + s * 1000));
    const eventosB = b.tick(NOW + 120_000);
    expect(eventosB).toEqual(eventosA);
  });

  it("tem agentes trabalhando, esperando o dono e projetos; o snapshot traz tudo que a interface lê", () => {
    const o = new DemoOffice({ seed: 7, now: NOW });
    const snap = o.snapshot() as { type: string; office: { agents: { status: string }[]; rooms: unknown[] }; projects: unknown[]; forYou: { status: string }[]; forYouTypes: unknown[] };
    expect(snap.type).toBe("office:snapshot");
    expect(snap.office.rooms.length).toBeGreaterThanOrEqual(3);
    expect(snap.office.agents.length).toBeGreaterThanOrEqual(8);
    expect(snap.projects.length).toBeGreaterThanOrEqual(3);
    expect(o.tasks.some((t) => t.status === "done")).toBe(true);
    expect(o.forYou.length).toBeGreaterThan(0);
    // em 6h30 de simulação acontece de tudo: trabalho, espera pelo dono e retomada
    expect(new Set(o.forYou.map((i) => i.status)).size).toBeGreaterThan(1);
  });

  it("os números da diária e do gasto batem com as tarefas e os itens fabricados", () => {
    const o = new DemoOffice({ seed: 7, now: NOW });
    const stats = o.dayStats();
    const concluidas = o.tasks.filter((t) => t.status === "done").length;
    expect(stats.totals.tasksDone).toBe(concluidas);
    // o gasto: um turno por tarefa terminada, e o total do dia é a soma das linhas
    const terminadas = o.tasks.filter((t) => t.status === "done" || t.status === "failed").length;
    expect(o.usage).toHaveLength(terminadas);
    expect(stats.totals.turns).toBe(terminadas);
    expect(stats.totals.costUsd).toBeCloseTo(o.usage.reduce((soma, r) => soma + (r.costUsd ?? 0), 0), 9);
    expect(stats.totals.tokens.output).toBe(o.usage.reduce((soma, r) => soma + (r.tokens?.output ?? 0), 0));
    // esperando você = a soma das esperas dos itens decididos ou abertos
    const esperas = o.forYou.map((item) => (item.decidedAt ? Date.parse(item.decidedAt) : o.now) - Date.parse(item.createdAt));
    expect(stats.totals.ms.waiting_owner).toBeGreaterThan(0);
    expect(stats.totals.ms.waiting_owner).toBeLessThanOrEqual(esperas.reduce((a, b) => a + b, 0));
    // o tempo trabalhando soma o que o relógio acumulou
    expect(stats.totals.ms.working).toBeGreaterThan(0);
    expect(totalMs(stats.totals.ms)).toBeGreaterThan(stats.totals.ms.working);
    // projetos: tarefa do projeto concluída = tarefa fabricada concluída
    const doProjeto = o.tasks.filter((t) => t.work && t.status === "done");
    for (const t of doProjeto) {
      const projeto = o.projects.find((p) => p.id === t.work!.projectId)!;
      expect(projeto.tasks.find((x) => x.ref === t.work!.ref)!.status).toBe("concluida");
    }
  });

  it("o dia gravado de mentira tem o formato do gravador e reproduz o estado de agora", () => {
    const o = new DemoOffice({ seed: 7, now: NOW });
    const records = o.dayRecords();
    expect(records[0]).toMatchObject({ t: "k", boot: true });
    expect(records.filter((r) => r.t === "k").length).toBeGreaterThan(60); // um quadro completo a cada 5 min em 6h30
    expect(records.some((r) => r.t === "d")).toBe(true);
    const quadro = emptyFrame();
    let atual = quadro;
    for (const r of records) {
      if (r.t === "k") atual = frameOf(r);
      else if (r.t === "d") applyChanges(atual, r);
    }
    const agora = o.frame();
    // o último registro está a menos de um batimento de agora: os agentes e as salas são os mesmos
    expect([...atual.agents.keys()]).toEqual([...agora.agents.keys()]);
    expect([...atual.rooms.keys()]).toEqual([...agora.rooms.keys()]);
  });
});
