import { MAESTRO_TEXTS, type OfficeState } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { makeAgent, makeOffice, makeRoom, makeTask } from "../test-fixtures";
import type { ActivityEntry } from "../ui/activity";
import { agentWorkStatus, maestroOf, maestroRequests, maestroStatus, maestroSteps } from "./maestroTimeline";
import { clockLabel } from "./timelineLogic";

/** O escritório de teste com a Sala do Maestro, a Gerência e o Maestro. */
function withMaestro(): OfficeState {
  const office = makeOffice();
  office.tasks = [];
  office.rooms.push(makeRoom("sala", { kind: "maestro", name: "Sala do Maestro", gridPosition: { x: -1, y: 0 } }));
  office.teams.push({ id: "gerencia", roomId: "sala", name: "Gerência", focus: "coordenar" });
  office.agents.push(makeAgent("maestro", "gerencia", { role: "maestro" }));
  return office;
}

const at = (minute: number) => `2026-11-07T10:${String(minute).padStart(2, "0")}:00.000Z`;
const asked = (id: string, minute: number, overrides = {}) =>
  makeTask(id, { roomId: "sala", teamId: "gerencia", agentId: "maestro", createdAt: at(minute), updatedAt: at(minute), ...overrides });
const sub = (id: string, projectId: string, overrides = {}) =>
  makeTask(id, { projectId, roomId: "b", teamId: "b-time", agentId: "caio", routeReason: "pedido fala de 'revisar' → time Time B", ...overrides });

describe("maestroRequests", () => {
  it("só os pedidos ao Maestro, o mais novo embaixo, com o time, o motivo e quem pegou", () => {
    const office = withMaestro();
    office.tasks.push(
      asked("p2", 5, { status: "in_progress", routeReason: "pedido fala de 'revisar' → time Time B" }),
      asked("p1", 1, { status: "done", result: "Entregue por caio.\n\nfeito" }),
      sub("s2", "p2", { status: "in_progress" }),
      makeTask("direta", { status: "in_progress" }),
    );
    const { items, total } = maestroRequests(office, "maestro", {
      s2: { agentId: "caio", progress: 0.4, message: "Escrevendo" },
      p2: { agentId: "maestro", progress: 0.5, message: MAESTRO_TEXTS.delegated("Time B") },
    });
    expect(total).toBe(2);
    expect(items.map((item) => item.id)).toEqual(["p1", "p2"]);
    expect(items[0]).toMatchObject({ stage: "done", stageLabel: "Concluído", tone: "success", result: "Entregue por caio.\n\nfeito" });
    expect(items[0]!.progress).toBeUndefined();
    expect(items[1]).toMatchObject({
      stage: "routed",
      tone: "busy",
      reason: "pedido fala de 'revisar' → time Time B",
      team: { id: "b-time", name: "Time B" },
      room: { id: "b", name: "B" },
      agent: { id: "caio", name: "caio", roomId: "b" },
      subtaskId: "s2",
      subtaskStatus: "in_progress",
      // O progresso da subtarefa (o time trabalhando) vence o do Maestro.
      progress: { value: 0.4, message: "Escrevendo" },
    });
  });

  it("corta nos mais recentes e conta o total", () => {
    const office = withMaestro();
    for (let minute = 0; minute < 5; minute++) office.tasks.push(asked(`p${minute}`, minute, { status: "done" }));
    const { items, total } = maestroRequests(office, "maestro", {}, 3);
    expect(total).toBe(5);
    expect(items.map((item) => item.id)).toEqual(["p2", "p3", "p4"]);
  });

  it("estágios: fila, triagem, na fila do time, revisando, precisa de você e falhou", () => {
    const office = withMaestro();
    office.tasks.push(
      asked("fila", 1),
      asked("triagem", 2, { status: "in_progress" }),
      asked("time", 3, { status: "in_progress" }),
      sub("s-time", "time"),
      asked("revisa", 4, { status: "in_progress" }),
      sub("s-revisa", "revisa", { status: "done", result: "ok" }),
      asked("sem-time", 5, { status: "waiting_approval", routeReason: MAESTRO_TEXTS.noTeam }),
      asked("aprova", 6, { status: "waiting_approval" }),
      sub("s-aprova", "aprova", { status: "waiting_approval" }),
      asked("falhou", 7, { status: "failed", result: "O time Time B não concluiu: sem motivo" }),
    );
    const byId = Object.fromEntries(maestroRequests(office, "maestro", {}).items.map((item) => [item.id, item]));
    expect(byId.fila).toMatchObject({ stage: "queued" });
    expect(byId.triagem).toMatchObject({ stage: "triage", stageLabel: "Triando" });
    expect(byId.triagem!.team).toBeUndefined();
    expect(byId.time).toMatchObject({ stage: "routed", stageLabel: "Na fila do time" });
    expect(byId.revisa).toMatchObject({ stage: "reviewing" });
    expect(byId["sem-time"]).toMatchObject({ stage: "waiting_you", stageLabel: "Precisa de você", reason: MAESTRO_TEXTS.noTeam, tone: "attention" });
    expect(byId.aprova).toMatchObject({ stage: "waiting_you", stageLabel: "Esperando sua aprovação" });
    expect(byId.falhou).toMatchObject({ stage: "failed", tone: "danger", result: "O time Time B não concluiu: sem motivo" });
  });
});

