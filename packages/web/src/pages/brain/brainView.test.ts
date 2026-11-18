import type { BrainNoteSummary, BrainSummary, OfficeState, Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import {
  absoluteDate,
  brainCrew,
  brainHash,
  brainLevel,
  buildWikiIndex,
  cleanExcerpt,
  cleanNoteBody,
  crewLabel,
  latestDate,
  noteKind,
  noteTypeLabel,
  parseFrontmatterFields,
  plainTitle,
  relativeDate,
  doneSignature,
  filterNotes,
  frontmatterChips,
  frontmatterTags,
  parseBrainHash,
  resolveWiki,
  stripLeadingTitle,
  fixedName,
  groupNotes,
  agentRulesHash,
  agentRulesState,
  brainAgents,
  brainWeight,
  ruleLineCount,
  shelfHint,
  weightLabel,
} from "./brainView";

const note = (file: string, title: string, extra: Partial<BrainNoteSummary> = {}): BrainNoteSummary => ({
  file,
  layer: "note",
  title,
  date: null,
  tags: [],
  excerpt: "",
  ...extra,
});

describe("endereço da nota", () => {
  it("ida e volta, com nomes que precisam de escape", () => {
    const hash = brainHash("principal", "projetox", "nota com espaço?.md");
    expect(hash).toBe("#/biblioteca/cerebro/principal/projetox/nota%20com%20espa%C3%A7o%3F.md");
    expect(parseBrainHash(hash, "principal")).toEqual({ brainId: "projetox", file: "nota com espaço?.md" });
    expect(brainHash("principal", "global")).toBe("#/biblioteca/cerebro/principal/global");
    expect(parseBrainHash("#/biblioteca/cerebro/principal/global", "principal")).toEqual({ brainId: "global", file: null });
    expect(brainHash("principal", null)).toBe("#/biblioteca/cerebro/principal");
  });

  it("outro workspace, outra página ou escape quebrado = nada escolhido", () => {
    const none = { brainId: null, file: null };
    expect(parseBrainHash("#/biblioteca/cerebro/outro/global/a.md", "principal")).toEqual(none);
    expect(parseBrainHash("#/biblioteca/skills/principal/global/a.md", "principal")).toEqual(none);
    expect(parseBrainHash("#/biblioteca/cerebro/principal", "principal")).toEqual(none);
    expect(parseBrainHash("#/biblioteca/cerebro/principal/global/%E0%A4%A.md", "principal")).toEqual({ brainId: "global", file: null });
    expect(parseBrainHash("#/biblioteca/cerebro/principal/global/a.md", null)).toEqual(none);
  });
});

describe("filterNotes", () => {
  const notes = [
    note("a.md", "Preferências do usuário", { excerpt: "Escreve em português" }),
    note("b.md", "Decisões técnicas", { tags: ["arquitetura"], excerpt: "React e Node" }),
  ];

  it("busca por título, tag e trecho, sem acento nem caixa, todas as palavras", () => {
    expect(filterNotes(notes, "").map((item) => item.file)).toEqual(["a.md", "b.md"]);
    expect(filterNotes(notes, "PREFERENCIAS").map((item) => item.file)).toEqual(["a.md"]);
    expect(filterNotes(notes, "#arquitetura").map((item) => item.file)).toEqual(["b.md"]);
    expect(filterNotes(notes, "react node").map((item) => item.file)).toEqual(["b.md"]);
    expect(filterNotes(notes, "react português")).toEqual([]);
  });
});

describe("times do quarto", () => {
  const office: Pick<OfficeState, "teams" | "agents"> = {
    teams: [
      { id: "t1", roomId: "projetox", name: "Frontend", focus: "x" },
      { id: "t2", roomId: "projetox", name: "Backend", focus: "x" },
      { id: "t3", roomId: "projetoy", name: "Pesquisa", focus: "x" },
    ],
    agents: [
      { id: "lia", teamId: "t1", name: "Lia" } as OfficeState["agents"][number],
      { id: "davi", teamId: "t1", name: "Davi" } as OfficeState["agents"][number],
    ],
  };

  it("lista times e agentes de um quarto", () => {
    const crew = brainCrew(office, "projetox");
    expect(crew).toEqual([
      { id: "t1", name: "Frontend", agents: ["Lia", "Davi"] },
      { id: "t2", name: "Backend", agents: [] },
    ]);
    expect(crewLabel(crew)).toBe("Frontend: Lia, Davi · Backend: sem agentes");
    expect(brainCrew(office, "global")).toEqual([]);
    expect(brainCrew(null, "projetox")).toEqual([]);
  });

  it("chips do frontmatter com nomes atuais de agente e time", () => {
    const chips = frontmatterChips(
      { data: "2026-11-07T10:00:00.000Z", agent: "lia", team: "t1", autor: "Harry", tags: ["x"] },
      office,
      () => "07/11 07:00",
    );
    expect(chips).toEqual([
      { key: "data", label: "Data", value: "07/11 07:00", iso: "2026-11-07T10:00:00.000Z" },
      { key: "autor", label: "Autor", value: "Harry" },
      { key: "agente", label: "Agente", value: "Lia" },
      { key: "time", label: "Time", value: "Frontend" },
    ]);
    expect(frontmatterChips({ agent: "sumiu", date: "ontem" }, null, (iso) => iso)).toEqual([
      { key: "data", label: "Data", value: "ontem" },
      { key: "agente", label: "Agente", value: "sumiu" },
    ]);
    expect(frontmatterTags({ tags: ["#a", "b", "a"] })).toEqual(["a", "b"]);
    expect(frontmatterTags({ tag: "a, b" })).toEqual(["a", "b"]);
  });

  it("chip de atualização só quando difere da data", () => {
    const chips = frontmatterChips({ autor: "Maestro", atualizado: "2026-11-09T12:10:24.294Z" }, null, () => "há 2 h");
    expect(chips).toEqual([
      { key: "atualizado", label: "Atualizada", value: "há 2 h", iso: "2026-11-09T12:10:24.294Z" },
      { key: "autor", label: "Autor", value: "Maestro" },
    ]);
    expect(frontmatterChips({ data: "2026-11-09", atualizado: "2026-11-09" }, null, () => "x").map((chip) => chip.key)).toEqual(["data"]);
  });
});

describe("corpo e trecho sem frontmatter colado", () => {
  // Caso real: a nota foi regravada com o frontmatter e o título dentro do corpo.
  const body = "\n# Regras — LinkedIn\n\n---\ntipo: regras\ntags: [a, \"b\"]\n---\n# Regras — LinkedIn\n\nRegras que valem.\n\n- Item\n";

  it("cleanNoteBody tira títulos repetidos e o bloco de frontmatter, devolvendo os campos", () => {
    expect(cleanNoteBody(body, "Regras — LinkedIn")).toEqual({
      body: "Regras que valem.\n\n- Item\n",
      frontmatter: { tipo: "regras", tags: ["a", "b"] },
    });
  });

  it("cleanNoteBody não mexe numa linha horizontal comum nem num título diferente", () => {
    expect(cleanNoteBody("Texto\n\n---\nchave: valor\n---\n", "Nota").body).toBe("Texto\n\n---\nchave: valor\n---\n");
    expect(cleanNoteBody("---\n\nTexto", "Nota").body).toBe("---\n\nTexto");
    expect(cleanNoteBody("# Outra\r\n\r\ncorpo", "Nota").body).toBe("# Outra\n\ncorpo");
  });

  it("parseFrontmatterFields lê escalares, listas inline e listas com hífen", () => {
    expect(parseFrontmatterFields("tipo: 'regras'\nautor: \"Maestro\"\ntags:\n  - x\n  - y\nvazio:")).toEqual({
      tipo: "regras",
      autor: "Maestro",
      tags: ["x", "y"],
      vazio: [],
    });
  });

  it("cleanExcerpt tira os pares chave: valor só quando vêm antes do título", () => {
    expect(cleanExcerpt("tipo: regras Regras — LinkedIn Regras que valem neste quarto.", "Regras — LinkedIn")).toBe("Regras que valem neste quarto.");
    expect(cleanExcerpt("Objetivo: movimentar o LinkedIn.", "Briefing")).toBe("Objetivo: movimentar o LinkedIn.");
    expect(cleanExcerpt("tipo: x outra coisa", "Nota")).toBe("tipo: x outra coisa");
  });

  it("plainTitle tira a marcação do título", () => {
    expect(plainTitle("REVISÃO. **Contexto** - LinkedIn do H…")).toBe("REVISÃO. Contexto - LinkedIn do H…");
    expect(plainTitle("Nota simples")).toBe("Nota simples");
  });
});

describe("tipos de nota e datas", () => {
  it("noteKind e o rótulo do tipo", () => {
    expect(noteKind(note("_regras.md", "R", { layer: "fixed" }))).toBe("regras");
    expect(noteKind(note("_indice.md", "I", { layer: "fixed" }))).toBe("indice");
    expect(noteKind(note("historico/x.md", "H", { layer: "history" }))).toBe("historico");
    expect(noteKind(note("doc.md", "D"))).toBe("nota");
    expect(noteTypeLabel({ tipo: "decisao" }, "nota")).toBe("Decisão");
    expect(noteTypeLabel({ tipo: "aprendizado" }, "nota")).toBe("Aprendizado");
    expect(noteTypeLabel({}, "briefing")).toBe("Briefing");
    expect(noteTypeLabel({ tipo: "tarefa" }, "historico")).toBe("Histórico de tarefa");
  });

  it("brainLevel segue o endereço", () => {
    expect(brainLevel({ brainId: null, file: null })).toBe("brains");
    expect(brainLevel({ brainId: "global", file: null })).toBe("notes");
    expect(brainLevel({ brainId: "global", file: "a.md" })).toBe("reader");
  });

  it("relativeDate: minutos, horas, ontem, dias, semanas e a data", () => {
    const now = new Date(2026, 10, 10, 15, 0, 0);
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    expect(relativeDate(ago(20_000), now)).toBe("agora");
    expect(relativeDate(ago(5 * 60_000), now)).toBe("há 5 min");
    expect(relativeDate(ago(2 * 3_600_000), now)).toBe("há 2 h");
    expect(relativeDate(new Date(2026, 10, 9, 9, 0).toISOString(), now)).toBe("ontem");
    expect(relativeDate(new Date(2026, 10, 6, 9, 0).toISOString(), now)).toBe("há 4 dias");
    expect(relativeDate(new Date(2026, 9, 27, 9, 0).toISOString(), now)).toBe("há 2 sem.");
    expect(relativeDate(new Date(2026, 8, 1, 9, 0).toISOString(), now)).toMatch(/^1 de set/);
    expect(relativeDate(new Date(2025, 8, 1, 9, 0).toISOString(), now)).toMatch(/2025/);
    expect(relativeDate("sem data", now)).toBe("sem data");
    expect(absoluteDate(new Date(2026, 10, 9, 12, 10).toISOString())).toMatch(/9 de novembro de 2026.*12:10/);
  });

  it("latestDate pega a mais recente", () => {
    expect(latestDate([{ date: null }, { date: "2026-11-01T00:00:00.000Z" }, { date: "2026-11-09T00:00:00.000Z" }])).toBe("2026-11-09T00:00:00.000Z");
    expect(latestDate([])).toBeNull();
  });
});

describe("wiki links", () => {
  const brains: BrainSummary[] = [
    { id: "global", kind: "lobby", name: "Lobby", notes: [note("preferencias.md", "Preferências do usuário"), note("resumo.md", "Resumo")] },
    { id: "projetox", kind: "team", name: "ProjetoX", notes: [note("resumo-x.md", "Resumo")] },
  ];
  const index = buildWikiIndex(brains);

  it("acha pelo título ou pelo arquivo, preferindo o Cérebro aberto", () => {
    expect(resolveWiki(index, "preferências do usuário", "projetox")).toMatchObject({ brainId: "global", file: "preferencias.md" });
    expect(resolveWiki(index, "preferencias", null)).toMatchObject({ file: "preferencias.md" });
    expect(resolveWiki(index, "Resumo", "projetox")).toMatchObject({ brainId: "projetox", file: "resumo-x.md" });
    expect(resolveWiki(index, "Resumo", "global")).toMatchObject({ brainId: "global", file: "resumo.md" });
    expect(resolveWiki(index, "pasta/Resumo", "global")).toMatchObject({ file: "resumo.md" });
    expect(resolveWiki(index, "Não existe", "global")).toBeNull();
  });
});

describe("outros", () => {
  it("doneSignature muda quando entra uma tarefa concluída", () => {
    const task = (id: string, status: Task["status"], updatedAt: string) => ({ id, status, updatedAt }) as Task;
    const before = doneSignature([task("a", "done", "2026-01-01"), task("b", "in_progress", "2026-01-02")]);
    const after = doneSignature([task("a", "done", "2026-01-01"), task("b", "done", "2026-01-03")]);
    expect(before).not.toBe(after);
    expect(doneSignature(undefined)).toBe("0|");
  });

  it("stripLeadingTitle só tira o título repetido", () => {
    expect(stripLeadingTitle("# Nota\n\ncorpo", "Nota")).toBe("\ncorpo");
    expect(stripLeadingTitle("# Outra\n\ncorpo", "Nota")).toBe("# Outra\n\ncorpo");
    expect(stripLeadingTitle("corpo", "Nota")).toBe("corpo");
  });
});

describe("camadas da lista de notas", () => {
  it("separa fixas, notas e histórico mantendo a ordem do server", () => {
    const list = [
      note("_regras.md", "Regras — X", { layer: "fixed" }),
      note("_briefing.md", "Briefing — X", { layer: "fixed" }),
      note("decisao.md", "Decisão"),
      note("historico/2026-11-07-090503-tela.md", "Tela", { layer: "history" }),
      note("doc.md", "Doc"),
    ];
    const groups = groupNotes(list);
    expect(groups.regra.map((item) => fixedName(item))).toEqual(["Regras"]);
    expect(groups.referencia.map((item) => item.file)).toEqual(["_briefing.md", "decisao.md", "doc.md"]);
    expect(groups.registro.map((item) => item.title)).toEqual(["Tela"]);
  });

  it("groupNotes: o _regras.md vem primeiro, depois as notas de regra (tag ou título); o índice vai para a referência", () => {
    const groups = groupNotes([
      note("a.md", "Regra: sem emoji"),
      note("b.md", "Estilo", { tags: ["regra"] }),
      note("_indice.md", "Índice — X", { layer: "fixed" }),
      note("c.md", "Decisão"),
      note("_regras.md", "Regras — X", { layer: "fixed" }),
    ]);
    expect(groups.regra.map((item) => item.file)).toEqual(["_regras.md", "a.md", "b.md"]);
    expect(groups.referencia.map((item) => item.file)).toEqual(["_indice.md", "c.md"]);
    expect(brainWeight([note("a.md", "Regra: x"), note("b.md", "B"), note("_regras.md", "R", { layer: "fixed" })])).toEqual({ reference: 1, rules: 2 });
    expect(weightLabel({ reference: 1, rules: 2 })).toBe("1 nota de referência · 2 regras");
  });

  it("dicas das prateleiras trocam 'desta sala' por 'deste workspace' no lobby", () => {
    expect(shelfHint("regra", false)).toBe("Entram em toda tarefa desta sala.");
    expect(shelfHint("regra", true)).toBe("Entram em toda tarefa deste workspace.");
    expect(shelfHint("referencia", false)).toBe("O agente só vê o título e lê quando precisa.");
    expect(shelfHint("registro", false)).toBe("Só aparece quando o agente busca.");
  });

  it("regras do agente: conta linhas e diz o estado", () => {
    expect(ruleLineCount("- a\n\n  \n- b\n")).toBe(2);
    expect(agentRulesState("")).toBe("sem regras");
    expect(agentRulesState("- a")).toBe("1 regra");
    expect(agentRulesState("- a\n- b")).toBe("2 regras");
  });

  it("brainAgents lista os agentes dos times do quarto", () => {
    const office = {
      teams: [{ id: "t1", name: "Front", roomId: "sala" }, { id: "t2", name: "Back", roomId: "outra" }],
      agents: [{ id: "a1", name: "Lia", teamId: "t1" }, { id: "a2", name: "Davi", teamId: "t2" }],
    } as unknown as OfficeState;
    expect(brainAgents(office, "sala")).toEqual([{ id: "a1", name: "Lia", teamName: "Front" }]);
    expect(brainAgents(null, "sala")).toEqual([]);
  });

  it("endereço das regras de um agente: ida e volta, sem colidir com notas", () => {
    const hash = agentRulesHash("principal", "sala", "agente 1");
    expect(hash).toBe("#/biblioteca/cerebro/principal/sala/%40agente/agente%201");
    expect(parseBrainHash(hash, "principal")).toEqual({ brainId: "sala", file: null, agentId: "agente 1" });
    expect(brainLevel(parseBrainHash(hash, "principal"))).toBe("reader");
    // Uma nota real sempre termina em .md: nunca vira "@agente".
    expect(parseBrainHash("#/biblioteca/cerebro/principal/sala/%40agente.md", "principal")).toEqual({ brainId: "sala", file: "@agente.md" });
    expect(parseBrainHash("#/biblioteca/cerebro/principal/sala/%40agente", "principal")).toEqual({ brainId: "sala", file: null });
  });

  it("wiki link [[quarto/nome]] acha a nota do histórico pelo nome sem a pasta", () => {
    const index = buildWikiIndex([{ id: "projetoy", kind: "team", name: "ProjetoY", notes: [note("historico/2026-11-07-090503-tela.md", "Tela", { layer: "history" })] }]);
    expect(resolveWiki(index, "projetoy/2026-11-07-090503-tela", null)).toMatchObject({ brainId: "projetoy", file: "historico/2026-11-07-090503-tela.md" });
  });
});
