import { z } from "zod";
import type { FreebuffEngineInfo } from "./freebuff";

/**
 * A tela "Motores" (Configurações): todos os motores que o Cyno conhece, com o estado detectado por
 * código. Claude Code, Antigravity, Freebuff, OpenClaw e Hermes são motores de agente de verdade; o
 * `supported: false` fica para um motor que o servidor só detecta (hoje nenhum, sem o executável configurado).
 */
export const ENGINE_CATALOG_IDS = ["claude", "gemini", "freebuff", "openclaw", "hermes"] as const;
export type EngineCatalogId = (typeof ENGINE_CATALOG_IDS)[number];

/** Motores com suporte (a rota de teste, caminho e "usar como padrão" só valem para eles). */
export const SUPPORTED_ENGINE_IDS = ["claude", "gemini"] as const satisfies readonly EngineCatalogId[];
export type SupportedEngineId = (typeof SUPPORTED_ENGINE_IDS)[number];

export function isSupportedEngineId(value: string): value is SupportedEngineId {
  return (SUPPORTED_ENGINE_IDS as readonly string[]).includes(value);
}

/**
 * OpenClaw e Hermes: um processo por turno. A conta tem duas formas (`OneShotAccount`): a chave do OpenRouter que o dono
 * põe no painel (uma só, guardada pelo servidor e passada por ambiente SÓ a estes dois processos), ou a configuração do
 * próprio programa (provedores por assinatura/OAuth, chaves de qualquer provedor, modelos locais), na pasta pessoal do
 * dono ou na pasta isolada do Cyno. O Cyno nunca faz login por eles e nunca lê os segredos que eles guardam.
 */
export const ONE_SHOT_ENGINE_IDS = ["openclaw", "hermes"] as const satisfies readonly EngineCatalogId[];
export type OneShotEngineId = (typeof ONE_SHOT_ENGINE_IDS)[number];

export function isOneShotEngineId(value: string): value is OneShotEngineId {
  return (ONE_SHOT_ENGINE_IDS as readonly string[]).includes(value);
}

/** Motores que o Cyno sabe instalar em cópia privada (opcional; nunca altera a instalação global do sistema). */
export const INSTALLABLE_ENGINE_IDS = ["claude", "gemini", "openclaw", "hermes"] as const satisfies readonly EngineCatalogId[];
export type InstallableEngineId = (typeof INSTALLABLE_ENGINE_IDS)[number];

export function isInstallableEngineId(value: string): value is InstallableEngineId {
  return (INSTALLABLE_ENGINE_IDS as readonly string[]).includes(value);
}

/**
 * not_installed: executável não achado; installed: achado (com versão, se deu para ler);
 * no_login: achado, mas a conta não está entrada; working: o "Testar" passou nas últimas 24 h;
 * no_quota: a cota da assinatura acabou (`resetsAt` = quando volta);
 */
export const ENGINE_STATES = ["not_installed", "installed", "no_login", "working", "no_quota"] as const;
export type EngineState = (typeof ENGINE_STATES)[number];

/** De onde vem o caminho em uso: escolhido na tela, variável de ambiente (CLAUDE_BIN/AGY_BIN) ou o PATH. */
export type EnginePathSource = "config" | "env" | "path";

/** Resultado do botão "Testar" (um pedido mínimo ao motor). */
export type EngineTestResult = {
  ok: boolean;
  /** Quanto o teste demorou (ms). */
  ms: number;
  /** Quando terminou (ISO). */
  at: string;
  /** O que o motor respondeu (curto), no sucesso. */
  text?: string;
  /** Mensagem clara, na falha. */
  error?: string;
  /** Tokens que a CLI informou (entrada + saída), se informou. */
  tokens?: number;
  /** Modelo do teste. */
  model?: string;
};

/** A chave do OpenRouter como a tela vê: nunca o valor, só o final e quando foi guardada. */
export type OpenRouterKeyInfo = { configured: boolean; last4?: string; savedAt?: string; /** Só na resposta de guardar: a chave foi aceita, mas tem um problema que o dono precisa saber (ex.: é de gerenciamento). */ warning?: string };