describe("maestroStatus / agentWorkStatus", () => {
  it("livre sem pedidos ativos", () => {
    const office = withMaestro();
    office.tasks.push(asked("p", 1, { status: "done" }));
    expect(maestroStatus(office, "maestro", {})).toMatchObject({ label: "Livre", tone: "neutral", detail: "Livre para conversar", active: 0 });
  });

  it("delegando ao time, com o progresso; quem precisa de você vem primeiro", () => {
    const office = withMaestro();
    office.tasks.push(asked("p", 1, { status: "in_progress" }), sub("s", "p", { status: "in_progress" }));
    const progress = { s: { agentId: "caio", progress: 0.25, message: "Revisando o texto" } };
    expect(maestroStatus(office, "maestro", progress)).toMatchObject({ label: "Delegando · time Time B", tone: "busy", detail: "Revisando o texto", progress: 0.25, active: 1 });

    office.tasks.push(asked("q", 0, { status: "waiting_approval", routeReason: MAESTRO_TEXTS.noTeam }));
    expect(maestroStatus(office, "maestro", progress)).toMatchObject({ label: "Esperando você", tone: "attention", detail: MAESTRO_TEXTS.noTeam, active: 2 });
  });

  it("triando e revisando", () => {
    const office = withMaestro();
    office.tasks.push(asked("p", 1, { status: "in_progress" }));
    expect(maestroStatus(office, "maestro", { p: { agentId: "maestro", progress: 0.1, message: MAESTRO_TEXTS.triage } })).toMatchObject({
      label: "Triando",
      detail: MAESTRO_TEXTS.triage,
    });
    office.tasks.push(sub("s", "p", { status: "done" }));
    expect(maestroStatus(office, "maestro", {}).label).toBe("Revisando · time Time B");
  });

  it("um agente comum: o status dele e a tarefa atual", () => {
    const office = withMaestro();
    office.agents.find((agent) => agent.id === "caio")!.status = "working";
    office.tasks.push(makeTask("t", { agentId: "caio", status: "in_progress" }));
    expect(agentWorkStatus(office, "caio", { t: { agentId: "caio", progress: 0.6, message: "Quase" } })).toMatchObject({
      label: "trabalhando",
      tone: "busy",
      detail: "Quase",
      progress: 0.6,
      active: 1,
    });
    expect(agentWorkStatus(office, "maestro", {})?.label).toBe("Livre");
    expect(agentWorkStatus(office, "ninguem", {})).toBeNull();
  });
});

describe("maestroSteps", () => {
  it("as transições do Maestro em ordem e o progresso ao vivo no fim", () => {
    const office = withMaestro();
    office.tasks.push(asked("p", 1, { status: "in_progress", prompt: "revisar o post" }));
    const entry = (kind: ActivityEntry["kind"], minute: number, agentId = "maestro"): ActivityEntry => ({
      key: `p:${kind}:${agentId}`,
      kind,
      taskId: "p",
      agentId,
      roomId: kind === "delegated" ? "b" : "sala",
      teamId: kind === "delegated" ? "b-time" : "gerencia",
      prompt: "revisar o post",
      detail: kind === "delegated" ? "motivo" : undefined,
      at: at(minute),
    });
    // O feed guarda as mais novas primeiro; o passo de outro agente fica de fora.
    const entries = [entry("delegated", 2), entry("created", 3, "caio"), entry("created", 1)];
    const steps = maestroSteps(entries, office, "maestro", { p: { agentId: "maestro", progress: 0.5, message: "Delegada ao time Time B" } });
    expect(steps.map((step) => [step.state, step.text])).toEqual([
      ["info", "recebeu o pedido: “revisar o post”"],
      ["info", "mandou para o time Time B: “revisar o post”"],
      ["running", "Delegada ao time Time B"],
    ]);
    expect(steps[1]!.detail).toBe("motivo");
    expect(steps[2]).toMatchObject({ variant: "progress", progress: 0.5 });
  });
});

describe("maestroOf / clockLabel", () => {
  it("acha o Maestro e o quarto dele", () => {
    expect(maestroOf(withMaestro())).toEqual({ id: "maestro", roomId: "sala" });
    expect(maestroOf(makeOffice())).toBeUndefined();
    expect(maestroOf(null)).toBeUndefined();
  });

  it("só a hora quando é de hoje; com a data quando não é", () => {
    const now = new Date(2026, 10, 7, 15, 0);
    expect(clockLabel(new Date(2026, 10, 7, 9, 5).toISOString(), now)).toBe("09:05");
    expect(clockLabel(new Date(2026, 10, 6, 9, 5).toISOString(), now)).toBe("06/11 09:05");
    expect(clockLabel("nada", now)).toBe("nada");
  });
});
