import {
  CONNECTOR_ICON_MAX_BYTES,
  OAUTH_CALLBACK_PATH,
  createLibraryConnectorBodySchema,
  createLibrarySkillBodySchema,
  importLibrarySkillsBodySchema,
  librarySkillParamsSchema,
  updateLibrarySkillBodySchema,
  SKILL_UPLOAD_BASE64_MAX,
  uploadLibrarySkillBodySchema,
  type ImportLibrarySkillsResponse,
  type LibrarySkillDetail,
  type LibrarySkillView,
  type SkillImportResponse,
  libraryConnectorParamsSchema,
  oauthDiscoverBodySchema,
  oauthFinishBodySchema,
  oauthStartBodySchema,
  setLibraryGrantsBodySchema,
  updateLibraryConnectorBodySchema,
  uploadConnectorIconBodySchema,
  type LibraryConnector,
  type LibraryImportResponse,
  type LibraryWorkspaceInfo,
  type OAuthDiscoveryResult,
  type OAuthStartResponse,
} from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import { OAuthCallbackError } from "../library/connectors/oauth/manager";
import { oauthResultPage } from "../library/connectors/oauth/page";
import type { LibraryService } from "../library/library-service";
import { HttpError } from "../platform/http/errors";

/**
 * Biblioteca da plataforma (`/api/library`, de app inteiro, fora dos workspaces). Atrás da senha de
 * acesso como todo o `/api`. Nenhuma resposta traz segredos: só os nomes dos cabeçalhos/variáveis
 * definidos e a URL mascarada. Quem usa (`uses`) vem com nomes e avatares dos agentes.
 */
export function registerLibraryRoutes(app: FastifyInstance, library: LibraryService): void {
  /** Workspaces e agentes (a janela de liberar mostra todos). */
  app.get("/api/library/workspaces", async (): Promise<LibraryWorkspaceInfo[]> => library.directory());

  registerSkillRoutes(app, library);

  app.get("/api/library/connectors", async (): Promise<LibraryConnector[]> => library.list());

  app.get("/api/library/connectors/import/claude", async (): Promise<LibraryImportResponse> => library.importFromClaude());

  registerOAuthRoutes(app, library);

  app.get("/api/library/connectors/:connectorId", async (request): Promise<LibraryConnector> => {
    const { connectorId } = libraryConnectorParamsSchema.parse(request.params);
    return library.get(connectorId);
  });

  app.post("/api/library/connectors", async (request, reply) => {
    const created = await library.create(createLibraryConnectorBodySchema.parse(request.body));
    return reply.code(201).send(created);
  });

  app.patch("/api/library/connectors/:connectorId", async (request): Promise<LibraryConnector> => {
    const { connectorId } = libraryConnectorParamsSchema.parse(request.params);
    return library.update(connectorId, updateLibraryConnectorBodySchema.parse(request.body));
  });

  app.delete("/api/library/connectors/:connectorId", async (request, reply) => {
    const { connectorId } = libraryConnectorParamsSchema.parse(request.params);
    await library.removeByUser(connectorId);
    return reply.code(204).send();
  });

  /** Testa agora (initialize + tools/list) e devolve o conector com o estado e as ferramentas. */
  app.post("/api/library/connectors/:connectorId/test", async (request): Promise<LibraryConnector> => {
    const { connectorId } = libraryConnectorParamsSchema.parse(request.params);
    return library.test(connectorId);
  });

  /** Liberações nos dois níveis: o mapa inteiro de workspace -> agentes (o que não estiver nele é retirado). */
  app.put("/api/library/connectors/:connectorId/grants", async (request): Promise<LibraryConnector> => {
    const { connectorId } = libraryConnectorParamsSchema.parse(request.params);
    const { grants } = setLibraryGrantsBodySchema.parse(request.body);
    return library.setGrants(connectorId, grants);
  });

  app.post("/api/library/connectors/:connectorId/icon", { bodyLimit: Math.ceil(CONNECTOR_ICON_MAX_BYTES * 1.5) + 4096 }, async (request): Promise<LibraryConnector> => {
    const { connectorId } = libraryConnectorParamsSchema.parse(request.params);
    const body = uploadConnectorIconBodySchema.parse(request.body);
    const bytes = Buffer.from(body.dataBase64, "base64");
    if (bytes.length > CONNECTOR_ICON_MAX_BYTES) throw new HttpError(413, `A imagem passa de ${Math.round(CONNECTOR_ICON_MAX_BYTES / 1024)} KB`);
    return library.setIcon(connectorId, body.mime, bytes);
  });

  app.get("/api/library/connectors/:connectorId/icon", async (request, reply) => {
    const { connectorId } = libraryConnectorParamsSchema.parse(request.params);
    const icon = await library.readIcon(connectorId);
    if (!icon) throw new HttpError(404, "Este conector não tem ícone próprio");
    return reply
      .header("content-type", icon.mime)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'")
      .header("cache-control", "private, max-age=86400")
      .send(icon.bytes);
  });
}

/**
 * Skills da Biblioteca (`/api/library/skills*`). Mesma senha do resto; nenhuma resposta traz caminho do
 * computador do dono além do rótulo da origem ("~/.claude/skills"). Criar/importar nunca libera a
 * ninguém: a liberação é o `PUT /:id/grants` (workspace -> agentes), igual à dos conectores.
 */
