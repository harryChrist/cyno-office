import type { AgentTerminalInfo, ForYouItem, OfficeState, Project, Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { makeAgent, makeRoom, makeTask } from "../../test-fixtures";
import { ALARME_MS, calcularEfeitos, ERRO_DE_TERMINAL_MS, FESTA_MS, memoriaDeEfeitosVazia, memoriaInicial, montarRetrato, type EntradaDeEfeitos, type EntradaDoRetrato, type MemoriaDaCena } from "@cyno/shared/cena";

const AGORA = Date.parse("2026-11-12T12:00:00.000Z");
const iso = (ms: number) => new Date(AGORA + ms).toISOString();

function escritorio(tarefas: Task[] = []): OfficeState {
  return {
    rooms: [makeRoom("estudio", { name: "Estúdio", gridPosition: { x: 0, y: 0 } }), makeRoom("lab", { name: "Lab", gridPosition: { x: 1, y: 0 } }), makeRoom("maestro", { kind: "maestro", name: "Sala do Maestro", gridPosition: { x: 5, y: 5 } })],
    teams: [
      { id: "gerencia", roomId: "maestro", name: "Gerência", focus: "" },
      { id: "texto", roomId: "estudio", name: "Texto", focus: "" },
      { id: "dados", roomId: "lab", name: "Dados", focus: "" },
    ],
    agents: [makeAgent("maestro-1", "gerencia"), makeAgent("ana", "texto"), makeAgent("beto", "dados")],
    tasks: tarefas,
  };
}

const projeto = (status: Project["status"], extra: Partial<Project> = {}): Project =>
  ({
    id: "p1",
    kind: "projeto",
    title: "Lançamento",
    origin: "usuario",
    status,
    version: 1,
    tasks: [
      { ref: "T1", title: "Texto", ownerId: "ana", sprintId: "S1" },
      { ref: "T2", title: "Dados", ownerId: "beto", sprintId: "S2" },
    ],
    sprints: [
      { id: "S1", name: "Sprint 1 · Texto", status: "fechando" },
      { id: "S2", name: "Sprint 2", status: "ativa" },
    ],
    ...extra,
  }) as unknown as Project;

const sprint = (status: ForYouItem["status"]): ForYouItem => ({ id: "A-1", agentId: "ana", roomId: "estudio", type: "post", kind: "sprint", projectId: "p1", sprintId: "S1", status, meta: {}, text: "", originalText: "", editedByUser: false }) as ForYouItem;

const terminal = (status: AgentTerminalInfo["status"], updatedAt: string): AgentTerminalInfo => ({ agentId: "beto", engine: "claude", status, updatedAt });

function entrada(office: OfficeState, extra: Partial<EntradaDoRetrato> = {}): EntradaDoRetrato {
  return { workspaceId: "ws", workspaceName: "WS", office, progress: {}, forYou: [], projects: [], terminals: {}, logs: {}, indisponiveis: {}, agora: AGORA, ...extra };
}

/** Roda os retratos em sequência, passando a memória adiante; devolve o efeito de cada sala no último. */
function sequencia(passos: Array<Partial<EntradaDoRetrato> & { office: OfficeState }>) {
  let memoria: MemoriaDaCena = memoriaInicial(AGORA);
  let ultimo = montarRetrato(entrada(passos[0]!.office, passos[0]), memoria);
  memoria = ultimo.memoria;
  const historico = [ultimo];
  for (const passo of passos.slice(1)) {
    ultimo = montarRetrato(entrada(passo.office, passo), memoria);
    memoria = ultimo.memoria;
    historico.push(ultimo);
  }
  const efeitoDe = (i: number, sala: string) => historico[i]!.snapshot.rooms.find((r) => r.id === sala)?.effect;
  return { historico, efeitoDe };
}

describe("festa e alarme por eventos do Cyno", () => {
  it("sprint aprovada: festa de 12 s nas salas de quem tinha tarefa nela, uma vez; a carga inicial não comemora", () => {
    const office = escritorio();
    const projetos = [projeto("ativo")];
    const { efeitoDe } = sequencia([
      { office, projects: projetos, forYou: [sprint("pendente")] },
      { office, projects: projetos, forYou: [sprint("aprovado")], agora: AGORA + 1_000 },
      { office, projects: projetos, forYou: [sprint("aprovado")], agora: AGORA + 2_000 },
      { office, projects: projetos, forYou: [sprint("aprovado")], agora: AGORA + FESTA_MS + 5_000 },
    ]);
    expect(efeitoDe(0, "estudio")).toBeUndefined();
    expect(efeitoDe(1, "estudio")).toMatchObject({ kind: "party", text: "Sprint 1 · Texto entregue!", at: AGORA + 1_000, until: AGORA + 1_000 + FESTA_MS, agentId: "ana" });
    expect(efeitoDe(1, "lab")).toBeUndefined();
    // Mesmo efeito (mesmo `at`): o motor não dispara de novo.
    expect(efeitoDe(2, "estudio")?.at).toBe(AGORA + 1_000);
    expect(efeitoDe(3, "estudio")).toBeUndefined();
  });

  it("já aprovada na carga inicial (ou depois de recarregar) não faz festa", () => {
    const office = escritorio();
    const { efeitoDe } = sequencia([{ office, projects: [projeto("concluido")], forYou: [sprint("aprovado")] }]);
    expect(efeitoDe(0, "estudio")).toBeUndefined();
    expect(efeitoDe(0, "lab")).toBeUndefined();
  });

  it("projeto concluído: festa nas salas dos donos das tarefas", () => {
    const office = escritorio();
    const { efeitoDe } = sequencia([
      { office, projects: [projeto("ativo")] },
      { office, projects: [projeto("concluido")], agora: AGORA + 500 },
    ]);
    expect(efeitoDe(1, "estudio")).toMatchObject({ kind: "party", text: "Projeto Lançamento concluído!" });
    expect(efeitoDe(1, "lab")).toMatchObject({ kind: "party" });
    expect(efeitoDe(1, "maestro")).toBeUndefined();
  });

  it("meta de rotina batida: festa na sala do dono, uma vez por meta e período; já batida na carga inicial não comemora", () => {
    const office = escritorio();
    const meta = { key: "R-0001:2026-W46", title: "Convites", agentId: "ana" };
    const { efeitoDe } = sequencia([
      { office },
      { office, metasBatidas: [meta], agora: AGORA + 1_000 },
      { office, metasBatidas: [meta], agora: AGORA + 2_000 },
    ]);
    expect(efeitoDe(0, "estudio")).toBeUndefined();
    expect(efeitoDe(1, "estudio")).toMatchObject({ kind: "party", text: "Meta batida: Convites!", at: AGORA + 1_000, agentId: "ana" });
    expect(efeitoDe(2, "estudio")?.at).toBe(AGORA + 1_000);
    expect(efeitoDe(1, "lab")).toBeUndefined();
    // Já na primeira leitura (recarregou a página): sem festa.
    expect(sequencia([{ office, metasBatidas: [meta] }]).efeitoDe(0, "estudio")).toBeUndefined();
  });

  it("tarefa que falhou: alarme na sala do agente até concluir uma tarefa ali; cancelada não conta", () => {
    const rodando = escritorio([makeTask("t1", { agentId: "ana", teamId: "texto", roomId: "estudio", prompt: "Escrever o post", status: "in_progress" })]);
    const falhou = escritorio([makeTask("t1", { agentId: "ana", teamId: "texto", roomId: "estudio", prompt: "Escrever o post", status: "failed" })]);
    const cancelada = escritorio([makeTask("t1", { agentId: "ana", teamId: "texto", roomId: "estudio", prompt: "Escrever o post", status: "failed", outcome: "cancelled" })]);
    const concluida = escritorio([
      makeTask("t1", { agentId: "ana", teamId: "texto", roomId: "estudio", prompt: "Escrever o post", status: "failed" }),
      makeTask("t2", { agentId: "ana", teamId: "texto", roomId: "estudio", prompt: "Outra", status: "done" }),
    ]);
    const emAndamento2 = escritorio([...falhou.tasks, makeTask("t2", { agentId: "ana", teamId: "texto", roomId: "estudio", prompt: "Outra", status: "in_progress" })]);

    const comAlarme = sequencia([{ office: rodando }, { office: falhou, agora: AGORA + 1_000 }, { office: falhou, agora: AGORA + 60_000 }]);
    expect(comAlarme.efeitoDe(1, "estudio")).toMatchObject({ kind: "alarm", text: "Falhou: Escrever o post", agentId: "ana", at: AGORA + 1_000 });
    expect(comAlarme.efeitoDe(2, "estudio")?.at).toBe(AGORA + 1_000);
    expect(comAlarme.efeitoDe(1, "lab")).toBeUndefined();

    expect(sequencia([{ office: rodando }, { office: cancelada, agora: AGORA + 1_000 }]).efeitoDe(1, "estudio")).toBeUndefined();
    expect(sequencia([{ office: falhou }]).efeitoDe(0, "estudio")).toBeUndefined();

    const apagado = sequencia([{ office: rodando }, { office: falhou, agora: AGORA + 1_000 }, { office: emAndamento2, agora: AGORA + 2_000 }, { office: concluida, agora: AGORA + 3_000 }]);
    expect(apagado.efeitoDe(2, "estudio")?.kind).toBe("alarm");
    expect(apagado.efeitoDe(3, "estudio")).toBeUndefined();

    const expira = sequencia([{ office: rodando }, { office: falhou, agora: AGORA + 1_000 }, { office: falhou, agora: AGORA + ALARME_MS + 2_000 }]);
    expect(expira.efeitoDe(2, "estudio")).toBeUndefined();
  });

  it("terminal com erro há mais de 2 min: alarme (vale já na carga); some quando normaliza", () => {
    const office = escritorio();
    const curto = sequencia([{ office, terminals: { beto: terminal("error", iso(-30_000)) } }]);
    expect(curto.efeitoDe(0, "lab")).toBeUndefined();
    const longo = sequencia([
      { office, terminals: { beto: terminal("error", iso(-ERRO_DE_TERMINAL_MS - 5_000)) } },
      { office, terminals: { beto: terminal("error", iso(-ERRO_DE_TERMINAL_MS - 5_000)) }, agora: AGORA + 10_000 },
      { office, terminals: { beto: terminal("idle", iso(0)) }, agora: AGORA + 20_000 },
    ]);
    expect(longo.efeitoDe(0, "lab")).toMatchObject({ kind: "alarm", text: expect.stringContaining("Terminal com erro"), agentId: "beto" });
    expect(longo.efeitoDe(1, "lab")).toEqual(longo.efeitoDe(0, "lab"));
    expect(longo.efeitoDe(2, "lab")).toBeUndefined();
  });

  it("função pura: a memória de entrada não é mutada", () => {
    const memoria = memoriaDeEfeitosVazia();
    const entradaDe: EntradaDeEfeitos = { office: escritorio(), forYou: [sprint("pendente")], projects: [projeto("ativo")], terminals: {}, tarefasAntes: new Map(), primeira: true, agora: AGORA };
    const saida = calcularEfeitos(entradaDe, memoria);
    expect(memoria.forYouVistos.size).toBe(0);
    expect(saida.memoria.forYouVistos.get("A-1")).toBe("pendente");
  });
});
