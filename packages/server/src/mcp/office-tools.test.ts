import { autoForYouType, builtinForYouTypes, legacyForYouTypes, type ForYouTypeDef, type OfficeState } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { officeToolsFor, type OfficeToolsDeps } from "./office-tools";
import { handleMcpPayload, type McpTool } from "./protocol";

const AT = "2026-11-08T12:00:00.000Z";

/** Escritório mínimo: a Sala do Maestro (Gerência) e um time com a Clara. */
const STATE = {
  rooms: [
    { id: "gerencia", name: "Sala do Maestro", kind: "maestro" },
    { id: "conteudo", name: "Conteúdo", kind: "team" },
  ],
  teams: [
    { id: "t-ger", roomId: "gerencia", name: "Gerência", focus: "coordenar" },
    { id: "t-cont", roomId: "conteudo", name: "Conteúdo", focus: "textos" },
  ],
  agents: [
    { id: "maestro", teamId: "t-ger", name: "Maestro" },
    { id: "clara", teamId: "t-cont", name: "Clara" },
  ],
  tasks: [],
} as unknown as OfficeState;

/** Tipos do workspace: os de antes mais a "Legenda de post" (2.200, o limite do Instagram). */
const legenda: ForYouTypeDef = {
  ...autoForYouType("Legenda de post", [], AT),
  description: "Legenda de um post no Instagram.",
  limits: { default: 2200 },
};
const TYPES: ForYouTypeDef[] = [...legacyForYouTypes(AT), legenda];

function setup(types: ForYouTypeDef[] = TYPES) {
  const maestro = {
    team: vi.fn(() => "equipe"),
    openRequest: vi.fn(() => ({ id: "4f0a2b8e-1111-4c4c-9a9a-123456789abc" })),
    delegate: vi.fn(() => "Subtarefa criada."),
    viewTask: vi.fn(() => "tarefa"),
    conclude: vi.fn(() => "ok"),
    requestApproval: vi.fn(() => "Pedido de aprovação F-0001 enviado ao usuário."),
  };
  const runner = {
    deliver: vi.fn(() => "Entregue."),
    progress: vi.fn(() => "ok"),
    requestApproval: vi.fn(() => "Pedido de aprovação enviado ao usuário."),
  };
  const forYouTypes = { list: () => structuredClone(types), define: vi.fn() };
  const deps = { state: { read: () => STATE }, maestro, runner, forYouTypes } as unknown as OfficeToolsDeps;
  const tools = (agentId: string) => officeToolsFor(agentId, deps);
  const call = async (agentId: string, name: string, args: Record<string, unknown>) => {
    const tool = tools(agentId).find((candidate) => candidate.name === name)!;
    return tool.call(tool.input.parse(args));
  };
  return { maestro, runner, tools, call };
}

