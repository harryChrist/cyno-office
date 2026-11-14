import { INITIAL_MODEL_DEFAULTS, type Agent, type EnginesResponse, type Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { MAESTRO_NO_ENGINE } from "./sim/coordinator";
import { NO_ENGINE_RESULT } from "./engines/runner/no-engine-runner";
import { call, createRoom, createTeam, TEST_AVATAR } from "./dev/test-api";
import { API, useTestApp } from "./dev/test-app";

const setupApp = useTestApp();

/** Produção: modo simulado desligado (sem AGENT_RUNNER=mock). */
const production = { simulated: false, initialModelDefaults: INITIAL_MODEL_DEFAULTS } as const;

describe("modo simulado desligado (padrão de produção)", () => {
  it("GET /api/engines não oferece o motor mock e diz simulated: false", async () => {
    const { app } = await setupApp(production);
    const body = await call<EnginesResponse>(app, "GET", "/api/engines");
    expect(body.simulated).toBe(false);
    expect(body.engines.map((info) => info.engine)).not.toContain("mock");
  });

  it("com o modo simulado ligado, o motor mock aparece e simulated: true", async () => {
    const { app } = await setupApp();
    const body = await call<EnginesResponse>(app, "GET", "/api/engines");
    expect(body.simulated).toBe(true);
    expect(body.engines.map((info) => info.engine)).toContain("mock");
  });

  it("agente criado sem motor nasce com o padrão de agentes (claude/sonnet) e engine mock é recusado", async () => {
    const { app } = await setupApp(production);
    const room = await createRoom(app, "Sala nova");
    const team = await createTeam(app, room.id, "Time novo");
    const base = { teamId: team.id, role: "Dev", instructions: "", avatar: TEST_AVATAR };
    const agent = await call<Agent>(app, "POST", `${API}/agents`, { ...base, name: "Bia" }, 201);
    expect(agent).toMatchObject({ engine: "claude", model: "sonnet", effort: "medium" });
    await call(app, "POST", `${API}/agents`, { ...base, name: "Caio", engine: "mock" }, 400);
    await call(app, "PATCH", `${API}/agents/${agent.id}`, { engine: "mock" }, 400);
    // Motor sem adaptador de CLI instalado (codex, opencode): recusado na hora, não só ao rodar.
    await call(app, "PATCH", `${API}/agents/${agent.id}`, { engine: "codex" }, 400);
    await call(app, "POST", `${API}/agents`, { ...base, name: "Duda", engine: "opencode" }, 400);
    await call(app, "PATCH", `${API}/agents/${agent.id}`, { engine: "gemini" }, 200);
  });

  it("agente antigo sem motor: a tarefa falha com mensagem clara e o agente não muda", async () => {
    const first = await setupApp();
    const { dataDir } = first;
    const agentId = (await call<{ agents: Agent[] }>(first.app, "GET", `${API}/office`)).agents.find((agent) => agent.teamId === "projetox-frontend")!.id;
    await first.app.close();

    const second = await setupApp({ ...production, dataDir });
    const before = (await call<{ agents: Agent[] }>(second.app, "GET", `${API}/office`)).agents.find((agent) => agent.id === agentId)!;
    expect(before.engine).toBeUndefined();
    const task = await call<Task>(second.app, "POST", `${API}/tasks`, { prompt: "faça algo", teamId: before.teamId }, 201);
    await second.log.waitForTask(task.id, "failed");
    const failed = (await call<Task[]>(second.app, "GET", `${API}/tasks`)).find((candidate) => candidate.id === task.id)!;
    expect(failed.result).toBe(NO_ENGINE_RESULT);
    const after = (await call<{ agents: Agent[] }>(second.app, "GET", `${API}/office`)).agents.find((agent) => agent.id === agentId)!;
    expect(after).toEqual({ ...before, status: "idle" });
  });

  it("Maestro sem motor: o pedido é recusado (409) com a mensagem clara", async () => {
    const { app } = await setupApp(production);
    const body = await call<{ error: string }>(app, "POST", `${API}/tasks`, { prompt: "faça algo" }, 409);
    expect(body.error).toBe(MAESTRO_NO_ENGINE);
  });
});
