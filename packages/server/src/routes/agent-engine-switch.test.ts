import type { Agent, ModelDefaults } from "@cyno/shared";
import { INITIAL_MODEL_DEFAULTS } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, soloTeam } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";

const setupApp = useTestApp();

describe("API: trocar o motor de um agente", () => {
  it("trocar só o motor limpa o modelo e o esforço do motor anterior", async () => {
    const { app } = await setupApp();
    const { agent } = await soloTeam(app, "Troca");
    await call<Agent>(app, "PATCH", `/api/w/principal/agents/${agent.id}`, { engine: "claude", model: "sonnet", effort: "high" });
    const switched = await call<Agent>(app, "PATCH", `/api/w/principal/agents/${agent.id}`, { engine: "gemini" });
    expect(switched.engine).toBe("gemini");
    expect(switched.model).toBeUndefined();
    expect(switched.effort).toBeUndefined();
  });

  it("trocar o motor com modelo novo guarda o modelo; o esforço de modelo Gemini não é guardado", async () => {
    const { app } = await setupApp();
    const { agent } = await soloTeam(app, "Troca 2");
    await call<Agent>(app, "PATCH", `/api/w/principal/agents/${agent.id}`, { engine: "claude", model: "sonnet", effort: "high" });
    const switched = await call<Agent>(app, "PATCH", `/api/w/principal/agents/${agent.id}`, { engine: "gemini", model: "gemini-3.8-flash-medium", effort: "high" });
    expect(switched).toMatchObject({ engine: "gemini", model: "gemini-3.8-flash-medium" });
    expect(switched.effort).toBeUndefined();
  });

  it("mudar só o modelo para Gemini no mesmo agente também tira o esforço (o Maestro nascido com esforço alto)", async () => {
    const { app } = await setupApp();
    const { agent } = await soloTeam(app, "Troca 3");
    await call<Agent>(app, "PATCH", `/api/w/principal/agents/${agent.id}`, { engine: "gemini", model: "outro-modelo-1", effort: "high" });
    const same = await call<Agent>(app, "PATCH", `/api/w/principal/agents/${agent.id}`, { model: "gemini-3.8-flash-medium" });
    expect(same.model).toBe("gemini-3.8-flash-medium");
    expect(same.effort).toBeUndefined();
  });

  it("sem trocar de motor, o modelo e o esforço continuam (Claude Code)", async () => {
    const { app } = await setupApp();
    const { agent } = await soloTeam(app, "Troca 4");
    await call<Agent>(app, "PATCH", `/api/w/principal/agents/${agent.id}`, { engine: "claude", model: "sonnet", effort: "high" });
    const renamed = await call<Agent>(app, "PATCH", `/api/w/principal/agents/${agent.id}`, { name: "Outro nome" });
    expect(renamed).toMatchObject({ engine: "claude", model: "sonnet", effort: "high" });
  });

  it("os Modelos padrão não guardam esforço onde o motor e o modelo não o aceitam", async () => {
    const { app } = await setupApp();
    const defaults: ModelDefaults = {
      ...INITIAL_MODEL_DEFAULTS,
      maestro: { engine: "gemini", model: "gemini-3.8-flash-medium", effort: "high" },
      agentes: { engine: "claude", model: "sonnet", effort: "medium" },
      subagentes: { claude: { model: "haiku", effort: "low" }, gemini: { model: "gemini-3.8-flash-medium", effort: "high" } },
    };
    const saved = await call<{ defaults: ModelDefaults }>(app, "PUT", "/api/settings/models", { defaults });
    expect(saved.defaults.maestro).toEqual({ engine: "gemini", model: "gemini-3.8-flash-medium" });
    expect(saved.defaults.agentes).toEqual({ engine: "claude", model: "sonnet", effort: "medium" });
    expect(saved.defaults.subagentes).toEqual({ claude: { model: "haiku" }, gemini: { model: "gemini-3.8-flash-medium" } });
  });
});
