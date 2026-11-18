import { BRAIN_RULE_LIMITS, type AgentRulesResponse, type BrainNoteResponse, type BrainOrganizeResponse, type ListBrainsResponse } from "@cyno/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Brain } from "../workspace/brain/brain";
import { HttpError } from "../platform/http/errors";
import type { WorkspaceRuntime } from "../workspace/runtime";

/** Cérebro do workspace da requisição. */
export type BrainOf = (request: FastifyRequest) => Brain;

const noteParamsSchema = z.object({ brainId: z.string(), file: z.string() });
const rulesBodySchema = z.strictObject({ content: z.string().max(BRAIN_RULE_LIMITS.rulesFile) });

/**
 * Navegador do Cérebro, dentro de /api/w/:ws. Os parâmetros não passam por um schema de
 * formato: qualquer coisa que não seja um Cérebro deste workspace ou o nome exato de uma nota
 * .md dele (inclusive "..", "%2e%2e", barras) é simplesmente "não encontrado" (404).
 */
export function registerBrainRoutes(scope: FastifyInstance, brainOf: BrainOf): void {
  scope.get("/brains", async (request): Promise<ListBrainsResponse> => brainOf(request).listBrains());

  scope.get("/brains/:brainId/notes/:file", async (request): Promise<BrainNoteResponse> => {
    const { brainId, file } = noteParamsSchema.parse(request.params);
    const brain = brainOf(request);
    if (!brain.hasBrain(brainId)) throw new HttpError(404, `Cérebro "${brainId}" não encontrado`);
    const note = await brain.readNote(brainId, file);
    if (!note) throw new HttpError(404, `Nota "${file}" não encontrada`);
    return note;
  });

  /** O dono troca o texto do `_regras.md` do Cérebro (a sala ou o lobby): só o corpo; o frontmatter `tipo: regras` fica. */
  scope.put("/brains/:brainId/rules", async (request): Promise<BrainNoteResponse> => {
    const { brainId } = z.object({ brainId: z.string() }).parse(request.params);
    const { content } = rulesBodySchema.parse(request.body);
    const brain = brainOf(request);
    if (!brain.hasBrain(brainId)) throw new HttpError(404, `Cérebro "${brainId}" não encontrado`);
    return brain.setRules(brainId, content);
  });
}

/**
 * Regras de um agente (`agents/<id>/regras.md`), dentro de /api/w/:ws: o que só ele recebe, em toda
 * tarefa. Agente que não existe neste workspace = 404.
 */
export function registerAgentRulesRoutes(scope: FastifyInstance, runtimeOf: (request: FastifyRequest) => WorkspaceRuntime): void {
  const agentOf = (request: FastifyRequest) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const runtime = runtimeOf(request);
    if (!runtime.state.read().agents.some((agent) => agent.id === id)) throw new HttpError(404, `Agente "${id}" não encontrado`);
    return { id, rules: runtime.agentRules };
  };

  scope.get("/agents/:id/rules", async (request): Promise<AgentRulesResponse> => {
    const { id, rules } = agentOf(request);
    return { agentId: id, ...(await rules.read(id)) };
  });

  scope.put("/agents/:id/rules", async (request): Promise<AgentRulesResponse> => {
    const { id, rules } = agentOf(request);
    const { content } = rulesBodySchema.parse(request.body);
    return { agentId: id, ...(await rules.write(id, content)) };
  });
}

/**
 * "Organizar" um Cérebro (POST /brains/:brainId/organize, sem corpo): pede ao Maestro uma proposta de organização, que chega
 * em Aprovações como cartão `kind: "organizacao"`. Aprovar (ou recusar) é pelo `POST /for-you/:id/decision`.
 */
export function registerBrainOrganizeRoute(scope: FastifyInstance, runtimeOf: (request: FastifyRequest) => WorkspaceRuntime): void {
  scope.post("/brains/:brainId/organize", async (request): Promise<BrainOrganizeResponse> => {
    const { brainId } = z.object({ brainId: z.string() }).parse(request.params);
    return runtimeOf(request).brainOrganize.ask(brainId);
  });
}
