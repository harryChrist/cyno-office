import { readFile } from "node:fs/promises";
import path from "node:path";
import { INITIAL_MODEL_DEFAULTS, MODEL_DEFAULTS_PATH, type ModelDefaults, type ModelDefaultsResponse, type Workspace } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, createWorkspace, getOffice } from "../../dev/test-api";
import { TEST_MODEL_DEFAULTS, useTestApp } from "../../dev/test-app";

const setupApp = useTestApp();

const putDefaults = async (app: Awaited<ReturnType<typeof setupApp>>["app"], defaults: ModelDefaults) => {
  const response = await app.inject({ method: "PUT", url: MODEL_DEFAULTS_PATH, payload: { defaults } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as ModelDefaultsResponse;
};

describe("modelos padrão: só preenchem o que nasce", () => {
  it("padrões iniciais da instalação: tudo no Sonnet (Maestro alto) e Gemini 3.8 Flash no Antigravity", () => {
    expect(INITIAL_MODEL_DEFAULTS).toEqual({
      maestro: { engine: "claude", model: "sonnet", effort: "high" },
      agentes: { engine: "claude", model: "sonnet", effort: "medium" },
      subagentes: { claude: { model: "sonnet", effort: "medium" }, gemini: { model: "gemini-3.8-flash-medium" } },
      // O Cyno (agente da plataforma): Claude Sonnet, esforço médio.
      cyno: { engine: "claude", model: "sonnet", effort: "medium" },
    });
  });

  it("workspace antigo (principal) ganha os padrões globais na migração; os agentes dele não mudam", async () => {
    const { app, dataDir } = await setupApp({ initialModelDefaults: INITIAL_MODEL_DEFAULTS });
    const [principal] = await call<Workspace[]>(app, "GET", "/api/workspaces");
    expect(principal!.models).toEqual(INITIAL_MODEL_DEFAULTS);
    const saved = JSON.parse(await readFile(path.join(dataDir, "workspaces.json"), "utf8")) as Workspace[];
    expect(saved[0]!.models).toEqual(INITIAL_MODEL_DEFAULTS);
    // O Maestro do principal continua simulado (nunca vira motor pago sozinho).
    const maestro = (await getOffice(app)).agents.find((agent) => agent.id === "maestro")!;
    expect(maestro.engine).toBeUndefined();
    expect(maestro.model).toBeUndefined();
  });

  it("workspace novo: padrões copiados dos globais e o Maestro nasce com o padrão `maestro`", async () => {
    const { app } = await setupApp({ initialModelDefaults: INITIAL_MODEL_DEFAULTS });
    const created = await createWorkspace(app, "LinkedIn");
    expect(created.models).toEqual(INITIAL_MODEL_DEFAULTS);
    const maestro = (await getOffice(app, "linkedin")).agents.find((agent) => agent.role === "maestro")!;
    expect(maestro).toMatchObject({ engine: "claude", model: "sonnet", effort: "high" });
  });

  it("mudar o global não mexe nos workspaces existentes; só vale para os novos", async () => {
    const { app } = await setupApp();
    const before = await createWorkspace(app, "Antes");
    expect(before.models).toEqual(TEST_MODEL_DEFAULTS);
    expect((await call<ModelDefaultsResponse>(app, "GET", MODEL_DEFAULTS_PATH)).defaults).toEqual(TEST_MODEL_DEFAULTS);

    // Sonnet com esforço: o Haiku não tem níveis de esforço, e o esforço que não vale para o modelo não é guardado.
    const next: ModelDefaults = { maestro: { engine: "mock" }, agentes: { engine: "claude", model: "sonnet", effort: "low" }, subagentes: { claude: { model: "haiku" } } };
    expect((await putDefaults(app, next)).defaults).toEqual(next);
    const semEsforco = await putDefaults(app, { ...next, agentes: { engine: "claude", model: "haiku", effort: "low" } });
    expect(semEsforco.defaults.agentes).toEqual({ engine: "claude", model: "haiku" });
    await putDefaults(app, next);
    const list = await call<Workspace[]>(app, "GET", "/api/workspaces");
    expect(list.find((ws) => ws.id === "antes")!.models).toEqual(TEST_MODEL_DEFAULTS);
    expect((await createWorkspace(app, "Depois")).models).toEqual(next);

    const invalid = await app.inject({ method: "PUT", url: MODEL_DEFAULTS_PATH, payload: { defaults: { ...next, agentes: { engine: "claude", model: "-x" } } } });
    expect(invalid.statusCode).toBe(400);
  });

  it("o global fica salvo em DATA_DIR/models.json e volta no reinício", async () => {
    const { app, dataDir } = await setupApp();
    const next: ModelDefaults = { ...TEST_MODEL_DEFAULTS, agentes: { engine: "claude", model: "sonnet" } };
    await putDefaults(app, next);
    expect(JSON.parse(await readFile(path.join(dataDir, "models.json"), "utf8"))).toEqual(next);
    await app.close();
    const again = await setupApp({ dataDir });
    expect((await call<ModelDefaultsResponse>(again.app, "GET", MODEL_DEFAULTS_PATH)).defaults).toEqual(next);
  });

  it("mudar os padrões do workspace não mexe nos agentes existentes; create_agent usa os novos", async () => {
    const { app, workspaces } = await setupApp();
    const office = await getOffice(app);
    const models: ModelDefaults = { ...TEST_MODEL_DEFAULTS, agentes: { engine: "claude", model: "opus", effort: "high" } };
    const updated = await call<Workspace>(app, "PATCH", "/api/workspaces/principal", { models });
    expect(updated).toMatchObject({ id: "principal", name: "Principal", models });
    expect((await getOffice(app)).agents).toEqual(office.agents);
    expect(workspaces.get("principal").models()?.agentes).toEqual(models.agentes);
    // Nome e modelos são opcionais, mas não os dois ao mesmo tempo.
    await call(app, "PATCH", "/api/workspaces/principal", {}, 400);
  });
});