/** O aviso da chave de gerenciamento/provisionamento: ela passa na consulta da chave, mas não roda modelos (o chat responde 401 "User not found"). */
export const MANAGEMENT_KEY_NOTICE = "Esta é uma chave de gerenciamento do OpenRouter (serve para criar e administrar outras chaves). Ela não roda modelos.";
export const MANAGEMENT_KEY_FIX = "No openrouter.ai, em Keys, crie uma chave de API comum (não em Management/Provisioning Keys) e troque a chave aqui.";

/** O que a tela Configurar guarda de um motor de um processo por turno. */
export type EngineChoices = { model?: string; /** O id foi digitado e não estava na lista lida do OpenRouter (só o "Verificar" confere). */ unlisted?: boolean; effort?: "low" | "medium" | "high" | "xhigh" | "max"; provider?: string };

/**
 * Como o OpenClaw/Hermes entra na conta. `openrouter`: a chave do painel (isolado na pasta do Cyno, chave por ambiente).
 * `program`: o que o próprio programa guardou; `location` diz de qual pasta ele lê (`personal` = ~/.openclaw / ~/.hermes
 * do dono; `cyno` = a pasta isolada do Cyno, configurada pelo dono no terminal dele).
 */
export const ONE_SHOT_ACCOUNT_MODES = ["openrouter", "program"] as const;
export const ONE_SHOT_LOCATIONS = ["cyno", "personal"] as const;
export type OneShotAccount = { mode: (typeof ONE_SHOT_ACCOUNT_MODES)[number]; location: (typeof ONE_SHOT_LOCATIONS)[number] };
export const DEFAULT_ONE_SHOT_ACCOUNT: OneShotAccount = { mode: "openrouter", location: "cyno" };
export const oneShotAccountBodySchema = z.strictObject({ mode: z.enum(ONE_SHOT_ACCOUNT_MODES).optional(), location: z.enum(ONE_SHOT_LOCATIONS).optional() }).refine((body) => body.mode !== undefined || body.location !== undefined, "informe o modo ou o local");
export type OneShotAccountBody = z.input<typeof oneShotAccountBodySchema>;

/** Um provedor que o programa diz ter ligado, sem nenhum segredo: só o nome, o tipo e quantos perfis. */
export type ProgramProviderKind = "oauth" | "api_key" | "token" | "local" | "unknown";
export const PROGRAM_PROVIDER_KIND_LABELS: Record<ProgramProviderKind, string> = { oauth: "assinatura (OAuth)", api_key: "chave de API", token: "token", local: "modelo local", unknown: "tipo não informado" };
export type ProgramProvider = { provider: string; kind: ProgramProviderKind; /** Quantos perfis/credenciais o programa guarda para o provedor. */ profiles?: number };

/** O que o comando de estado do programa disse (lido sob demanda, nunca guardado com segredo). */
export type ProgramAccountInfo = {
  at: string;
  location: OneShotAccount["location"];
  /** O comando de estado rodou e deu uma resposta que o Cyno entendeu. */
  ok: boolean;
  providers: ProgramProvider[];
  /** O modelo padrão do próprio programa (`provedor/modelo`). */
  defaultModel?: string;
  /** Provedores que o programa usa (modelo padrão etc.) mas ainda sem conta ligada. */
  missing?: string[];
  error?: string;
  /** O formato desta leitura foi conferido com o programa de verdade? (OpenClaw sim; Hermes só pelo código-fonte.) */
  verified: boolean;
  /** O comando de estado usado, para a tela mostrar (sem segredo). */
  command: string;
};

/** A forma "configuração do próprio programa": onde ela fica e os comandos exatos para o dono configurar no terminal dele. */
export type ProgramSetupInfo = {
  /** A pasta de configuração em uso conforme `account.location`. */
  dir: string;
  /** Os comandos (texto copiável), já com as variáveis de ambiente da pasta do Cyno na frente. */
  commands: string[];
  /** As duas pastas possíveis, para a tela explicar a escolha. */
  personalDir: string;
  cynoDir: string;
  /** O que o Cyno escreve nesta forma, em português simples (nada além disso). */
  writes: string[];
};

