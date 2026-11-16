// As moedinhas vêm do motor (`Wallets`); o adaptador só entrega as tarefas certas. Cada evento paga uma vez:
// tarefa concluída (por id), e o que já estava concluído antes de o agente chegar não vira dinheiro novo.
import type { OfficeState } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { DELIVERY_REWARD, START_COINS, TASK_REWARD, TURN_REWARD, Wallets } from "../../../../cena/client/src/world/social/wallet";
import { makeAgent, makeLogEntry, makeRoom, makeTask } from "../../test-fixtures";
import { memoriaInicial, montarRetrato, type EntradaDoRetrato, type MemoriaDaCena } from "@cyno/shared/cena";

const AGORA = Date.parse("2026-11-12T12:00:00.000Z");

const escritorio = (tarefas: ReturnType<typeof makeTask>[]): OfficeState => ({
  rooms: [makeRoom("estudio", { gridPosition: { x: 0, y: 0 } }), makeRoom("maestro", { kind: "maestro", gridPosition: { x: 5, y: 5 } })],
  teams: [
    { id: "ger", roomId: "maestro", name: "Gerência", focus: "" },
    { id: "texto", roomId: "estudio", name: "Texto", focus: "" },
  ],
  agents: [makeAgent("maestro-1", "ger"), makeAgent("ana", "texto")],
  tasks: tarefas,
});

const entrada = (office: OfficeState, agora: number): EntradaDoRetrato => ({ workspaceId: "ws", workspaceName: "WS", office, progress: {}, forYou: [], projects: [], terminals: {}, logs: {}, indisponiveis: {}, agora });
const tarefa = (id: string, status: "in_progress" | "done") => makeTask(id, { agentId: "ana", teamId: "texto", roomId: "estudio", prompt: `Tarefa ${id}`, status, updatedAt: new Date(AGORA - 60_000).toISOString() });

function ana(retrato: ReturnType<typeof montarRetrato>) {
  return retrato.snapshot.agents.find((a) => a.id === "ana")!;
}

describe("moedinhas (o que o adaptador entrega ao motor)", () => {
  it("cada tarefa concluída paga +10 uma vez, mesmo com vários retratos seguidos; o que já estava feito ao chegar entra no saldo inicial", () => {
    const carteiras = new Wallets(null);
    let memoria: MemoriaDaCena = memoriaInicial(AGORA);

    // O agente chega com t0 já concluída: saldo inicial + 10 de uma vez ("1 tarefa já concluída"), sem pagar de novo depois.
    let r = montarRetrato(entrada(escritorio([tarefa("t0", "done"), tarefa("t1", "in_progress")]), AGORA), memoria);
    memoria = r.memoria;
    expect(carteiras.ensure(ana(r), AGORA).created).toBe(true);
    expect(carteiras.coins("ana")).toBe(START_COINS.main + TASK_REWARD);
    expect(carteiras.payTasks(ana(r), AGORA)).toBe(0);

    // t1 conclui: aparece como `completed` e rende +10, uma vez, por mais retratos que cheguem.
    for (const [i, agora] of [AGORA + 1_000, AGORA + 2_000, AGORA + 3_000].entries()) {
      r = montarRetrato(entrada(escritorio([tarefa("t0", "done"), tarefa("t1", "done")]), agora), memoria);
      memoria = r.memoria;
      expect(ana(r).tasks.filter((t) => t.status === "completed").map((t) => t.id).sort()).toEqual(["t0", "t1"]);
      expect(carteiras.payTasks(ana(r), agora)).toBe(i === 0 ? TASK_REWARD : 0);
    }
    expect(carteiras.coins("ana")).toBe(START_COINS.main + 2 * TASK_REWARD);
  });

  it("os valores do motor: tarefa 10, pedido atendido 5, entrega de subagente 15", () => {
    expect([TASK_REWARD, TURN_REWARD, DELIVERY_REWARD]).toEqual([10, 5, 15]);
    const carteiras = new Wallets(null);
    carteiras.ensure({ id: "x", name: "X", kind: "main", tasks: [] }, AGORA);
    expect(carteiras.credit("x", TURN_REWARD, "💬", "Pedido atendido", AGORA)).toBe(5);
    expect(carteiras.credit("x", DELIVERY_REWARD, "📦", "Entregou", AGORA)).toBe(15);
    expect(carteiras.coins("x")).toBe(START_COINS.main + 20);
  });

  it("o fim do turno do agente (pedido atendido) sai como atividade `done`, uma vez por transição", () => {
    let memoria: MemoriaDaCena = memoriaInicial(AGORA);
    memoria = montarRetrato(entrada(escritorio([tarefa("t1", "in_progress")]), AGORA), memoria).memoria;
    const depois = montarRetrato(entrada(escritorio([tarefa("t1", "done")]), AGORA + 1_000), memoria);
    expect(ana(depois).activity).toMatchObject({ kind: "done", id: "done:t1" });
    const outra = montarRetrato(entrada(escritorio([tarefa("t1", "done")]), AGORA + 2_000), depois.memoria);
    expect(ana(outra).activity?.id).toBe("done:t1");
  });

  it("subagente: personagem com crachá ao lado do pai; ao terminar vira `done` por um tempo (a entrega) e depois some", () => {
    const abre = makeLogEntry("e1", { kind: "subagent", phase: "started", subagentId: "s1", label: "Rascunho A", goal: "Meta" }, { agentId: "ana", taskId: "t1" });
    const fecha = makeLogEntry("e2", { kind: "subagent", phase: "finished", subagentId: "s1", label: "Rascunho A", status: "ok" }, { agentId: "ana", taskId: "t1" });
    const office = escritorio([tarefa("t1", "in_progress")]);
    const comLog = (logs: EntradaDoRetrato["logs"], agora: number) => ({ ...entrada(office, agora), logs });
    let r = montarRetrato(comLog({ ana: [abre] }, AGORA), memoriaInicial(AGORA));
    const sub = r.snapshot.agents.find((a) => a.kind === "sub")!;
    expect(sub).toMatchObject({ id: "ana::s1", parentId: "ana", status: "working", roomId: "estudio" });
    // Terminou: `done` (o motor entrega ao pai); some depois do prazo.
    r = montarRetrato(comLog({ ana: [abre, fecha] }, AGORA + 5_000), r.memoria);
    expect(r.snapshot.agents.find((a) => a.id === "ana::s1")).toMatchObject({ status: "done", parentId: "ana" });
    r = montarRetrato(comLog({ ana: [abre, fecha] }, AGORA + 60_000), r.memoria);
    expect(r.snapshot.agents.find((a) => a.id === "ana::s1")).toBeUndefined();
  });
});
