import { APPROVAL_REFUSED_RESULT, legacyForYouLimit as forYouLimit, type Agent, type BrainContext, type Task, type Team, type Room } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { MockRunner, type MockRunnerOptions } from "./mock-runner";
import { mockDraft, recipientOf, SIMULATED_DRAFT_MARK } from "./mock-script";
import type { ApprovalDecision, ApprovalRequest, RunHooks, RunInput, RunnerLogInput, SubagentHooks, ToolResultInput } from "../engines/runner/types";

const context: BrainContext = {
  roomId: "a",
  sources: [
    { kind: "self", id: "a", name: "A", notes: [{ file: "1.md", title: "Um", content: "x" }, { file: "2.md", title: "Dois", content: "y" }] },
    { kind: "lobby", id: "global", name: "Cérebro global", notes: [{ file: "g.md", title: "G", content: "z" }] },
  ],
  text: "",
};

const room: Room = { id: "a", kind: "team", name: "A", theme: "mint", gridPosition: { x: 1, y: 0 }, readsGlobalBrain: true, readsBrainsOf: [] };
const team: Team = { id: "a-time", roomId: "a", name: "Time", focus: "testar" };
const agent: Agent = {
  id: "ana",
  teamId: "a-time",
  name: "Ana",
  role: "Testadora",
  instructions: "",
  avatar: { skin: "tone3", hair: "bun", hairColor: "ink", shirt: "mint", pants: "denim" },
  status: "working",
};

function makeInput(prompt: string, signal = new AbortController().signal): RunInput {
  const at = "2026-11-07T09:00:00.000Z";
  const task: Task = { id: "t1", roomId: "a", teamId: "a-time", agentId: "ana", prompt, status: "in_progress", createdAt: at, updatedAt: at };
  return { task, agent, team, room, context, signal };
}

/** Sequência fixa de "aleatórios" (repete o último). */
const sequence = (...values: number[]) => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
};

function makeRunner(options: Partial<MockRunnerOptions> = {}) {
  const waits: number[] = [];
  const runner = new MockRunner({
    minMs: 3000,
    maxMs: 8000,
    approvalRate: 0,
    random: () => 0,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...options,
  });
  return { runner, waits };
}

/** Tudo o que o runner mandou pelos ganchos, em ordem ("" = o agente; senão, o id do subagente). */
type Trace =
  | { thread: string; type: "log"; entry: RunnerLogInput }
  | { thread: string; type: "toolResult"; toolUseId: string; result: ToolResultInput }
  | { thread: string; type: "progress"; value: number; message: string }
  | { thread: string; type: "subagent"; id: string; label: string }
  | { thread: string; type: "finish"; status: string };

function recordingHooks(decision: boolean | ApprovalDecision = true) {
  const progress: Array<[number, string]> = [];
  const questions: string[] = [];
  const requests: ApprovalRequest[] = [];
  const trace: Trace[] = [];
  let subagents = 0;
  const thread = (name: string) => ({
    log: (entry: RunnerLogInput) => void trace.push({ thread: name, type: "log", entry }),
    toolResult: (toolUseId: string, result: ToolResultInput) => void trace.push({ thread: name, type: "toolResult", toolUseId, result }),
  });
  const hooks: RunHooks = {
    ...thread(""),
    onProgress: (value, message) => {
      progress.push([value, message]);
      trace.push({ thread: "", type: "progress", value, message });
    },
    requestApproval: async (request) => {
      questions.push(request.question);
      requests.push(request);
      return typeof decision === "boolean" ? { approved: decision } : decision;
    },
    subagent: ({ label }): SubagentHooks => {
      const id = `sa-${++subagents}`;
      trace.push({ thread: "", type: "subagent", id, label });
      return {
        id,
        ...thread(id),
        progress: (value, message) => void trace.push({ thread: id, type: "progress", value, message }),
        finish: ({ status }) => void trace.push({ thread: id, type: "finish", status }),
      };
    },
  };
  return { hooks, progress, questions, requests, trace };
}