export type ProgramModelsResponse = { models: { id: string; label?: string }[]; /** De onde veio: o comando do programa, ou "nenhum" (digitação livre). */ source: "program" | "none"; readAt: string; note?: string };

/** Plano de instalação mostrado ANTES de instalar (o dono confirma na tela). */
export type EngineInstallPlan = {
  engine: InstallableEngineId;
  title: string;
  /** O comando exato que o servidor roda (já com as pastas). */
  command: string;
  /** O que acontece, passo a passo, em português simples. */
  steps: string[];
  /** De onde baixa. */
  downloads: string[];
  /** Onde instala. */
  destination: string;
  needsSudo: boolean;
  sudoNote: string;
  /** Arquivos FORA da pasta de instalação que o instalador mexe (ex.: o PATH no ~/.bashrc). */
  touches: string[];
  /** O que não foi confirmado com o programa de verdade. */
  unverified: string[];
};

/** Preço de um modelo do OpenRouter, em dólar por milhão de tokens. */
export type ModelPrice = { free: boolean; promptPerM?: number; completionPerM?: number };

/** Uma etapa do passo a passo: `current` é a da vez (tem o botão de ação). */
export type EngineStep = { id: "install" | "key" | "model" | "verify"; label: string; state: "done" | "todo" | "error" | "current"; detail?: string };

/** Uma checagem do "Verificar": `ok: null` = não deu para checar (depende de outra que falhou). `fix`: o que fazer. */
export type EngineCheck = { id: string; label: string; ok: boolean | null; detail?: string; fix?: string };

export type EngineVerifyResult = {
  at: string;
  /** Todas as checagens passaram, incluindo o turno de teste. */
  ok: boolean;
  checks: EngineCheck[];
  /** O turno de teste de verdade (só roda com a confirmação do dono e se as outras checagens passaram). */
  turn?: EngineTestResult;
  /** As checagens passaram e falta só o turno de teste: o que ele vai usar e quanto pode custar (a tela pede a confirmação). */
  pendingTurn?: { model: string; price?: ModelPrice; notice: string };
};

export type EngineInstallJob = {
  id: string;
  engine: InstallableEngineId;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  /** Últimas linhas da saída do instalador. */
  log: string[];
  error?: string;
};

export type EngineStatus = {
  id: EngineCatalogId;
  label: string;
  /** O que é, em uma linha. */
  blurb: string;
  /** Funciona como motor de agente hoje (falso = "em breve"). */
  supported: boolean;
  state: EngineState;
  version?: string;
  /** Onde o executável foi achado (caminho completo). */
  path?: string;
  pathSource?: EnginePathSource;
  /** Para o motor com caminho configurável: o que está salvo na tela (ausente = nenhum). */
  configuredPath?: string;
  /** Como o dono entra na conta (rodar no terminal dele; o Cyno nunca toca em senha). */
  loginCommand?: string;
  /** Sem cota: quando volta (ISO). */
  resetsAt?: string;
  lastTest?: EngineTestResult;
  /** Texto de apoio (ex.: "o suporte chega numa próxima entrega"). */
  notice?: string;
  /** OpenClaw e Hermes: a chave do OpenRouter (a mesma para os dois). */
  openrouterKey?: OpenRouterKeyInfo;
  /** OpenClaw e Hermes: a forma de conta escolhida no passo "Conta". */
  account?: OneShotAccount;
  /** OpenClaw e Hermes: a cerca de arquivos (Landlock) e se ela vale neste computador. */
  fence?: EngineFence;
  /** Forma "configuração do programa": o que o comando de estado do programa disse (sob demanda) e como configurar. */
  program?: ProgramAccountInfo;
  programSetup?: ProgramSetupInfo;
  /** OpenClaw e Hermes: custo em dólar que o programa relatou nos turnos (informação, não alerta; o modelo gratuito custa zero). */
  spent?: { usd: number; at: string };
  /** O modelo escolhido: gratuito ou pago, e o preço por milhão de tokens (da lista do OpenRouter). */
  modelPrice?: ModelPrice;
  /** O passo a passo guiado: etapas com o estado de cada uma. */
  steps?: EngineStep[];
  /** O último "Verificar". */
  verify?: EngineVerifyResult;
  /** OpenClaw e Hermes: o que foi escolhido em Configurar e a lista de modelos lida do programa (sob demanda). */
  choices?: EngineChoices;
  models?: { id: string; label?: string }[];
  modelsReadAt?: string;
  /** Só no Hermes: o teto de gateways simultâneos (cada um ~270 MB), quantos estão em uso e quantos turnos esperam vaga. */
  gateways?: { max: number; inUse: number; waiting: number };
  /** Hermes não instalado: o botão Instalar existe (o plano vem de `POST …/install/plan`). */
  installable?: boolean;
  /** A última instalação (ou a em andamento). */
  installJob?: EngineInstallJob;
  /** Pontos que não foram verificados com o programa de verdade (aparecem na tela). */
  unverified?: string[];
  /** Só no Freebuff: modelo da plataforma, lista lida do `/model`, horas do dia e horas abertas. */
  freebuff?: FreebuffEngineInfo;
};

