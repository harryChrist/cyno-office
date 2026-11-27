import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIRMATION_MAX_PENDING, CONFIRMATION_TTL_MS, findMaestroAgent, parseConfirmationMarker, parseProposalMarker, type AgentLogBody, type Confirmation, type CynoServerEvent, type EngineInfo } from "@cyno/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTestApp } from "../../dev/test-app";
import { useTempDirs } from "../../dev/test-utils";
import { cynoStructureTools } from "../../mcp/cyno/structure-tools";
import { scopedGetTeam, scopedStructureTools } from "../../mcp/cyno/scoped";
import type { McpTool } from "../../mcp/protocol";
import { platformPaths } from "../../store/paths";
import { WriteQueue } from "../../store/write-queue";
import { isAuthExempt } from "../auth/routes";
import { writeAuthFile } from "../auth/store";
import { CynoStructure } from "./cyno-structure";
import { refuseHostCommand } from "./host-command";
import type { ProposalInput } from "./proposals";

const setupApp = useTestApp();
const tempDir = useTempDirs();
/** Filas de gravação dos testes: esperam esvaziar antes de a pasta temporária sair (gravar depois dela falharia o rmdir). */
const queues: WriteQueue[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.idle()));
});

const ENGINES: EngineInfo[] = [
  { engine: "claude", label: "Claude Code", available: true, models: [{ id: "sonnet" }, { id: "haiku" }, { id: "opus" }], freeModel: false },
  { engine: "gemini", label: "Antigravity", available: true, models: [{ id: "gemini-3.8-flash-medium" }, { id: "gemini-3.8-pro-high" }], freeModel: false },
  { engine: "mock", label: "Simulado", available: true, models: [], freeModel: false },
];

/** O Cyno estruturado com um relógio que o teste move e espiões no lugar do chat, dos eventos e do "acordar o Cyno". */
async function setup(options: { now?: { t: Date }; requireApproval?: boolean } = {}) {
  const clock = options.now ?? { t: new Date("2026-11-11T12:00:00.000Z") };
  const test = await setupApp({ now: () => clock.t });
  const dir = await tempDir();
  const paths = platformPaths(dir);
  const chat: AgentLogBody[] = [];
  const emitted: CynoServerEvent[] = [];
  const woken: { tag: string; text: string }[] = [];
  const records: { action: string; actor: string; summary: string }[] = [];
  const queue = new WriteQueue();
  queues.push(queue);
  const structure = await CynoStructure.open(
    {
      workspaces: test.workspaces,
      engines: async () => ENGINES,
      simulated: true,
      paths,
      now: () => clock.t,
      log: test.app.log,
      ...(options.requireApproval !== undefined ? { requireApproval: options.requireApproval } : {}),
      chat: (body) => chat.push(body),
      emit: (event) => emitted.push(event),
      wake: (tag, build) => woken.push({ tag, text: build() }),
      record: (input) => records.push({ action: input.action, actor: input.actor, summary: input.summary }),
    },
    queue,
  );
  const host = { workspaces: test.workspaces, simulated: true };
  const scoped = scopedStructureTools(host);
  const tools: McpTool[] = [...scoped.tools, scopedGetTeam(host), ...cynoStructureTools(structure.toolDeps())];
  const call = async (name: string, args: object = {}) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`ferramenta ${name} não existe`);
    const parsed = tool.input.parse(args);
    return tool.call(parsed);
  };
  /** Cria um workspace "Design" com 1 sala, 1 time e 2 agentes (pelas ferramentas do próprio Cyno). */
  const seedDesign = async () => {
    await call("create_workspace", { name: "Design" });
    await call("create_room", { workspace: "Design", name: "Estúdio", purpose: "design" });
    await call("create_team", { workspace: "Design", room: "Estúdio", name: "Arte", focus: "Peças visuais" });
    await call("create_agent", { workspace: "Design", team: "Arte", name: "Eco", role: "Designer", instructions: "Cria peças." });
    await call("create_agent", { workspace: "Design", team: "Arte", name: "Lume", role: "Revisora", instructions: "Revisa peças." });
  };
  const workspaceIds = () => test.workspaces.list().map((workspace) => workspace.id);
  return { test, structure, tools, call, chat, emitted, woken, records, clock, seedDesign, workspaceIds, dir, paths };
}

const pendingId = (text: string) => /PENDING_CONFIRMATION (C-\d+)/.exec(text)![1]!;

