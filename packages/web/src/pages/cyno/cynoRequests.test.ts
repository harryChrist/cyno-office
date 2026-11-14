import type { SentRequestView } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { isOpenRequest, openRequestsOf, requestLine, requestsBadge, requestTone, stateLabel, tasksLabel } from "./cynoRequests";

const view = (extra: Partial<SentRequestView> = {}): SentRequestView => ({
  projectId: "p1",
  workspace: "linkedin",
  workspaceName: "LinkedIn",
  title: "Post da semana",
  address: "linkedin/maestro",
  sentAt: "2026-11-11T10:00:00.000Z",
  state: "andando",
  tasksDone: 2,
  tasksTotal: 4,
  waitingForYou: 0,
  ...extra,
});

describe("cartão de pedido enviado", () => {
  it("a linha compacta: para onde, título, tarefas e o estado (esperando você traz quantos)", () => {
    expect(requestLine(view())).toBe("Enviado ao LinkedIn · Post da semana · 2/4 tarefas · andando");
    expect(requestLine(view({ state: "esperando_voce", waitingForYou: 1 }))).toBe("Enviado ao LinkedIn · Post da semana · 2/4 tarefas · esperando você (1)");
    expect(requestLine(view({ state: "enviado", tasksDone: 0, tasksTotal: 0 }))).toBe("Enviado ao LinkedIn · Post da semana · enviado");
    expect(requestLine(view({ state: "concluido", tasksDone: 4 }))).toContain("concluído");
  });

  it("tons, rótulos e contagens", () => {
    expect(requestTone("esperando_voce")).toBe("wait");
    expect(requestTone("concluido")).toBe("ok");
    expect(requestTone("falhou")).toBe("bad");
    expect(stateLabel({ state: "enviado" })).toBe("enviado");
    expect(tasksLabel({ tasksDone: 0, tasksTotal: 1 })).toBe("0/1 tarefa");
    expect(tasksLabel({ tasksDone: 0, tasksTotal: 0 })).toBe("");
  });

  it("o selo da ficha conta só os pedidos abertos do workspace", () => {
    const list = [view(), view({ projectId: "p2", state: "concluido" }), view({ projectId: "p3", workspace: "design", state: "esperando_voce" })];
    expect(list.filter(isOpenRequest)).toHaveLength(2);
    expect(openRequestsOf(list, "linkedin")).toHaveLength(1);
    expect(requestsBadge(0)).toBe("");
    expect(requestsBadge(1)).toBe("1 pedido do Cyno");
    expect(requestsBadge(3)).toBe("3 pedidos do Cyno");
  });
});