function registerSkillRoutes(app: FastifyInstance, library: LibraryService): void {
  const base = "/api/library/skills";

  app.get(base, async (): Promise<LibrarySkillView[]> => library.skillList());

  /** As candidatas em ~/.claude/skills e nos plugins (só nomes e descrições; nada é copiado). */
  app.get(`${base}/import/candidates`, async (): Promise<SkillImportResponse> => library.skills.importCandidates());

  /** Copia as candidatas marcadas para a Biblioteca. */
  app.post(`${base}/import`, async (request, reply): Promise<ImportLibrarySkillsResponse> => {
    const { keys } = importLibrarySkillsBodySchema.parse(request.body);
    const { imported, failed } = await library.skills.importLocal(keys);
    return reply.code(imported.length > 0 ? 201 : 200).send({ imported: imported.map((record) => library.skillView(record)), failed });
  });

  app.post(base, async (request, reply) => {
    const record = await library.skills.create(createLibrarySkillBodySchema.parse(request.body));
    return reply.code(201).send(library.skillView(record));
  });

  /** Pasta (lista de arquivos) ou .zip em base64; com o id de uma skill existente, substitui (guarda a anterior). */
  app.post(`${base}/upload`, { bodyLimit: SKILL_UPLOAD_BASE64_MAX + 64 * 1024 }, async (request, reply) => {
    const body = uploadLibrarySkillBodySchema.parse(request.body);
    const existed = body.id ? library.skills.all().some((record) => record.id === body.id) : false;
    const record = await library.skills.upload(body);
    return reply.code(existed ? 200 : 201).send(library.skillView(record));
  });

  app.get(`${base}/:skillId`, async (request): Promise<LibrarySkillDetail> => {
    const { skillId } = librarySkillParamsSchema.parse(request.params);
    return library.skillDetail(skillId);
  });

  app.put(`${base}/:skillId`, async (request): Promise<LibrarySkillView> => {
    const { skillId } = librarySkillParamsSchema.parse(request.params);
    return library.skillView(await library.skills.update(skillId, updateLibrarySkillBodySchema.parse(request.body)));
  });

  app.delete(`${base}/:skillId`, async (request, reply) => {
    const { skillId } = librarySkillParamsSchema.parse(request.params);
    await library.skills.remove(skillId);
    return reply.code(204).send();
  });

  app.post(`${base}/:skillId/restore`, async (request): Promise<LibrarySkillView> => {
    const { skillId } = librarySkillParamsSchema.parse(request.params);
    return library.skillView(await library.skills.restore(skillId));
  });

  app.post(`${base}/:skillId/duplicate`, async (request, reply) => {
    const { skillId } = librarySkillParamsSchema.parse(request.params);
    return reply.code(201).send(library.skillView(await library.skills.duplicate(skillId)));
  });

  app.put(`${base}/:skillId/grants`, async (request): Promise<LibrarySkillView> => {
    const { skillId } = librarySkillParamsSchema.parse(request.params);
    const { grants } = setLibraryGrantsBodySchema.parse(request.body);
    return library.skillView(await library.skills.setGrants(skillId, grants));
  });
}

/**
 * Login OAuth dos conectores HTTP. Atrás da senha como todo o `/api`. Nenhuma resposta traz token,
 * código nem segredo do cliente. O retorno do login é um GET que o navegador do dono faz (o cookie
 * da sessão vai junto) e termina numa página simples de "Conectado" ou de erro.
 */
function registerOAuthRoutes(app: FastifyInstance, library: LibraryService): void {
  /** Só descobre (nada é guardado): o formulário mostra escopos e se o cadastro é automático. */
  app.post("/api/library/connectors/oauth/discover", async (request): Promise<OAuthDiscoveryResult> => {
    const body = oauthDiscoverBodySchema.parse(request.body);
    return library.discoverOAuthFor(body);
  });

  /** Começa o login: devolve a URL da tela do serviço e o endereço de retorno usado. */
  app.post("/api/library/connectors/:connectorId/oauth/start", async (request): Promise<OAuthStartResponse> => {
    const { connectorId } = libraryConnectorParamsSchema.parse(request.params);
    return library.startOAuth(connectorId, oauthStartBodySchema.parse(request.body).origin);
  });

  /**
   * Termina o login com o endereço colado (retorno em `localhost` quando o navegador não está na máquina
   * do servidor). Nada da URL, do código nem dos tokens vai para o log.
   */
  app.post("/api/library/connectors/:connectorId/oauth/finish", async (request): Promise<LibraryConnector> => {
    const { connectorId } = libraryConnectorParamsSchema.parse(request.params);
    const { callbackUrl } = oauthFinishBodySchema.parse(request.body);
    try {
      return await library.finishOAuth(connectorId, callbackUrl);
    } catch (error) {
      if (error instanceof OAuthCallbackError) throw new HttpError(400, error.message);
      throw error;
    }
  });

  app.post("/api/library/connectors/:connectorId/oauth/disconnect", async (request): Promise<LibraryConnector> => {
    const { connectorId } = libraryConnectorParamsSchema.parse(request.params);
    return library.disconnectOAuth(connectorId);
  });

  /** Retorno do login (o endereço que o dono cadastra no Google). */
  app.get(OAUTH_CALLBACK_PATH, async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const text = (key: string) => (typeof query[key] === "string" ? (query[key] as string).slice(0, 4000) : undefined);
    reply.header("content-type", "text/html; charset=utf-8").header("cache-control", "no-store").header("referrer-policy", "no-referrer").header("x-content-type-options", "nosniff");
    try {
      const done = await library.completeOAuth({ state: text("state"), code: text("code"), error: text("error"), errorDescription: text("error_description"), iss: text("iss") });
      return reply.send(oauthResultPage({ ok: true, name: done.name }));
    } catch (error) {
      if (error instanceof OAuthCallbackError) return reply.code(400).send(oauthResultPage({ ok: false, message: error.message }));
      app.log.warn({ err: error }, "retorno do login OAuth falhou");
      return reply.code(500).send(oauthResultPage({ ok: false, message: "Algo deu errado ao terminar o login. Tente de novo." }));
    }
  });
}
