import type { Agent, AgentLogEntry, AgentTerminalInfo, ForYouItem, OfficeState, Project, Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { makeAgent, makeLogEntry, makeRoom, makeTask } from "../../test-fixtures";
import { avatarParaPartes, ferramentaEmUso, sementeDaSala, tipoDaFerramenta, memoriaDeJson, memoriaInicial, memoriaParaJson, montarRetrato, SALA_DESCONHECIDA, textoDeProgresso, type EntradaDoRetrato, type MemoriaDaCena } from "@cyno/shared/cena";

const AGORA = Date.parse("2026-11-12T12:00:00.000Z");
const iso = (deslocamentoMs: number) => new Date(AGORA + deslocamentoMs).toISOString();

/** Escritório de teste: sala do Maestro + "estudio" (times Texto e Video) + "vazia" (sem agentes). */
function escritorio(extra: { agentes?: Agent[]; tarefas?: Task[] } = {}): OfficeState {
  return {
    rooms: [
      makeRoom("estudio", { name: "Estúdio", gridPosition: { x: 0, y: 0 } }),
      makeRoom("vazia", { name: "Sala vazia", gridPosition: { x: 1, y: 0 }, theme: "ocean" }),
      makeRoom("maestro", { kind: "maestro", name: "Sala do Maestro", gridPosition: { x: 5, y: 5 } }),
    ],
    teams: [
      { id: "gerencia", roomId: "maestro", name: "Gerência", focus: "" },
      { id: "texto", roomId: "estudio", name: "Texto", focus: "" },
      { id: "video", roomId: "estudio", name: "Vídeo", focus: "" },
    ],
    agents: extra.agentes ?? [makeAgent("maestro-1", "gerencia", { name: "Maestro" }), makeAgent("ana", "texto"), makeAgent("beto", "video")],
    tasks: extra.tarefas ?? [],
  };
}

function entrada(office: OfficeState, extra: Partial<EntradaDoRetrato> = {}): EntradaDoRetrato {
  return { workspaceId: "ws", workspaceName: "WS", office, progress: {}, forYou: [], projects: [], terminals: {}, logs: {}, indisponiveis: {}, agora: AGORA, ...extra };
}

const retratar = (office: OfficeState, extra: Partial<EntradaDoRetrato> = {}, memoria: MemoriaDaCena = memoriaInicial(AGORA)) => montarRetrato(entrada(office, extra), memoria);
const agenteDe = (office: OfficeState, id: string, extra: Partial<EntradaDoRetrato> = {}, memoria?: MemoriaDaCena) => retratar(office, extra, memoria).snapshot.agents.find((a) => a.id === id);

const terminal = (agentId: string, status: AgentTerminalInfo["status"], extra: Partial<AgentTerminalInfo> = {}): AgentTerminalInfo => ({ agentId, engine: "claude", status, updatedAt: iso(0), ...extra });
const comMotor = (id: string, teamId: string, engine: Agent["engine"] = "claude") => makeAgent(id, teamId, { engine });

function pendente(agentId: string, extra: Partial<ForYouItem> = {}): ForYouItem {
  return { id: "A-0001", agentId, roomId: "estudio", type: "post", status: "pendente", meta: {}, text: "", originalText: "", editedByUser: false, ...extra } as ForYouItem;
}

describe("montarRetrato: estados (tabela 2.3)", () => {
  const ana = (agente: Partial<Agent> = {}) => escritorio({ agentes: [makeAgent("maestro-1", "gerencia"), makeAgent("ana", "texto", agente)] });

  const casos: Array<{ nome: string; office: OfficeState; extra: Partial<EntradaDoRetrato>; status: string; waitingFor?: RegExp; shell?: RegExp }> = [
    { nome: "trabalhando (agent.status working)", office: ana({ status: "working" }), extra: {}, status: "working" },
    { nome: "terminal ocupado (busy)", office: ana({ engine: "claude" }), extra: { terminals: { ana: terminal("ana", "busy") } }, status: "working" },
    { nome: "conversando com o dono", office: ana({ engine: "claude" }), extra: { terminals: { ana: terminal("ana", "idle", { chatting: true }) } }, status: "working" },
    { nome: "parado (terminal ligado e sem tarefa)", office: ana({ engine: "claude" }), extra: { terminals: { ana: terminal("ana", "idle") } }, status: "idle" },
    { nome: "parado (agente simulado)", office: ana(), extra: {}, status: "idle" },
    { nome: "concluiu (agent.status done) vira idle", office: ana({ status: "done" }), extra: {}, status: "idle" },
    { nome: "esperando a aprovação (agent.status)", office: ana({ status: "waiting_approval" }), extra: {}, status: "waiting", waitingFor: /aprovar/ },
    { nome: "esperando a aprovação (item do Para você)", office: ana(), extra: { forYou: [pendente("ana", { title: "Post sobre o lançamento" })] }, status: "waiting", waitingFor: /Post sobre o lançamento/ },
    { nome: "alerta aberto da cadeia de atenção (pergunta)", office: ana(), extra: { atencao: new Map([["ana", { kind: "question" as const, count: 1 }]]) }, status: "waiting", waitingFor: /responder uma pergunta/ },
    { nome: "terminal com erro", office: ana({ engine: "claude" }), extra: { terminals: { ana: terminal("ana", "error", { error: "spawn agy ENOENT" }) } }, status: "waiting", waitingFor: /terminal com erro: comando agy não encontrado/ },
    { nome: "sem cota", office: ana({ engine: "gemini" }), extra: { indisponiveis: { ana: { label: "sem cota · volta às 14:30" } }, terminals: { ana: terminal("ana", "stopped", { engine: "gemini" }) } }, status: "shell", shell: /Sem cota · volta às 14:30/ },
    { nome: "sem cota com turno em curso continua trabalhando", office: ana({ engine: "gemini", status: "working" }), extra: { indisponiveis: { ana: { label: "sem cota" } }, terminals: { ana: terminal("ana", "busy", { engine: "gemini" }) } }, status: "working" },
    { nome: "terminal dormindo por ociosidade: continua no escritório, à toa", office: ana({ engine: "claude" }), extra: { terminals: { ana: terminal("ana", "stopped", { everStarted: true, stoppedReason: "Parado por ociosidade" }) } }, status: "idle" },
  ];

  it.each(casos)("$nome -> $status", ({ office, extra, status, waitingFor, shell }) => {
    // A memória do caso diz que a Ana já estava presente.
    const memoria: MemoriaDaCena = { ...memoriaInicial(AGORA), presentes: new Set(["ana"]) };
    const a = agenteDe(office, "ana", extra, memoria);
    expect(a?.status).toBe(status);
    if (waitingFor) expect(a?.waitingFor).toMatch(waitingFor);
    if (shell) expect(a?.shells?.[0]?.label).toMatch(shell);
    if (status === "waiting") expect(a?.activity?.kind).toBe("ask");
  });

  it("carga a frio: quem estava com o terminal dormindo também entra no escritório (idle), sem ninguém sumir", () => {
    const office = ana({ engine: "claude" });
    const retrato = retratar(office, { terminals: { ana: terminal("ana", "stopped", { everStarted: true, stoppedReason: "Parado por ociosidade" }) } });
    expect(retrato.snapshot.agents.map((a) => [a.id, a.status])).toEqual([["maestro-1", "idle"], ["ana", "idle"]]);
  });

  it("o terminal que dorme e depois acorda não faz o agente sair: o status só volta a working", () => {
    const office = ana({ engine: "claude" });
    const dormindo = retratar(office, { terminals: { ana: terminal("ana", "stopped", { everStarted: true }) } });
    expect(dormindo.snapshot.agents.find((a) => a.id === "ana")?.status).toBe("idle");
    const acordou = montarRetrato(entrada(office, { terminals: { ana: terminal("ana", "busy") }, agora: AGORA + 5_000 }), dormindo.memoria);
    expect(acordou.snapshot.agents.find((a) => a.id === "ana")?.status).toBe("working");
  });

  it("agente removido do escritório deixa de estar no retrato (o motor o leva pelo elevador)", () => {
    const com = retratar(ana({ engine: "claude" }));
    const sem = montarRetrato(entrada(escritorio({ agentes: [makeAgent("maestro-1", "gerencia")] }), { agora: AGORA + 5_000 }), com.memoria);
    expect(sem.snapshot.agents.map((a) => a.id)).toEqual(["maestro-1"]);
  });

  it("terminal criado e nunca iniciado é parado (idle), não offline", () => {
    const a = agenteDe(ana({ engine: "claude" }), "ana", { terminals: { ana: terminal("ana", "stopped", { everStarted: false }) } });
    expect(a?.status).toBe("idle");
  });

  it("o Maestro nunca fica offline por terminal desligado", () => {
    const office = escritorio({ agentes: [makeAgent("maestro-1", "gerencia", { engine: "claude" })] });
    const a = agenteDe(office, "maestro-1", { terminals: { "maestro-1": terminal("maestro-1", "stopped", { everStarted: true }) } });
    expect(a?.status).toBe("idle");
  });

  it("terminal desligado com tarefa ativa não é offline", () => {
    const office = ana({ engine: "claude" });
    office.tasks = [makeTask("t1", { agentId: "ana", roomId: "estudio", teamId: "texto", status: "in_progress" })];
    const a = agenteDe(office, "ana", { terminals: { ana: terminal("ana", "stopped", { everStarted: true }) } }, { ...memoriaInicial(AGORA), presentes: new Set(["ana"]) });
    expect(a?.status).not.toBe("offline");
  });

  it("projeto parado por pedido de ajuda: espera com as brincadeiras (shell)", () => {
    const projeto = { id: "p1", tasks: [{ ref: "T1", ownerId: "ana", status: "em_andamento", blocked: { type: "agente", note: "preciso de acesso", since: iso(-120_000) } }] } as unknown as Project;
    const a = agenteDe(ana(), "ana", { projects: [projeto] });
    expect(a?.status).toBe("shell");
    expect(a?.shells?.[0]).toMatchObject({ label: "Esperando o Maestro", startedAt: AGORA - 120_000 });
  });

  it("projeto parado esperando acesso", () => {
    const projeto = { id: "p1", tasks: [{ ref: "T1", ownerId: "ana", status: "em_andamento", blocked: { type: "acesso", note: "Instagram", since: iso(-1000) } }] } as unknown as Project;
    expect(agenteDe(ana(), "ana", { projects: [projeto] })?.shells?.[0]?.label).toBe("Esperando acesso: Instagram");
  });

  it("projeto concluído com bloqueio antigo não conta", () => {
    const projeto = { id: "p1", tasks: [{ ref: "T1", ownerId: "ana", status: "concluida", blocked: { type: "agente", note: "x", since: iso(-1000) } }] } as unknown as Project;
    expect(agenteDe(ana(), "ana", { projects: [projeto] })?.status).toBe("idle");
  });

  it("o Maestro com o pedido nas mãos de um time e terminal ocioso espera o time (shell)", () => {
    const office = escritorio({
      agentes: [makeAgent("maestro-1", "gerencia", { engine: "claude" }), makeAgent("ana", "texto")],
      tarefas: [
        makeTask("r1", { agentId: "maestro-1", roomId: "maestro", teamId: "gerencia", role: "request", status: "in_progress" }),
        makeTask("s1", { agentId: "ana", roomId: "estudio", teamId: "texto", projectId: "r1", status: "queued" }),
      ],
    });
    const a = agenteDe(office, "maestro-1", { terminals: { "maestro-1": terminal("maestro-1", "idle") } });
    expect(a?.status).toBe("shell");
    expect(a?.shells?.[0]?.label).toBe("Esperando o time Texto");
  });

  it("a prioridade da tabela vale: erro de terminal vence aprovação pendente", () => {
    const a = agenteDe(ana({ engine: "claude", status: "waiting_approval" }), "ana", { terminals: { ana: terminal("ana", "error", { error: "caiu" }) } });
    expect(a?.waitingFor).toMatch(/^terminal com erro/);
  });
});

describe("montarRetrato: salas, mesas e identidade", () => {
  it("a placa da sala mostra quantos itens esperam o dono ali", () => {
    const atencao = new Map([["ana", { kind: "approval" as const, count: 2 }], ["beto", { kind: "question" as const, count: 1 }]]);
    const { snapshot } = retratar(escritorio(), { atencao });
    expect(snapshot.rooms.find((r) => r.id === "estudio")?.name).toBe("Estúdio · 3 esperam");
    expect(snapshot.rooms.find((r) => r.id === "vazia")?.name).toBe("Sala vazia");
    expect(snapshot.agents.find((a) => a.id === "beto")?.status).toBe("waiting");
  });

  it("a Sala do Maestro é a primeira vaga, depois por linha e coluna; sala vazia aparece", () => {
    const { snapshot } = retratar(escritorio());
    expect(snapshot.rooms.map((r) => r.id)).toEqual(["maestro", "estudio", "vazia"]);
    expect(snapshot.rooms.map((r) => r.slot)).toEqual([0, 1, 2]);
    expect(snapshot.rooms[0]?.name).toBe("Maestro");
    expect(snapshot.rooms[1]?.path).toBe("ws/estudio");
    expect(snapshot.agents.filter((a) => a.roomId === "vazia")).toEqual([]);
  });

  it("a semente da sala escolhe o tema do motor (seed % 10) e é estável", () => {
    const { snapshot } = retratar(escritorio());
    expect(snapshot.rooms.find((r) => r.id === "vazia")!.seed % 10).toBe(8);
    expect(snapshot.rooms.find((r) => r.id === "estudio")!.seed % 10).toBe(2);
    expect(sementeDaSala({ id: "x", theme: "mint" })).toBe(sementeDaSala({ id: "x", theme: "mint" }));
    expect(sementeDaSala({ id: "x", theme: "mint", layoutSeed: 7 })).not.toBe(sementeDaSala({ id: "x", theme: "mint", layoutSeed: 8 }));
  });

  it("as mesas seguem a ordem dos times na sala, com o líder primeiro e a chegada como desempate", () => {
    const office = escritorio({
      agentes: [makeAgent("maestro-1", "gerencia"), makeAgent("v1", "video"), makeAgent("t1", "texto"), makeAgent("t2", "texto"), makeAgent("t3", "texto")],
    });
    office.teams = office.teams.map((t) => (t.id === "texto" ? { ...t, leadAgentId: "t3" } : t));
    const ids = retratar(office).snapshot.agents.map((a) => a.id);
    expect(ids).toEqual(["maestro-1", "t3", "t1", "t2", "v1"]);
  });

  it("agente sem sala (time inexistente) vai para a recepção ('?') no fim", () => {
    const office = escritorio({ agentes: [makeAgent("maestro-1", "gerencia"), makeAgent("orfao", "time-que-sumiu"), makeAgent("ana", "texto")] });
    const { snapshot } = retratar(office);
    expect(snapshot.agents.map((a) => a.id)).toEqual(["maestro-1", "ana", "orfao"]);
    expect(snapshot.agents.at(-1)?.roomId).toBe(SALA_DESCONHECIDA);
  });

  it("o Maestro tem papel e visual fixos; os outros usam o avatar", () => {
    const { snapshot } = retratar(escritorio());
    const maestro = snapshot.agents.find((a) => a.id === "maestro-1")!;
    expect(maestro.role).toBe("Maestro");
    expect(maestro.parts).toMatchObject({ top: "#1f2a44", topStyle: "shirt_tie", accessory: "headphones" });
    const ana = snapshot.agents.find((a) => a.id === "ana")!;
    expect(ana.parts).toEqual(avatarParaPartes(ana.id === "ana" ? makeAgent("ana", "texto").avatar : makeAgent("x", "y").avatar));
    expect(ana.role).toBe("Testador");
    expect(ana.look).toBe("f");
  });

  it("avatarParaPartes: cores da paleta em hex, acessório 'scarf' vira nenhum, 'earring' vira 'earrings'", () => {
    expect(avatarParaPartes({ skin: "tone2", hair: "mohawk", hairColor: "ink", shirt: "mint", pants: "navy", accessory: "scarf" })).toMatchObject({ skin: "#f2c6a0", hairStyle: "mohawk", hair: "#1c1522", accessory: "none" });
    expect(avatarParaPartes({ skin: "tone1", hair: "short", hairColor: "wood", shirt: "wine", pants: "denim", accessory: "earring" }).accessory).toBe("earrings");
  });

  it("workspace sem nenhum agente: só as salas, sem erro", () => {
    const office = escritorio({ agentes: [] });
    const { snapshot } = retratar(office);
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.accounts).toEqual([]);
    expect(snapshot.rooms).toHaveLength(3);
  });

  it("26 agentes numa sala: todos entram, na ordem e com ids distintos", () => {
    const agentes = Array.from({ length: 26 }, (_, i) => makeAgent(`a${String(i).padStart(2, "0")}`, "texto"));
    const { snapshot } = retratar(escritorio({ agentes: [makeAgent("maestro-1", "gerencia"), ...agentes] }));
    const doEstudio = snapshot.agents.filter((a) => a.roomId === "estudio");
    expect(doEstudio).toHaveLength(26);
    expect(new Set(doEstudio.map((a) => a.id)).size).toBe(26);
    expect(doEstudio.map((a) => a.id)).toEqual(agentes.map((a) => a.id));
  });

  it("contas: um item por motor presente, com a contagem de agentes", () => {
    const office = escritorio({ agentes: [makeAgent("maestro-1", "gerencia", { engine: "claude" }), comMotor("ana", "texto", "gemini"), comMotor("bia", "texto", "gemini"), makeAgent("caio", "video")] });
    const contas = retratar(office).snapshot.accounts;
    expect(contas.map((c) => [c.id, c.short, c.name, c.sessions])).toEqual([
      ["claude", "C", "Claude Code", 1],
      ["gemini", "A", "Antigravity", 2],
      ["mock", "S", "Simulado", 1],
    ]);
  });
});

