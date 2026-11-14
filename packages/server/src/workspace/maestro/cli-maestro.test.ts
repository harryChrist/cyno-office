import type { Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { restartResume } from "./cli-maestro";

const at = "2026-11-10T12:00:00.000Z";
const request: Task = { id: "pedido-1", roomId: "sala-do-maestro", teamId: "maestro", agentId: "maestro", prompt: "Post sobre IA", status: "in_progress", createdAt: at, updatedAt: at };
const subtask = (id: string, status: Task["status"], result?: string): Task => ({
  id,
  roomId: "projetoy",
  teamId: "projetoy-conteudo",
  agentId: "beto",
  projectId: request.id,
  prompt: `parte ${id}`,
  status,
  createdAt: at,
  updatedAt: at,
  ...(result ? { result } : {}),
});
const names = (agentId: string | undefined) => (agentId === "beto" ? "Beto" : (agentId ?? "?"));

describe("restartResume (boot do Maestro de CLI: acordar ou não por um pedido aberto)", () => {
  it("sem subtarefa: acorda o Maestro para continuar de onde parou", () => {
    const next = restartResume(request, [], names);
    expect(next).toEqual({ wake: "O servidor reiniciou. O pedido pedido-1 ainda está aberto: Post sobre IA\n\nNenhuma subtarefa ainda.\n\nContinue de onde parou." });
  });

  it("todas as subtarefas terminadas: acorda, com o estado e o resultado de cada uma", () => {
    const next = restartResume(request, [subtask("a", "done", "texto pronto"), subtask("b", "failed", "sem acesso")], names);
    expect("wake" in next && next.wake).toContain("Subtarefas:\n- a (Beto): done — texto pronto\n- b (Beto): failed — sem acesso");
  });

  it("alguma subtarefa ainda andando: não acorda; as já terminadas viram só um aviso para a próxima mensagem", () => {
    expect(restartResume(request, [subtask("a", "in_progress"), subtask("b", "queued")], names)).toEqual({});
    expect(restartResume(request, [subtask("a", "waiting_approval")], names)).toEqual({});
    const next = restartResume(request, [subtask("a", "done", "texto pronto"), subtask("b", "in_progress")], names);
    expect("wake" in next).toBe(false);
    expect(next).toEqual({ notice: "O servidor reiniciou enquanto o pedido pedido-1 esperava subtarefas; estas já tinham terminado (detalhes com get_task): a (Beto): done." });
  });
});
