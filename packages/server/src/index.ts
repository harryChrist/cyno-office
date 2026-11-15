import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import { loadConfig, loadRootEnvFile } from "./config";
import { updateConfigFromEnv } from "./platform/version/checker";
import { updateApplyFromEnv } from "./platform/version/run-mode";
import { migrateActivity } from "./workspace/activity/migrate";
import { startActivity, type ActivityHandle } from "./platform/activity/system";
import { createRunner } from "./engines/runner";
import { seedDataDir } from "./workspace/office/seed";
import { migrateLegacyLayout } from "./store/legacy-layout";
import { DEFAULT_MCP_READY_TIMEOUT_MS } from "./engines/terminals/manager";

/** Atividade do servidor (DATA_DIR/activity): boot, batimento, alertas de memória e erros não tratados. */
let system: ActivityHandle | undefined;

async function start(): Promise<FastifyInstance> {
  // Datas do app (calendário, "hoje", "amanhã") no fuso do usuário, não no da máquina (UTC). As CLIs
  // dos agentes herdam. TZ=... no ambiente troca.
  loadRootEnvFile();
  process.env.TZ ||= "America/Sao_Paulo";
  const config = loadConfig();
  if (config.systemLog.enabled) {
    system = await startActivity({ dataDir: config.dataDir, sampleMs: config.systemLog.sampleMs, startData: { port: config.port } });
  }
  // Layout antigo (um escritório só em DATA_DIR) vira o workspace "Principal"; depois, o seed de pastas novas.
  const { migrated } = await migrateLegacyLayout(config.dataDir);
  const { created } = await seedDataDir(config.dataDir);
  // Primeiro boot com a Atividade: converte o diário antigo, preenche o histórico e apaga o resto (uma vez só).
  if (system) {
    const activity = await migrateActivity({ dataDir: config.dataDir }).catch((error: unknown) => {
      console.error("não foi possível migrar a Atividade:", error instanceof Error ? error.message : error);
      return undefined;
    });
    if (activity?.ran) console.log(`Atividade migrada: ${activity.migrated} do diário antigo, ${activity.backfilled} preenchidas do estado, ${activity.removedFiles} arquivos antigos apagados`);
  }
  const app = await buildApp({
    dataDir: config.dataDir,
    logger: { level: config.logLevel },
    runner: createRunner(config),
    doneLingerMs: config.doneLingerMs,
    approvalParkMs: config.approvalParkMs,
    wsHeartbeatMs: config.wsHeartbeatMs,
    ...(config.terminals.cynoIdleMs > 0 ? { cynoIdleMs: config.terminals.cynoIdleMs } : {}),
    terminals: {
      mcpUrl: config.terminals.mcpUrl,
      idleMs: config.terminals.idleMs,
      maxRetries: config.terminals.maxRetries,
      // A primeira mensagem de cada subida espera a CLI conectar no MCP (initialize + tools/list), até 30 s.
      mcpReadyTimeoutMs: DEFAULT_MCP_READY_TIMEOUT_MS,
      claude: { command: config.terminals.claudeBin, defaultEffort: config.terminals.claudeEffort, autocompact: config.terminals.claudeAutocompact },
      maestroRotateTokens: config.terminals.maestroRotateTokens,
      gemini: { command: config.terminals.agyBin },
      // Maestro de Claude Code: o `claude` interativo (pty), com a conversa lida de ~/.claude/projects.
      maestroPty: { enabled: config.terminals.maestroPty, remoteControl: config.terminals.maestroRemoteControl, projectsDir: config.retention.claudeProjectsDir },
    },
    // Retenção do histórico (conversas das CLIs dos nossos agentes e logs de tarefas): boot + diária.
    retention: { claudeProjectsDir: config.retention.claudeProjectsDir, autoRun: config.retention.autoRun },
    connectors: { allowStdio: config.connectorsStdio },
    // Aviso de atualização: CYNO_UPDATE_CHECK=off|0 desliga a verificação automática; CYNO_UPDATE_BRANCH troca o ramo (padrão main);
    // CYNO_UPDATE_APPLY=off|0 desliga o botão que baixa a atualização.
    version: (() => {
      const update = updateConfigFromEnv(process.env);
      return { autoCheck: update.auto, branch: update.branch, applyEnabled: updateApplyFromEnv(process.env) };
    })(),
    browser: config.browser,
    routineTickMs: config.routineTickMs,
    // Sem senha o app fica fechado até a configuração inicial; CYNO_AUTH=off (só dev/testes) abre como antes.
    auth: { open: config.authOff, announce: (lines) => console.log(lines.join("\n")) },
    // Workspaces (e as CLIs dos agentes) só retomam com a porta aberta: o MCP já aceita a conexão delas.
    bootOn: "listen",
    // Uso da conta Claude (endpoint não documentado, com o login do Claude Code); 0 = desligado.
    ...(config.claudeUsagePollMs > 0 ? { accountUsage: { intervalMs: config.claudeUsagePollMs } } : {}),
    // Cota da conta Google no Antigravity (`agy -p /usage`, sem turno de modelo); 0 = desligado.
    ...(config.antigravityUsagePollMs > 0 ? { antigravityUsage: { intervalMs: config.antigravityUsagePollMs, command: config.terminals.agyBin } } : {}),
    ...(system ? { activity: system.log } : {}),
    // Só laboratório: aponta o OpenRouter para um servidor falso (o app de teste nunca fala com o OpenRouter de verdade).
    ...(process.env.OPENROUTER_BASE_URL ? { oneShot: { openrouter: { baseUrl: process.env.OPENROUTER_BASE_URL } } } : {}),
  });
  system?.attachLogger(app.log);
  if (migrated) app.log.info({ dataDir: config.dataDir }, "dados antigos migrados para o workspace Principal");
  if (created) app.log.info({ dataDir: config.dataDir }, "dados iniciais criados (seed)");
  if (config.authOff) app.log.warn("CYNO_AUTH=off: SEM senha o app fica ABERTO a quem alcançar a porta. Só para desenvolvimento e testes.");
  if (config.agentRunner) app.log.warn({ runner: config.agentRunner }, "MODO SIMULADO ligado (AGENT_RUNNER): só para testes");
  try {
    await app.listen({ port: config.port, host: config.host });
    await app.bootWorkspaces();
  } catch (error) {
    app.log.error({ err: error }, "não foi possível iniciar o servidor");
    system?.log.record({ category: "sistema", action: "nao_iniciou", actor: "sistema", summary: `O servidor não conseguiu abrir a porta: ${error instanceof Error ? error.message : String(error)}` });
    system?.log.flushSync();
    process.exit(1);
  }
  return app;
}