describe("montarRetrato: atividade, tarefas e tempo", () => {
  const comTarefa = (status: Task["status"] = "in_progress", extra: Partial<Task> = {}): OfficeState =>
    escritorio({
      agentes: [makeAgent("maestro-1", "gerencia"), makeAgent("ana", "texto", { status: "working" })],
      tarefas: [makeTask("t1", { agentId: "ana", roomId: "estudio", teamId: "texto", prompt: "Escrever o post\nsegunda linha", status, updatedAt: iso(-90_000), ...extra })],
    });

  it("a frase é o texto de progresso do Cyno, com o %; sem progresso, o título da tarefa", () => {
    const office = comTarefa();
    const com = agenteDe(office, "ana", { progress: { t1: { agentId: "ana", progress: 0.4, message: "Pesquisando referências" } } });
    expect(com?.activity?.text).toBe("Pesquisando referências · 40%");
    const sem = agenteDe(office, "ana");
    expect(sem?.activity?.text).toBe("Trabalhando em «Escrever o post»");
    expect(sem?.title).toBe("Escrever o post");
    expect(textoDeProgresso(undefined, undefined).texto).toBe("Trabalhando");
  });

  describe("a frase da ferramenta em uso", () => {
    const ferramenta = (id: string, name: string, input: Record<string, unknown>, status: "running" | "ok" | "error", em: number, extra: Partial<AgentLogEntry> = {}) =>
      makeLogEntry(`f-${id}`, { kind: "tool", toolUseId: id, name, summary: "", input, status }, { agentId: "ana", taskId: "t1", at: iso(em), ...extra });

    it("ferramenta rodando vira a frase do balão (ícone, texto, tipo e nome bruto), no lugar do progresso", () => {
      const office = comTarefa();
      const logs = { ana: [ferramenta("u1", "Read", { file_path: "/x/package.json" }, "running", -1_000)] };
      const a = agenteDe(office, "ana", { logs, progress: { t1: { agentId: "ana", progress: 0.4, message: "Pesquisando" } } });
      expect(a?.activity).toMatchObject({ text: "Lendo package.json", icon: "📖", kind: "read", tool: "Read", at: AGORA - 1_000, id: "tool:u1" });
    });

    it("sem ferramenta, cai no progresso; ferramenta de subagente não conta; ferramenta velha também não", () => {
      const office = comTarefa();
      const progress = { t1: { agentId: "ana", progress: 0.4, message: "Pesquisando" } };
      expect(agenteDe(office, "ana", { progress })?.activity?.text).toBe("Pesquisando · 40%");
      const doSub = { ana: [ferramenta("u2", "Read", { file_path: "a.ts" }, "running", -1_000, { thread: "sub-1" })] };
      expect(agenteDe(office, "ana", { progress, logs: doSub })?.activity?.text).toBe("Pesquisando · 40%");
      const velha = { ana: [ferramenta("u3", "Read", { file_path: "a.ts" }, "ok", -60_000)] };
      expect(agenteDe(office, "ana", { progress, logs: velha })?.activity?.text).toBe("Pesquisando · 40%");
    });

    it("a ferramenta que acabou há pouco ainda dá a frase (o balão não pisca)", () => {
      const log = [ferramenta("u4", "Bash", { command: "npm test" }, "ok", -2_000)];
      expect(ferramentaEmUso(log, AGORA)?.kind).toBe("run");
      expect(ferramentaEmUso(undefined, AGORA)).toBeUndefined();
    });

    it("tipos por nome de ferramenta", () => {
      expect(tipoDaFerramenta("Grep")).toBe("search");
      expect(tipoDaFerramenta("Edit")).toBe("edit");
      expect(tipoDaFerramenta("WebFetch")).toBe("web");
      expect(tipoDaFerramenta("mcp__cyno_browser__navigate")).toBe("browser");
      expect(tipoDaFerramenta("mcp__cyno__send_to_colleague")).toBe("communicate");
      expect(tipoDaFerramenta("TodoWrite")).toBe("plan");
      expect(tipoDaFerramenta("Coisa")).toBe("other");
    });
  });

  it("statusSince vem do updatedAt da tarefa ativa na primeira vez e não anda entre chamadas", () => {
    const office = comTarefa();
    const primeiro = retratar(office);
    expect(primeiro.snapshot.agents.find((a) => a.id === "ana")?.statusSince).toBe(AGORA - 90_000);
    const depois = montarRetrato(entrada(office, { agora: AGORA + 60_000 }), primeiro.memoria);
    expect(depois.snapshot.agents.find((a) => a.id === "ana")?.statusSince).toBe(AGORA - 90_000);
  });

  it("o quadro da parede: ativas primeiro, concluídas das últimas 24 h, falha vira concluída, cancelada fora, pedido do Maestro fora", () => {
    const office = escritorio({
      agentes: [makeAgent("maestro-1", "gerencia"), makeAgent("ana", "texto")],
      tarefas: [
        makeTask("velha", { status: "done", updatedAt: iso(-3 * 86_400_000) }),
        makeTask("feita", { status: "done", updatedAt: iso(-3_600_000) }),
        makeTask("falhou", { status: "failed", updatedAt: iso(-3_600_000) }),
        makeTask("cancelada", { status: "failed", outcome: "cancelled", updatedAt: iso(-3_600_000) }),
        makeTask("fila", { status: "queued" }),
        makeTask("andando", { status: "in_progress" }),
        makeTask("pedido", { role: "request", status: "in_progress" }),
      ],
    });
    const tasks = agenteDe(office, "ana")!.tasks;
    expect(tasks.map((t) => [t.id, t.status])).toEqual([
      ["andando", "in_progress"],
      ["fila", "pending"],
      ["feita", "completed"],
      ["falhou", "completed"],
    ]);
  });

  it("no máximo 15 tarefas no quadro", () => {
    const tarefas = Array.from({ length: 20 }, (_, i) => makeTask(`t${i}`, { status: "queued" }));
    expect(agenteDe(escritorio({ agentes: [makeAgent("maestro-1", "gerencia"), makeAgent("ana", "texto")], tarefas }), "ana")!.tasks).toHaveLength(15);
  });

  it("tarefa que conclui entre dois retratos mostra 'Concluiu' por um tempo; a carga inicial não comemora", () => {
    const antes = comTarefa("in_progress");
    const primeiro = retratar(antes);
    expect(primeiro.snapshot.agents.find((a) => a.id === "ana")?.activity?.kind).not.toBe("done");
    const feito = comTarefa("done");
    feito.agents = feito.agents.map((a) => (a.id === "ana" ? { ...a, status: "idle" as const } : a));
    const depois = montarRetrato(entrada(feito, { agora: AGORA + 1000 }), primeiro.memoria);
    expect(depois.snapshot.agents.find((a) => a.id === "ana")?.activity).toMatchObject({ kind: "done", id: "done:t1" });
    const muitoDepois = montarRetrato(entrada(feito, { agora: AGORA + 20_000 }), depois.memoria);
    expect(muitoDepois.snapshot.agents.find((a) => a.id === "ana")?.activity).toBeUndefined();
    // carga fria já com a tarefa concluída: nada de festa
    expect(retratar(feito).snapshot.agents.find((a) => a.id === "ana")?.activity).toBeUndefined();
  });

  it("tarefa que falhou mostra 'Falhou'; cancelada não", () => {
    const primeiro = retratar(comTarefa("in_progress"));
    const falhou = comTarefa("failed");
    const r = montarRetrato(entrada(falhou, { agora: AGORA + 500 }), primeiro.memoria);
    expect(r.snapshot.agents.find((a) => a.id === "ana")?.activity).toMatchObject({ kind: "error" });
    const cancelada = comTarefa("failed", { outcome: "cancelled" });
    const c = montarRetrato(entrada(cancelada, { agora: AGORA + 500 }), primeiro.memoria);
    expect(c.snapshot.agents.find((a) => a.id === "ana")?.activity?.kind).not.toBe("error");
  });
});

