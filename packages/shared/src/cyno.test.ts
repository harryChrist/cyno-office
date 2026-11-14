import { describe, expect, it } from "vitest";
import { availabilitySchema, agendaEventSchema } from "./agenda";
import { cardSummarySchema } from "./card";
import {
  askRecordSchema,
  confirmationSchema,
  cynoMessageBodySchema,
  cynoModelBodySchema,
  cynoSettingsSchema,
  DANGEROUS_ACTIONS,
  parseCynoEvent,
  sentRequestSchema,
  workspaceProposalSchema,
  CYNO_IDLE_MINUTES,
} from "./cyno";
import { jointProjectSchema } from "./joint";
import { INITIAL_MODEL_DEFAULTS, cynoChoiceOf, modelDefaultsSchema } from "./models";
import { mediaItemSchema } from "./media";
import { muralEntrySchema } from "./mural";

const AT = "2026-11-11T12:00:00.000Z";

describe("Cyno: modelos padrão", () => {
  it("o padrão do Cyno é Claude Sonnet com esforço médio; sem o campo, vale o inicial", () => {
    expect(INITIAL_MODEL_DEFAULTS.cyno).toEqual({ engine: "claude", model: "sonnet", effort: "medium" });
    expect(cynoChoiceOf(undefined)).toEqual({ engine: "claude", model: "sonnet", effort: "medium" });
    expect(cynoChoiceOf({ cyno: { engine: "gemini", model: "gemini-3.8-flash-medium" } })).toEqual({ engine: "gemini", model: "gemini-3.8-flash-medium" });
  });

  it("models.json de antes (sem `cyno`) continua válido; com `cyno`, o motor e o modelo são conferidos", () => {
    const old = Object.fromEntries(Object.entries(INITIAL_MODEL_DEFAULTS).filter(([key]) => key !== "cyno"));
    expect(modelDefaultsSchema.parse(old).cyno).toBeUndefined();
    expect(modelDefaultsSchema.parse(INITIAL_MODEL_DEFAULTS).cyno).toEqual(INITIAL_MODEL_DEFAULTS.cyno);
    expect(modelDefaultsSchema.safeParse({ ...old, cyno: { engine: "claude", model: "--perigoso" } }).success).toBe(false);
  });
});

describe("Cyno: mensagens e eventos", () => {
  it("a mensagem do dono é aparada e não pode ser vazia nem enorme", () => {
    expect(cynoMessageBodySchema.parse({ text: "  oi  " }).text).toBe("oi");
    expect(cynoMessageBodySchema.safeParse({ text: "   " }).success).toBe(false);
    expect(cynoMessageBodySchema.safeParse({ text: "x".repeat(8001) }).success).toBe(false);
    expect(cynoMessageBodySchema.safeParse({ text: "oi", extra: 1 }).success).toBe(false);
    expect(cynoModelBodySchema.safeParse({ choice: { engine: "claude", model: "sonnet" } }).success).toBe(true);
  });

  it("parseCynoEvent só aceita os eventos do Cyno", () => {
    expect(parseCynoEvent({ type: "cyno:status", state: {} })?.type).toBe("cyno:status");
    expect(parseCynoEvent({ type: "office:snapshot" })).toBeNull();
    expect(parseCynoEvent(null)).toBeNull();
    expect(parseCynoEvent("texto")).toBeNull();
  });

  it("as configurações têm padrões: 10 minutos de ociosidade, resumo desligado", () => {
    const settings = cynoSettingsSchema.parse({});
    expect(settings.idleMinutes).toBe(CYNO_IDLE_MINUTES);
    expect(settings.dailyTurnCap).toBe(40);
    expect(settings.digest).toEqual({ enabled: false, frequency: "daily", time: "08:00", useAi: false });
  });
});

describe("Cyno: tipos das próximas fatias (com padrões)", () => {
  it("as ações que sempre pedem OK incluem as quatro do dono e o comando na máquina", () => {
    for (const action of ["delete_workspace", "install_connector", "install_app", "run_host_command"]) expect(DANGEROUS_ACTIONS).toContain(action);
  });

  it("confirmação: nasce pendente, do Cyno, e o id segue o formato C-0001", () => {
    const confirmation = confirmationSchema.parse({ id: "C-0001", action: "delete_workspace", paramsHash: "abc", summary: "Apagar o workspace x", createdAt: AT, expiresAt: AT });
    expect(confirmation).toMatchObject({ status: "pendente", origin: "cyno", params: {}, impact: "", reason: "" });
    expect(confirmationSchema.safeParse({ ...confirmation, id: "X-1" }).success).toBe(false);
    expect(confirmationSchema.safeParse({ ...confirmation, action: "rm_rf" }).success).toBe(false);
  });

  it("proposta de workspace: só o nome é obrigatório; o resto assume padrões", () => {
    const proposal = workspaceProposalSchema.parse({ id: "P-0001", plan: { name: "PDFs" }, createdAt: AT, updatedAt: AT });
    expect(proposal).toMatchObject({ version: 1, status: "proposta", progress: [], plan: { name: "PDFs", rooms: [], sites: [], connectors: [], routines: [] } });
  });

  it("pedido enviado, pedido de ajuda do Maestro, ficha, agenda, mural e projeto conjunto", () => {
    expect(sentRequestSchema.parse({ projectId: "p1", workspace: "linkedin", title: "T", address: "linkedin/maestro", sentAt: AT }).workspace).toBe("linkedin");
    expect(askRecordSchema.parse({ id: "A-0001", workspace: "linkedin", kind: "help", message: "m", createdAt: AT }).status).toBe("aberto");
    expect(cardSummarySchema.parse({})).toEqual({ summary: "", by: "dono" });
    expect(cardSummarySchema.safeParse({ summary: "x".repeat(281) }).success).toBe(false);
    const event = agendaEventSchema.parse({ id: "G-0001", title: "Call", start: "2026-11-12T10:00:00-03:00", end: "2026-11-12T11:00:00-03:00", createdAt: AT });
    expect(event).toMatchObject({ kind: "outro", status: "marcado", by: { kind: "dono" } });
    const availability = availabilitySchema.parse({});
    expect(availability.weekly).toHaveLength(5);
    expect(availability).toMatchObject({ bufferMinutes: 15, timezone: "America/Sao_Paulo", exceptions: [] });
    expect(muralEntrySchema.parse({ id: "N-0001", kind: "note", workspace: "design", by: "design/maestro", title: "Vídeo", createdAt: AT })).toMatchObject({ status: "ativo", tags: [], usedBy: [], seenBy: {}, note: "" });
    const joint = jointProjectSchema.parse({ id: "J-0001", title: "T", brief: "B", createdAt: AT, parts: [{ ref: "P1", workspace: "design", title: "A", briefing: "B" }] });
    expect(joint).toMatchObject({ status: "ativo", parts: [{ status: "esperando", dependsOn: [], deliverables: [] }] });
  });

  it("a mídia pode ser compartilhada com a plataforma (shared), sem quebrar as antigas", () => {
    const base = { id: "M-0001", kind: "image", mime: "image/png", fileName: "a.png", title: "A", size: 1, createdAt: AT, createdBy: "usuario", origin: "upload" };
    expect(mediaItemSchema.parse(base).shared).toBeUndefined();
    expect(mediaItemSchema.parse({ ...base, shared: { at: AT } }).shared).toEqual({ at: AT, note: "" });
  });
});
