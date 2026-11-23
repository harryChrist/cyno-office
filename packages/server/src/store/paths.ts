import path from "node:path";
import { BOARD_ID_PATTERN, GLOBAL_BRAIN_ID, isSafeId } from "@cyno/shared";

export type DataPaths = {
  root: string;
  officeFile: string;
  /** Marcador do layout: { dataVersion: 4 } (gravado por último pelas migrações: 3 = projetos, 4 = árvore/sprints e o projeto "Avulsas"). */
  schemaFile: string;
  /** Tarefas (unidade do runner) por mês de criação: tasks/AAAA-MM.json. */
  tasksDir: string;
  /** Projetos: projects/<id>.json (cabeçalho e tarefas do projeto). */
  projectsDir: string;
  /** Arquivo mensal somente leitura do "Avulsas": projects/avulsas.archive/AAAA-MM.json (as folhas finalizadas há mais de 14 dias). */
  projectsArchiveDir: string;
  /** Relatório da migração para sprints (o mapa antigo -> Avulsas e o que foi para o arquivo). */
  sprintsReportFile: string;
  /** Itens do "Para você" por mês de criação: for-you/AAAA-MM.json. */
  forYouDir: string;
  /** Arquivo dos itens decididos há mais tempo que o prazo: for-you/archive/AAAA-MM.json (pelo mês da decisão). */
  forYouArchiveDir: string;
  /** Relatório da migração para projetos (o que foi agrupado e as validações). */
  migrationReportFile: string;
  backupRoot: string;
  /** Formato antigo (só a migração lê): tasks.json, plans.json e for-you.json; depois ficam como *.legacy.json. */
  legacy: { tasks: string; plans: string; forYou: string; tasksRenamed: string; plansRenamed: string; forYouRenamed: string };
  /** Eventos do calendário (ausente = calendário vazio). */
  calendarFile: string;
  /** Tipos do "Para você" do workspace (ausente = migração no boot; veja migrateForYouTypes). */
  forYouTypesFile: string;
  /** A frase "o que este workspace faz" da ficha (ausente = sem frase; veja CardSummaryStore). */
  cardFile: string;
  /** Rotinas, livro-razão, execuções e decisões do vigia (ausente = nenhuma rotina; veja RoutineService). */
  routinesFile: string;
  /** Itens acompanhados de uma rotina (routines/<routineId>/items.json), fora de routines.json. */
  routineItemsFile: (routineId: string) => string;
  /** Biblioteca de mídia: índice (media/media.json) e arquivos (media/files/<id>.<ext>). */
  mediaDir: string;
  mediaFile: string;
  mediaFilesDir: string;
  /** Quadros: índice (boards/boards.json) e, por quadro, boards/<id>/page.html e data.json. */
  boardsDir: string;
  boardsFile: string;
  boardDir: (boardId: string) => string;
  brainsDir: string;
  /** Pasta do Cérebro: "global" ou o id de um quarto. */
  brainDir: (brainId: string) => string;
  /** Logs de trabalho dos agentes: um `<taskId>.jsonl` por tarefa (veja AgentLogService). */
  logsDir: string;
  taskLogFile: (taskId: string) => string;
  /** Pastas dos agentes de CLI: `agents/<agentId>/` (cwd do processo, CLAUDE.md, session.json). */
  agentsDir: string;
  agentDir: (agentId: string) => string;
  /** Relatórios da Gestão (congelados): `reports/{day,week,month}/<período>.json`. */
  reportsDir: string;
};

/** Ids de tarefa aceitos no nome do arquivo de log (os do server são UUIDs). */
const TASK_LOG_ID = /^[a-z0-9][a-z0-9-]{0,63}$/i;

