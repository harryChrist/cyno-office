import { describe, expect, it } from "vitest";
import { useTestApp } from "../../dev/test-app";
import { maestroToolBridge, type ScopedHost } from "./scoped";

const setupApp = useTestApp();

async function setup() {
  const test = await setupApp();
  const host: ScopedHost = { workspaces: test.workspaces, simulated: true };
  const tools = maestroToolBridge(host);
  const call = async (name: string, args: object = {}) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`ferramenta ${name} não existe`);
    const parsed = tool.input.parse(args);
    return tool.call(parsed);
  };
  return { test, tools, call };
}

describe("ponte do Cyno para ferramentas do Maestro (maestroToolBridge)", () => {
  it("workspace_tools lista ferramentas do Maestro (com filtro query) e omite todas as de BRIDGE_EXCLUDED", async () => {
    const t = await setup();
    const listed = await t.call("workspace_tools", { workspace: "principal" });
    expect(listed.isError).toBeUndefined();
    expect(listed.text).toMatch(/^Tools of workspace "Principal" \(\d+\):/);
    expect(listed.text).toMatch(/^- save_note: /m);
    expect(listed.text).toMatch(/^- read_note: /m);
    expect(listed.text).toMatch(/^- search_notes: /m);
    expect(listed.text).toMatch(/^- list_projects: /m);
    for (const excluded of ["ask_cyno", "delete_agent", "delete_room", "delete_team", "agenda_book", "create_room", "get_team", "mural_list", "get_usage", "message_agent", "cancel_request"]) {
      expect(listed.text).not.toMatch(new RegExp(`^- ${excluded}:`, "m"));
    }

    const filtered = await t.call("workspace_tools", { workspace: "Principal", query: "save_note" });
    expect(filtered.isError).toBeUndefined();
    expect(filtered.text).toMatch(/^- save_note: /m);
    expect(filtered.text).not.toMatch(/^- list_projects: /m);
  });

  it("workspace_tools com `tool` devolve descrição completa e `Input schema:` com JSON válido", async () => {
    const t = await setup();
    const detail = await t.call("workspace_tools", { workspace: "principal", tool: "save_note" });
    expect(detail.isError).toBeUndefined();
    expect(detail.text).toMatch(/^save_note\n/);
    expect(detail.text).toContain("Input schema:\n");
    const raw = detail.text.split("Input schema:\n")[1];
    expect(raw).toBeDefined();
    const schema = JSON.parse(raw!) as { type?: string; properties?: Record<string, unknown> };
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("title");
    expect(schema.properties).toHaveProperty("content");
    expect(schema.properties).toHaveProperty("kind");
    expect(schema.properties).toHaveProperty("brain");
  });

  it("use_workspace_tool executa ferramentas do Maestro no workspace (salva e lê uma nota do Cérebro)", async () => {
    const t = await setup();
    const saved = await t.call("use_workspace_tool", {
      workspace: "principal",
      tool: "save_note",
      args: { title: "Nota da ponte", content: "Conteúdo gravado pelo Cyno via ponte.", kind: "doc" },
    });
    expect(saved.isError).toBeUndefined();
    const match = /Note saved: `([^`]+)`/.exec(saved.text);
    expect(match).not.toBeNull();

    const read = await t.call("use_workspace_tool", {
      workspace: "principal",
      tool: "read_note",
      args: { path: match![1]! },
    });
    expect(read.isError).toBeUndefined();
    expect(read.text).toContain("Conteúdo gravado pelo Cyno via ponte.");
  });

  it("use_workspace_tool devolve isError com 'Invalid arguments' quando os argumentos não passam no schema zod", async () => {
    const t = await setup();
    const bad = await t.call("use_workspace_tool", {
      workspace: "principal",
      tool: "save_note",
      args: { title: "", kind: "invalido" },
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/^Invalid arguments for save_note:/);
  });

  it("ferramenta excluída ou inexistente devolve isError com 'No tool' tanto em workspace_tools quanto em use_workspace_tool", async () => {
    const t = await setup();
    for (const tool of ["ask_cyno", "delete_agent", "agenda_book", "ferramenta_que_nao_existe"]) {
      const used = await t.call("use_workspace_tool", { workspace: "principal", tool });
      expect(used.isError).toBe(true);
      expect(used.text).toMatch(new RegExp(`^No tool "${tool}"`));

      const described = await t.call("workspace_tools", { workspace: "principal", tool });
      expect(described.isError).toBe(true);
      expect(described.text).toMatch(new RegExp(`^No tool "${tool}"`));
    }
  });

  it("workspace inexistente devolve isError com 'No workspace'", async () => {
    const t = await setup();
    const listed = await t.call("workspace_tools", { workspace: "nao-existe" });
    expect(listed.isError).toBe(true);
    expect(listed.text).toMatch(/^No workspace "nao-existe"/);

    const used = await t.call("use_workspace_tool", {
      workspace: "nao-existe",
      tool: "save_note",
      args: { title: "X", content: "Y", kind: "doc" },
    });
    expect(used.isError).toBe(true);
    expect(used.text).toMatch(/^No workspace "nao-existe"/);
  });
});