describe("request_approval confere o limite do tipo", () => {
  it("agente: acima do limite volta erro (em inglês, para o modelo) e o item não é criado", async () => {
    const { runner, call } = setup();
    const result = await call("clara", "request_approval", { question: "Posso postar?", approval_type: "legenda-de-post", text: "x".repeat(2450), where: "Legenda do post 3" });
    expect(result).toEqual({
      text: 'The text is over the limit of "Legenda de post" (where: Legenda do post 3): 2.450 of 2.200 characters. Shorten it and call request_approval again.',
      isError: true,
    });
    expect(runner.requestApproval).not.toHaveBeenCalled();
  });

  it("Maestro: limite pelo 'onde' (headline do perfil = 220), sem criar o item", async () => {
    const { maestro, call } = setup();
    const result = await call("maestro", "request_approval", { question: "Headline nova?", approval_type: "perfil", text: "y".repeat(230), where: "Headline" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('limit of "Perfil" (where: Headline): 230 of 220 characters');
    expect(maestro.requestApproval).not.toHaveBeenCalled();
  });

  it("dentro do limite (contando emoji como 1) o pedido segue", async () => {
    const { runner, maestro, call } = setup();
    const ok = await call("clara", "request_approval", { question: "Posso postar?", approval_type: "Legenda de post", text: "🎉".repeat(2200) });
    expect(ok).toEqual({ text: "Pedido de aprovação enviado ao usuário." });
    expect(runner.requestApproval).toHaveBeenCalledWith("clara", "Posso postar?", { type: "Legenda de post", text: "🎉".repeat(2200), where: undefined, to: undefined });
    const sobre = await call("maestro", "request_approval", { question: "Sobre?", approval_type: "perfil", text: "z".repeat(2500), where: "Sobre" });
    expect(sobre.isError).toBeUndefined();
    expect(maestro.requestApproval).toHaveBeenCalledTimes(1);
  });

  it("tipo que ainda não existe: o modelo dos de antes vale (convite = 200); tipo novo não tem limite", async () => {
    const { runner, call } = setup(builtinForYouTypes(AT));
    expect((await call("clara", "request_approval", { question: "Convite?", approval_type: "convite", text: "a".repeat(201) })).isError).toBe(true);
    expect((await call("clara", "request_approval", { question: "Reels?", approval_type: "reels", text: "a".repeat(5000) })).isError).toBeUndefined();
    expect(runner.requestApproval).toHaveBeenCalledTimes(1);
  });

  it("pelo MCP (JSON-RPC): o erro chega ao modelo como isError", async () => {
    const { runner, tools } = setup();
    const response = await handleMcpPayload(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "request_approval", arguments: { question: "Convite?", approval_type: "convite", text: "b".repeat(250) } } },
      () => tools("clara"),
    );
    expect(response).toMatchObject({ result: { isError: true, content: [{ type: "text", text: expect.stringContaining('"Convite": 250 of 200 characters') }] } });
    expect(runner.requestApproval).not.toHaveBeenCalled();
  });

  it("a descrição do request_approval do agente lista os tipos com os limites", () => {
    const { tools } = setup();
    const tool = tools("clara").find((candidate) => candidate.name === "request_approval") as McpTool;
    expect(tool.description).toContain("legenda-de-post (Legenda de post): Legenda de um post no Instagram. [limit 2.200 characters]");
    expect(tool.description).toContain("above it, the request returns an error");
  });
});

describe("open_request", () => {
  it("abre o pedido com título, briefing e a frase de origem e devolve o id para as próximas ferramentas", async () => {
    const { maestro, call } = setup();
    const result = (await call("maestro", "open_request", { title: "Post sobre IA", description: "Post para o LinkedIn, tom leve, até 1.300 caracteres", user_quote: "pode pedir para o time escrever" })) as { text: string };
    expect(maestro.openRequest).toHaveBeenCalledWith({ title: "Post sobre IA", description: "Post para o LinkedIn, tom leve, até 1.300 caracteres", origin: "pode pedir para o time escrever" });
    expect(result.text).toContain("Request 4f0a2b8e-1111-4c4c-9a9a-123456789abc opened");
    expect(result.text).toContain('delegate_task(request_id: "4f0a2b8e-1111-4c4c-9a9a-123456789abc"');
  });
});

describe("delegate_task leva o tipo e o limite para o agente", () => {
  it("com tipo: o pedido da subtarefa traz nome, descrição e limite", async () => {
    const { maestro, call } = setup();
    await call("maestro", "delegate_task", { agent_id: "clara", task: "Escreva a legenda do post de lançamento", reason: "redatora", approval_type: "legenda-de-post" });
    const pedido = (maestro.delegate.mock.calls[0] as unknown as [{ task: string }])[0].task;
    expect(pedido).toContain("Escreva a legenda do post de lançamento");
    expect(pedido).toContain('"Legenda de post" (approval_type: "legenda-de-post"): Legenda de um post no Instagram.');
    expect(pedido).toContain("Limite: 2.200 caracteres.");
    expect(pedido).toContain('Use request_approval com approval_type: "legenda-de-post".');
    expect(maestro.delegate).toHaveBeenCalledWith(expect.objectContaining({ approvalType: "legenda-de-post" }));
  });

  it("limites por 'onde' e tipo mencionado no pedido", async () => {
    const { maestro, call } = setup();
    await call("maestro", "delegate_task", { agent_id: "clara", task: 'Nova headline (tipo: "perfil")' });
    const pedido = (maestro.delegate.mock.calls[0] as unknown as [{ task: string }])[0].task;
    expect(pedido).toContain('"headline…" (headline) = 220');
  });

  it("sem tipo: o pedido vai como veio", async () => {
    const { maestro, call } = setup();
    await call("maestro", "delegate_task", { team_id: "t-cont", task: "Pesquise o tema", request_id: "p-1" });
    expect(maestro.delegate).toHaveBeenCalledWith({ agentId: undefined, teamId: "t-cont", task: "Pesquise o tema", reason: undefined, requestId: "p-1" });
  });
});