export function dataPaths(root: string): DataPaths {
  const brainsDir = path.join(root, "brains");
  const logsDir = path.join(root, "logs");
  const agentsDir = path.join(root, "agents");
  return {
    root,
    officeFile: path.join(root, "office.json"),
    schemaFile: path.join(root, "schema.json"),
    tasksDir: path.join(root, "tasks"),
    projectsDir: path.join(root, "projects"),
    projectsArchiveDir: path.join(root, "projects", "avulsas.archive"),
    sprintsReportFile: path.join(root, "migration-report-sprints.json"),
    forYouDir: path.join(root, "for-you"),
    forYouArchiveDir: path.join(root, "for-you", "archive"),
    migrationReportFile: path.join(root, "migration-report.json"),
    backupRoot: path.join(root, "backup"),
    legacy: {
      tasks: path.join(root, "tasks.json"),
      plans: path.join(root, "plans.json"),
      forYou: path.join(root, "for-you.json"),
      tasksRenamed: path.join(root, "tasks.legacy.json"),
      plansRenamed: path.join(root, "plans.legacy.json"),
      forYouRenamed: path.join(root, "for-you.legacy.json"),
    },
    calendarFile: path.join(root, "calendar.json"),
    forYouTypesFile: path.join(root, "for-you-types.json"),
    cardFile: path.join(root, "card.json"),
    routinesFile: path.join(root, "routines.json"),
    routineItemsFile(routineId) {
      if (!/^R-\d{4,}$/.test(routineId)) throw new Error(`id de rotina inválido: "${routineId}"`);
      return path.join(root, "routines", routineId, "items.json");
    },
    mediaDir: path.join(root, "media"),
    mediaFile: path.join(root, "media", "media.json"),
    mediaFilesDir: path.join(root, "media", "files"),
    boardsDir: path.join(root, "boards"),
    boardsFile: path.join(root, "boards", "boards.json"),
    boardDir(boardId) {
      if (!BOARD_ID_PATTERN.test(boardId)) throw new Error(`id de quadro inválido: "${boardId}"`);
      return path.join(root, "boards", boardId);
    },
    brainsDir,
    brainDir(brainId) {
      if (brainId !== GLOBAL_BRAIN_ID && !isSafeId(brainId)) {
        throw new Error(`id de Cérebro inválido: "${brainId}"`);
      }
      return path.join(brainsDir, brainId);
    },
    logsDir,
    taskLogFile(taskId) {
      if (!TASK_LOG_ID.test(taskId)) throw new Error(`id de tarefa inválido: "${taskId}"`);
      return path.join(logsDir, `${taskId}.jsonl`);
    },
    agentsDir,
    reportsDir: path.join(root, "reports"),
    agentDir(agentId) {
      if (!isSafeId(agentId)) throw new Error(`id de agente inválido: "${agentId}"`);
      return path.join(agentsDir, agentId);
    },
  };
}

/**
 * Raiz de DATA_DIR:
 * - workspaces.json: lista de workspaces ({ id, name, createdAt });
 * - workspaces/<id>/: os dados de cada workspace (office.json, schema.json, tasks/, projects/, for-you/, calendar.json, for-you-types.json, brains/, logs/, agents/), veja dataPaths;
 * - excluidos/workspaces/: pastas de workspaces excluídos (nada é apagado de verdade).
 */
export type RootPaths = {
  root: string;
  workspacesFile: string;
  workspacesDir: string;
  /** Pasta de dados de um workspace. */
  workspaceDir: (workspaceId: string) => string;
  deletedWorkspacesDir: string;
};

export function rootPaths(root: string): RootPaths {
  const workspacesDir = path.join(root, "workspaces");
  return {
    root,
    workspacesFile: path.join(root, "workspaces.json"),
    workspacesDir,
    workspaceDir(workspaceId) {
      if (!isSafeId(workspaceId)) throw new Error(`id de workspace inválido: "${workspaceId}"`);
      return path.join(workspacesDir, workspaceId);
    },
    deletedWorkspacesDir: path.join(root, "excluidos", "workspaces"),
  };
}

/**
 * Dados da plataforma (o que não é de um workspace): `data/platform/`.
 * - cyno/: a pasta do Cyno (cwd da CLI: CLAUDE.md, GEMINI.md, mcp.json, session.json) e o log da conversa;
 * - usage/: o histórico de gastos do Cyno ("Cyno · plataforma" na página Gastos);
 * - settings.json: ociosidade e afins (veja `cynoSettingsSchema`).
 * Agenda, mural, projetos conjuntos e confirmações entram aqui nas próximas fatias.
 */