export type EngineStatusResponse = { engines: EngineStatus[] };

/**
 * A cerca de arquivos (Landlock) de um motor, como a tela Motores vê. `enabled`: a opção "Cercar os arquivos do agente" (ligada por padrão no OpenClaw e no Hermes);
 * `available`: este computador tem Landlock e Python 3 para montar a cerca; `active`: as duas coisas (é o que vale de verdade nos turnos).
 */
export type EngineFence = {
  enabled: boolean;
  available: boolean;
  active: boolean;
  /** A versão da ABI do Landlock do kernel (só quando há). */
  abi?: number;
  /** Sem cerca neste computador: por quê, em português simples. */
  reason?: string;
};

/** Motores que aceitam a cerca de arquivos: os dois de um processo por turno. (O Freebuff fica de fora: não dá para provar sem gastar as horas do dono.) */
export const FENCEABLE_ENGINES = ["openclaw", "hermes"] as const;

/**
 * Aviso de alcance dos arquivos (revisão 2, G1) SEM a cerca: o Hermes não tem opção para prender as ferramentas de arquivo a uma pasta (provado com o
 * programa): elas leem e gravam em qualquer lugar que o usuário do servidor alcança. O OpenClaw confina por opção própria e não tem aviso.
 */
export const FILE_REACH_WARNING: Partial<Record<OneShotEngineId, string>> = {
  hermes: "Neste motor, um agente com ferramentas de arquivo consegue ler arquivos fora da pasta dele, inclusive a chave do OpenRouter; use em workspaces de confiança.",
};

/** Texto curto de uma linha, para o seletor de motor do agente (o cartão do motor tem o texto inteiro, `fileReachNotice`). */
export const FENCE_ACTIVE_SHORT = "Cerca ativa: o agente só alcança a pasta dele (o sistema bloqueia o resto).";

/**
 * O que a tela diz do alcance dos arquivos de um agente deste motor, em português simples: com a cerca ativa, a verdade nova (o que está fechado e o que sobra); sem a
 * cerca (desligada ou sem Landlock neste computador), o aviso antigo. `undefined` = nada a avisar (OpenClaw sem cerca: ele já prende os arquivos à pasta pela opção dele).
 */