describe("MockRunner", () => {
  it.each([
    [0, 4],
    [0.5, 5],
    [0.99, 6],
  ])("random %s -> %s passos de progresso até 1, dentro da duração sorteada", async (random, steps) => {
    const { runner, waits } = makeRunner({ random: () => random });
    const { hooks, progress, questions } = recordingHooks();
    const outcome = await runner.run(makeInput("Fazer algo"), hooks);
    expect(outcome.status).toBe("done");
    expect(progress).toHaveLength(steps);
    expect(progress.at(-1)![0]).toBe(1);
    expect(progress.every(([, message]) => message.length > 0 && message.length <= 40)).toBe(true);
    expect(questions).toEqual([]);
    const total = waits.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeGreaterThanOrEqual(3000 - steps);
    expect(total).toBeLessThanOrEqual(8000 + steps);
  });

  it("resultado em markdown cita quantas fontes e notas de contexto recebeu", async () => {
    const { runner } = makeRunner();
    const outcome = await runner.run(makeInput("Resumir"), recordingHooks().hooks);
    expect(outcome.result).toContain("## Resultado (simulado)");
    expect(outcome.result).toContain("2 fontes de contexto com 3 notas");
    expect(outcome.result).toContain("**Pedido:** Resumir");
  });

  it("'[aprovar]' pede aprovação; aprovado -> done", async () => {
    const { runner } = makeRunner();
    const { hooks, questions } = recordingHooks(true);
    const outcome = await runner.run(makeInput("Publicar [aprovar]"), hooks);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("Ana");
    // A UI já põe a mensagem entre “…”: o pedido citado vai entre ‘…’, sem aspas retas aninhadas.
    expect(questions[0]).toMatch(/‘.+’$/);
    expect(questions[0]).not.toContain('"');
    expect(outcome.status).toBe("done");
  });

  it("recusado -> failed com 'Recusado pelo usuário'", async () => {
    const { runner } = makeRunner();
    const outcome = await runner.run(makeInput("Publicar [aprovar]"), recordingHooks(false).hooks);
    expect(outcome).toEqual({ status: "failed", result: APPROVAL_REFUSED_RESULT });
  });

  it("recusado com nota -> a nota vira o motivo", async () => {
    const { runner } = makeRunner();
    const outcome = await runner.run(makeInput("Publicar [aprovar]"), recordingHooks({ approved: false, response: "tom errado" }).hooks);
    expect(outcome).toEqual({ status: "failed", result: `${APPROVAL_REFUSED_RESULT}: tom errado` });
  });

  it("aprovação manda um rascunho simulado e o resultado usa o texto final aprovado", async () => {
    const { runner } = makeRunner();
    const { hooks, requests } = recordingHooks({ approved: true, text: "Texto que eu editei", response: "capriche" });
    const outcome = await runner.run(makeInput("Escrever convite para Ana Souza [aprovar]"), hooks);
    expect(requests[0]!.draft).toMatchObject({ type: "convite", to: "Ana Souza" });
    expect(requests[0]!.draft!.text).toContain(SIMULATED_DRAFT_MARK);
    expect(outcome.status).toBe("done");
    expect(outcome.result).toContain("### Texto aprovado\n\nTexto que eu editei");
    expect(outcome.result).toContain("### Nota para o time\n\ncapriche");
  });

  it("pergunta respondida: o resultado traz a resposta", async () => {
    const { runner } = makeRunner();
    const { hooks, requests } = recordingHooks({ approved: true, response: "Pode ser na terça" });
    const outcome = await runner.run(makeInput("Qual o melhor dia para publicar? [aprovar]"), hooks);
    expect(requests[0]!.draft).toMatchObject({ type: "pergunta", title: "Qual o melhor dia para publicar?" });
    expect(outcome.result).toContain("### Sua resposta\n\nPode ser na terça");
  });

  it("MOCK_APPROVAL_RATE: pede aprovação quando o sorteio fica abaixo da taxa", async () => {
    const asks = async (rate: number, draw: number) => {
      const { runner } = makeRunner({ approvalRate: rate, random: sequence(0, 0, draw, 0) });
      const { hooks, questions } = recordingHooks();
      await runner.run(makeInput("Normal"), hooks);
      return questions.length;
    };
    expect(await asks(0.2, 0.1)).toBe(1);
    expect(await asks(0.2, 0.3)).toBe(0);
    expect(await asks(0, 0)).toBe(0);
  });

  it("'[falhar]' termina failed", async () => {
    const { runner } = makeRunner();
    const { hooks, progress } = recordingHooks();
    const outcome = await runner.run(makeInput("Quebrar [falhar]"), hooks);
    expect(outcome.status).toBe("failed");
    expect(outcome.result).toContain("Falha simulada");
    expect(progress.length).toBeLessThan(4);
  });

  it("respeita o AbortSignal: rejeita e para de emitir progresso", async () => {
    const controller = new AbortController();
    const { runner } = makeRunner({
      sleep: async (_ms, signal) => {
        controller.abort(new Error("cancelada"));
        signal.throwIfAborted();
      },
    });
    const { hooks, progress, trace } = recordingHooks();
    await expect(runner.run(makeInput("Algo", controller.signal), hooks)).rejects.toThrow("cancelada");
    expect(progress).toEqual([]);
    // Só a narração do primeiro passo saiu antes da espera abortada.
    expect(trace).toEqual([{ thread: "", type: "log", entry: { kind: "text", text: expect.any(String) } }]);
  });

  it("log: narra cada passo, ferramentas vão running -> ok na ordem, progresso depois de cada passo", async () => {
    const { runner } = makeRunner();
    const { hooks, trace } = recordingHooks();
    await runner.run(makeInput("Fazer algo"), hooks);
    const kinds = trace.map((item) => (item.type === "log" ? item.entry.kind : item.type));
    expect(kinds[0]).toBe("text");
    expect(kinds.filter((kind) => kind === "progress")).toHaveLength(4);
    expect(kinds.slice(-2)).toEqual(["progress", "text"]);
    // O primeiro passo é sempre "Lendo as notas do Cérebro": brain.search com as notas do contexto.
    const firstTool = trace.find((item) => item.type === "log" && item.entry.kind === "tool");
    expect(firstTool).toMatchObject({ entry: { kind: "tool", name: "brain.search", input: { query: "Fazer algo" } } });
    const toolIds = trace.flatMap((item) => (item.type === "log" && item.entry.kind === "tool" ? [item.entry.toolUseId] : []));
    expect(new Set(toolIds).size).toBe(toolIds.length);
    for (const id of toolIds) {
      const started = trace.findIndex((item) => item.type === "log" && item.entry.kind === "tool" && item.entry.toolUseId === id);
      const finished = trace.findIndex((item) => item.type === "toolResult" && item.toolUseId === id);
      expect(finished).toBeGreaterThan(started);
    }
    const brainResult = trace.find((item) => item.type === "toolResult");
    expect(brainResult).toMatchObject({ result: { status: "ok", output: expect.stringContaining("Um (A)") } });
  });

  it("ferramenta que falha: error, narração da nova tentativa e ok com outro toolUseId", async () => {
    // Sorteios: duração, passos, aprovação, mensagens (2) e falha da ferramenta (> 0.85).
    const { runner } = makeRunner({ random: sequence(0, 0, 0.5, 0, 0, 0.9, 0) });
    const { hooks, trace } = recordingHooks();
    await runner.run(makeInput("Fazer algo"), hooks);
    const results = trace.filter((item) => item.type === "toolResult");
    expect(results[0]).toMatchObject({ result: { status: "error", output: "Tempo esgotado (simulado)" } });
    expect(results[1]).toMatchObject({ result: { status: "ok" } });
    expect(results[0]!.toolUseId).not.toBe(results[1]!.toolUseId);
    expect(trace).toContainEqual({ thread: "", type: "log", entry: { kind: "text", text: "A ferramenta brain.search falhou; tentando de novo." } });
  });

  it("subagentes: 2–3 em paralelo, cada um com a própria thread, e o pai junta depois", async () => {
    const { runner, waits } = makeRunner({ subagentRate: 1, random: () => 0.99 });
    const { hooks, trace, progress } = recordingHooks();
    const outcome = await runner.run(makeInput("Pesquisar concorrentes"), hooks);
    expect(outcome.status).toBe("done");
    expect(progress).toHaveLength(6);

    const started = trace.filter((item) => item.type === "subagent");
    expect(started.map((item) => item.type === "subagent" && item.label)).toEqual([
      "Ana · pesquisa de referências",
      "Ana · levantamento nas notas",
      "Ana · rascunho alternativo",
    ]);
    // Todos começam antes de qualquer um terminar (rodam ao mesmo tempo).
    const firstFinish = trace.findIndex((item) => item.type === "finish");
    const lastStart = trace.findLastIndex((item) => item.type === "subagent");
    expect(lastStart).toBeLessThan(firstFinish);
    for (const id of ["sa-1", "sa-2", "sa-3"]) {
      const own = trace.filter((item) => item.thread === id);
      expect(own.map((item) => (item.type === "log" ? item.entry.kind : item.type))).toEqual(["text", "progress", "tool", "toolResult", "progress", "finish"]);
      expect(own.at(-1)).toMatchObject({ type: "finish", status: "ok" });
    }
    // O pai só junta depois que todos terminaram, e o passo seguinte vem depois.
    const merge = trace.findIndex((item) => item.type === "log" && item.entry.kind === "text" && item.entry.text.startsWith("Juntei"));
    expect(merge).toBeGreaterThan(trace.findLastIndex((item) => item.type === "finish"));
    // Cada subagente gasta a duração do passo (as esperas dele somam waitMs).
    expect(waits.length).toBeGreaterThan(0);
  });

  it("subagentes param todos no abort e nenhum gancho é chamado depois", async () => {
    const controller = new AbortController();
    let calls = 0;
    const { runner } = makeRunner({
      subagentRate: 1,
      random: () => 0.99,
      sleep: async (_ms, signal) => {
        // Aborta no meio do passo dos subagentes (depois de algumas esperas).
        if (++calls === 6) controller.abort(new Error("cancelada"));
        await Promise.resolve();
        signal.throwIfAborted();
      },
    });
    const { hooks, trace } = recordingHooks();
    await expect(runner.run(makeInput("Algo", controller.signal), hooks)).rejects.toThrow("cancelada");
    const length = trace.length;
    expect(trace.some((item) => item.type === "subagent")).toBe(true);
    expect(trace.some((item) => item.type === "finish")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(trace).toHaveLength(length);
  });

  it("é determinístico com aleatoriedade e relógio injetados", async () => {
    const run = async () => {
      const { runner, waits } = makeRunner({ random: sequence(0.3, 0.7, 0.5, 0.1, 0.9) });
      const { hooks, progress } = recordingHooks();
      await runner.run(makeInput("Igual"), hooks);
      return { waits, progress };
    };
    expect(await run()).toEqual(await run());
  });
});

describe("mockDraft", () => {
  const draft = (prompt: string) => mockDraft(makeInput(prompt));

  it("convite cita o 'para' e cabe em 200 caracteres, mesmo com pedido longo", () => {
    const long = draft(`Convite para Marina Lopes sobre ${"engenharia de dados ".repeat(20)}`);
    expect(long).toMatchObject({ type: "convite", to: "Marina Lopes" });
    expect(long.text.startsWith("Oi, Marina!")).toBe(true);
    expect(long.text.length).toBeLessThanOrEqual(200);
    expect(long.text.endsWith(SIMULATED_DRAFT_MARK)).toBe(true);
  });

  it.each([
    ["Mensagem de boas-vindas para o Rui", "boas-vindas"],
    ["Mandar mensagem para a Bia", "mensagem"],
    ["Resposta para o João", "resposta"],
  ] as const)("%s -> %s dentro do limite", (prompt, type) => {
    const result = draft(prompt);
    expect(result.type).toBe(type);
    expect(result.text.length).toBeLessThanOrEqual(forYouLimit(type)!.max);
  });

  it("perfil escolhe o 'onde' e respeita o limite dele", () => {
    const headline = draft(`Atualizar a headline do perfil: ${"x".repeat(400)}`);
    expect(headline).toMatchObject({ type: "perfil", where: "Headline" });
    expect(headline.text.length).toBeLessThanOrEqual(220);
    expect(draft("Reescrever o perfil")).toMatchObject({ where: "Sobre" });
  });

  it("comentário, post e outro têm 'por quê', metadados e a marca de simulado", () => {
    for (const prompt of ["Comentário no post do Caio", "Escrever um post sobre testes", "Organizar a planilha"]) {
      const result = draft(prompt);
      expect(result.why).toContain("Ana");
      expect(result.meta).toMatchObject({ crivo: "aprovado (simulado)" });
      expect(result.text).toContain(SIMULATED_DRAFT_MARK);
    }
    expect(draft("Comentário no post do Caio")).toMatchObject({ type: "comentario", where: "Post de Caio" });
  });

  it("recipientOf pega o nome depois de 'para'", () => {
    expect(recipientOf("Convite para Ana de Souza")).toBe("Ana de Souza");
    expect(recipientOf("Convite para a Bia")).toBe("Bia");
    expect(recipientOf("Convite para o time")).toBeUndefined();
  });
});