describe("contrato MCP em inglês", () => {
  it("o Maestro e os agentes só têm nomes em inglês; ask_user é o mesmo nome para os dois", () => {
    const { tools } = setup();
    const maestro = tools("maestro").map((tool) => tool.name);
    const worker = tools("clara").map((tool) => tool.name);
    expect(worker).toEqual(["get_task", "ask_user", "request_help", "send_to_colleague", "submit_result", "report_progress", "request_approval"]);
    expect(maestro).toEqual(expect.arrayContaining(["get_team", "open_request", "delegate_task", "get_task", "complete_request", "request_approval", "ask_user", "set_approval_type"]));
    for (const name of [...maestro, ...worker]) expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it("nome antigo (sessão retomada) volta erro claro apontando o novo, sem executar nada", async () => {
    const { runner, tools } = setup();
    const response = await handleMcpPayload({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "entregar", arguments: { resultado: "x" } } }, () => tools("clara"));
    expect(response).toMatchObject({ result: { isError: true, content: [{ type: "text", text: expect.stringContaining('renamed to "submit_result"') }] } });
    expect(runner.deliver).not.toHaveBeenCalled();
    const unknown = await handleMcpPayload({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "nao_existe", arguments: {} } }, () => tools("clara"));
    expect(unknown).toMatchObject({ error: { message: "Unknown tool: nao_existe" } });
  });
});

describe("set_workspace_summary (a frase da ficha)", () => {
  const withStore = (stored: "frase" | "sugestao" | "igual") => {
    const write = vi.fn(async () => ({ stored, summary: { summary: "x", by: "maestro" as const } }));
    const deps = { state: { read: () => STATE }, maestro: {}, runner: {}, forYouTypes: { list: () => [] }, cardSummary: { get: () => ({ summary: "", by: "dono" as const }), write } } as unknown as OfficeToolsDeps;
    return { write, tool: (agentId: string) => officeToolsFor(agentId, deps).find((candidate) => candidate.name === "set_workspace_summary") };
  };

  it("só o Maestro tem; agente de time não escreve a ficha", () => {
    const { tool } = withStore("frase");
    expect(tool("maestro")).toBeDefined();
    expect(tool("clara")).toBeUndefined();
  });

  it("grava como 'maestro', rejeita mais de 280 caracteres e explica quando vira sugestão", async () => {
    const { write, tool } = withStore("frase");
    const maestroTool = tool("maestro")!;
    expect((await maestroTool.call(maestroTool.input.parse({ text: "Posts do perfil." }))).text).toMatch(/^Saved/);
    expect(write).toHaveBeenCalledWith("Posts do perfil.", "maestro");
    expect(maestroTool.input.safeParse({ text: "x".repeat(281) }).success).toBe(false);
    const suggested = withStore("sugestao").tool("maestro")!;
    expect((await suggested.call(suggested.input.parse({ text: "Outra" }))).text).toMatch(/suggestion/);
  });

  it("sem o armazenamento da ficha, a ferramenta não existe", () => {
    const deps = { state: { read: () => STATE }, maestro: {}, runner: {}, forYouTypes: { list: () => [] } } as unknown as OfficeToolsDeps;
    expect(officeToolsFor("maestro", deps).some((candidate) => candidate.name === "set_workspace_summary")).toBe(false);
  });
});
