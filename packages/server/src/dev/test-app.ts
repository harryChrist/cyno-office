import { INITIAL_MODEL_DEFAULTS, type ModelDefaults, type ServerEvent, type Task } from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { afterEach } from "vitest";
import { buildApp, type AppDeps } from "../app";
import type { EventHub } from "../platform/events/hub";
import type { MaestroTimings } from "../sim/coordinator";
import { MockRunner, type MockRunnerOptions } from "../sim/mock-runner";
import type { Sleep } from "../engines/runner/sleep";
import type { AgentRunner } from "../engines/runner/types";
import { SEED_WORKSPACE, seedDataDir } from "../workspace/office/seed";
import type { OfficeStore } from "../store/office-store";
import type { TerminalsConfig } from "../engines/terminals/manager";
import { rootPaths } from "../store/paths";
import { useTempDirs } from "./test-utils";
import type { WorkspaceManager } from "../platform/workspaces/manager";

/** MockRunner determinístico e instantâneo (sem aprovação aleatória). */
export function testRunner(overrides: Partial<MockRunnerOptions> = {}): MockRunner {
  return new MockRunner({
    minMs: 0,
    maxMs: 0,
    approvalRate: 0,
    random: () => 0,
    sleep: async () => undefined,
    ...overrides,
  });
}

/** Sleep que segura todos os passos do MockRunner até `open()`; respeita o AbortSignal. */
export function gatedSleep() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const signals: AbortSignal[] = [];
  const sleep: Sleep = (_ms, signal) => {
    signals.push(signal);
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason as Error);
      signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
      void gate.then(resolve);
    });
  };
  return { sleep, open, signals };
}

/** Guarda todos os eventos do hub e espera por eventos específicos. */
export class EventLog {
  readonly events: ServerEvent[] = [];
  private readonly waiters = new Set<() => void>();

  constructor(hub: EventHub) {
    hub.subscribe((event) => {
      this.events.push(structuredClone(event));
      for (const wake of this.waiters) wake();
    });
  }

  waitFor(predicate: (event: ServerEvent) => boolean, timeoutMs = 3000): Promise<ServerEvent> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = this.events.find(predicate);
        if (!found) return false;
        this.waiters.delete(check);
        clearTimeout(timer);
        resolve(found);
        return true;
      };
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error("evento esperado não chegou a tempo"));
      }, timeoutMs);
      if (!check()) this.waiters.add(check);
    });
  }

  waitForTask(taskId: string, status: Task["status"]): Promise<ServerEvent> {
    return this.waitFor((event) => event.type === "task:upserted" && event.task.id === taskId && event.task.status === status);
  }

  taskStatuses(taskId: string): Task["status"][] {
    return this.events.flatMap((event) => (event.type === "task:upserted" && event.task.id === taskId ? [event.task.status] : []));
  }

  agentStatuses(agentId: string): string[] {
    return this.events.flatMap((event) => (event.type === "agent:upserted" && event.agent.id === agentId ? [event.agent.status] : []));
  }
}

export type TestAppOptions = {
  /**
   * DATA_DIR já existente (para simular reinício). Padrão: nova pasta temporária com seed
   * (o workspace "principal").
   */
  dataDir?: string;
  runner?: AgentRunner;
  /** false = modo simulado desligado (como em produção): sem runner falso, sem motor "mock" na API. */
  simulated?: boolean;
  doneLingerMs?: number;
  /** Quanto uma tarefa que espera o usuário segura a vaga do agente (padrão do servidor: 2 min). */
  approvalParkMs?: number;
  /** Padrão nos testes: o Maestro decide e revisa na hora (0 ms). */
  maestro?: Partial<MaestroTimings>;
  wsHeartbeatMs?: number;
  /** Terminais de CLI (nos testes: sempre a CLI falsa; veja terminals/fake-cli.mjs). */
  terminals?: Partial<TerminalsConfig>;
  /** Conectores (padrão nos testes: sem teste automático de conexão). */
  connectors?: AppDeps["connectors"];
  /** Home falso para importar skills (padrão nos testes: uma pasta vazia dentro do DATA_DIR; nunca o ~/.claude de verdade). */
  skillsHome?: string;
  /** Apps externos da Biblioteca: catálogo, executores e probe falsos (os testes nunca baixam nada). */
  apps?: AppDeps["apps"];
  /** Modelos padrão globais iniciais (padrão nos testes: TEST_MODEL_DEFAULTS, tudo simulado). */
  initialModelDefaults?: ModelDefaults;
  /** Senha de acesso (padrão nos testes: sem pausa após erro). */
  auth?: AppDeps["auth"];
  /** Ociosidade do Cyno em ms antes de dormir (padrão do servidor: 10 min). */
  cynoIdleMs?: number;
  /** Quem manda o Web Push. Padrão nos testes: um falso que não faz nada (nunca fala com um serviço de push de verdade). */
  pushSender?: AppDeps["pushSender"];
  pushBatchMs?: number;
  /** Relógio do app (testes de validade). Padrão: o real. */
  now?: () => Date;
  /** Tela Motores: sonda, PATH e teste falsos. */
  engineTools?: AppDeps["engineTools"];
  /** Atividade do servidor (padrão nos testes: desligada). */
  activity?: AppDeps["activity"];
  /** OpenClaw e Hermes (passo a passo da tela Motores): receita, download, OpenRouter e turno falsos. */
  oneShot?: AppDeps["oneShot"];
  /** Versão do app e verificação de atualização (os testes passam um repositório temporário em `rootDir`). */
  version?: AppDeps["version"];
  /** Freebuff: nos testes, nunca o de verdade (executável que não existe e uma pasta de dados vazia); os testes do motor passam a TUI falsa. */
  freebuff?: AppDeps["freebuff"];
  /** Armazenamento dos motores: pastas temporárias do Antigravity e do Freebuff (padrão nos testes: nenhuma, nunca as de verdade). */
  engineStorage?: AppDeps["engineStorage"];
  /** Contas extras dos motores: HOME falso nos testes (padrão: `fake-home` dentro do DATA_DIR; nunca o HOME real). */
  engineAccounts?: AppDeps["engineAccounts"];
  /** Sessão de login pelo PTY nos testes. */
  engineLogin?: AppDeps["engineLogin"];
  /** Receita falsa de instalação para testes de `claude`/`gemini`/`openclaw`/`hermes`. */
  installRecipe?: AppDeps["installRecipe"];
};

