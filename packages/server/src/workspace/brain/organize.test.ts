import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { forYouKind, type BrainOrganizeAction, type ForYouItem, type Room, type ServerEvent } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { dataPaths } from "../../store/paths";
import { AgentRules } from "./agent-rules";
import { Brain } from "./brain";
import { parseFrontmatter } from "./frontmatter";
import { BrainOrganizeService } from "./organize";

const tempDir = useTempDirs();
const NOW = new Date("2026-11-18T12:00:00.000Z");

const ROOMS = [
  { id: "sala-a", name: "Sala A", kind: "team" },
  { id: "sala-b", name: "Sala B", kind: "team" },
  { id: "sala-do-maestro", name: "Sala do Maestro", kind: "maestro" },
] as unknown as Room[];

const AGENTS = [
  { id: "clara", name: "Clara", role: "Redatora", roomId: "sala-a" },
  { id: "eco", name: "Eco", role: "Revisor", roomId: "sala-b" },
];

const note = (title: string, body: string, front: Record<string, string> = {}, tags: string[] = []) =>
  `---\n${Object.entries({ tipo: "doc", ...front }).map(([key, value]) => `${key}: "${value}"`).join("\n")}\ntags: [${tags.map((tag) => `"${tag}"`).join(", ")}]\n---\n\n# ${title}\n\n${body}\n`;

