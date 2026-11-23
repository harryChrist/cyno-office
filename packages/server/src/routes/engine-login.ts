import {
  DEFAULT_ACCOUNT_ID,
  ENGINE_ACCOUNTS_PATH,
  ENGINE_LABELS,
  engineAccountIdSchema,
  engineLoginClientMessageSchema,
  isAccountEngine,
  type AccountEngine,
  type ApiErrorBody,
  type EngineLoginServerMessage,
} from "@cyno/shared";
import type { WebSocket } from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { EngineAccountStore } from "../engines/accounts/account-store";
import { DEFAULT_ACCOUNT_LABEL, type AccountLoginChecker } from "../engines/accounts/login-status";
import { findExecutable } from "../engines/terminals/engine-status";
import type { EngineBinary } from "../engines/terminals/engines";
import { LoginSessionBusyError, type LoginSession, type LoginSessionManager } from "../engines/terminals/login-session";

/** Junta pedaços de saída do PTY por ~8 ms antes de mandar (igual ao terminal do Maestro). */
const OUTPUT_BATCH_MS = 8;

export type EngineLoginRoutesDeps = {
  store: EngineAccountStore;
  loginChecker: AccountLoginChecker;
  sessions: LoginSessionManager;
  resolveBinary: (engine: AccountEngine) => EngineBinary;
  pathEnv: () => string;
  homeDir: string;
  /** `true` quando o app roda com `CYNO_AUTH=off` (recusa abrir login pelo navegador). */
  authOff: boolean;
  /** Verifica se o servidor tem senha de acesso configurada. */
  authEnabled: () => Promise<boolean>;
  /** Flag explícita só para testes sem senha; em produção sempre `false`/ausente. */
  allowWithoutAuth?: boolean;
};

type ResolvedTarget = {
  engine: AccountEngine;
  accountId: string;
  label: string;
  isDefault: boolean;
};

