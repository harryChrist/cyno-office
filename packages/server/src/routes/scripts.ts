import { scriptOutputQuerySchema, scriptParamsSchema, type ScriptOutputResponse, type ScriptRun, type ScriptsState } from "@cyno/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { attachment } from "../platform/http/attachment";
import type { ScriptsService } from "../workspace/scripts/service";

/** Scripts do workspace da requisição (`:ws`). */
export type ScriptsOf = (request: FastifyRequest) => ScriptsService;

/** `s12-baixar-capitulos.txt` (id e título sem acentos nem símbolos). */
export function scriptFileName(run: Pick<ScriptRun, "id" | "title">): string {
  const slug = run.title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return `${run.id}${slug ? `-${slug}` : ""}.txt`;
}

/**
 * Scripts dos agentes (dentro de /api/w/:ws):
 * - GET  /scripts                -> os que rodam e os terminados recentes
 * - GET  /scripts/:id            -> um script
 * - GET  /scripts/:id/output     -> a saída em pedaços (?from=<byte>)
 * - GET  /scripts/:id/download   -> a saída inteira, sem cores, como arquivo de texto
 * - POST /scripts/:id/stop       -> para o script (parado por "user")
 */
export function registerScriptRoutes(scope: FastifyInstance, scriptsOf: ScriptsOf): void {
  scope.get("/scripts", async (request): Promise<ScriptsState> => scriptsOf(request).state());

  scope.get("/scripts/:id", async (request): Promise<ScriptRun> => {
    const { id } = scriptParamsSchema.parse(request.params);
    return scriptsOf(request).get(id);
  });

  scope.get("/scripts/:id/output", async (request): Promise<ScriptOutputResponse> => {
    const { id } = scriptParamsSchema.parse(request.params);
    const { from } = scriptOutputQuerySchema.parse(request.query);
    return scriptsOf(request).readOutput(id, from);
  });

  scope.get("/scripts/:id/download", async (request, reply) => {
    const { id } = scriptParamsSchema.parse(request.params);
    const scripts = scriptsOf(request);
    const run = scripts.get(id);
    return reply
      .header("Content-Type", "text/plain; charset=utf-8")
      .header("Content-Disposition", attachment(scriptFileName(run)))
      .header("X-Content-Type-Options", "nosniff")
      .send(await scripts.plainOutput(id));
  });

  scope.post("/scripts/:id/stop", async (request): Promise<ScriptRun> => {
    const { id } = scriptParamsSchema.parse(request.params);
    return scriptsOf(request).stop(id, "user");
  });
}