async function setup(options: { maestro?: boolean } = {}) {
  const dir = await tempDir();
  const brain = new Brain({ paths: dataPaths(dir), rooms: () => ROOMS, now: () => NOW });
  await brain.migrate();
  const roomDir = brain.dir("sala-a");
  const files: Record<string, string> = {
    "relatorio-etapa-1.md": note("Relatório da etapa 1", "Etapa 1 concluída: 12 arquivos conferidos.", { data: "2026-10-01" }),
    "checagem-links.md": note("Checagem dos links", "Todos os links responderam 200.", { data: "2026-10-02" }, ["checagem"]),
    "tom.md": note("Tom de voz", "Sempre falar de forma leve e direta, sem formalidade.", { data: "2026-10-03" }),
    "post-longo.md": note("Como postamos", `${"Explicação longa sobre o processo de postagem. ".repeat(40)}`, { data: "2026-10-04" }, ["post"]),
    "decisao-a.md": note("Decisão A", "Usamos o fluxo curto.", { data: "2026-10-05" }, ["fluxo", "regra"]),
    "decisao-b.md": note("Decisão B", "O fluxo curto vale para posts.", { data: "2026-10-06" }, ["fluxo"]),
  };
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(roomDir, file), content);
  await writeFile(path.join(roomDir, "_indice.md"), `# Índice\n\n${Object.keys(files).map((file) => `- [[${file.replace(/\.md$/, "")}]] — nota`).join("\n")}\n`);

  const items: ForYouItem[] = [];
  const listeners = new Set<(event: ServerEvent) => void>();
  const asked: { title: string; message: string }[] = [];
  let counter = 0;
  const forYou = {
    list: () => items,
    openSpecial: vi.fn((input: { agentId: string; roomId: string; title: string; text: string; organize: NonNullable<ForYouItem["organize"]> }): ForYouItem => {
      counter += 1;
      const created: ForYouItem = { id: `A-${String(counter).padStart(4, "0")}`, agentId: input.agentId, roomId: input.roomId, type: "outro", status: "pendente", title: input.title, meta: {}, text: input.text, originalText: input.text, editedByUser: false, kind: "organizacao", organize: input.organize, createdAt: NOW.toISOString() };
      items.push(created);
      return created;
    }),
    updateOrganize: vi.fn(async (id: string, plan: NonNullable<ForYouItem["organize"]>): Promise<ForYouItem> => {
      const found = items.find((candidate) => candidate.id === id)!;
      found.organize = plan;
      return found;
    }),
  };
  const agentRules = new AgentRules((agentId) => path.join(dir, "agents", agentId), () => NOW);
  const service = new BrainOrganizeService({
    brain,
    agentRules,
    agents: () => AGENTS,
    forYou,
    maestro: {
      available: () => options.maestro !== false,
      agentId: () => "maestro",
      roomId: () => "sala-do-maestro",
      ask: ({ title, message }) => {
        asked.push({ title, message });
        return { id: `T-${asked.length}` };
      },
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const emit = (event: ServerEvent) => listeners.forEach((listener) => listener(event));
  const read = (file: string) => readFile(path.join(roomDir, file), "utf8");
  const exists = (file: string) => read(file).then(() => true, () => false);
  const history = async () => (await readdir(path.join(roomDir, "historico")).catch(() => [] as string[])).sort();
  return { dir, roomDir, brain, service, items, asked, forYou, agentRules, emit, read, exists, history };
}

const ARCHIVE: BrainOrganizeAction = { type: "archive", file: "relatorio-etapa-1.md" };

describe("BrainOrganizeService.ask", () => {
  it("manda UMA mensagem em inglês com o inventário (regras, notas da raiz, histórico, agentes da sala) e abre a janela", async () => {
    const { service, asked } = await setup();
    const { taskId } = await service.ask("sala-a");
    expect(taskId).toBe("T-1");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.title).toBe("Organizar o Cérebro: Sala A");
    const message = asked[0]!.message;
    expect(message).toContain("propose_brain_cleanup");
    expect(message).toContain("sala-a/relatorio-etapa-1.md");
    expect(message).toContain("title: Relatório da etapa 1");
    expect(message).toContain("tipo: doc");
    expect(message).toContain("date: 2026-10-01");
    expect(message).toMatch(/sala-a\/decisao-a\.md .*rule: yes/);
    expect(message).toMatch(/sala-a\/tom\.md .*rule: no/);
    expect(message).toContain("tags: fluxo, regra");
    expect(message).toContain("excerpt: Etapa 1 concluída");
    expect(message).toContain("0 more file(s) already in historico/");
    expect(message).toContain("clara | Clara | Redatora");
    expect(message).not.toContain("eco | Eco");
    expect(message).not.toContain("_briefing.md |");
    expect(service.isAsking("sala-a")).toBe(true);
  });

  it("o Cérebro global não tem a seção de agentes", async () => {
    const { service, asked, brain } = await setup();
    await writeFile(path.join(brain.dir("global"), "algo.md"), note("Algo", "texto"));
    await service.ask("global");
    expect(asked[0]!.message).not.toContain("Agents of this room");
    expect(asked[0]!.message).toContain("global/algo.md");
  });

  it("recusa com 404/409 (pt-BR): Cérebro que não existe, Maestro sem CLI, já organizando, proposta pendente e Cérebro sem notas", async () => {
    const { service, items } = await setup();
    await expect(service.ask("nao-existe")).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.ask("sala-b")).rejects.toMatchObject({ statusCode: 409, message: "Este Cérebro ainda não tem notas para organizar." });
    await service.ask("sala-a");
    await expect(service.ask("sala-a")).rejects.toMatchObject({ statusCode: 409, message: "O Maestro já está organizando este Cérebro: espere ele terminar." });
    // Outro Cérebro em paralelo não é barrado pela janela de sala-a.
    await expect(service.ask("sala-b")).rejects.toMatchObject({ message: "Este Cérebro ainda não tem notas para organizar." });
    items.push({ id: "A-0099", agentId: "maestro", roomId: "sala-a", type: "outro", status: "pendente", meta: {}, text: "", originalText: "", editedByUser: false, kind: "organizacao", organize: { brainId: "sala-b", brainName: "Sala B", summary: "x", actions: [], before: { notes: 0, chars: 0, rules: 1 }, after: { notes: 0, chars: 0, rules: 1 } }, createdAt: NOW.toISOString() });
    await expect(service.ask("sala-b")).rejects.toMatchObject({ statusCode: 409, message: "Já existe uma proposta de organização deste Cérebro esperando você em Aprovações." });
    const off = await setup({ maestro: false });
    await expect(off.service.ask("sala-a")).rejects.toMatchObject({ statusCode: 409, message: "O Maestro deste workspace não roda numa CLI: ligue-o em Configurações para ele organizar o Cérebro." });
  });

  it("a janela fecha quando o pedido termina (done ou failed)", async () => {
    const { service, emit } = await setup();
    await service.ask("sala-a");
    emit({ type: "task:upserted", task: { id: "T-1", status: "done" } } as unknown as ServerEvent);
    expect(service.isAsking("sala-a")).toBe(false);
    await expect(service.propose({ brain: "sala-a", summary: "x", actions: [ARCHIVE] })).rejects.toThrow(/only works while/);
  });
});