export function fileReachNotice(engine: OneShotEngineId, fence: Pick<EngineFence, "active" | "enabled" | "available"> | undefined, account?: OneShotAccount): string | undefined {
  if (fence?.active) {
    const program = account?.mode === "program";
    if (engine === "hermes") {
      return `Cerca ativa: o sistema operacional fecha, para o agente e tudo que ele abre, o que não é dele. Ele só alcança a pasta de trabalho, o estado do próprio Hermes dele e o temporário dele. Ficam fechados a chave do OpenRouter, o cookie de sessão, os outros agentes e tokens, as configurações dos outros motores, a sua pasta pessoal e as outras pastas. Ainda ao alcance: o token de MCP do próprio agente (no config.yaml dele), a lista de números de processo do computador (sem o conteúdo) e, no Hermes, a pasta pequena do gerenciador de pacotes do programa.${program ? " Com a configuração do próprio programa, o agente também alcança as credenciais que você ligou no Hermes (.env e auth.json), porque o programa precisa lê-las." : ""} Rede e terminal seguem as permissões do workspace.`;
    }
    return "Cerca ativa (além do confinamento do próprio OpenClaw): o sistema operacional fecha o que não é do agente. Ele só alcança a pasta de trabalho, o estado do OpenClaw no Cyno e o temporário dele; a configuração do agente (token de MCP) é só de leitura. Ficam fechados a chave do OpenRouter, o cookie de sessão, os outros agentes, a sua pasta pessoal e as outras pastas. O estado do OpenClaw (as sessões) é compartilhado entre os agentes dele. Com o terminal ligado para um agente, o OpenClaw dele roda sem cerca (o programa precisa ler o /proc dos processos que abre para encerrá-los; sem isso o turno falha): ali valem só a trava de pasta do próprio programa e a sua escolha de ligar o terminal.";
  }
  const base = FILE_REACH_WARNING[engine];
  if (!base) return undefined;
  if (fence && !fence.available) return `${base} Sem cerca neste computador: ele não tem o Landlock que a monta.`;
  if (fence && !fence.enabled) return `${base} A cerca de arquivos está desligada; ligue em "Cercar os arquivos do agente".`;
  return base;
}

export const ENGINE_STATUS_PATH = "/api/engines/status";
export const engineTestPath = (id: string) => `/api/engines/${id}/test`;
export const engineConfigPath = (id: string) => `/api/engines/${id}/config`;
/** OpenClaw e Hermes: o "Verificar" (checagens; `confirm: true` roda também o turno de teste de verdade). */
export const engineVerifyPath = (id: string) => `/api/engines/${id}/verify`;
/** A chave do OpenRouter (uma só, dos dois motores): GET informa, PUT guarda/troca, DELETE remove. Nenhuma rota devolve a chave. */
export const OPENROUTER_KEY_PATH = "/api/engines/openrouter/key";
/** Lê a lista pública de modelos do OpenRouter (sob demanda; fica guardada em disco). */
export const OPENROUTER_MODELS_PATH = "/api/engines/openrouter/models";
/** A forma de conta (PUT `{ mode?, location? }`). */
export const engineAccountPath = (id: string) => `/api/engines/${id}/account`;
/** Lê de novo o que o programa tem ligado (POST; roda só o comando de estado dele). */
export const engineProgramDetectPath = (id: string) => `/api/engines/${id}/program/detect`;
/** Os modelos que o próprio programa lista (GET; vazio = digitação livre). */
export const engineProgramModelsPath = (id: string) => `/api/engines/${id}/program/models`;
/** Hermes pessoal: o dono confirma que o Cyno escreva o bloco do MCP no config.yaml (POST). */
export const engineInstallPlanPath = (id: string) => `/api/engines/${id}/install/plan`;
export const engineInstallPath = (id: string) => `/api/engines/${id}/install`;

/** Corpo do "Verificar" e do "Testar" do OpenClaw e do Hermes: o turno de teste pode custar (modelo pago), então só roda com `confirm: true`. */
export const oneShotTestBodySchema = z.strictObject({ confirm: z.boolean().optional() });
/** Corpo de `PUT /api/engines/openrouter/key`. */
export const openRouterKeyBodySchema = z.strictObject({ key: z.string().trim().min(10).max(300).regex(/^sk-or-[A-Za-z0-9_-]+$/, "Isto não parece uma chave do OpenRouter (começa com sk-or-)") });
/**
 * Um modelo da lista pública do OpenRouter. `provider` = o trecho do id antes da barra; `tools` = a rota informa que o
 * modelo aceita ferramentas (`supported_parameters` com `tools`; ausente = a rota não disse); `inputModalities` = o que
 * ele lê (texto, imagem…); `created` = quando entrou no OpenRouter (segundos desde 1970).
 */
