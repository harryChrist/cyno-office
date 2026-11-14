import { workspaceProposalSchema, type Confirmation } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { agentEngineLabel, confirmationLabel, confirmationTone, liveStatus, pendingDecisions, proposalTotals, purposeLabel, remainingLabel, routineLabel } from "./cynoDecisions";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const confirmation = (over: Partial<Confirmation> = {}): Confirmation => ({
  id: "C-0001",
  action: "delete_workspace",
  params: {},
  paramsHash: "h",
  summary: 'Apagar o workspace "Design"',
  impact: "",
  details: [],
  reason: "",
  status: "pendente",
  origin: "cyno",
  createdAt: "2026-11-11T11:50:00.000Z",
  expiresAt: "2026-11-11T12:20:00.000Z",
  ...over,
});
const proposal = (status: "proposta" | "criada" = "proposta") =>
  workspaceProposalSchema.parse({
    id: "P-0001",
    status,
    plan: {
      name: "Cafeteria",
      rooms: [
        { name: "Conteúdo", purpose: "conteudo", teams: [{ name: "Posts", focus: "x", agents: [{ name: "Bia", engine: "claude", model: "sonnet" }, { name: "Lia", engine: "gemini", model: "gemini-3.8-flash-medium" }] }] },
        { name: "Atendimento", teams: [{ name: "Comentários", focus: "y", agents: [{ name: "Ana", engine: "claude" }] }] },
      ],
    },
    createdAt: "2026-11-11T11:55:00.000Z",
    updatedAt: "2026-11-11T11:55:00.000Z",
  });

describe("cartões de confirmação", () => {
  it("o tempo que falta: minutos, depois segundos, depois venceu", () => {
    expect(remainingLabel("2026-11-11T12:24:10.000Z", NOW)).toBe("vence em 25 min");
    expect(remainingLabel("2026-11-11T12:00:45.000Z", NOW)).toBe("vence em 45 s");
    expect(remainingLabel("2026-11-11T11:59:59.000Z", NOW)).toBe("venceu");
  });

  it("pendente que passou da validade já conta como expirada, sem esperar o servidor", () => {
    expect(liveStatus(confirmation(), NOW)).toBe("pendente");
    expect(liveStatus(confirmation(), NOW + 31 * 60_000)).toBe("expirada");
    expect(liveStatus(confirmation({ status: "executada" }), NOW + 31 * 60_000)).toBe("executada");
  });

  it("rótulos e tons por estado", () => {
    expect(confirmationLabel("recusada")).toBe("Você recusou");
    expect(confirmationTone("executada")).toBe("ok");
    expect(confirmationTone("falhou")).toBe("bad");
    expect(confirmationTone("expirada")).toBe("idle");
  });

  it("a lista de pendentes junta confirmações dentro da validade e propostas por decidir, do mais antigo ao mais novo", () => {
    const list = pendingDecisions(
      [confirmation(), confirmation({ id: "C-0002", status: "recusada" }), confirmation({ id: "C-0003", expiresAt: "2026-11-11T11:59:00.000Z" })],
      [proposal(), { ...proposal("criada"), id: "P-0002" }],
      NOW,
    );
    expect(list.map((item) => item.id)).toEqual(["C-0001", "P-0001"]);
    expect(list[1]!.text).toBe('Criar o workspace "Cafeteria"');
  });
});

describe("cartão de proposta", () => {
  it("totais, motor/modelo, tipo de sala e rotina", () => {
    expect(proposalTotals(proposal().plan)).toBe("2 salas · 2 times · 3 agentes");
    expect(agentEngineLabel({ engine: "gemini", model: "gemini-3.8-flash-medium" })).toBe("Antigravity · gemini-3.8-flash-medium");
    expect(agentEngineLabel({ engine: "claude" })).toBe("Claude Code");
    expect(purposeLabel("conteudo")).toBe("Conteúdo");
    expect(purposeLabel(undefined)).toBe("Geral");
    expect(routineLabel({ title: "Posts da semana", type: "goal", goal: { target: 3, period: "week" } })).toBe("Posts da semana (meta 3 por semana)");
    expect(routineLabel({ title: "Inscrições", type: "tracking" })).toBe("Inscrições (acompanhamento)");
  });
});