export type PlatformPaths = {
  root: string;
  cynoDir: string;
  /** Log da conversa do Cyno: `conversa-cyno-AAAAMMDD.jsonl` (formato do log dos agentes). */
  logsDir: string;
  logFile: (logId: string) => string;
  usageDir: string;
  settingsFile: string;
  /** Pedidos que o Cyno enviou aos Maestros (`sent-requests.json`). */
  requestsFile: string;
  /** O que o Cyno já viu das fichas (`cyno/cards-seen.json`): o cursor do delta sobrevive a um reinício. */
  cardsSeenFile: string;
  /** Quantos turnos o Cyno usou hoje (`cyno/turns.json`). */
  turnsFile: string;
  /** Pedidos de ajuda dos Maestros ao Cyno (`asks.json`). */
  asksFile: string;
  /** Confirmações de ações perigosas (`cyno/confirmations.json`) e propostas de workspace (`cyno/proposals.json`). */
  confirmationsFile: string;
  proposalsFile: string;
  /** Registro completo dos comandos rodados na máquina (`cyno/host-commands.jsonl`). */
  hostCommandsFile: string;
  /** Pasta de trabalho padrão do `run_host_command` (`cyno/work/`). */
  workDir: string;
  /** `data/platform/agenda/`: os compromissos do tempo do dono (events.json) e a disponibilidade (availability.json). */
  agendaDir: string;
  agendaEventsFile: string;
  availabilityFile: string;
  /** `data/platform/joint/`: um arquivo por projeto conjunto (J-0001.json). */
  jointDir: string;
  /** `attention.json`: as preferências do dono e os alertas que não se refazem sozinhos (a cadeia de atenção). */
  attentionFile: string;
  /** `usage-guard.json`: as regras de pausa por limite de uso do plano e as pausas em vigor. */
  usageGuardFile: string;
  /** `owner.json`: a presença do dono e o "enquanto você estava fora" (uma só para todos os navegadores). */
  ownerFile: string;
  /** `push.json` (modo 0600): as chaves VAPID e os aparelhos inscritos no aviso com o site fechado. Nunca sai por rota (só a chave pública). */
  pushFile: string;
  /** `engine-accounts.json`: contas extras dos motores (Claude Code e Antigravity); pastas ficam em `platform/engines/<motor>/accounts/<id>/`. */
  engineAccountsFile: string;
  /** `data/platform/reports/week/AAAA-Www.json`: a semana da plataforma (a soma e um bloco por workspace). */
  reportsDir: string;
};

export function platformPaths(dataRoot: string): PlatformPaths {
  const root = path.join(dataRoot, "platform");
  const cynoDir = path.join(root, "cyno");
  const logsDir = path.join(cynoDir, "logs");
  return {
    root,
    cynoDir,
    logsDir,
    logFile(logId) {
      if (!TASK_LOG_ID.test(logId)) throw new Error(`id de log inválido: "${logId}"`);
      return path.join(logsDir, `${logId}.jsonl`);
    },
    usageDir: path.join(root, "usage"),
    settingsFile: path.join(root, "settings.json"),
    requestsFile: path.join(root, "sent-requests.json"),
    cardsSeenFile: path.join(cynoDir, "cards-seen.json"),
    turnsFile: path.join(cynoDir, "turns.json"),
    asksFile: path.join(root, "asks.json"),
    confirmationsFile: path.join(cynoDir, "confirmations.json"),
    proposalsFile: path.join(cynoDir, "proposals.json"),
    hostCommandsFile: path.join(cynoDir, "host-commands.jsonl"),
    workDir: path.join(cynoDir, "work"),
    agendaDir: path.join(root, "agenda"),
    agendaEventsFile: path.join(root, "agenda", "events.json"),
    availabilityFile: path.join(root, "agenda", "availability.json"),
    jointDir: path.join(root, "joint"),
    attentionFile: path.join(root, "attention.json"),
    usageGuardFile: path.join(root, "usage-guard.json"),
    ownerFile: path.join(root, "owner.json"),
    pushFile: path.join(root, "push.json"),
    engineAccountsFile: path.join(root, "engine-accounts.json"),
    reportsDir: path.join(root, "reports"),
  };
}