/** Padrões dos testes: Maestro e agentes simulados (workspace novo não cria agente de CLI de verdade). */
export const TEST_MODEL_DEFAULTS: ModelDefaults = {
  maestro: { engine: "mock" },
  agentes: { engine: "mock" },
  subagentes: structuredClone(INITIAL_MODEL_DEFAULTS.subagentes),
};

export type TestApp = {
  app: FastifyInstance;
  /** Hub, store e pasta do workspace "principal" (onde os testes trabalham por padrão). */
  hub: EventHub;
  log: EventLog;
  dir: string;
  store: OfficeStore;
  dataDir: string;
  workspaces: WorkspaceManager;
};

/** Pasta de dados do workspace "principal" dentro de DATA_DIR. */
export const principalDir = (dataDir: string) => rootPaths(dataDir).workspaceDir(SEED_WORKSPACE.id);

/** Prefixo das rotas do workspace "principal". */
export const API = `/api/w/${SEED_WORKSPACE.id}`;

/** App completo (workspaces + orquestradores + rotas) numa pasta temporária; fechado após cada teste. */
export function useTestApp(): (options?: TestAppOptions) => Promise<TestApp> {
  const tempDir = useTempDirs();
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });
  return async (options = {}) => {
    const dataDir = options.dataDir ?? (await tempDir());
    if (!options.dataDir) await seedDataDir(dataDir);
    const app = await buildApp({
      dataDir,
      runner: options.simulated === false ? undefined : (options.runner ?? testRunner()),
      doneLingerMs: options.doneLingerMs ?? 5,
      ...(options.approvalParkMs !== undefined ? { approvalParkMs: options.approvalParkMs } : {}),
      maestro: { triageMinMs: 0, triageMaxMs: 0, reviewMs: 0, ...options.maestro },
      wsHeartbeatMs: options.wsHeartbeatMs,
      // Os testes nunca sobem o `claude` nem o `agy` de verdade: sem CLI falsa, o executável não existe.
      connectors: options.connectors ?? { autoTest: false },
      skills: { homeDir: options.skillsHome ?? path.join(dataDir, "fake-home") },
      ...(options.apps ? { apps: options.apps } : {}),
      initialModelDefaults: options.initialModelDefaults ?? TEST_MODEL_DEFAULTS,
      auth: { failDelayMs: 0, open: true, blocksFile: null, ...options.auth },
      ...(options.cynoIdleMs ? { cynoIdleMs: options.cynoIdleMs } : {}),
      ...(options.now ? { now: options.now } : {}),
      pushSender: options.pushSender ?? (async () => undefined),
      ...(options.pushBatchMs !== undefined ? { pushBatchMs: options.pushBatchMs } : {}),
      ...(options.engineTools ? { engineTools: options.engineTools } : {}),
      ...(options.oneShot ? { oneShot: options.oneShot } : {}),
      ...(options.version ? { version: options.version } : {}),
      ...(options.activity ? { activity: options.activity } : {}),
      ...(options.engineStorage ? { engineStorage: options.engineStorage } : {}),
      engineAccounts: options.engineAccounts ?? { realHomeDir: path.join(dataDir, "fake-home") },
      ...(options.engineLogin ? { engineLogin: options.engineLogin } : {}),
      ...(options.installRecipe ? { installRecipe: options.installRecipe } : {}),
      freebuff: { command: "/nao-existe/freebuff-nunca-nos-testes", manicodeDir: path.join(dataDir, "fake-manicode"), ...options.freebuff },
      terminals: {
        // Os testes nunca sobem o OpenClaw nem o Hermes de verdade (o OpenClaw está instalado na máquina do dono).
        openclaw: { command: "/nao-existe/openclaw-nunca-nos-testes", homeDir: path.join(dataDir, "platform", "engines", "openclaw") },
        hermes: { command: "/nao-existe/hermes-nunca-nos-testes", homeDir: path.join(dataDir, "platform", "engines", "hermes") },
        ...(options.terminals ?? { claude: { command: "/nao-existe/claude-nunca-nos-testes" }, gemini: { command: "/nao-existe/agy-nunca-nos-testes" } }),
      },
    });
    apps.push(app);
    const principal = app.workspaces.get(SEED_WORKSPACE.id);
    // Antes do ready: o log vê também os eventos do boot (resume do orquestrador).
    const log = new EventLog(principal.hub);
    await app.ready();
    return {
      app,
      hub: principal.hub,
      log,
      dir: principalDir(dataDir),
      store: principal.store,
      dataDir,
      workspaces: app.workspaces,
    };
  };
}