export type OpenRouterModel = { id: string; name: string; provider: string; contextLength?: number; price: ModelPrice; tools?: boolean; inputModalities?: string[]; created?: number };
export type OpenRouterModelsResponse = { models: OpenRouterModel[]; readAt: string };
/** O id de um modelo é só o que o OpenRouter aceita: `provedor/modelo`, com `:sufixo` opcional (sem o prefixo `openrouter/`); o `~` no começo marca os apelidos "sempre o mais novo" (`~deepseek/deepseek-flash-latest`). */
export const OPENROUTER_MODEL_ID = /^~?[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9._-]+)?$/;
/** Tira espaços e o prefixo `openrouter/` (como o id aparece no OpenClaw); devolve o id só se o formato é válido (`openrouter/auto` é um modelo de verdade e fica). */
export function normalizeOpenRouterModelId(raw: string): string | undefined {
  const text = raw.trim();
  const stripped = text.replace(/^openrouter\//i, "");
  if (stripped.length <= 80 && OPENROUTER_MODEL_ID.test(stripped)) return stripped;
  return text.length <= 80 && OPENROUTER_MODEL_ID.test(text) ? text : undefined;
}
/** Com a configuração do programa o modelo é `provedor/modelo` de qualquer provedor (openrouter/…, openai/…, ollama/llama3.2:3b…). */
export const PROGRAM_MODEL_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9~][A-Za-z0-9._:/@+[\]-]*$/;
/** Tira espaços; devolve a referência só se o formato é `provedor/modelo`. */
export function normalizeProgramModelRef(raw: string): string | undefined {
  const text = raw.trim();
  return text.length <= 80 && PROGRAM_MODEL_REF.test(text) ? text : undefined;
}
/** `openrouter/deepseek/x:free` → `{ provider: "openrouter", model: "deepseek/x:free" }`. */
export function splitModelRef(ref: string): { provider: string; model: string } | undefined {
  const index = ref.indexOf("/");
  return index > 0 && index < ref.length - 1 ? { provider: ref.slice(0, index), model: ref.slice(index + 1) } : undefined;
}
/** Corpo de `POST …/install`: só instala com `confirm: true` (o dono viu o plano). */
export const engineInstallBodySchema = z.strictObject({ confirm: z.boolean().optional() });

/** O "Testar" passou nas últimas 24 h conta como "funcionando". */
export const ENGINE_TEST_FRESH_MS = 24 * 3_600_000;

/**
 * Corpo de `PUT /api/engines/:id/config`: o caminho do executável (null/vazio = voltar ao padrão) e, no OpenClaw e no
 * Hermes, o modelo, o esforço e o provedor padrão (vazio/null = o padrão do programa).
 */
export const engineConfigBodySchema = z.strictObject({
  path: z
    .string()
    .trim()
    .max(500)
    .refine((value) => !/[\0\n\r]/.test(value), "caminho inválido")
    .nullable()
    .optional(),
  model: z
    .string()
    .trim()
    .max(80)
    .regex(/^~?[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/, "modelo inválido")
    .nullable()
    .optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional(),
  provider: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "provedor inválido")
    .nullable()
    .optional(),
  /** Só no OpenClaw e no Hermes: a cerca de arquivos (Landlock) dos agentes: ligada ou desligada. */
  fence: z.boolean().optional(),
  /** Só no Hermes: o teto de gateways (agentes em turno) ao mesmo tempo; os outros esperam vaga. */
  maxGateways: z.number().int().min(1).max(8).optional(),
});
export type EngineConfigBody = z.input<typeof engineConfigBodySchema>;
