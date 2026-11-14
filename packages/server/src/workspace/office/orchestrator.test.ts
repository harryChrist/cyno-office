import { readdir, readFile } from "node:fs/promises";
import { readDiskTasks, writeDiskTasks } from "../../dev/test-utils";
import path from "node:path";
import { APPROVAL_REFUSED_RESULT, type Task } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { call, createTask, createWorkspace, getOffice, soloTeam } from "../../dev/test-api";
import type { AgentRunner } from "../../engines/runner/types";
import { EventLog, gatedSleep, testRunner, useTestApp, type TestApp } from "../../dev/test-app";

const setupApp = useTestApp();

const approve = (app: TestApp["app"], taskId: string, approved: boolean) =>
  call<Task>(app, "POST", `/api/w/principal/tasks/${taskId}/approval`, { approved }, 200);

/** Notas do histórico do quarto (os resultados de tarefa vão para `historico/`) que citam `text`. */
async function notesMentioning(dir: string, roomId: string, text: string): Promise<string[]> {
  const brainDir = path.join(dir, "brains", roomId, "historico");
  const files = await readdir(brainDir).catch(() => [] as string[]);
  const contents = await Promise.all(files.map((file) => readFile(path.join(brainDir, file), "utf8")));
  return contents.filter((content) => content.includes(text));
}

