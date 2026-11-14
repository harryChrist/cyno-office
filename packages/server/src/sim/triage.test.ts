import { MAESTRO_TEXTS, type Agent, type Room, type Team } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { buildSeedOffice } from "../workspace/office/seed";
import { TEST_AVATAR } from "../dev/test-api";
import { keywords, stem, triage } from "./triage";

const room = (id: string, name: string, kind: Room["kind"] = "team", x = 1): Room => ({
  id,
  kind,
  name,
  theme: "mint",
  gridPosition: { x, y: 0 },
  readsGlobalBrain: true,
  readsBrainsOf: [],
});
const team = (id: string, roomId: string, name: string, focus = "geral"): Team => ({ id, roomId, name, focus });
const agent = (id: string, teamId: string, role = "Generalista", instructions = ""): Agent => ({
  id,
  teamId,
  name: id,
  role,
  instructions,
  avatar: TEST_AVATAR,
  status: "idle",
});

/** Estúdio (Vídeo) e Escritório (Textos), mais a Sala do Maestro com a Gerência. */
function studioOffice() {
  return {
    rooms: [room("estudio", "Estúdio"), room("escritorio", "Escritório", "team", 2), room("sala", "Sala do Maestro", "maestro", -1)],
    teams: [team("textos", "escritorio", "Textos", "escrever e revisar"), team("video", "estudio", "Vídeo", "gravar e editar"), team("gerencia", "sala", "Gerência", "coordenar vídeo e textos")],
    agents: [agent("ana", "textos", "Redatora"), agent("bia", "video", "Editora", "Editar os cortes"), agent("maestro", "gerencia", "maestro")],
  };
}

describe("keywords e stem", () => {
  it("tira acento, plural e palavras genéricas; os marcadores do mock não contam", () => {
    expect(stem("Vídeos")).toBe("video");
    expect(stem("pesquisar")).toBe(stem("Pesquisas"));
    expect([...keywords("Quero um vídeo para o canal [aprovar] [falhar]").values()]).toEqual(["vídeo", "canal"]);
    expect([...keywords("Editar os vídeos e o vídeo").keys()]).toEqual(["editar", "video"]);
  });
});

describe("triage (regra do Maestro)", () => {
  it("escolhe o time cujas pistas batem com o pedido e explica o porquê", () => {
    const result = triage(studioOffice(), "Preciso de um vídeo curto de lançamento");
    expect(result).toMatchObject({ kind: "team", team: { id: "video" }, room: { id: "estudio" } });
    expect(result.reason).toBe("pedido fala de 'vídeo' → time Vídeo do quarto Estúdio");
  });

  it("soma nome do time, foco, nome do quarto e papel/instruções dos agentes", () => {
    const office = studioOffice();
    // "editar" está no foco do Vídeo e nas instruções da Bia; "revisar" só no foco de Textos.
    const result = triage(office, "Editar e revisar");
    expect(result.kind === "team" && result.team.id).toBe("video");
    const scores = Object.fromEntries(result.scores.map((score) => [score.team.id, score.score]));
    expect(scores).toEqual({ textos: 3, video: 4 });
  });

  it("no seed: pesquisa vai para Pesquisa, API para Backend, tela para o Frontend", () => {
    const office = buildSeedOffice();
    const pick = (prompt: string) => {
      const result = triage(office, prompt);
      return result.kind === "team" ? result.team.id : result.kind;
    };
    expect(pick("Pesquisar referências sobre agentes")).toBe("projetoy-pesquisa");
    expect(pick("Criar endpoints da API de pedidos")).toBe("projetox-backend");
    expect(pick("Revisar o texto do post")).toBe("projetoy-conteudo");
  });

  it("nenhuma pista: vai para o primeiro time (na ordem da lista)", () => {
    const result = triage(studioOffice(), "Bom dia!");
    expect(result).toMatchObject({ kind: "team", team: { id: "textos" } });
    expect(result.reason).toBe("nenhuma pista no pedido → primeiro time Textos do quarto Escritório");
  });

  it("empate: vai para o primeiro dos empatados e diz isso no motivo", () => {
    const office = studioOffice();
    office.teams[0]!.focus = "gravar textos";
    const result = triage(office, "gravar");
    expect(result).toMatchObject({ kind: "team", team: { id: "textos" } });
    expect(result.reason).toBe("pedido fala de 'gravar', empate entre Textos e Vídeo → primeiro time Textos do quarto Escritório");
  });

  it("ignora a Gerência e times sem agentes", () => {
    const office = studioOffice();
    office.agents = office.agents.filter((candidate) => candidate.id !== "bia");
    const result = triage(office, "coordenar o vídeo");
    expect(result).toMatchObject({ kind: "team", team: { id: "textos" } });
    expect(result.scores.map((score) => score.team.id)).toEqual(["textos"]);
  });

  it("sem time: pede ao usuário para criar um quarto e um time; sem agentes: para adicionar um agente", () => {
    const office = studioOffice();
    const onlyMaestro = { ...office, teams: office.teams.filter((t) => t.id === "gerencia"), agents: office.agents.filter((a) => a.id === "maestro") };
    expect(triage(onlyMaestro, "vídeo")).toMatchObject({ kind: "none", reason: MAESTRO_TEXTS.noTeam });
    const noAgents = { ...office, agents: office.agents.filter((a) => a.id === "maestro") };
    expect(triage(noAgents, "vídeo")).toMatchObject({ kind: "none", reason: MAESTRO_TEXTS.noAgents });
  });
});
