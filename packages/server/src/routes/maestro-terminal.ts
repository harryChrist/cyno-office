import {
  maestroTerminalClientMessageSchema,
  WS_CLOSE_NO_MAESTRO_TERMINAL,
  type MaestroTerminalServerMessage,
} from "@cyno/shared";
import type { WebSocket } from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { TerminalManager } from "../engines/terminals/manager";

/** Junta pedaços de saída por este tempo antes de mandar (menos mensagens quando a TUI redesenha). */
const OUTPUT_BATCH_MS = 8;

function send(socket: WebSocket, message: MaestroTerminalServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

/**
 * WebSocket do terminal do Maestro (`/api/w/:ws/maestro/terminal`): o `claude` interativo dele, ao
 * vivo, para o xterm do painel. Vários navegadores podem assistir ao mesmo tempo; o que qualquer um
 * digita vai para o terminal, e o último a mudar de tamanho decide o tamanho da tela.
 *
 * Ao conectar: `hello` (estado, tamanho, Remote Control), `replay` (o fim recente da saída) e um
 * redesenho da tela; depois `out` a cada saída nova, `status`/`remote` a cada mudança e `exit` quando
 * o processo sai. O navegador manda `in` (teclas), `resize` e `start` (ligar, se parado). Abrir o
 * terminal liga o Maestro se ele estiver parado. Sem terminal interativo (Maestro simulado, outro
 * motor ou modo desligado): fecha com 4409.
 */
export function registerMaestroTerminalRoute(scope: FastifyInstance, terminalsOf: (request: FastifyRequest) => TerminalManager): void {
  scope.get("/maestro/terminal", { websocket: true }, (socket, request) => {
    let terminal;
    try {
      terminal = terminalsOf(request).maestroPty();
    } catch {
      terminal = undefined;
    }
    if (!terminal) {
      socket.close(WS_CLOSE_NO_MAESTRO_TERMINAL, "o Maestro deste workspace não roda num terminal interativo");
      return;
    }
    const pty = terminal;
    const { cols, rows } = pty.dimensions();
    const remote = pty.remote();
    const error = pty.lastError();
    send(socket, { t: "hello", status: pty.status(), cols, rows, ...(remote ? { remote } : {}), ...(error ? { error } : {}) });
    const replay = pty.replay();
    if (replay) send(socket, { t: "replay", d: replay });

    let batch = "";
    let flushTimer: NodeJS.Timeout | undefined;
    const flush = () => {
      flushTimer = undefined;
      if (!batch) return;
      send(socket, { t: "out", d: batch });
      batch = "";
    };
    const offOutput = pty.onOutput((data) => {
      batch += data;
      flushTimer ??= setTimeout(flush, OUTPUT_BATCH_MS);
    });
    const offEvents = pty.onEvent((event) => {
      if (event.type === "status") send(socket, { t: "status", status: event.status, ...(event.error ? { error: event.error } : {}) });
      else if (event.type === "remote") send(socket, { t: "remote", remote: event.remote });
    });
    const offExit = pty.onExit((code) => {
      flush();
      send(socket, { t: "exit", code });
    });

    // Quem abre o terminal quer vê-lo: liga se estiver parado (retomando a conversa).
    if (pty.status() === "stopped" || pty.status() === "error") void pty.ensureRunning().catch(() => undefined);
    else pty.redraw();

    socket.on("message", (raw: Buffer) => {
      let parsed;
      try {
        parsed = maestroTerminalClientMessageSchema.safeParse(JSON.parse(raw.toString("utf8")));
      } catch {
        return;
      }
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.t === "in") pty.write(message.d);
      else if (message.t === "resize") pty.resize(message.cols, message.rows);
      else void pty.ensureRunning().catch(() => undefined);
    });
    socket.on("close", () => {
      if (flushTimer) clearTimeout(flushTimer);
      offOutput();
      offEvents();
      offExit();
    });
    socket.on("error", (err) => request.log.debug({ err }, "erro no WebSocket do terminal do Maestro"));
  });
}