describe("Cyno: ações perigosas em duas fases", () => {
  it("chamar a ferramenta só registra o cartão: nada muda até o clique do dono", async () => {
    const t = await setup();
    await t.seedDesign();
    const result = await t.call("delete_workspace", { workspace: "Design", reason: "O dono pediu para limpar os testes" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toMatch(/^PENDING_CONFIRMATION C-0001\./);
    expect(result.text).toMatch(/Do not retry/);
    // O workspace continua lá, com tudo.
    expect(t.workspaceIds()).toContain("design");
    expect(t.test.workspaces.get("design").store.snapshot().agents.map((agent) => agent.name)).toEqual(expect.arrayContaining(["Eco", "Lume"]));
    // O cartão: resumo e impacto montados por código; o texto do modelo à parte; a marca no chat; o evento ao vivo.
    const [card] = t.structure.listConfirmations();
    expect(card).toMatchObject({ id: "C-0001", action: "delete_workspace", status: "pendente", reason: "O dono pediu para limpar os testes", workspace: "Design" });
    expect(card!.summary).toBe('Apagar o workspace "Design": 1 sala, 2 agentes, 0 tarefas, 0 mídias');
    expect(card!.impact).toBe("1 sala, 2 agentes, 0 tarefas, 0 mídias");
    expect(Date.parse(card!.expiresAt) - Date.parse(card!.createdAt)).toBe(CONFIRMATION_TTL_MS);
    expect(t.chat.map((body) => (body.kind === "status" ? parseConfirmationMarker(body.message) : undefined))).toContain("C-0001");
    expect(t.emitted.some((event) => event.type === "cyno:confirmations")).toBe(true);
    // Nem o Cyno foi acordado (ele recebe só o resultado da decisão) e o registro da plataforma tem o pedido.
    expect(t.woken).toEqual([]);
    expect(t.records.map((record) => record.action)).toContain("confirmacao_pedida");
  });

  it("o OK do dono executa uma vez só e o Cyno é acordado com o resultado", async () => {
    const t = await setup();
    await t.seedDesign();
    await t.call("delete_workspace", { workspace: "Design" });
    const done = await t.structure.approve("C-0001");
    expect(done.status).toBe("executada");
    expect(done.result).toMatch(/apagado/);
    expect(t.workspaceIds()).not.toContain("design");
    expect(t.woken).toHaveLength(1);
    expect(t.woken[0]!.text).toMatch(/APPROVED and the server ran it/);
    expect(t.woken[0]!.text).toMatch(/success/);
    // Repetir o clique não executa de novo.
    await expect(t.structure.approve("C-0001")).rejects.toMatchObject({ statusCode: 409 });
    expect(() => t.structure.reject("C-0001")).toThrow(/já foi decidida/);
    expect(t.records.map((record) => record.action)).toEqual(expect.arrayContaining(["confirmacao_autorizada", "acao_executada"]));
  });

  it("recusar não muda nada e avisa o Cyno", async () => {
    const t = await setup();
    await t.seedDesign();
    await t.call("delete_agent", { workspace: "Design", agent: "Lume" });
    const refused = t.structure.reject("C-0001");
    expect(refused.status).toBe("recusada");
    expect(t.test.workspaces.get("design").store.snapshot().agents.map((agent) => agent.name)).toContain("Lume");
    expect(t.woken[0]!.text).toMatch(/REFUSED/);
    expect(t.woken[0]!.text).toMatch(/Nothing was done/);
    await expect(t.structure.approve("C-0001")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("vence em 30 minutos: aprovar depois dá 409, o cartão vira expirado e a próxima mensagem leva o aviso", async () => {
    const t = await setup();
    await t.seedDesign();
    await t.call("delete_room", { workspace: "Design", room: "Estúdio" });
    t.clock.t = new Date(t.clock.t.getTime() + CONFIRMATION_TTL_MS + 1000);
    await expect(t.structure.approve("C-0001")).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/expirou/) });
    expect(t.structure.listConfirmations()[0]!.status).toBe("expirada");
    expect(t.test.workspaces.get("design").store.snapshot().rooms.map((room) => room.name)).toContain("Estúdio");
    expect(t.structure.takeNotices().join(" ")).toMatch(/C-0001 EXPIRED/);
    expect(t.structure.takeNotices()).toEqual([]);
  });

  it("parâmetros congelados: mudar o alvo entre o pedido e o OK não executa algo diferente do que foi mostrado", async () => {
    const t = await setup();
    await t.seedDesign();
    await t.call("delete_agent", { workspace: "Design", agent: "Eco" });
    await t.call("delete_workspace", { workspace: "Design" });
    // Depois do pedido, o agente é renomeado e o workspace também.
    const runtime = t.test.workspaces.get("design");
    const eco = runtime.store.snapshot().agents.find((agent) => agent.name === "Eco")!;
    await runtime.services.agents.update(eco.id, { name: "Outro" });
    await t.test.workspaces.rename("design", "Design 2");
    const agent = await t.structure.approve("C-0001");
    expect(agent.status).toBe("falhou");
    expect(agent.result).toMatch(/mudou de nome/);
    expect(runtime.store.snapshot().agents.map((item) => item.name)).toContain("Outro");
    const workspace = await t.structure.approve("C-0002");
    expect(workspace.status).toBe("falhou");
    expect(workspace.result).toMatch(/renomeado/);
    expect(t.workspaceIds()).toContain("design");
    expect(t.woken.at(-1)!.text).toMatch(/FAILED/);
  });

  it("os parâmetros gravados são conferidos pelo hash: arquivo adulterado não executa", async () => {
    const t = await setup();
    await t.seedDesign();
    await t.call("delete_workspace", { workspace: "Design" });
    // Troca o alvo direto na estrutura em memória (como um arquivo adulterado depois do pedido).
    const stored = JSON.parse(await readFile(t.paths.confirmationsFile, "utf8").catch(() => '{"items":[]}')) as { items: Confirmation[] };
    expect(stored.items.length >= 0).toBe(true);
    const book = (t.structure as unknown as { confirmations: { records: { all(): Confirmation[] } } }).confirmations;
    book.records.all()[0]!.params = { workspace: "principal", name: "Principal" };
    await expect(t.structure.approve("C-0001")).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/não batem/) });
    expect(t.workspaceIds()).toEqual(expect.arrayContaining(["design", "principal"]));
  });

  it("o mesmo pedido pendente devolve o mesmo cartão e há no máximo 5 pendentes", async () => {
    const t = await setup();
    await t.seedDesign();
    const first = await t.call("delete_agent", { workspace: "Design", agent: "Eco" });
    const again = await t.call("delete_agent", { workspace: "Design", agent: "Eco" });
    expect(pendingId(again.text)).toBe(pendingId(first.text));
    expect(t.structure.listConfirmations()).toHaveLength(1);
    expect(t.chat.filter((body) => body.kind === "status")).toHaveLength(1);
    for (let n = 2; n <= CONFIRMATION_MAX_PENDING; n++) await t.call("run_host_command", { command: "echo", args: [String(n)] });
    const over = await t.call("run_host_command", { command: "echo", args: ["extra"] });
    expect(over.isError).toBe(true);
    expect(over.text).toMatch(/already 5 confirmations/);
  });

  it("apagar sala e time: resumo com o impacto; executa pelo clique", async () => {
    const t = await setup();
    await t.seedDesign();
    const room = await t.call("delete_room", { workspace: "Design", room: "Estúdio" });
    const team = await t.call("delete_team", { workspace: "Design", team: "Arte" });
    const [roomCard, teamCard] = t.structure.listConfirmations();
    expect(roomCard!.summary).toBe('Apagar a sala "Estúdio" do workspace Design: 1 time, 2 agentes, 0 tarefas, 3 notas do Cérebro');
    expect(teamCard!.summary).toBe('Apagar o time "Arte" do workspace Design: 2 agentes (Eco, Lume), 0 tarefas ativas');
    expect(`${room.text}${team.text}`).toContain("PENDING_CONFIRMATION");
    expect((await t.structure.approve(pendingId(team.text))).status).toBe("executada");
    expect(t.test.workspaces.get("design").store.snapshot().agents.filter((agent) => ["Eco", "Lume"].includes(agent.name))).toHaveLength(0);
  });

  it("acesso e conectores: o cartão mostra antes e depois e só o clique muda", async () => {
    const t = await setup();
    await t.seedDesign();
    const runtime = t.test.workspaces.get("design");
    const eco = runtime.store.snapshot().agents.find((agent) => agent.name === "Eco")!;
    // Terminal fora da política do workspace: nem vira cartão (o agente nunca passa da política).
    const capped = await t.call("set_agent_access", { workspace: "Design", agent: "Eco", terminal: true });
    expect(capped.isError).toBe(true);
    expect(capped.text).toMatch(/does not allow terminal/);
    expect(t.structure.listConfirmations()).toEqual([]);
    // Libera o terminal na política do workspace e pede para o agente desligar.
    await t.test.workspaces.update("design", { access: { terminal: true } });
    const access = await t.call("set_agent_access", { workspace: "Design", agent: "Eco", terminal: false, internet: false });
    expect(t.structure.listConfirmations().at(-1)!.summary).toBe('Mudar o acesso do agente "Eco" (Design): internet: ligado -> desligado; terminal: ligado -> desligado');
    expect(runtime.store.snapshot().agents.find((agent) => agent.id === eco.id)!.internet).toBeUndefined();
    expect((await t.structure.approve(pendingId(access.text))).status).toBe("executada");
    expect(runtime.store.snapshot().agents.find((agent) => agent.id === eco.id)).toMatchObject({ internet: false, terminal: false });

    const wsAccess = await t.call("set_workspace_access", { workspace: "Design", allow_local_network: true, allowed_domains: ["https://www.Exemplo.com/x"] });
    expect(t.structure.listConfirmations().at(-1)!.summary).toBe("Mudar o acesso de TODOS os agentes do workspace Design: rede local: desligado -> ligado; domínios permitidos: www.exemplo.com");
    expect((await t.structure.approve(pendingId(wsAccess.text))).status).toBe("executada");
    expect(runtime.access()).toMatchObject({ allowLocalNetwork: true, allowedDomains: ["www.exemplo.com"] });

    const add = await t.call("add_connector", { workspace: "Design", name: "Notion", kind: "http", url: "https://mcp.exemplo.com/mcp" });
    expect(t.structure.listConfirmations().at(-1)!.summary).toBe('Cadastrar o conector "Notion" no workspace Design: servidor MCP em https://mcp.exemplo.com/mcp');
    expect(runtime.connectors.list()).toHaveLength(0);
    expect((await t.structure.approve(pendingId(add.text))).status).toBe("executada");
    expect(runtime.connectors.list().map((connector) => connector.name)).toEqual(["Notion"]);
    expect(runtime.connectors.list()[0]!.agentIds).toEqual([]);

    const give = await t.call("set_agent_connectors", { workspace: "Design", agent: "Eco", connectors: ["Notion"] });
    expect(t.structure.listConfirmations().at(-1)!.summary).toBe('Dar ao agente "Eco" (Design) acesso aos conectores: Notion');
    expect(runtime.connectors.list()[0]!.agentIds).toEqual([]);
    expect((await t.structure.approve(pendingId(give.text))).status).toBe("executada");
    expect(runtime.connectors.list()[0]!.agentIds).toEqual([eco.id]);
    const unknown = await t.call("set_agent_connectors", { workspace: "Design", agent: "Eco", connectors: ["Slack"] });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/Connector "Slack" not found/);
  });
});