describe("montarRetrato: subagentes", () => {
  const log = (entradas: AgentLogEntry[]) => ({ ana: entradas });
  const abre = (id: string, label: string) => makeLogEntry(`e-${id}-1`, { kind: "subagent", phase: "started", subagentId: id, label, goal: `Meta de ${label}` }, { agentId: "ana", taskId: "t1" });
  const fecha = (id: string, label: string) => makeLogEntry(`e-${id}-2`, { kind: "subagent", phase: "finished", subagentId: id, label, status: "ok" }, { agentId: "ana", taskId: "t1" });
  const tarefa = makeTask("t1", { agentId: "ana", roomId: "estudio", teamId: "texto", status: "in_progress" });
  const office = escritorio({ agentes: [makeAgent("maestro-1", "gerencia"), makeAgent("ana", "texto", { status: "working" })], tarefas: [tarefa] });

  it("cada thread rodando vira um personagem com crachá, logo depois do pai", () => {
    const { snapshot } = retratar(office, { logs: log([abre("s1", "Rafa"), abre("s2", "Lia")]) });
    expect(snapshot.agents.map((a) => a.id)).toEqual(["maestro-1", "ana", "ana::s1", "ana::s2"]);
    const sub = snapshot.agents.find((a) => a.id === "ana::s1")!;
    expect(sub).toMatchObject({ kind: "sub", parentId: "ana", roomId: "estudio", status: "working", name: "Rafa", title: "Meta de Rafa", account: "mock" });
    expect(snapshot.agents.find((a) => a.id === "ana")?.stats.subagents).toBe(2);
  });

  it("no máximo 6 por agente; o resto vira '+N' na atividade do pai", () => {
    const entradas = Array.from({ length: 8 }, (_, i) => abre(`s${i}`, `Sub${i}`));
    const { snapshot } = retratar(office, { logs: log(entradas) });
    expect(snapshot.agents.filter((a) => a.kind === "sub")).toHaveLength(6);
    expect(snapshot.agents.find((a) => a.id === "ana")?.activity?.detail).toContain("+2 subagentes");
  });

  it("ao terminar fica `done` por 25 s e depois some", () => {
    const rodando = retratar(office, { logs: log([abre("s1", "Rafa")]) });
    const terminou = montarRetrato(entrada(office, { logs: log([abre("s1", "Rafa"), fecha("s1", "Rafa")]), agora: AGORA + 5_000 }), rodando.memoria);
    expect(terminou.snapshot.agents.find((a) => a.id === "ana::s1")?.status).toBe("done");
    const aindaLa = montarRetrato(entrada(office, { logs: log([abre("s1", "Rafa"), fecha("s1", "Rafa")]), agora: AGORA + 25_000 }), terminou.memoria);
    expect(aindaLa.snapshot.agents.find((a) => a.id === "ana::s1")?.status).toBe("done");
    const sumiu = montarRetrato(entrada(office, { logs: log([abre("s1", "Rafa"), fecha("s1", "Rafa")]), agora: AGORA + 31_000 }), aindaLa.memoria);
    expect(sumiu.snapshot.agents.find((a) => a.id === "ana::s1")).toBeUndefined();
  });

  it("subagente de um agente com o terminal dormindo entra normalmente (o pai está no escritório)", () => {
    const off = escritorio({ agentes: [makeAgent("maestro-1", "gerencia"), comMotor("ana", "texto")] });
    const retrato = retratar(off, { logs: log([abre("s1", "Rafa")]), terminals: { ana: terminal("ana", "stopped", { everStarted: true }) } });
    expect(retrato.snapshot.agents.some((a) => a.kind === "sub")).toBe(true);
  });
});

