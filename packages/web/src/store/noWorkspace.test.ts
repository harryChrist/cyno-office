import { MAESTRO, type Workspace } from "@cyno/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { settingsHash, settingsSectionFromHash } from "../pages/settings/settingsView";
import { createWorkspaceBody, newWorkspaceValues, validateNewWorkspace } from "../ui/workspaceFormLogic";
import { hashFor, parseHash, useNavStore } from "./navStore";
import { useWorkspaceStore, workspaceView } from "./workspaceStore";

const AT = "2026-01-01T00:00:00.000Z";
const LIST: Workspace[] = [
  { id: "principal", name: "Principal", createdAt: AT },
  { id: "linkedin", name: "LinkedIn", createdAt: AT },
];

describe("sem workspace: endereços", () => {
  it("as Configurações abrem sem workspace, com ou sem seção", () => {
    expect(parseHash("#/configuracoes")).toEqual({ workspaceId: null, page: "configuracoes" });
    expect(parseHash("#/configuracoes/motores")).toEqual({ workspaceId: null, page: "configuracoes", sub: "motores" });
    expect(settingsSectionFromHash("#/configuracoes/motores")).toBe("motores");
    expect(settingsSectionFromHash("#/configuracoes")).toBe("senha");
    expect(settingsSectionFromHash(settingsHash(null, "historico"))).toBe("historico");
    // Com workspace, nada muda.
    expect(settingsSectionFromHash("#/principal/configuracoes/motores")).toBe("motores");
    expect(parseHash(hashFor({ workspaceId: null, page: "office" }))).toEqual({ workspaceId: null, page: "office" });
  });
});

describe("sem workspace: lista e navegação", () => {
  beforeEach(() => {
    useNavStore.setState({ workspaceId: null, page: "office" });
    useWorkspaceStore.setState({ workspaces: null });
  });

  it("workspaceView: carregando, vazio ou pronto", () => {
    expect(workspaceView(null, "principal")).toBe("loading");
    expect(workspaceView([], null)).toBe("empty");
    expect(workspaceView([], "principal")).toBe("empty");
    expect(workspaceView(LIST, "linkedin")).toBe("ready");
    // Endereço de um workspace que não existe mais: ainda trocando (a lista leva para outro).
    expect(workspaceView(LIST, "excluido")).toBe("loading");
  });

  it("endereço de workspace inexistente com a lista vazia cai no estado vazio", () => {
    useNavStore.setState({ workspaceId: "principal", page: "trabalho" });
    useWorkspaceStore.getState().setList([]);
    expect(useNavStore.getState()).toMatchObject({ workspaceId: null, page: "office" });
    expect(workspaceView(useWorkspaceStore.getState().workspaces, useNavStore.getState().workspaceId)).toBe("empty");
  });

  it("endereço de workspace inexistente com outros na lista cai no primeiro", () => {
    useNavStore.setState({ workspaceId: "excluido", page: "gestao" });
    useWorkspaceStore.getState().setList(LIST);
    expect(useNavStore.getState()).toMatchObject({ workspaceId: "principal", page: "gestao" });
  });

  it("as Configurações continuam abertas quando o último workspace some", () => {
    useNavStore.setState({ workspaceId: "principal", page: "configuracoes" });
    useWorkspaceStore.getState().setList([]);
    expect(useNavStore.getState()).toMatchObject({ workspaceId: null, page: "configuracoes" });
  });

  it("criar do zero: a lista nova abre o workspace criado", () => {
    useWorkspaceStore.getState().setList([]);
    expect(useNavStore.getState().workspaceId).toBeNull();
    useWorkspaceStore.getState().setList([{ id: "do-zero", name: "Do Zero", createdAt: AT }]);
    expect(useNavStore.getState()).toMatchObject({ workspaceId: "do-zero", page: "office" });
  });
});

describe("formulário de workspace novo", () => {
  const opus = { engine: "claude", model: "opus", effort: "high" } as const;

  it("sem mexer no Maestro, manda só o nome", () => {
    const values = { ...newWorkspaceValues(), name: "  Loja  " };
    expect(createWorkspaceBody(values, opus)).toEqual({ name: "Loja" });
    // Motor igual ao padrão global também não vai.
    values.maestro.engine = { engine: "claude", model: "opus", effort: "high" };
    expect(createWorkspaceBody(values, opus)).toEqual({ name: "Loja" });
  });

  it("acesso dos agentes: só o que difere dos padrões vai no corpo", () => {
    const values = { ...newWorkspaceValues(), name: "Loja" };
    expect(values.access).toEqual({ internet: true, browser: true, terminal: false });
    values.access = { internet: true, browser: false, terminal: true };
    expect(createWorkspaceBody(values, opus)).toEqual({ name: "Loja", access: { browser: false, terminal: true } });
  });

  it("manda do Maestro só o que mudou", () => {
    const values = newWorkspaceValues();
    values.name = "Loja";
    values.maestro = {
      name: " Gon ",
      avatar: { skin: "tone5", hair: "curly", hairColor: "lavender", shirt: "mint", pants: "denim" },
      engine: { engine: "gemini", model: "", effort: "" },
      instructions: "  Fale curto.  ",
      sessionName: "  Maestro da Loja  ",
    };
    expect(createWorkspaceBody(values, opus)).toEqual({
      name: "Loja",
      maestro: {
        name: "Gon",
        avatar: { skin: "tone5", hair: "curly", hairColor: "lavender", shirt: "mint", pants: "denim" },
        choice: { engine: "gemini" },
        instructions: "Fale curto.",
        sessionName: "Maestro da Loja",
      },
    });
    // Nome vazio = o padrão ("Maestro").
    values.maestro.name = "  ";
    expect(createWorkspaceBody(values, opus).maestro?.name).toBeUndefined();
    expect(newWorkspaceValues().maestro.name).toBe(MAESTRO.agentName);
  });

  it("valida o nome do workspace e os limites do Maestro", () => {
    const values = newWorkspaceValues();
    expect(validateNewWorkspace(values)).toEqual({ name: "Dê um nome ao workspace." });
    values.name = "Loja";
    values.maestro.name = "M".repeat(25);
    expect(Object.keys(validateNewWorkspace(values))).toEqual(["maestroName"]);
    values.maestro.name = "Gon";
    values.maestro.sessionName = "S".repeat(81);
    expect(validateNewWorkspace(values)).toEqual({ sessionName: "Use no máximo 80 caracteres." });
    values.maestro.sessionName = "linha\nquebrada";
    expect(Object.keys(validateNewWorkspace(values))).toEqual(["sessionName"]);
    // Vazio = o padrão: vale.
    values.maestro.sessionName = "";
    expect(validateNewWorkspace(values)).toEqual({});
  });
});
