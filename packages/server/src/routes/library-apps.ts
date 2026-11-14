import { appJobParamsSchema, appParamsSchema, installAppBodySchema, type AppRun, type AppRuntimeInfo, type AppsListing, type InstallJob, type InstallPlan, type LibraryApp } from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppInstaller } from "../library/apps/installer";
import type { AppToolRunner } from "../library/apps/tool-runner";

/**
 * Apps externos da Biblioteca (`/api/library/apps*`), atrás da senha como todo o `/api`. A instalação
 * só começa por aqui, numa chamada da sessão do dono (o clique em "Instalar" depois de ver o plano é
 * o OK): nenhuma ferramenta MCP instala apps. Um token de agente só vale em `/mcp`.
 */
export function registerLibraryAppsRoutes(app: FastifyInstance, installer: AppInstaller, runner: AppToolRunner): void {
  /** O catálogo com o que está instalado, os requisitos desta máquina e os runtimes compartilhados. */
  app.get("/api/library/apps", async (): Promise<AppsListing> => installer.listing());

  /** Execuções recentes das ferramentas dos apps (fila e última execução). */
  app.get("/api/library/apps/runs", async (): Promise<AppRun[]> => runner.list());

  /** Cancela uma execução (na fila ou rodando). */
  app.post("/api/library/apps/runs/:runId/cancel", async (request, reply) => {
    const { runId } = z.object({ runId: z.string().regex(/^R-\d{4,}$/) }).parse(request.params);
    if (!runner.cancel(runId)) return reply.code(404).send({ error: "Execução não encontrada ou já terminou." });
    return reply.code(204).send();
  });

  app.get("/api/library/runtimes", async (): Promise<AppRuntimeInfo[]> => installer.runtimes());

  /** Apaga os runtimes que nenhum app usa. */
  app.post("/api/library/runtimes/clean", async (): Promise<{ removed: string[] }> => ({ removed: await installer.cleanRuntimes() }));

  app.get("/api/library/apps/jobs/:jobId/log", async (request, reply) => {
    const { jobId } = appJobParamsSchema.parse(request.params);
    return reply.header("content-type", "text/plain; charset=utf-8").send(await installer.log(jobId));
  });

  /** O plano mostrado antes do OK: o que baixa e de onde, requisitos nesta máquina, tamanho, licença e avisos. */
  app.get("/api/library/apps/:appId/plan", async (request): Promise<InstallPlan> => {
    const { appId } = appParamsSchema.parse(request.params);
    return installer.plan(appId);
  });

  app.post("/api/library/apps/:appId/install", async (request, reply): Promise<{ app: LibraryApp; job: InstallJob }> => {
    const { appId } = appParamsSchema.parse(request.params);
    const body = installAppBodySchema.parse(request.body ?? {});
    return reply.code(202).send(await installer.install(appId, body));
  });

  /** "Já rodei, continuar" e "Tentar de novo": retoma do passo em que parou. */
  app.post("/api/library/apps/:appId/resume", async (request, reply) => {
    const { appId } = appParamsSchema.parse(request.params);
    return reply.code(202).send(await installer.resume(appId));
  });

  /** Cancela a instalação em andamento e apaga tudo o que ela criou. */
  app.post("/api/library/apps/:appId/cancel", async (request, reply) => {
    const { appId } = appParamsSchema.parse(request.params);
    await installer.cancel(appId);
    return reply.code(204).send();
  });

  app.post("/api/library/apps/:appId/update", async (request, reply) => {
    const { appId } = appParamsSchema.parse(request.params);
    return reply.code(202).send(await installer.update(appId));
  });

  /** Roda o mini teste de novo. */
  app.post("/api/library/apps/:appId/test", async (request): Promise<LibraryApp> => {
    const { appId } = appParamsSchema.parse(request.params);
    return installer.retest(appId);
  });

  app.delete("/api/library/apps/:appId", async (request, reply) => {
    const { appId } = appParamsSchema.parse(request.params);
    await installer.uninstall(appId);
    return reply.code(204).send();
  });
}