describe("montarRetrato: estabilidade", () => {
  it("duas chamadas seguidas com o mesmo estado dão o mesmo retrato (fora o número)", () => {
    const office = escritorio();
    const um = retratar(office);
    const dois = montarRetrato(entrada(office), um.memoria);
    const semRev = ({ rev: _rev, ...resto }: typeof um.snapshot) => resto;
    expect(semRev(dois.snapshot)).toEqual(semRev(um.snapshot));
    expect(dois.snapshot.rev).toBe(2);
  });

  it("a memória de chegada esquece agente apagado (e não poda com a lista vazia)", () => {
    const office = escritorio();
    const primeiro = retratar(office);
    const ids = [...primeiro.memoria.primeiraVez.keys()];
    expect(ids.length).toBeGreaterThan(1);
    const semUm = { ...office, agents: office.agents.filter((agente) => agente.id !== ids[0]) };
    const depois = montarRetrato(entrada(semUm), primeiro.memoria);
    expect(depois.memoria.primeiraVez.has(ids[0]!)).toBe(false);
    expect(depois.memoria.primeiraVez.size).toBe(ids.length - 1);
    const vazio = montarRetrato(entrada({ ...office, agents: [] }), primeiro.memoria);
    expect(vazio.memoria.primeiraVez.size).toBe(ids.length);
  });

  it("a memória não é mutada: a mesma memória e a mesma entrada dão o mesmo resultado", () => {
    const memoria = memoriaInicial(AGORA);
    const copia = JSON.stringify([...memoria.primeiraVez]);
    const um = montarRetrato(entrada(escritorio()), memoria);
    const dois = montarRetrato(entrada(escritorio()), memoria);
    expect(dois).toEqual(um);
    expect(JSON.stringify([...memoria.primeiraVez])).toBe(copia);
    expect(memoria.rev).toBe(0);
  });

  it("um agente novo não troca a ordem nem os dados dos outros", () => {
    const antes = retratar(escritorio());
    const novo = escritorio({ agentes: [...escritorio().agents, makeAgent("zoe", "texto")] });
    const depois = montarRetrato(entrada(novo, { agora: AGORA + 5_000 }), antes.memoria);
    const ids = depois.snapshot.agents.map((a) => a.id);
    expect(ids).toEqual(["maestro-1", "ana", "zoe", "beto"]);
    for (const velho of antes.snapshot.agents) expect(depois.snapshot.agents.find((a) => a.id === velho.id)).toEqual(velho);
    expect(depois.snapshot.agents.find((a) => a.id === "zoe")?.startedAt).toBe(AGORA + 5_000);
  });

  it("a recarga com a memória guardada mantém identidades, ordem e horário de chegada", () => {
    const office = escritorio();
    const primeiro = retratar(office);
    const guardado = memoriaParaJson(primeiro.memoria);
    const recarregada = montarRetrato(entrada(office, { agora: AGORA + 3_600_000 }), memoriaDeJson(guardado, AGORA + 3_600_000));
    for (const velho of primeiro.snapshot.agents) {
      const novo = recarregada.snapshot.agents.find((a) => a.id === velho.id)!;
      expect([novo.seed, novo.look, novo.parts, novo.roomId, novo.startedAt]).toEqual([velho.seed, velho.look, velho.parts, velho.roomId, velho.startedAt]);
    }
    expect(recarregada.snapshot.agents.map((a) => a.id)).toEqual(primeiro.snapshot.agents.map((a) => a.id));
    expect(recarregada.snapshot.meta.startedAt).toBe(primeiro.snapshot.meta.startedAt);
  });

  it("memória guardada estragada ou ausente vira memória vazia", () => {
    for (const ruim of [null, "", "{", "[]", '{"v":2}', '{"v":1,"inicio":"x","primeiraVez":{}}']) {
      expect(memoriaDeJson(ruim, AGORA).primeiraVez.size).toBe(0);
      expect(memoriaDeJson(ruim, AGORA).inicio).toBe(AGORA);
    }
  });

  it("a identidade (seed, look) depende só do id do agente, não do momento", () => {
    const a = agenteDe(escritorio(), "ana")!;
    const b = agenteDe(escritorio(), "ana", {}, memoriaInicial(AGORA + 99999))!;
    expect([a.seed, a.look]).toEqual([b.seed, b.look]);
  });
});
