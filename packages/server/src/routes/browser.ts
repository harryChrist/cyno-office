import { browserClientMessageSchema, browserOpenBodySchema, browserTabParamsSchema, type BrowserServerMessage, type BrowserState } from "@cyno/shared";
import type { WebSocket } from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserService } from "../workspace/browser/service";

/** Navegador do workspace da requisição (`:ws`); undefined = desligado no server. */
export type BrowserOf = (request: FastifyRequest) => BrowserService | undefined;

const DISABLED: BrowserState = { enabled: false, running: false, tabs: [] };

function send(socket: WebSocket, message: BrowserServerMessage): void {
  // Sem fila: se o painel não deu conta do quadro anterior (rede lenta), este quadro é pulado.
  if (socket.readyState === socket.OPEN && (message.t !== "frame" || socket.bufferedAmount < 2_000_000)) socket.send(JSON.stringify(message));
}

function requireBrowser(browser: BrowserService | undefined): BrowserService {
  if (!browser) throw Object.assign(new Error("O navegador compartilhado está desligado neste servidor (BROWSER=0)"), { statusCode: 409 });
  return browser;
}

/**
 * Painel "Navegador" (dentro de /api/w/:ws): as abas, abrir/fechar aba do usuário e o WebSocket
 * `/browser/stream` com a tela ao vivo (CDP screencast) e o controle remoto (clique, rolagem,
 * teclas, endereço). É por ele que o usuário faz login nos sites uma vez: o perfil guarda a sessão.
 */
export function registerBrowserRoutes(scope: FastifyInstance, browserOf: BrowserOf): void {
  scope.get("/browser", async (request): Promise<BrowserState> => browserOf(request)?.state() ?? DISABLED);

  scope.post("/browser/tabs", async (request, reply) => {
    const { url } = browserOpenBodySchema.parse(request.body ?? {});
    const tab = await requireBrowser(browserOf(request)).userOpen(url);
    return reply.code(201).send(tab);
  });

  scope.delete("/browser/tabs/:tab", async (request, reply) => {
    const { tab } = browserTabParamsSchema.parse(request.params);
    await requireBrowser(browserOf(request)).userClose(tab);
    return reply.code(204).send();
  });

  scope.get("/browser/stream", { websocket: true }, (socket, request) => {
    const browser = browserOf(request);
    if (!browser) {
      socket.close(4409, "navegador desligado");
      return;
    }
    const leave = browser.viewerJoined();
    let watching: string | null = null;
    let stop: (() => void) | undefined;
    let generation = 0;

    const watch = async (tab: string | null) => {
      const mine = ++generation;
      stop?.();
      stop = undefined;
      watching = tab;
      if (!tab) return;
      try {
        const unwatch = await browser.watch(
          tab,
          (frame) => send(socket, { t: "frame", ...frame }),
          () => send(socket, { t: "gone", tab }),
        );
        // Trocou de aba (ou fechou o painel) enquanto a tela subia.
        if (mine !== generation || socket.readyState !== socket.OPEN) unwatch();
        else stop = unwatch;
      } catch (error) {
        send(socket, { t: "gone", tab });
        request.log.debug({ err: error }, "não foi possível transmitir a aba");
      }
    };

    // Uma ação de cada vez (cliques e teclas na ordem em que o usuário fez).
    let chain = Promise.resolve();
    socket.on("message", (raw: Buffer) => {
      let parsed;
      try {
        parsed = browserClientMessageSchema.safeParse(JSON.parse(raw.toString("utf8")));
      } catch {
        return;
      }
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.t === "watch") {
        void watch(message.tab);
        return;
      }
      const tab = watching;
      if (!tab) return;
      chain = chain.then(() =>
        browser.userInput(tab, message).catch((error: unknown) => {
          send(socket, { t: "error", message: error instanceof Error ? error.message.split("\n")[0]! : String(error) });
        }),
      );
    });
    socket.on("close", () => {
      generation++;
      stop?.();
      leave();
    });
    socket.on("error", (err) => request.log.debug({ err }, "erro no WebSocket do navegador"));
  });
}
