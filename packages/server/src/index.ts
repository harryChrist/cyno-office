import { startServer, type RunningServer } from "./start";

export { startServer, type RunningServer, type StartServerOptions } from "./start";

let running: RunningServer;
try {
  running = await startServer();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

let closing = false;
/** Shutdown limpo: para o orquestrador, fecha os sockets e espera as gravações pendentes. */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (closing) return;
  closing = true;
  await running.close(signal);
  process.exit(0);
}
// `on`, não `once`: o pm2 mata a árvore toda (bottom-up) e o tsx repassa o sinal, então o node recebe SIGINT
// mais de uma vez; com `once` o segundo cairia no padrão do Node (morrer na hora) no meio do desligamento.
// `closing` ignora os repetidos.
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