function send(socket: WebSocket, message: EngineLoginServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function isWebSocketUpgrade(request: FastifyRequest): boolean {
  const upgrade = request.headers.upgrade;
  return typeof upgrade === "string" && upgrade.toLowerCase() === "websocket";
}

/**
 * Rota WebSocket GLOBAL (fora de `/w/:ws`): `GET /api/engines/accounts/:id/login` (upgrade).
 * - Coberta pelo hook de autenticação (`registerAuth`), e recusada quando o servidor roda sem senha
 *   (`CYNO_AUTH=off`), exceto em teste com `allowWithoutAuth: true`.
 * - Conta desconhecida: 404. Motor sem binário instalado: 409 (pt-BR). Segunda sessão: 409 (pt-BR).
 * - Nunca registra o conteúdo do terminal em log nem na Atividade.
 */
export function registerEngineLoginRoutes(app: FastifyInstance, deps: EngineLoginRoutesDeps): void {
  const prepared = new WeakMap<FastifyRequest, LoginSession>();

  app.get<{ Params: { id: string }; Querystring: { engine?: string } }>(
    `${ENGINE_ACCOUNTS_PATH}/:id/login`,
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (!deps.allowWithoutAuth && (deps.authOff || !(await deps.authEnabled()))) {
          return reply.code(403).send({
            error: "O login pelo navegador exige senha de acesso configurada (indisponível sem senha ou com CYNO_AUTH=off).",
          } satisfies ApiErrorBody);
        }

        const id = request.params.id;
        const queryEngine = request.query?.engine;
        let target: ResolvedTarget;

        if (id === DEFAULT_ACCOUNT_ID) {
          if (!queryEngine || !isAccountEngine(queryEngine)) {
            return reply.code(400).send({
              error: "Para a conta padrão, informe o motor (?engine=claude ou ?engine=gemini).",
            } satisfies ApiErrorBody);
          }
          target = { engine: queryEngine, accountId: DEFAULT_ACCOUNT_ID, label: DEFAULT_ACCOUNT_LABEL, isDefault: true };
        } else {
          if (!engineAccountIdSchema.safeParse(id).success) {
            return reply.code(404).send({ error: `Conta "${id}" não encontrada.` } satisfies ApiErrorBody);
          }
          const account = deps.store.get(id);
          if (!account || (queryEngine !== undefined && queryEngine !== account.engine)) {
            return reply.code(404).send({ error: `Conta "${id}" não encontrada.` } satisfies ApiErrorBody);
          }
          target = { engine: account.engine, accountId: account.id, label: account.label, isDefault: false };
        }

        const binary = deps.resolveBinary(target.engine);
        const executable = await findExecutable(binary.command, deps.pathEnv(), deps.homeDir);
        if (!executable) {
          return reply.code(409).send({
            error: `${ENGINE_LABELS[target.engine]} não está instalado neste servidor.`,
          } satisfies ApiErrorBody);
        }

        try {
          deps.sessions.assertAvailable(target.engine, target.accountId);
        } catch (error) {
          if (error instanceof LoginSessionBusyError) {
            return reply.code(409).send({ error: error.message } satisfies ApiErrorBody);
          }
          throw error;
        }

        if (isWebSocketUpgrade(request)) {
          try {
            const { session } = await deps.sessions.openOrReconnect({
              engine: target.engine,
              accountId: target.accountId,
              label: target.label,
              binary,
              ...(target.isDefault ? {} : { cwd: deps.store.profileDir({ id: target.accountId, engine: target.engine }) }),
              ...(target.isDefault ? {} : { profileEnv: deps.store.profileEnv({ id: target.accountId, engine: target.engine }) }),
              checkLogin: () => deps.loginChecker.checkFresh({ engine: target.engine, accountId: target.accountId, isDefault: target.isDefault }),
              onLoginDetected: () => deps.loginChecker.setCached(target.engine, target.accountId, true),
            });
            prepared.set(request, session);
          } catch (error) {
            if (error instanceof LoginSessionBusyError) {
              return reply.code(409).send({ error: error.message } satisfies ApiErrorBody);
            }
            throw error;
          }
        }
        return undefined;
      },
    },
    (socket, request) => {
      const session = prepared.get(request);
      prepared.delete(request);
      if (!session) {
        socket.close(1011, "sessão de login indisponível");
        return;
      }

      const detach = session.attach();
      send(socket, { type: "hello", engine: session.engine, label: session.label });
      const replay = session.replay();
      if (replay) send(socket, { type: "replay", data: replay });
      if (session.loggedIn()) send(socket, { type: "login", loggedIn: true });

      let batch = "";
      let flushTimer: NodeJS.Timeout | undefined;
      const flush = () => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
        if (!batch) return;
        send(socket, { type: "out", data: batch });
        batch = "";
      };

      const offData = session.onData((data) => {
        batch += data;
        flushTimer ??= setTimeout(flush, OUTPUT_BATCH_MS);
      });
      const offLogin = session.onLogin((loggedIn) => {
        flush();
        send(socket, { type: "login", loggedIn });
      });
      const offExit = session.onExit((code) => {
        flush();
        send(socket, { type: "exit", code });
      });

      socket.on("message", (raw: Buffer) => {
        let parsed;
        try {
          parsed = engineLoginClientMessageSchema.safeParse(JSON.parse(raw.toString("utf8")));
        } catch {
          return;
        }
        if (!parsed.success) return;
        const message = parsed.data;
        if (message.type === "in") session.write(message.data);
        else session.resize(message.cols, message.rows);
      });

      socket.on("close", () => {
        if (flushTimer) clearTimeout(flushTimer);
        offData();
        offLogin();
        offExit();
        detach();
      });

      // Nunca registrar conteúdo do terminal no log.
      socket.on("error", () => request.log.debug("erro no WebSocket da sessão de login"));
    },
  );
}