describe("Orchestrator com MockRunner determinístico", () => {
  it("fluxo feliz: queued -> in_progress -> done, progresso, nota no Cérebro e agente done -> idle", async () => {
    const { app, log, dir } = await setupApp();
    const task = await createTask(app, "projetox", "projetox-frontend", "Criar a tela de pedidos");
    await log.waitForTask(task.id, "done");
    await log.waitFor((event) => event.type === "agent:upserted" && event.agent.id === task.agentId && event.agent.status === "idle");

    expect(log.taskStatuses(task.id)).toEqual(["queued", "in_progress", "done"]);
    expect(log.agentStatuses(task.agentId!)).toEqual(["working", "done", "idle"]);

    const progress = log.events.flatMap((event) => (event.type === "task:progress" && event.taskId === task.id ? [event] : []));
    expect(progress.length).toBeGreaterThanOrEqual(4);
    expect(progress.length).toBeLessThanOrEqual(6);
    expect(progress.map((event) => event.progress)).toEqual([...progress.map((event) => event.progress)].sort());
    expect(progress.at(-1)!.progress).toBe(1);
    expect(progress.every((event) => event.agentId === task.agentId && event.message.length > 0)).toBe(true);

    const done = (await getOffice(app)).tasks.find((candidate) => candidate.id === task.id)!;
    expect(done.result).toContain("2 fontes de contexto");
    const notes = await notesMentioning(dir, "projetox", `task: "${task.id}"`);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`agent: "${task.agentId}"`);
    expect(notes[0]).toContain(done.result!);
  });

  it("aprovação aceita: waiting_approval -> in_progress -> done", async () => {
    const { app, log } = await setupApp();
    const task = await createTask(app, "projetox", "projetox-backend", "Migrar o banco [aprovar]");
    await log.waitForTask(task.id, "waiting_approval");
    expect((await getOffice(app)).agents.find((agent) => agent.id === task.agentId)!.status).toBe("waiting_approval");

    const approved = await approve(app, task.id, true);
    expect(approved.status).toBe("in_progress");
    await log.waitForTask(task.id, "done");
    expect(log.taskStatuses(task.id)).toEqual(["queued", "in_progress", "waiting_approval", "in_progress", "done"]);
    expect(log.agentStatuses(task.agentId!).slice(0, 4)).toEqual(["working", "waiting_approval", "working", "done"]);
  });

  it("aprovação recusada: failed com 'Recusado pelo usuário', agente idle e nenhuma nota", async () => {
    const { app, log, dir } = await setupApp();
    const task = await createTask(app, "projetox", "projetox-backend", "Apagar tudo [aprovar]");
    await log.waitForTask(task.id, "waiting_approval");
    const refused = await approve(app, task.id, false);
    expect(refused).toMatchObject({ status: "failed", result: APPROVAL_REFUSED_RESULT });
    expect(log.agentStatuses(task.agentId!).at(-1)).toBe("idle");
    expect(await notesMentioning(dir, "projetox", task.id)).toEqual([]);
    await call(app, "POST", `/api/w/principal/tasks/${task.id}/approval`, { approved: true }, 409);
  });

  it("falha: '[falhar]' termina failed e o agente volta a idle", async () => {
    const { app, log, dir } = await setupApp();
    const task = await createTask(app, "projetoy", "projetoy-pesquisa", "Pesquisar [falhar]");
    await log.waitForTask(task.id, "failed");
    expect(log.taskStatuses(task.id)).toEqual(["queued", "in_progress", "failed"]);
    expect(log.agentStatuses(task.agentId!)).toEqual(["working", "idle"]);
    const failed = (await getOffice(app)).tasks.find((candidate) => candidate.id === task.id)!;
    expect(failed.result).toContain("Falha simulada");
    expect(await notesMentioning(dir, "projetoy", task.id)).toEqual([]);
  });

  it("fila FIFO por agente: uma tarefa por vez, na ordem de chegada", async () => {
    const gate = gatedSleep();
    const { app, log } = await setupApp({ runner: testRunner({ sleep: gate.sleep }) });
    const { room, team, agent } = await soloTeam(app);
    const first = await createTask(app, room.id, team.id, "Primeira");
    const second = await createTask(app, room.id, team.id, "Segunda");
    const third = await createTask(app, room.id, team.id, "Terceira");
    expect([first, second, third].map((task) => task.agentId)).toEqual([agent.id, agent.id, agent.id]);

    await log.waitForTask(first.id, "in_progress");
    expect(log.taskStatuses(second.id)).toEqual(["queued"]);
    expect(log.taskStatuses(third.id)).toEqual(["queued"]);

    gate.open();
    await log.waitForTask(third.id, "done");
    const order = log.events.flatMap((event) =>
      event.type === "task:upserted" && event.task.status !== "queued" ? [`${event.task.prompt}:${event.task.status}`] : [],
    );
    expect(order).toEqual([
      "Primeira:in_progress",
      "Primeira:done",
      "Segunda:in_progress",
      "Segunda:done",
      "Terceira:in_progress",
      "Terceira:done",
    ]);
  });

  it("o agente fica done por doneLingerMs antes da próxima tarefa", async () => {
    const { app, log } = await setupApp({ doneLingerMs: 60 });
    const { room, team, agent } = await soloTeam(app);
    const first = await createTask(app, room.id, team.id, "Primeira");
    const second = await createTask(app, room.id, team.id, "Segunda");
    await log.waitForTask(first.id, "done");
    // O relógio parte de quando o `done` da primeira foi visto (antes, partia da criação da segunda, que pode demorar uns ms sob carga e comer a folga).
    const firstDone = Date.now();
    await log.waitForTask(second.id, "in_progress");
    expect(Date.now() - firstDone).toBeGreaterThanOrEqual(50);
    await log.waitForTask(second.id, "done");
    // O primeiro "idle" é o agent:upserted da criação do agente.
    expect(log.agentStatuses(agent.id).slice(0, 5)).toEqual(["idle", "working", "done", "working", "done"]);
  });

  it("retomada no boot: tarefas interrompidas voltam para a fila e terminam; aprovação pendente continua pendente", async () => {
    // Pedidos com "[aprovar]" chegam logo à aprovação; os outros ficam presos em in_progress.
    const [instant, gated] = [testRunner(), testRunner({ sleep: gatedSleep().sleep })];
    const runner: AgentRunner = {
      run: (input, hooks) => (input.task.prompt.includes("[aprovar]") ? instant : gated).run(input, hooks),
    };
    const first = await setupApp({ runner });
    const { room, team, agent } = await soloTeam(first.app);
    const running = await createTask(first.app, room.id, team.id, "Interrompida");
    const waiting = await createTask(first.app, room.id, team.id, "Na fila");
    const approval = await createTask(first.app, "projetox", "projetox-backend", "Precisa de ok [aprovar]");
    await first.log.waitForTask(running.id, "in_progress");
    await first.log.waitForTask(approval.id, "waiting_approval");
    await first.app.close();

    const persisted = await readDiskTasks<Task>(first.dir);
    expect(persisted.map((task) => task.status)).toEqual(["in_progress", "queued", "waiting_approval"]);

    const rebooted = await setupApp({ dataDir: first.dataDir });
    await rebooted.log.waitForTask(running.id, "done");
    await rebooted.log.waitForTask(waiting.id, "done");
    expect(rebooted.log.taskStatuses(running.id)).toEqual(["queued", "in_progress", "done"]);
    expect(rebooted.log.taskStatuses(waiting.id)).toEqual(["in_progress", "done"]);
    expect(rebooted.log.agentStatuses(agent.id)[0]).toBe("idle");
    // A aprovação pendente não roda de novo sozinha: segue esperando a decisão do usuário.
    expect(rebooted.log.taskStatuses(approval.id)).toEqual([]);
    const office = await getOffice(rebooted.app);
    expect(office.tasks.find((task) => task.id === approval.id)!.status).toBe("waiting_approval");
    expect(office.agents.find((candidate) => candidate.id === approval.agentId)!.status).toBe("waiting_approval");
  });

  it("boot com tarefa na fila de um agente que não existe mais: vira failed", async () => {
    const first = await setupApp();
    const { room, team } = await soloTeam(first.app);
    await first.app.close();
    const at = new Date().toISOString();
    const orphan: Task = { id: "orfa", roomId: room.id, teamId: team.id, agentId: "fantasma", prompt: "x", status: "queued", createdAt: at, updatedAt: at };
    await writeDiskTasks(first.dir, [orphan], at.slice(0, 7));

    const rebooted = await setupApp({ dataDir: first.dataDir });
    const event = await rebooted.log.waitForTask("orfa", "failed");
    expect(event.type === "task:upserted" && event.task.result).toBe("Cancelada: o agente não existe mais");
  });
});