let app: FastifyInstance;
try {
  app = await start();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  system?.log.record({ category: "sistema", action: "nao_iniciou", actor: "sistema", summary: `O servidor não conseguiu iniciar: ${error instanceof Error ? error.message : String(error)}` });
  system?.log.flushSync();
  process.exit(1);
}

let closing = false;
/** Shutdown limpo: para o orquestrador, fecha os sockets e espera as gravações pendentes. */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "encerrando o servidor");
  // Segura o processo vivo até o fim: as esperas do desligamento (terminais, navegador) usam timers "unref",
  // e sem isto o Node pode sair calado (código 0) no meio, com a parada marcada só como pedida.
  const keepAlive = setInterval(() => undefined, 1000);
  // Já no disco: se o pm2 matar à força antes do fim, o próximo início sabe que foi um pedido de parada.
  system?.log.flushSync();
  system?.lifecycle.markStopping(signal);
  // Um navegador com o app aberto segura o websocket e o app.close() pode não terminar antes do
  // SIGKILL do pm2 (kill_timeout 10 s): passa de 6 s, segue e marca a parada como limpa mesmo assim.
  await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 6000).unref())]);
  await system?.shutdown(signal);
  clearInterval(keepAlive);
  process.exit(0);
}
// `on`, não `once`: o pm2 mata a árvore toda (bottom-up) e o tsx repassa o sinal, então o node recebe SIGINT
// mais de uma vez; com `once` o segundo cairia no padrão do Node (morrer na hora) no meio do desligamento.
// `closing` ignora os repetidos.
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
