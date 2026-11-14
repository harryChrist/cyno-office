import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LAB, offlineLabApi, setupLab } from "./lab";
import { seedDataDir } from "../workspace/office/seed";
import { rootPaths } from "../store/paths";
import { useTempDirs } from "./test-utils";

const tempDir = useTempDirs();

describe("lab:setup (workspace Laboratório)", () => {
  it("cria o Laboratório com o Maestro e o Redator em motor claude e o Pesquisador no Antigravity, sem mexer no principal; rodar de novo não muda nada", async () => {
    const dataDir = await tempDir();
    await seedDataDir(dataDir);
    const principalFile = path.join(rootPaths(dataDir).workspaceDir("principal"), "office.json");
    const principalOffice = await readFile(principalFile, "utf8");

    const api = await offlineLabApi(dataDir);
    const first = await setupLab(api);
    expect(first.workspace).toMatchObject({ id: LAB.id, name: "Laboratório" });
    expect(first.maestro.engine).toBe("claude");
    expect(first.room).toMatchObject({ name: "Conteúdo", kind: "team", readsGlobalBrain: true });
    expect(first.team).toMatchObject({ name: "Conteúdo", focus: "escrever textos curtos" });
    expect(first.agent).toMatchObject({ name: "Redator", engine: "claude", teamId: first.team.id });
    expect(first.research.room).toMatchObject({ name: "Pesquisa", kind: "team" });
    expect(first.research.team).toMatchObject({ name: "Pesquisa", roomId: first.research.room.id });
    expect(first.research.agent).toMatchObject({ name: "Pesquisador", engine: "gemini", model: "gemini-3.8-flash-medium", teamId: first.research.team.id });
    expect(first.changes.length).toBeGreaterThan(0);

    const second = await setupLab(api);
    expect(second.changes).toEqual([]);
    expect(second.agent.id).toBe(first.agent.id);
    const office = await api.office(LAB.id);
    expect(office.agents.filter((agent) => agent.name === "Redator")).toHaveLength(1);
    expect(office.agents.filter((agent) => agent.name === "Pesquisador")).toHaveLength(1);

    // Laboratório antigo (só com o Redator) ou Pesquisador mexido à mão: o setup acerta.
    await api.updateAgent(LAB.id, first.research.agent.id, { engine: "claude", model: null });
    const third = await setupLab(api);
    expect(third.changes).toEqual(["Pesquisador agora roda no Antigravity (gemini-3.8-flash-medium)"]);
    expect(third.research.agent).toMatchObject({ engine: "gemini", model: "gemini-3.8-flash-medium" });
    await api.close();

    expect(await readFile(principalFile, "utf8")).toBe(principalOffice);
  });
});
