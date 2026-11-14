import type { Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { seedDataDir } from "./seed";
import { principalDir, useTestApp } from "../../dev/test-app";
import { useTempDirs, writeDiskTasks } from "../../dev/test-utils";
import { call, getOffice } from "../../dev/test-api";

const setupApp = useTestApp();
const tempDir = useTempDirs();

describe("review: Orchestrator.resume", () => {
  // office.json e tasks.json são gravados em sequência (não atomicamente juntos). Se o server cair
  // depois de gravar office.json (agente removido) e antes de tasks.json, a tarefa fica
  // in_progress apontando para um agente inexistente. No boot ela volta para "queued" e nunca sai.
  it("tarefa interrompida de agente que não existe mais não fica presa em queued após reinício", async () => {
    const dir = await tempDir();
    await seedDataDir(dir);
    const at = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const stuck: Task = {
      id: "t-orfa",
      roomId: "projetox",
      teamId: "projetox-frontend",
      agentId: "agente-removido",
      prompt: "Tarefa interrompida",
      status: "in_progress",
      createdAt: at,
      updatedAt: at,
    };
    await writeDiskTasks(principalDir(dir), [stuck]);

    const { app } = await setupApp({ dataDir: dir });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const task = (await getOffice(app)).tasks.find((candidate) => candidate.id === "t-orfa")!;
    expect(task.status).toBe("failed");
    const listed = await call<Task[]>(app, "GET", "/api/w/principal/tasks?agentId=agente-removido");
    expect(listed.every((candidate) => candidate.status !== "queued")).toBe(true);
  });
});