describe("BrainOrganizeService.propose", () => {
  async function opened() {
    const ctx = await setup();
    await ctx.service.ask("sala-a");
    return ctx;
  }

  it("sem pedido aberto não faz nada", async () => {
    const { service, items } = await setup();
    await expect(service.propose({ brain: "sala-a", summary: "x", actions: [ARCHIVE] })).rejects.toThrow(/only works while the owner's request/);
    expect(items).toHaveLength(0);
  });

  it("erros precisos em inglês: arquivo desconhecido, repetido, de outro Cérebro, fixo, do histórico, agente de outra sala, sem ações, passando do limite", async () => {
    const { service, items } = await opened();
    const fails = async (actions: BrainOrganizeAction[], pattern: RegExp, summary = "ok") => {
      await expect(service.propose({ brain: "sala-a", summary, actions })).rejects.toThrow(pattern);
    };
    await fails([{ type: "archive", file: "nao-existe.md" }], /Action 1 \(archive\): Note "nao-existe\.md" does not exist in the root/);
    await fails([ARCHIVE, { type: "archive", file: "sala-a/relatorio-etapa-1" }], /Action 2 \(archive\): "sala-a\/relatorio-etapa-1\.md" already appears in action 1/);
    await fails([ARCHIVE, { type: "merge", files: ["relatorio-etapa-1.md", "tom.md"], title: "Junto", content: "texto" }], /already appears in action 1/);
    await fails([{ type: "archive", file: "sala-b/x.md" }], /does not belong to this Brain/);
    await fails([{ type: "archive", file: "_briefing.md" }], /fixed file/);
    await fails([{ type: "rewrite", file: "_regras.md", content: "x" }], /use set_rules/);
    await fails([{ type: "archive", file: "historico/2026-10-01-antiga.md" }], /is in historico\//);
    await fails([{ type: "agent_rule", agentId: "eco", text: "Sempre revisar duas vezes." }], /agent "eco" is not an agent of this room\. Known: clara \(Clara\)/);
    await fails([], /`actions` is empty/);
    await fails([ARCHIVE], /`summary` is required/, "  ");
    await fails([ARCHIVE], /max 600/, "a".repeat(601));
    await fails([{ type: "make_rule", file: "post-longo.md" }], /too long for a rule/);
    await fails([{ type: "make_rule", file: "decisao-a.md" }], /already a rule/);
    await fails([{ type: "make_rule", file: "tom.md", content: "x".repeat(801) }], /content/);
    await fails([{ type: "set_rules", content: "a" }, { type: "set_rules", content: "b" }], /set_rules can appear only once/);
    await fails(Array.from({ length: 81 }, () => ARCHIVE), /Too many actions/);
    expect(items).toHaveLength(0);
  });

  it("abre o cartão com before/after, títulos, agente e fecha a janela; aceita caminho com ou sem o id e o .md", async () => {
    const { service, items, forYou } = await opened();
    const reply = await service.propose({
      brain: "sala-a",
      summary: "  Há relatórios de etapa para o histórico e duas decisões iguais.  ",
      actions: [
        { type: "archive", file: "sala-a/relatorio-etapa-1.md" },
        { type: "archive", file: "checagem-links" },
        { type: "make_rule", file: "tom.md" },
        { type: "merge", files: ["decisao-a", "decisao-b.md"], title: "Fluxo curto", content: "Usamos o fluxo curto nos posts." },
        { type: "rewrite", file: "post-longo.md", content: "Postamos assim: texto, revisão, publicação." },
        { type: "agent_rule", agentId: "Clara", text: "Sempre abrir com uma frase curta." },
      ],
    });
    expect(reply).toBe("Proposal card A-0001 opened for the owner (6 actions).");
    expect(forYou.openSpecial).toHaveBeenCalledOnce();
    const card = items[0]!;
    expect(forYouKind(card)).toBe("organizacao");
    expect(card).toMatchObject({ agentId: "maestro", roomId: "sala-a", type: "outro", title: "Organizar o Cérebro de Sala A", text: "Há relatórios de etapa para o histórico e duas decisões iguais.", status: "pendente" });
    const plan = card.organize!;
    expect(plan).toMatchObject({ brainId: "sala-a", brainName: "Sala A" });
    expect(plan.actions[0]).toMatchObject({ type: "archive", file: "relatorio-etapa-1.md", title: "Relatório da etapa 1" });
    expect(plan.actions[3]).toMatchObject({ type: "merge", files: ["decisao-a.md", "decisao-b.md"], titles: ["Decisão A", "Decisão B"] });
    expect(plan.actions[5]).toMatchObject({ type: "agent_rule", agentId: "clara", agentName: "Clara" });
    // Antes: 5 notas de referência e 2 regras (a decisão A e o _regras). Depois: tom vira regra (+1), A e B viram 1 nota (a regra A sai: -1).
    expect(plan.before).toMatchObject({ notes: 5, rules: 2 });
    expect(plan.after).toEqual({ notes: 2, chars: expect.any(Number), rules: 2 });
    expect(plan.after.chars).toBeLessThan(plan.before.chars);
    await expect(service.propose({ brain: "sala-a", summary: "outra", actions: [ARCHIVE] })).rejects.toThrow(/only works while/);
  });

  it("o cartão do Cérebro global fica na Sala do Maestro e aceita agente de qualquer sala", async () => {
    const { service, items, brain } = await setup();
    await writeFile(path.join(brain.dir("global"), "preferencias.md"), note("Preferências", "texto"));
    await service.ask("global");
    await service.propose({ brain: "global", summary: "ok", actions: [{ type: "agent_rule", agentId: "eco", text: "Sempre revisar duas vezes." }] });
    expect(items[0]).toMatchObject({ roomId: "sala-do-maestro", agentId: "maestro", title: "Organizar o Cérebro de Lobby" });
  });
});

describe("BrainOrganizeService.decide", () => {
  async function proposed(actions: BrainOrganizeAction[]) {
    const ctx = await setup();
    await ctx.service.ask("sala-a");
    await ctx.service.propose({ brain: "sala-a", summary: "Proposta de teste.", actions });
    return { ...ctx, card: ctx.items[0]! };
  }

  it("aprovado aplica cada tipo de ação: arquivar, virar regra (com e sem texto), encurtar, juntar, regras da sala e regra de agente", async () => {
    const { service, card, read, exists, history, roomDir, agentRules, forYou } = await proposed([
      { type: "archive", file: "relatorio-etapa-1.md" },
      { type: "make_rule", file: "tom.md" },
      { type: "make_rule", file: "post-longo.md", content: "Postar com revisão antes." },
      { type: "rewrite", file: "checagem-links.md", content: "Links conferidos: ok." },
      { type: "merge", files: ["decisao-a.md", "decisao-b.md"], title: "Fluxo curto", content: "O fluxo curto vale para posts." },
      { type: "set_rules", content: "- Sempre em português." },
      { type: "agent_rule", agentId: "clara", text: "Sempre abrir com uma frase curta." },
    ]);
    await service.decide(card, { status: "aprovado" });

    // archive: some da raiz e do índice; o histórico guarda o mesmo corpo, com arquivado e motivo.
    expect(await exists("relatorio-etapa-1.md")).toBe(false);
    expect(await read("_indice.md")).not.toContain("[[relatorio-etapa-1]]");
    expect(await read("_indice.md")).toContain("[[tom]]");
    const names = await history();
    const archivedName = names.find((name) => name.endsWith("relatorio-etapa-1.md") || name.includes("relatorio-da-etapa-1"));
    expect(archivedName).toMatch(/^2026-10-01-\d{6}-relatorio-da-etapa-1\.md$/);
    const archived = parseFrontmatter(await readFile(path.join(roomDir, "historico", archivedName!), "utf8"));
    expect(archived.frontmatter).toMatchObject({ tipo: "doc", data: "2026-10-01", motivo: "organizar", arquivado: NOW.toISOString() });
    expect(archived.body).toContain("Etapa 1 concluída: 12 arquivos conferidos.");

    // make_rule sem texto: tag e tipo, corpo intacto.
    const tom = parseFrontmatter(await read("tom.md"));
    expect(tom.frontmatter).toMatchObject({ tipo: "regra", tags: ["regra"] });
    expect(tom.body).toContain("Sempre falar de forma leve e direta");
    // make_rule com texto: corpo curto, título mantido, versão longa no histórico.
    const post = parseFrontmatter(await read("post-longo.md"));
    expect(post.frontmatter).toMatchObject({ tipo: "regra", tags: ["post", "regra"], atualizado: NOW.toISOString(), data: "2026-10-04" });
    expect(post.body.trim()).toBe("# Como postamos\n\nPostar com revisão antes.");
    expect(names.some((name) => name.includes("como-postamos"))).toBe(true);
    // rewrite: corpo novo, versão anterior no histórico.
    const links = parseFrontmatter(await read("checagem-links.md"));
    expect(links.body.trim()).toBe("# Checagem dos links\n\nLinks conferidos: ok.");
    expect(links.frontmatter).toMatchObject({ tags: ["checagem"], atualizado: NOW.toISOString() });
    expect(names.some((name) => name.includes("checagem-dos-links"))).toBe(true);
    // merge: nota nova no índice, originais no histórico.
    const merged = parseFrontmatter(await read("fluxo-curto.md"));
    expect(merged.frontmatter).toMatchObject({ tipo: "doc", autor: "Maestro", tags: ["fluxo"] });
    expect(merged.body).toContain("O fluxo curto vale para posts.");
    expect(await read("_indice.md")).toContain("[[fluxo-curto]]");
    expect(await exists("decisao-a.md")).toBe(false);
    expect(await exists("decisao-b.md")).toBe(false);
    expect(await read("_indice.md")).not.toContain("[[decisao-a]]");
    expect(names.some((name) => name.endsWith("decisao-a.md"))).toBe(true);
    // set_rules: o texto novo no lugar e o anterior no histórico.
    expect(await read("_regras.md")).toContain("- Sempre em português.");
    expect(names.some((name) => name.endsWith("regras-anteriores.md"))).toBe(true);
    // agent_rule.
    expect((await agentRules.read("clara")).content).toBe("- Sempre abrir com uma frase curta.");

    expect(forYou.updateOrganize).toHaveBeenCalledOnce();
    expect(card.organize!.failed).toBeUndefined();
    expect(card.organize!.skipped).toBeUndefined();
  });

  it("`skip` não aplica as ações desmarcadas e as grava no cartão", async () => {
    const { service, card, exists, history } = await proposed([ARCHIVE, { type: "archive", file: "checagem-links.md" }]);
    await service.decide(card, { status: "aprovado", organize: { skip: [1] } });
    expect(await exists("relatorio-etapa-1.md")).toBe(false);
    expect(await exists("checagem-links.md")).toBe(true);
    expect(await history()).toHaveLength(1);
    expect(card.organize).toMatchObject({ skipped: [1] });
    expect(card.organize!.failed).toBeUndefined();
  });

  it("índice de `skip` fora da proposta é 400", async () => {
    const { service, card, exists } = await proposed([ARCHIVE]);
    await expect(service.decide(card, { status: "aprovado", organize: { skip: [5] } })).rejects.toMatchObject({ statusCode: 400 });
    expect(await exists("relatorio-etapa-1.md")).toBe(true);
  });

  it("uma ação que não dá mais (nota sumiu, agente removido, regras cheias) vai para `failed` em pt-BR e não derruba as outras", async () => {
    const { service, card, exists, roomDir, agentRules } = await proposed([
      { type: "archive", file: "relatorio-etapa-1.md" },
      { type: "archive", file: "checagem-links.md" },
      { type: "agent_rule", agentId: "clara", text: "Uma regra que não cabe mais." },
      { type: "merge", files: ["decisao-a.md", "tom.md"], title: "Juntas", content: "texto" },
    ]);
    // Entre propor e aprovar: o dono apagou uma nota e as regras da Clara encheram.
    await (await import("node:fs/promises")).rm(path.join(roomDir, "relatorio-etapa-1.md"));
    await agentRules.write("clara", "x".repeat(3990));
    await service.decide(card, { status: "aprovado" });
    expect(await exists("checagem-links.md")).toBe(false);
    const failed = card.organize!.failed!;
    expect(failed.map((entry) => entry.index)).toEqual([0, 2]);
    expect(failed[0]!.error).toMatch(/relatorio-etapa-1\.md" não existe mais/);
    expect(failed[1]!.error).toMatch(/já estão cheias/);
    // O merge depois das falhas foi aplicado.
    expect(await exists("juntas.md")).toBe(true);
    expect(await exists("tom.md")).toBe(false);
  });

  it("um merge com uma original faltando não cria nada pela metade", async () => {
    const { service, card, exists, roomDir } = await proposed([{ type: "merge", files: ["decisao-a.md", "tom.md"], title: "Juntas", content: "texto" }]);
    await (await import("node:fs/promises")).rm(path.join(roomDir, "tom.md"));
    await service.decide(card, { status: "aprovado" });
    expect(card.organize!.failed).toHaveLength(1);
    expect(await exists("juntas.md")).toBe(false);
    expect(await exists("decisao-a.md")).toBe(true);
  });

  it("o nome do histórico nunca sobrescreve: arquivar duas notas do mesmo título e data usa sufixo", async () => {
    const ctx = await setup();
    await writeFile(path.join(ctx.roomDir, "copia-a.md"), note("Igual", "um", { data: "2026-10-01T10:00:00" }));
    await writeFile(path.join(ctx.roomDir, "copia-b.md"), note("Igual", "dois", { data: "2026-10-01T10:00:00" }));
    await ctx.brain.archiveRootNote("sala-a", "copia-a.md");
    await ctx.brain.archiveRootNote("sala-a", "copia-b.md");
    const names = (await ctx.history()).filter((name) => name.includes("igual"));
    expect(names).toHaveLength(2);
    expect(names.some((name) => /-igual-2\.md$/.test(name))).toBe(true);
  });

  it("recusado não muda nada", async () => {
    const { service, card, exists, history, forYou, asked } = await proposed([ARCHIVE]);
    await service.decide(card, { status: "rejeitado" });
    expect(await exists("relatorio-etapa-1.md")).toBe(true);
    expect(await history()).toHaveLength(0);
    expect(forYou.updateOrganize).not.toHaveBeenCalled();
    expect(asked).toHaveLength(1);
  });

  it("se o Cérebro sumiu, aprovar falha em 409 pt-BR e recusar continua funcionando", async () => {
    const { card, forYou } = await proposed([ARCHIVE]);
    const gone = new BrainOrganizeService({
      brain: { hasBrain: () => false } as never,
      agentRules: {} as never,
      agents: () => [],
      forYou,
      maestro: { available: () => true, agentId: () => "maestro", roomId: () => "r", ask: () => ({ id: "x" }) },
      subscribe: () => () => undefined,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await expect(gone.decide(card, { status: "aprovado" })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("não existe mais") });
    await expect(gone.decide(card, { status: "rejeitado" })).resolves.toBeUndefined();
  });
});
