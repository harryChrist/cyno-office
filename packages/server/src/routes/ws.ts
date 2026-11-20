import {
  WS_CLOSE_WORKSPACE_NOT_FOUND,
  WS_EPOCH_PARAM,
  WS_HEARTBEAT_WIRE,
  WS_PATH,
  WS_SINCE_PARAM,
  WS_WORKSPACE_PARAM,
  type BrowserState,
  type ServerEvent,
} from "@cyno/shared";
import type { WebSocket } from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { SequencedMeta } from "../platform/events/hub";
import type { WorkspaceManager } from "../platform/workspaces/manager";
import type { WorkspaceRuntime } from "../workspace/runtime";

/** Manda o evento; os numerados vão com o `seq` (a mensagem já vem serializada do hub). */
function send(socket: WebSocket, event: ServerEvent, meta?: SequencedMeta): void {
  if (socket.readyState === socket.OPEN) socket.send(meta ? meta.wire : JSON.stringify(event));
}

function sendWire(socket: WebSocket, wire: string): void {
  if (socket.readyState === socket.OPEN) socket.send(wire);
}

const BROWSER_OFF: BrowserState = { enabled: false, running: false, tabs: [] };

/** O cursor da reconexão (`?since=&epoch=`), se veio inteiro e válido. */
function cursorOf(query: Record<string, string | undefined>): { epoch: string; since: number } | null {
  const epoch = query[WS_EPOCH_PARAM];
  const raw = query[WS_SINCE_PARAM];
  if (!epoch || raw === undefined || !/^\d{1,15}$/.test(raw)) return null;
  return { epoch, since: Number(raw) };
}

/**
 * O retrato completo do workspace: escritório, progresso, terminais, uso, planos, "Para você"
 * (itens e tipos), conectores e navegador, com o epoch e o seq do hub naquele instante.
 */
function snapshotEvent(runtime: WorkspaceRuntime, manager: WorkspaceManager): ServerEvent {
  return {
    type: "office:snapshot",
    office: runtime.store.snapshot(),
    progress: runtime.progressSnapshot(),
    terminals: runtime.terminals.snapshot(),
    usage: manager.usage.snapshot(),
    projects: runtime.plans.list(),
    forYou: runtime.forYou.list(),
    forYouTypes: runtime.forYouTypes.list(),
    connectors: runtime.connectors.list(),
    browser: runtime.browser?.state() ?? BROWSER_OFF,
    scripts: runtime.scripts.state(),
    epoch: runtime.hub.epoch,
    seq: runtime.hub.seq,
  };
}

export type WsOptions = {
  /** Intervalo do ping; quem não responder com pong até o próximo ping é desconectado. */
  heartbeatMs: number;
};

/**
 * WebSocket de eventos: `/ws?workspace=<id>`. Ao conectar manda `workspaces:list` e o
 * `office:snapshot` daquele workspace (o retrato completo, com o `epoch` e o `seq` do hub) e depois
 * repassa só os eventos dele (cada um com o seu `seq`), mais `workspaces:list` sempre que a lista
 * muda e `usage:updated` (uso da assinatura das CLIs, que é da conta e vai para todos).
 * Reconexão com `&since=<seq>&epoch=<epoch>`: se o hub ainda tem tudo depois de `since`, manda
 * `sync:resumed`, só os eventos perdidos (em ordem) e o uso atual, sem snapshot; senão (outro epoch
 * = server reiniciou, ou o histórico já descartou algum), manda o snapshot como numa conexão nova.
 * Sem `?workspace=`, usa o primeiro da lista; sem `?workspace=` e sem workspace nenhum, fica aberto
 * só com a lista e o uso (a UI mostra "criar workspace" e troca de socket quando um nascer).
 * Workspace inexistente (ou excluído com o socket aberto): manda a lista e fecha com o código 4404.
 */
export function registerWsRoute(app: FastifyInstance, manager: WorkspaceManager, options: WsOptions): void {
  app.get(WS_PATH, { websocket: true }, (socket, request) => {
    const query = request.query as Record<string, string | undefined>;
    const requested = query[WS_WORKSPACE_PARAM] || manager.list()[0]?.id || "";
    const listEvent = (): ServerEvent => ({ type: "workspaces:list", workspaces: manager.list() });
    const notFound = () => socket.close(WS_CLOSE_WORKSPACE_NOT_FOUND, "workspace não encontrado");

    send(socket, listEvent());
    if (!requested) {
      listOnly(socket, manager, options, app);
      return;
    }
    const runtime = manager.find(requested);
    if (!runtime) {
      notFound();
      return;
    }
    // Tudo síncrono até o subscribe: nenhum evento cai entre o retrato (ou o replay) e o ao vivo.
    const cursor = cursorOf(query);
    const missed = cursor ? runtime.hub.replaySince(cursor.epoch, cursor.since) : null;
    if (cursor && missed) {
      send(socket, { type: "sync:resumed", epoch: runtime.hub.epoch, since: cursor.since, until: runtime.hub.seq, replayed: missed.length });
      for (const { wire } of missed) sendWire(socket, wire);
      // O uso da conta não tem histórico: vai o atual (é estado, não evento).
      for (const usage of manager.usage.snapshot()) send(socket, { type: "usage:updated", usage });
    } else {
      send(socket, snapshotEvent(runtime, manager));
    }
    const unsubscribeOffice = runtime.hub.subscribe((event, meta) => send(socket, event, meta));
    const unsubscribeUsage = manager.usage.hub.subscribe((event) => send(socket, event));
    const unsubscribeList = manager.listHub.subscribe((event) => {
      send(socket, event);
      if (event.type === "workspaces:list" && !event.workspaces.some((ws) => ws.id === runtime.id)) notFound();
    });

    watch(socket, options, app, () => {
      unsubscribeOffice();
      unsubscribeUsage();
      unsubscribeList();
    });
  });
}

/** Sem workspace nenhum: o socket só repassa a lista (e o uso da conta) até a UI trocar de socket. */
function listOnly(socket: WebSocket, manager: WorkspaceManager, options: WsOptions, app: FastifyInstance): void {
  const unsubscribeUsage = manager.usage.hub.subscribe((event) => send(socket, event));
  const unsubscribeList = manager.listHub.subscribe((event) => send(socket, event));
  watch(socket, options, app, () => {
    unsubscribeUsage();
    unsubscribeList();
  });
}

/**
 * Heartbeat e limpeza ao fechar. A cada batida vão o ping de protocolo (quem não responde com pong até a próxima é
 * derrubado) e o aviso de vida em texto, que é o que a página consegue ver para saber que a conexão não morreu.
 */
function watch(socket: WebSocket, options: WsOptions, app: FastifyInstance, cleanup: () => void): void {
  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
    sendWire(socket, WS_HEARTBEAT_WIRE);
  }, options.heartbeatMs);
  heartbeat.unref();

  socket.on("close", () => {
    clearInterval(heartbeat);
    cleanup();
  });
  socket.on("error", (error) => app.log.debug({ err: error }, "erro no WebSocket"));
}