describe("Orchestrator: aprovação pendente sobrevive ao restart", () => {
  /**
   * 1º boot: a aprovação é sorteada (approvalRate 1) e há outra tarefa na fila do mesmo agente.
   * 2º boot: o runner nunca sortearia aprovação (approvalRate 0), como o padrão 0.2 na maioria das vezes.
   */
  async function rebootWithPendingApproval(prompt: string, secondRunner?: AgentRunner) {
    const first = await setupApp({ runner: testRunner({ approvalRate: 1 }) });
    const solo = await soloTeam(first.app);
    const pending = await createTask(first.app, solo.room.id, solo.team.id, prompt);
    await first.log.waitForTask(pending.id, "waiting_approval");
    const next = await createTask(first.app, solo.room.id, solo.team.id, "Próxima da fila");
    await first.app.close();
    const rebooted = await setupApp({ dataDir: first.dataDir, ...(secondRunner ? { runner: secondRunner } : {}) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { ...rebooted, ...solo, pending, next };
  }

  it("sem decisão, a tarefa segue waiting_approval mas NÃO segura o agente: a fila anda", async () => {
    const { app, log, agent, pending, next } = await rebootWithPendingApproval("Publicar o site");
    // A aprovação pendente não roda de novo sozinha...
    expect(log.taskStatuses(pending.id)).toEqual([]);
    // ...mas a próxima tarefa do agente não espera por ela.
    await log.waitForTask(next.id, "done");
    const office = await getOffice(app);
    expect(office.tasks.find((task) => task.id === pending.id)!.status).toBe("waiting_approval");
    await vi.waitFor(async () => {
      const current = await getOffice(app);
      expect(current.agents.find((candidate) => candidate.id === agent.id)!.status).toBe("waiting_approval");
    });
  });

  it.each([["aprovação sorteada", "Publicar o site"], ["'[aprovar]' no pedido", "Publicar o site [aprovar]"]])(
    "aprovar (%s) roda a tarefa sem pedir aprovação de novo e a fila anda",
    async (_case, prompt) => {
      const { app, log, agent, pending, next } = await rebootWithPendingApproval(prompt);
      await log.waitForTask(next.id, "done");
      const approved = await approve(app, pending.id, true);
      expect(["queued", "in_progress"]).toContain(approved.status);
      await log.waitForTask(pending.id, "done");
      expect(log.taskStatuses(pending.id)).toEqual(["queued", "in_progress", "done"]);
      // A próxima já tinha começado antes do reinício (a espera soltou a vaga) e foi para a fila no boot.
      expect(log.taskStatuses(next.id)).toEqual(["queued", "in_progress", "done"]);
      expect(log.agentStatuses(agent.id)).toContain("working");
      await call(app, "POST", `/api/w/principal/tasks/${pending.id}/approval`, { approved: true }, 409);
    },
  );

  it("a tarefa que recomeça aprovada leva a decisão do usuário para o runner (o agente não pergunta de novo)", async () => {
    const inner = testRunner();
    const inputs: Parameters<AgentRunner["run"]>[0][] = [];
    const spy: AgentRunner = { provider: inner.provider, run: (input, hooks) => (inputs.push(input), inner.run(input, hooks)) };
    const { app, log, pending, next } = await rebootWithPendingApproval("Publicar o site", spy);
    await log.waitForTask(next.id, "done");
    await approve(app, pending.id, true);
    await log.waitForTask(pending.id, "done");
    expect(inputs.find((input) => input.task.id === pending.id)?.resumedDecision).toMatchObject({ approved: true });
    expect(inputs.find((input) => input.task.id === next.id)?.resumedDecision).toBeUndefined();
  });

  it("a decisão já tomada de uma tarefa na fila sobrevive a outro reinício (retoma com ela, sem pedir aprovação de novo)", async () => {
    const gate = gatedSleep();
    const { app, dataDir, log, pending, next } = await rebootWithPendingApproval("Publicar o site", testRunner({ sleep: gate.sleep }));
    await log.waitForTask(next.id, "in_progress");
    // O agente está ocupado com a "próxima": a aprovada espera na fila, com a decisão guardada no estado.
    const approved = await approve(app, pending.id, true);
    expect(approved.status).toBe("queued");
    await app.close();

    const inner = testRunner();
    const inputs: Parameters<AgentRunner["run"]>[0][] = [];
    const spy: AgentRunner = { provider: inner.provider, run: (input, hooks) => (inputs.push(input), inner.run(input, hooks)) };
    const again = await setupApp({ dataDir, runner: spy });
    await again.log.waitForTask(pending.id, "done");
    expect(inputs.find((input) => input.task.id === pending.id)?.resumedDecision).toMatchObject({ approved: true });
  });

  it("recusar marca failed ('Recusado pelo usuário'), solta o agente e a fila anda", async () => {
    const { app, log, dir, room, pending, next } = await rebootWithPendingApproval("Publicar o site");
    await log.waitForTask(next.id, "done");
    const refused = await approve(app, pending.id, false);
    expect(refused).toMatchObject({ status: "failed", result: APPROVAL_REFUSED_RESULT });
    expect(log.taskStatuses(pending.id)).toEqual(["failed"]);
    expect(await notesMentioning(dir, room.id, pending.id)).toEqual([]);
  });

  it("deletar o agente cancela a aprovação restaurada", async () => {
    const { app, agent, pending } = await rebootWithPendingApproval("Publicar o site");
    await call(app, "DELETE", `/api/w/principal/agents/${agent.id}`);
    const office = await getOffice(app);
    expect(office.tasks.find((task) => task.id === pending.id)).toMatchObject({ status: "failed" });
    await call(app, "POST", `/api/w/principal/tasks/${pending.id}/approval`, { approved: true }, 409);
  });
});

describe("Orchestrator: cancelamento por delete", () => {
  async function busyAgent() {
    const gate = gatedSleep();
    const testApp = await setupApp({ runner: testRunner({ sleep: gate.sleep }) });
    const solo = await soloTeam(testApp.app);
    const running = await createTask(testApp.app, solo.room.id, solo.team.id, "Rodando");
    const queued = await createTask(testApp.app, solo.room.id, solo.team.id, "Esperando");
    await testApp.log.waitForTask(running.id, "in_progress");
    return { ...testApp, ...solo, gate, running, queued };
  }

  it("deletar o agente aborta a execução e marca as tarefas ativas como failed", async () => {
    const { app, log, agent, gate, running, queued } = await busyAgent();
    await call(app, "DELETE", `/api/w/principal/agents/${agent.id}`);
    expect(gate.signals.some((signal) => signal.aborted)).toBe(true);
    for (const task of [running, queued]) {
      expect(log.taskStatuses(task.id).at(-1)).toBe("failed");
    }
    const office = await getOffice(app);
    expect(office.tasks.map((task) => task.result)).toEqual(["Cancelada: o agente foi removido", "Cancelada: o agente foi removido"]);
    gate.open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(log.taskStatuses(running.id)).toEqual(["queued", "in_progress", "failed"]);
  });

  it("deletar o time cancela as tarefas do time e remove os agentes", async () => {
    const { app, log, team, agent, running, queued } = await busyAgent();
    await call(app, "DELETE", `/api/w/principal/teams/${team.id}`);
    expect(log.taskStatuses(running.id).at(-1)).toBe("failed");
    expect(log.taskStatuses(queued.id).at(-1)).toBe("failed");
    expect(log.events.some((event) => event.type === "agent:deleted" && event.id === agent.id)).toBe(true);
    const office = await getOffice(app);
    expect(office.tasks.every((task) => task.result === "Cancelada: o time foi removido")).toBe(true);
  });

  it("deletar o quarto cancela (failed), depois remove as tarefas e manda um snapshot", async () => {
    const { app, log, room, gate, running } = await busyAgent();
    await call(app, "DELETE", `/api/w/principal/rooms/${room.id}`);
    expect(gate.signals.some((signal) => signal.aborted)).toBe(true);
    expect(log.taskStatuses(running.id).at(-1)).toBe("failed");
    const snapshot = log.events.at(-1);
    expect(snapshot?.type).toBe("office:snapshot");
    expect((await getOffice(app)).tasks).toEqual([]);
  });

  it("deletar um agente esperando aprovação libera a fila sem 409 posterior inconsistente", async () => {
    const { app, log } = await setupApp();
    const solo = await soloTeam(app);
    const task = await createTask(app, solo.room.id, solo.team.id, "Ok? [aprovar]");
    await log.waitForTask(task.id, "waiting_approval");
    await call(app, "DELETE", `/api/w/principal/agents/${solo.agent.id}`);
    expect(log.taskStatuses(task.id).at(-1)).toBe("failed");
    await call(app, "POST", `/api/w/principal/tasks/${task.id}/approval`, { approved: true }, 409);
  });
});

describe("Orchestrator por workspace", () => {
  it("cada workspace tem a sua fila; o resultado vira nota no Cérebro do workspace certo", async () => {
    const { app, log, dir, dataDir, workspaces } = await setupApp();
    await createWorkspace(app, "Instagram");
    const instagramLog = new EventLog(workspaces.get("instagram").hub);
    const { room, team } = await soloTeam(app, "Feed", "instagram");
    // Mesmo id de quarto que o seed do principal, para provar que a nota não cai no lugar errado.
    const task = await createTask(app, room.id, team.id, "Post da semana", "instagram");
    await instagramLog.waitForTask(task.id, "done");

    const instagramDir = path.join(dataDir, "workspaces", "instagram");
    expect(await notesMentioning(instagramDir, room.id, `task: "${task.id}"`)).toHaveLength(1);
    expect(log.events.some((event) => event.type === "task:upserted" && event.task.id === task.id)).toBe(false);
    expect((await readdir(path.join(dir, "brains"))).includes(room.id)).toBe(false);
    expect((await getOffice(app)).tasks).toEqual([]);
  });
});