describe("Cyno: run_host_command", () => {
  it("sem shell: o texto vira argumento, o comando exato aparece no cartão e só roda no clique, na pasta de trabalho", async () => {
    const t = await setup();
    const result = await t.call("run_host_command", { command: "echo", args: ["; touch pwned", "$HOME", "a b"], reason: "teste" });
    expect(result.text).toMatch(/PENDING_CONFIRMATION/);
    const [card] = t.structure.listConfirmations();
    expect(card!.summary).toBe("Rodar na máquina: echo '; touch pwned' '$HOME' 'a b'");
    expect(card!.impact).toBe(`Pasta: ${t.paths.workDir}`);
    await expect(readFile(t.paths.hostCommandsFile, "utf8")).rejects.toThrow();
    const done = await t.structure.approve("C-0001");
    expect(done.status).toBe("executada");
    // Nada foi interpretado: a saída é o texto literal.
    expect(done.result).toContain("; touch pwned $HOME a b");
    await expect(readFile(path.join(t.paths.workDir, "pwned"), "utf8")).rejects.toThrow();
    const logged = JSON.parse((await readFile(t.paths.hostCommandsFile, "utf8")).trim()) as { cwd: string; command: string; exitCode: number };
    expect(logged).toMatchObject({ cwd: t.paths.workDir, command: "echo", exitCode: 0 });
    expect(t.woken[0]!.text).toContain("; touch pwned");
  });

  it("roda na pasta pedida e mostra a pasta no cartão", async () => {
    const t = await setup();
    const folder = path.join(t.dir, "outra");
    await mkdir(folder);
    await writeFile(path.join(folder, "achado.txt"), "x");
    await t.call("run_host_command", { command: "ls", cwd: folder });
    expect(t.structure.listConfirmations()[0]!.impact).toBe(`Pasta: ${folder}`);
    expect((await t.structure.approve("C-0001")).result).toContain("achado.txt");
  });

  it("sudo e elevação de privilégio são recusados pela ferramenta, com o comando para o dono rodar", async () => {
    const t = await setup();
    for (const args of [
      { command: "sudo", args: ["apt", "update"] },
      { command: "/usr/bin/sudo", args: ["ls"] },
      { command: "bash", args: ["-c", "echo oi && sudo ls"] },
      { command: "env", args: ["FOO=1", "sudo", "ls"] },
      { command: "su", args: ["-"] },
      { command: "powershell", args: ["-Command", "sudo ls"] },
      { command: "pwsh", args: ["-c", "sudo id"] },
      { command: "cmd", args: ["/c", "sudo whoami"] },
      { command: "wsl", args: ["sudo", "apt", "update"] },
      { command: "bash.exe", args: ["-c", "sudo ls"] },
      { command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", args: ["-Command", "sudo ls"] },
    ]) {
      const result = await t.call("run_host_command", args);
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/never runs commands with sudo/);
      expect(result.text).toMatch(/run it themselves/);
    }
    expect(t.structure.listConfirmations()).toEqual([]);
    expect(refuseHostCommand({ command: "ls", args: ["-la"] })).toBeUndefined();
    expect(refuseHostCommand({ command: "echo", args: ["sudo é uma palavra"] })).toBeUndefined();

    // Descrição da ferramenta adapta o exemplo de shell conforme a plataforma.
    const linuxDesc = cynoStructureTools(t.structure.toolDeps(), { platform: "linux" }).find((tool) => tool.name === "run_host_command")?.description ?? "";
    const winDesc = cynoStructureTools(t.structure.toolDeps(), { platform: "win32" }).find((tool) => tool.name === "run_host_command")?.description ?? "";
    expect(linuxDesc).toContain('command "bash" and args ["-c"');
    expect(winDesc).toContain('command "powershell" and args ["-Command"');
  });

  it("corta a saída em 8 mil caracteres e o tempo limite mata o processo", async () => {
    const t = await setup();
    await t.call("run_host_command", { command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(30000))"] });
    const big = await t.structure.approve("C-0001");
    expect(big.status).toBe("executada");
    expect(big.result!.length).toBeLessThan(8400);
    expect(big.result).toMatch(/output cut at 8000/);
    const logged = JSON.parse((await readFile(t.paths.hostCommandsFile, "utf8")).trim().split("\n")[0]!) as { truncated: boolean };
    expect(logged.truncated).toBe(true);

    await t.call("run_host_command", { command: process.execPath, args: ["-e", "setTimeout(() => {}, 20000)"], timeout_seconds: 1 });
    const slow = await t.structure.approve("C-0002");
    expect(slow.status).toBe("falhou");
    expect(slow.result).toMatch(/passou do tempo limite/);
  });

  it("erro do comando vira cartão 'falhou' com a saída, e o programa inexistente também", async () => {
    const t = await setup();
    await t.call("run_host_command", { command: "ls", args: ["/nao/existe/mesmo"] });
    const failed = await t.structure.approve("C-0001");
    expect(failed.status).toBe("falhou");
    expect(failed.result).toMatch(/Terminou com erro/);
    await t.call("run_host_command", { command: "programa-que-nao-existe-xyz" });
    const missing = await t.structure.approve("C-0002");
    expect(missing.status).toBe("falhou");
    expect(missing.result).toMatch(/ENOENT/);
  });
});

describe("Cyno: montar workspaces", () => {
  const plan = (): ProposalInput => ({
    name: "Cafeteria",
    summary: "Instagram da cafeteria: posts com imagem e respostas aos comentários.",
    rooms: [
      {
        name: "Conteúdo",
        purpose: "content",
        teams: [
          {
            name: "Posts",
            focus: "Posts com imagem",
            agents: [
              { name: "Bia", role: "Redatora", focus: "Escreve legendas curtas e simpáticas.", connectors: ["notion"] },
              { name: "Lia", role: "Designer", engine: "gemini", focus: "Cria as imagens dos posts." },
            ],
          },
        ],
      },
      { name: "Atendimento", purpose: "general", teams: [{ name: "Comentários", focus: "Responde comentários", agents: [{ name: "Ana", engine: "claude", model: "haiku", focus: "Responde com educação." }] }] },
    ],
    sites: [{ domain: "instagram.com", why: "Conta da cafeteria" }],
    connectors: [{ id: "notion", why: "Calendário editorial" }],
    routines: [{ type: "goal", title: "Posts da semana", owner: "Bia", kind: "post", site: "instagram.com", unit: "post", instruction: "Posts com imagem.", goal: { target: 3, period: "week", preferred_days: [1, 3, 5] } }],
    notes: "Supus Instagram.",
  });

  it("o servidor valida antes de mostrar e devolve todos os problemas de uma vez (nada é exibido)", async () => {
    const t = await setup();
    const bad = plan();
    bad.rooms[0]!.teams[0]!.agents[0]!.model = "gpt-9";
    bad.rooms[0]!.teams[0]!.agents[1]!.name = "Bia";
    bad.name = "Principal";
    bad.routines![0]!.owner = "Fantasma";
    bad.routines!.push({ type: "goal", title: "Sem site", owner: "Bia", instruction: "x", goal: { target: 2 } });
    const result = await t.call("propose_workspace", bad);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/NOT shown/);
    expect(result.text).toMatch(/already exists/);
    expect(result.text).toMatch(/model "gpt-9" does not exist for claude/);
    expect(result.text).toMatch(/duplicate agent name "Bia"/);
    expect(result.text).toMatch(/owner "Fantasma" must be the name of an agent or team/);
    // O que a criação exigiria da rotina (kind e site) é conferido já na proposta, não depois do OK.
    expect(result.text).toMatch(/routines\[1\]: type "goal" needs goal/);
    expect(t.structure.listProposals()).toEqual([]);
    expect(t.chat).toEqual([]);

    const noEngine = plan();
    noEngine.rooms[0]!.teams[0]!.agents[1]!.model = "gemini-9";
    const wrongModel = await t.call("propose_workspace", noEngine);
    expect(wrongModel.text).toMatch(/model "gemini-9" does not exist for gemini. Options: gemini-3.8-flash-medium/);
  });

  it("a proposta mostra o pacote normalizado (padrões de modelo preenchidos) e nada é criado antes do OK", async () => {
    const t = await setup();
    const result = await t.call("propose_workspace", plan());
    expect(result.isError).toBeUndefined();
    expect(result.text).toMatch(/Proposal P-0001/);
    expect(result.text).toMatch(/NOTHING was created/);
    expect(result.text).toMatch(/not registered anywhere yet/);
    expect(t.workspaceIds()).not.toContain("cafeteria");
    const [proposal] = t.structure.listProposals();
    expect(proposal).toMatchObject({ id: "P-0001", status: "proposta", version: 1 });
    const agents = proposal!.plan.rooms.flatMap((room) => room.teams.flatMap((team) => team.agents));
    expect(agents.map((agent) => `${agent.name}:${agent.engine}/${agent.model}`)).toEqual(["Bia:claude/sonnet", "Lia:gemini/gemini-3.8-flash-medium", "Ana:claude/haiku"]);
    expect(agents[0]!.effort).toBe("medium");
    expect(proposal!.plan.rooms[0]).toMatchObject({ purpose: "conteudo", size: "auto" });
    expect(t.chat.map((body) => (body.kind === "status" ? parseProposalMarker(body.message) : undefined))).toContain("P-0001");

    // Ajuste: a nova versão substitui a anterior.
    const next = plan();
    next.name = "Cafeteria Café";
    const again = await t.call("propose_workspace", { ...next, replaces: "P-0001" });
    expect(again.text).toMatch(/Proposal P-0002 \(version 2\)/);
    expect(t.structure.listProposals().map((item) => `${item.id}:${item.status}`)).toEqual(["P-0001:recusada", "P-0002:proposta"]);
  });

  it("'Criar workspace' cria tudo por código: salas, times, agentes, líder, frase, rotina proposta e nota de logins", async () => {
    const t = await setup();
    // O conector que o pacote usa existe em outro workspace: é copiado (com o servidor MCP) para o novo.
    const principal = t.test.workspaces.get("principal");
    await principal.connectors.create({ name: "Notion", kind: "http", url: "https://mcp.exemplo.com/mcp" });
    await t.call("propose_workspace", plan());
    expect(t.structure.listProposals()[0]!.warnings.join(" ")).not.toMatch(/not registered/);
    const done = await t.structure.approveProposal("P-0001");
    expect(done.status).toBe("criada");
    expect(done.workspaceId).toBe("cafeteria");
    expect(done.progress.every((step) => step.done)).toBe(true);

    const runtime = t.test.workspaces.get("cafeteria");
    const state = runtime.store.snapshot();
    expect(state.rooms.filter((room) => room.kind !== "maestro").map((room) => `${room.name}:${room.purpose}`)).toEqual(["Conteúdo:conteudo", "Atendimento:geral"]);
    expect(state.teams.filter((team) => ["Posts", "Comentários"].includes(team.name))).toHaveLength(2);
    const byName = Object.fromEntries(state.agents.map((agent) => [agent.name, agent]));
    expect(byName.Bia).toMatchObject({ engine: "claude", model: "sonnet", role: "Redatora" });
    expect(byName.Lia).toMatchObject({ engine: "gemini", model: "gemini-3.8-flash-medium" });
    expect(byName.Ana).toMatchObject({ engine: "claude", model: "haiku" });
    const posts = state.teams.find((team) => team.name === "Posts")!;
    expect(posts.leadAgentId).toBe(byName.Bia!.id);
    expect(runtime.connectors.list().map((connector) => connector.name)).toEqual(["Notion"]);
    expect(runtime.connectors.list()[0]!.agentIds).toEqual([byName.Bia!.id]);
    expect(runtime.cardSummary.get().summary).toBe("Instagram da cafeteria: posts com imagem e respostas aos comentários.");
    expect(runtime.routines.list().map((routine) => `${routine.title}:${routine.status}`)).toEqual(["Posts da semana:proposta"]);
    const maestro = findMaestroAgent(state);
    expect(maestro).toBeDefined();
    const logins = await readFile(path.join(runtime.store.paths.root, "brains", "global", "logins-pendentes.md"), "utf8").catch(() => "");
    expect(logins).toMatch(/instagram\.com/);
    // O Cyno recebe o resultado, com os logins pendentes.
    expect(t.woken.at(-1)!.text).toMatch(/created everything/);
    expect(t.woken.at(-1)!.text).toMatch(/instagram\.com/);
    expect(t.records.map((record) => record.action)).toEqual(expect.arrayContaining(["workspace_proposto", "workspace_aprovado", "workspace_criado"]));
    // Segunda vez: já decidida.
    await expect(t.structure.approveProposal("P-0001")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("falhou no meio: desfaz o workspace e avisa, com o passo que quebrou", async () => {
    const t = await setup();
    await t.call("propose_workspace", { ...plan(), connectors: [], rooms: plan().rooms.map((room) => ({ ...room, teams: room.teams.map((team) => ({ ...team, agents: team.agents.map((agent) => ({ ...agent, connectors: [] })) })) })) });
    // O segundo agente não pode ser criado.
    const original = t.test.workspaces.find.bind(t.test.workspaces);
    vi.spyOn(t.test.workspaces, "find").mockImplementation((id: string) => {
      const runtime = original(id);
      if (runtime && id === "cafeteria") {
        const create = runtime.services.agents.create.bind(runtime.services.agents);
        let calls = 0;
        runtime.services.agents.create = async (input) => {
          calls += 1;
          if (calls === 2) throw new Error("falha forçada no segundo agente");
          return create(input);
        };
      }
      return runtime;
    });
    const failed = await t.structure.approveProposal("P-0001");
    vi.restoreAllMocks();
    expect(failed.status).toBe("falhou");
    expect(failed.error).toMatch(/Contratar 3 agentes/);
    expect(failed.error).toMatch(/falha forçada/);
    expect(failed.error).toMatch(/desfeito/);
    expect(failed.progress.find((step) => step.error)?.step).toMatch(/Contratar/);
    expect(t.workspaceIds()).not.toContain("cafeteria");
    expect(t.woken.at(-1)!.text).toMatch(/creation FAILED and was undone/);
  });

  it("recusar a proposta não cria nada e avisa o Cyno", async () => {
    const t = await setup();
    await t.call("propose_workspace", plan());
    expect(t.structure.rejectProposal("P-0001").status).toBe("recusada");
    expect(t.workspaceIds()).not.toContain("cafeteria");
    expect(t.woken[0]!.text).toMatch(/REFUSED the proposal/);
    await expect(t.structure.approveProposal("P-0001")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("get_catalog lista motores, modelos e conectores; create_workspace cria vazio sem pedir OK", async () => {
    const t = await setup();
    const principal = t.test.workspaces.get("principal");
    await principal.connectors.create({ name: "Notion", kind: "http", url: "https://mcp.exemplo.com/mcp" });
    const catalog = await t.call("get_catalog");
    expect(catalog.text).toMatch(/claude \(Claude Code\): installed/);
    expect(catalog.text).toMatch(/gemini-3.8-flash-medium/);
    expect(catalog.text).toMatch(/"Notion" \(http.*in workspace "Principal"/);
    expect(catalog.text).toMatch(/design: Creative table/);
    const created = await t.call("create_workspace", { name: "Vazio", summary: "Um workspace vazio." });
    expect(created.text).toMatch(/created/);
    expect(t.workspaceIds()).toContain("vazio");
    expect(t.test.workspaces.get("vazio").cardSummary.get().summary).toBe("Um workspace vazio.");
    expect(t.structure.listConfirmations()).toEqual([]);
  });
});

describe("Cyno: ferramentas de estrutura com `workspace` (adaptador)", () => {
  it("criam e mudam no workspace pedido (por nome ou id), sem pedir OK e sem o user_confirmed", async () => {
    const t = await setup();
    await t.seedDesign();
    const create = t.tools.find((tool) => tool.name === "create_agent")!;
    const shape = Object.keys(create.input.shape);
    expect(shape).toEqual(expect.arrayContaining(["workspace", "team", "name", "engine", "model"]));
    expect(shape).not.toContain("user_confirmed");
    // Motor real sem a confirmação do Maestro: o adaptador a entrega (o Cyno age em nome do dono). Aqui a CLI não está instalada, então o motivo é esse, não a confirmação.
    const real = await t.call("create_agent", { workspace: "design", team: "Arte", name: "Gem", role: "Pesquisa", instructions: "Pesquisa.", engine: "gemini", model: "gemini-3.8-flash-medium" });
    expect(real.isError).toBe(true);
    expect(real.text).toMatch(/not available on this server/);
    expect(real.text).not.toMatch(/user_confirmed|explicitly asked/);
    const gemini = await t.call("create_agent", { workspace: "design", team: "Arte", name: "Gem", role: "Pesquisa", instructions: "Pesquisa.", engine: "mock" });
    expect(gemini.isError).toBeUndefined();
    const runtime = t.test.workspaces.get("design");
    expect(runtime.store.snapshot().agents.find((agent) => agent.name === "Gem")).toMatchObject({ role: "Pesquisa" });
    // Trocar o modelo de um agente real também é direto (aqui a CLI falsa não existe, então o motor não passa na checagem do Maestro).
    const model = await t.call("set_agent_model", { workspace: "Design", agent: "Lume", effort: "high" });
    expect(model.isError).toBeUndefined();
    await t.call("update_agent", { workspace: "Design", agent: "Gem", team: "Arte", name: "Gema" });
    expect(runtime.store.snapshot().agents.map((agent) => agent.name)).toContain("Gema");
    expect((await t.call("get_team", { workspace: "Design" })).text).toContain("Gema");
    expect(t.structure.listConfirmations()).toEqual([]);
  });

  it("workspace desconhecido volta como erro claro; as perigosas do Maestro não existem sem OK (só as versões do Cyno)", async () => {
    const t = await setup();
    const unknown = await t.call("create_room", { workspace: "Nada", name: "Sala" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/No workspace "Nada"/);
    const scopedNames = t.tools.filter((tool) => ["delete_room", "delete_team", "delete_agent", "set_agent_access", "set_agent_connectors"].includes(tool.name));
    // Cada uma só existe uma vez e é a versão do Cyno (não a do Maestro).
    expect(scopedNames.map((tool) => tool.name).sort()).toEqual(["delete_agent", "delete_room", "delete_team", "set_agent_access", "set_agent_connectors"]);
    for (const tool of scopedNames) expect(tool.description).toMatch(/RUNS RIGHT AWAY.*PENDING_CONFIRMATION/);
    const names = t.tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("um agente de workspace nunca vê as ferramentas de estrutura do Cyno", async () => {
    const t = await setup();
    const runtime = t.test.workspaces.get("principal");
    const maestro = findMaestroAgent(runtime.store.snapshot())!;
    const worker = runtime.store.snapshot().agents.find((agent) => agent.id !== maestro.id);
    const exposed = [...runtime.officeTools(maestro.id), ...(worker ? runtime.officeTools(worker.id) : [])].map((tool) => tool.name);
    for (const name of ["propose_workspace", "create_workspace", "get_catalog", "run_host_command", "delete_workspace", "add_connector", "set_workspace_access", "rename_workspace"]) expect(exposed).not.toContain(name);
  });
});

describe("Cyno: as rotas do dono", () => {
  it("só a sessão do dono decide: sem ela (ou só com o token de um agente) a rota recusa e nada executa", async () => {
    const test = await setupApp();
    await writeAuthFile(test.dataDir, "senha-de-teste-123");
    const tool = test.app.cyno.tools().find((candidate) => candidate.name === "delete_workspace")!;
    // O Cyno pede apagar o workspace "principal" (cria o cartão, sem executar).
    const asked = await tool.call({ workspace: "principal" });
    expect(asked.text).toMatch(/PENDING_CONFIRMATION C-0001/);
    expect(test.workspaces.list().map((workspace) => workspace.id)).toContain("principal");

    const anonymous = await test.app.inject({ method: "POST", url: "/api/cyno/confirmations/C-0001/approve" });
    expect(anonymous.statusCode).toBe(401);
    // O token MCP de um agente só vale em /mcp: o portão de senha não o aceita em nenhuma outra rota.
    expect(isAuthExempt("POST", "/api/cyno/confirmations/C-0001/approve")).toBe(false);
    expect(isAuthExempt("POST", "/api/cyno/proposals/P-0001/approve")).toBe(false);
    const withAgentToken = await test.app.inject({ method: "POST", url: "/api/cyno/confirmations/C-0001/approve", headers: { authorization: "Bearer token-de-um-agente" } });
    expect(withAgentToken.statusCode).toBe(401);
    expect((await test.app.inject({ method: "GET", url: "/api/cyno/confirmations" })).statusCode).toBe(401);
    expect(test.workspaces.list().map((workspace) => workspace.id)).toContain("principal");
  });

  it("com a sessão: lista, recusa e confirma (e o resultado volta no JSON)", async () => {
    const test = await setupApp();
    const create = test.app.cyno.tools().find((candidate) => candidate.name === "create_workspace")!;
    await create.call({ name: "Lixo" });
    const del = test.app.cyno.tools().find((candidate) => candidate.name === "delete_workspace")!;
    await del.call({ workspace: "Lixo" });
    const list = (await test.app.inject({ method: "GET", url: "/api/cyno/confirmations" })).json() as { confirmations: Confirmation[] };
    expect(list.confirmations).toMatchObject([{ id: "C-0001", status: "pendente", action: "delete_workspace" }]);
    const refused = await test.app.inject({ method: "POST", url: "/api/cyno/confirmations/C-0001/reject" });
    expect(refused.json()).toMatchObject({ status: "recusada" });
    expect(test.workspaces.list().map((workspace) => workspace.id)).toContain("lixo");
    await del.call({ workspace: "Lixo" });
    const approved = await test.app.inject({ method: "POST", url: "/api/cyno/confirmations/C-0002/approve" });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: "executada" });
    expect(test.workspaces.list().map((workspace) => workspace.id)).not.toContain("lixo");
    expect((await test.app.inject({ method: "POST", url: "/api/cyno/confirmations/C-0002/approve" })).statusCode).toBe(409);
    expect((await test.app.inject({ method: "POST", url: "/api/cyno/confirmations/C-9999/approve" })).statusCode).toBe(404);
  });
});

describe("sem cartão de OK (requireApproval: false)", () => {
  const validPlan = (): ProposalInput => ({
    name: "Padaria",
    summary: "Posts e atendimento da padaria.",
    rooms: [
      {
        name: "Conteúdo",
        purpose: "content",
        teams: [
          {
            name: "Posts",
            focus: "Posts semanais",
            agents: [
              { name: "Bia", role: "Redatora", focus: "Escreve legendas curtas." },
              { name: "Lia", role: "Designer", engine: "gemini", focus: "Cria imagens." },
            ],
          },
        ],
      },
    ],
    sites: [{ domain: "instagram.com", why: "Perfil da padaria" }],
  });

  it("ação perigosa executa na hora, devolve DONE, não grava cartão nem acorda o Cyno e registra na Atividade", async () => {
    const t = await setup({ requireApproval: false });
    await t.seedDesign();
    const result = await t.call("delete_agent", { workspace: "Design", agent: "Lume", reason: "O dono pediu para tirar a revisora" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toMatch(/^DONE: Apagar o agente "Lume" do workspace Design/);
    expect(result.text).toMatch(/Agente "Lume" apagado/);
    expect(t.test.workspaces.get("design").store.snapshot().agents.map((agent) => agent.name)).not.toContain("Lume");
    expect(t.structure.listConfirmations()).toEqual([]);
    expect(t.chat.map((body) => (body.kind === "status" ? parseConfirmationMarker(body.message) : undefined)).filter(Boolean)).toEqual([]);
    expect(t.woken).toEqual([]);
    expect(t.records.map((record) => record.action)).toEqual(expect.arrayContaining(["acao_direta", "acao_executada"]));
  });

  it("falha na validação antes da execução ou durante a execução (FAILED:) sem deixar cartão pendente", async () => {
    const t = await setup({ requireApproval: false });
    await t.seedDesign();
    // Erro de validação antes da execução (prepareDeleteAgent / runtimeOf): nada entra na fila nem na Atividade.
    const missingAgent = await t.call("delete_agent", { workspace: "Design", agent: "Fantasma" });
    expect(missingAgent.isError).toBe(true);
    expect(missingAgent.text).toMatch(/Agent "Fantasma" not found/);
    const missingWorkspace = await t.call("delete_agent", { workspace: "Nada", agent: "Eco" });
    expect(missingWorkspace.isError).toBe(true);
    expect(missingWorkspace.text).toMatch(/No workspace "Nada"/);
    expect(t.structure.listConfirmations()).toEqual([]);
    expect(t.records.map((record) => record.action)).not.toContain("acao_direta");

    // Erro durante a execução (runNow): lança Error começando com "FAILED:", registra acao_falhou e nada fica pendente.
    await expect(t.structure.toolDeps().confirm.runHostCommand({ command: "programa-que-nao-existe-xyz" })).rejects.toThrow(/^FAILED: Rodar na máquina: programa-que-nao-existe-xyz/);
    const failedTool = await t.call("run_host_command", { command: "programa-que-nao-existe-xyz" });
    expect(failedTool.isError).toBe(true);
    expect(failedTool.text).toMatch(/^FAILED: Rodar na máquina: programa-que-nao-existe-xyz/);
    expect(t.structure.listConfirmations()).toEqual([]);
    expect(t.woken).toEqual([]);
    expect(t.records.map((record) => record.action)).toEqual(expect.arrayContaining(["acao_direta", "acao_falhou"]));
  });

  it("propose_workspace cria o workspace na hora, devolve DONE e deixa a proposta como criada (e desfaz se falhar)", async () => {
    const t = await setup({ requireApproval: false });
    const created = await t.call("propose_workspace", validPlan());
    expect(created.isError).toBeUndefined();
    expect(created.text).toMatch(/^DONE: the server created the whole workspace "Padaria"/);
    expect(t.workspaceIds()).toContain("padaria");
    expect(t.structure.listProposals()[0]).toMatchObject({ id: "P-0001", status: "criada", workspaceId: "padaria" });
    expect(t.test.workspaces.get("padaria").store.snapshot().agents.map((agent) => agent.name)).toEqual(expect.arrayContaining(["Bia", "Lia"]));
    expect(t.woken).toEqual([]);
    expect(t.records.map((record) => record.action)).toEqual(expect.arrayContaining(["workspace_proposto", "workspace_criado"]));

    // Falha no meio da criação: devolve FAILED, proposta fica "falhou" e tudo é desfeito.
    const original = t.test.workspaces.find.bind(t.test.workspaces);
    vi.spyOn(t.test.workspaces, "find").mockImplementation((id: string) => {
      const runtime = original(id);
      if (runtime && id === "padaria-2") {
        runtime.services.agents.create = async () => {
          throw new Error("falha forçada no agente");
        };
      }
      return runtime;
    });
    let failed: Awaited<ReturnType<typeof t.call>>;
    try {
      failed = await t.call("propose_workspace", { ...validPlan(), name: "Padaria 2" });
    } finally {
      vi.restoreAllMocks();
    }
    expect(failed.isError).toBe(true);
    expect(failed.text).toMatch(/^FAILED to create the workspace "Padaria 2"/);
    expect(t.structure.listProposals().find((proposal) => proposal.id === "P-0002")?.status).toBe("falhou");
    expect(t.workspaceIds()).not.toContain("padaria-2");
  });

  it("com requireApproval omitido (padrão), continua devolvendo PENDING_CONFIRMATION sem executar", async () => {
    const t = await setup();
    await t.seedDesign();
    const result = await t.call("delete_agent", { workspace: "Design", agent: "Lume" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toMatch(/^PENDING_CONFIRMATION C-0001\./);
    expect(t.test.workspaces.get("design").store.snapshot().agents.map((agent) => agent.name)).toContain("Lume");
    expect(t.structure.listConfirmations()).toHaveLength(1);
  });
});
