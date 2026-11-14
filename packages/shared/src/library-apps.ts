import { z } from "zod";
import type { LibraryApp } from "./library";

/**
 * Apps externos da Biblioteca (a aba Apps): o catálogo curado, as receitas de instalação (passos
 * tipados, executados por código, sem shell), os requisitos verificados na máquina, o plano mostrado
 * ao dono antes do OK e o andamento da instalação (job). Dados em `data/platform/apps/<id>/` e
 * `data/platform/runtimes/`.
 */

const slugSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/);

// ---------- Receita ----------

/** Runtimes compartilhados que a plataforma baixa para `data/platform/runtimes/` (nada no sistema). */
export const APP_RUNTIMES = ["uv", "ffmpeg", "chrome"] as const;
export type AppRuntimeId = (typeof APP_RUNTIMES)[number];

/** Caminho relativo à pasta do app (sem "..", sem barra inicial). */
const relPathSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes("..") && !value.includes("\0"), "caminho tem que ser relativo à pasta do app");

const stepBase = { label: z.string().max(120).optional(), timeoutSec: z.number().int().min(5).max(3600).optional() };

/** Pacote Python fixado: `nome==1.2.3`. */
const pinnedPip = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\-[\],]*==[A-Za-z0-9._+!-]+$/, "versão tem que estar fixada com ==");
/** Pacote npm fixado: `nome@1.2.3` (com ou sem escopo). */
const pinnedNpm = z.string().regex(/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d[A-Za-z0-9._+-]*$/, "versão tem que estar fixada com @");

export const recipeStepSchema = z.discriminatedUnion("run", [
  /** Baixa (se faltar) um runtime compartilhado para `runtimes/` e confere o sha256. */
  z.object({ run: z.literal("download-runtime"), runtime: z.enum(APP_RUNTIMES), ...stepBase }),
  /** Ambiente Python do app (`.venv`) com o Python do uv (nunca o do sistema). */
  z.object({ run: z.literal("venv"), python: z.string().regex(/^3\.\d{1,2}$/), ...stepBase }),
  /** `uv pip install` no `.venv` do app, só com versões fixadas. `torchBackend: "cpu"` evita as rodas de GPU. */
  z.object({ run: z.literal("pip-install"), packages: z.array(pinnedPip).min(1).max(20), torchBackend: z.enum(["cpu"]).optional(), ...stepBase }),
  /** `npm install --prefix <app>` com versões fixadas. */
  z.object({ run: z.literal("npm-install"), packages: z.array(pinnedNpm).min(1).max(20), ignoreScripts: z.boolean().default(true), ...stepBase }),
  /** Clona um repositório num commit fixado, dentro da pasta do app. */
  z.object({ run: z.literal("git-clone"), repo: z.url(), ref: z.string().regex(/^[0-9a-f]{40}$/, "use o hash completo do commit"), to: relPathSchema, /** Só estas pastas do repositório (clone parcial: não baixa o resto). */ sparse: z.array(relPathSchema).max(12).optional(), ...stepBase }),
  /** Baixa um arquivo com sha256 conferido (e, se pedido, descompacta .tar.gz). */
  z.object({ run: z.literal("download"), url: z.url(), sha256: z.string().regex(/^[0-9a-f]{64}$/), to: relPathSchema, unpack: z.enum(["tar.gz", "zip"]).optional(), ...stepBase }),
  /** Escreve um arquivo de texto (fixo, vindo do catálogo) dentro da pasta do app: projeto do mini teste, skill nossa. */
  z.object({ run: z.literal("write-file"), to: relPathSchema, content: z.string().max(60_000), ...stepBase }),
  /** Roda um binário que está DENTRO da pasta do app (ex.: `.venv/bin/python`), sem shell. */
  z.object({ run: z.literal("exec"), bin: relPathSchema, args: z.array(z.string().max(500)).max(40).default([]), ...stepBase }),
  /** Confere algo do sistema: se faltar, o job vira "precisa de você" com o comando para o dono rodar. */
  z.object({ run: z.literal("require-system"), bin: z.string().regex(/^[A-Za-z0-9._+-]+$/), sudoHint: z.string().min(1).max(600), reason: z.string().max(300).optional(), ...stepBase }),
]);
export type RecipeStep = z.output<typeof recipeStepSchema>;
export type RecipeStepInput = z.input<typeof recipeStepSchema>;

// ---------- Catálogo ----------

export const APP_AREAS = ["video", "imagem", "documentos", "web", "audio", "decisao"] as const;
export type AppArea = (typeof APP_AREAS)[number];

/** `disponivel` tem receita testada; `em-breve` e `em-avaliacao` aparecem no catálogo sem botão de instalar. */
export const CATALOG_STATUSES = ["disponivel", "em-breve", "em-avaliacao"] as const;

export const appRequirementSchema = z.object({
  kind: z.enum(["python", "node", "binary", "chrome", "gpu", "ram", "disk"]),
  /** `>=3.12`, `ffmpeg`, `1500MB`... */
  spec: z.string().min(1).max(60),
  /** Como a plataforma resolve sozinha, sem sudo. */
  provision: z.enum(["uv-python", "static-ffmpeg", "self-download"]).optional(),
  /** Comando que o dono roda quando falta algo do sistema (o Cyno nunca roda sudo). */
  sudoHint: z.string().max(600).optional(),
  /** Frase curta para a tela. */
  note: z.string().max(200).optional(),
});
export type AppRequirement = z.output<typeof appRequirementSchema>;

// ---------- Conector `app` (o "MCP fino nosso") ----------

const paramNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,30}$/);
const paramBase = { name: paramNameSchema, description: z.string().min(1).max(400), optional: z.boolean().default(false) };

/** Parâmetro tipado de uma ferramenta `app`: o servidor valida antes de montar o comando. */
export const appToolParamSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("string"), ...paramBase, default: z.string().max(500).optional(), pattern: z.string().max(200).optional(), maxLength: z.number().int().min(1).max(20_000).default(2000) }),
  z.object({ type: z.literal("integer"), ...paramBase, default: z.number().int().optional(), min: z.number().int().optional(), max: z.number().int().optional() }),
  z.object({ type: z.literal("number"), ...paramBase, default: z.number().optional(), min: z.number().optional(), max: z.number().optional() }),
  z.object({ type: z.literal("boolean"), ...paramBase, default: z.boolean().optional() }),
  z.object({ type: z.literal("enum"), ...paramBase, values: z.array(z.string().min(1).max(60)).min(1).max(30), default: z.string().max(60).optional() }),
  /** Caminho preso à pasta do agente (a pasta do app, no teste do instalador). `new-file`/`new-dir`: não existe ainda. */
  z.object({ type: z.literal("path"), ...paramBase, must: z.enum(["exist-dir", "exist-file", "new-file", "new-dir"]), ext: z.array(z.string().regex(/^\.[a-z0-9]{1,8}$/)).max(12).optional() }),
]);
export type AppToolParam = z.output<typeof appToolParamSchema>;

/** Item do comando: texto com `{param}` (no máximo um por item) ou `{ if: "param", args: [...] }` (só entra se o parâmetro veio). */
const argvItemSchema = z.union([z.string().min(1).max(400), z.object({ if: paramNameSchema, args: z.array(z.string().min(1).max(400)).min(1).max(8) })]);

export const appToolSpecSchema = z
  .object({
    /** Nome em inglês (vira `<prefixo>__<nome>` para o agente). */
    name: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
    /** Em inglês: o modelo lê. */
    description: z.string().min(1).max(1500),
    params: z.array(appToolParamSchema).max(16).default([]),
    /** [executável, ...argumentos]. Executável: caminho dentro da pasta do app, ou `runtime:<id>/<arquivo>`. Sem shell. */
    command: z.array(argvItemSchema).min(1).max(60),
    /** `app` (pasta do app) ou `param:<nome>` (um parâmetro de caminho `exist-dir`/`new-dir`). */
    cwd: z.string().regex(/^(app|param:[a-z][a-z0-9_]{0,30})$/).default("app"),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(400)).default({}),
    timeoutSec: z.number().int().min(5).max(3600).default(900),
    /** Linha do processo -> andamento. Grupos `pct` (0-100) ou `done` e `total`. */
    progress: z.object({ regex: z.string().max(200) }).optional(),
    /** Linhas de ruído (barras de andamento, rastros): não entram no texto que o agente recebe. */
    quiet: z.array(z.string().max(200)).max(10).optional(),
    /** O arquivo que a ferramenta gera: tem que existir e não estar vazio; vídeo/áudio são conferidos com o ffprobe e vão para a Mídia. */
    output: z.object({ param: paramNameSchema, kind: z.enum(["video", "image", "audio", "file"]), title: z.string().max(80).optional() }).optional(),
  })
  .superRefine((tool, ctx) => {
    const names = new Set(tool.params.map((param) => param.name));
    if (names.size !== tool.params.length) ctx.addIssue({ code: "custom", path: ["params"], message: "nome de parâmetro repetido" });
    const used = (text: string) => [...text.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((match) => match[1]!);
    const builtin = new Set(["app", "runtimes", "workers", "cpus", "node"]);
    for (const [index, item] of tool.command.entries()) {
      const texts = typeof item === "string" ? [item] : item.args;
      if (typeof item !== "string" && !names.has(item.if)) ctx.addIssue({ code: "custom", path: ["command", index], message: `"if" aponta para parâmetro inexistente: ${item.if}` });
      for (const text of texts) {
        const found = used(text);
        if (found.length > 1) ctx.addIssue({ code: "custom", path: ["command", index], message: "no máximo um {param} por item do comando" });
        for (const name of found) if (!names.has(name) && !builtin.has(name)) ctx.addIssue({ code: "custom", path: ["command", index], message: `{${name}} não é parâmetro nem variável conhecida` });
      }
    }
    if (typeof tool.command[0] !== "string") ctx.addIssue({ code: "custom", path: ["command", 0], message: "o primeiro item é o executável" });
    if (tool.cwd.startsWith("param:") && !tool.params.some((param) => param.name === tool.cwd.slice(6) && param.type === "path" && (param.must === "exist-dir" || param.must === "new-dir"))) ctx.addIssue({ code: "custom", path: ["cwd"], message: "cwd precisa apontar para um parâmetro de pasta" });
    if (tool.output) {
      const param = tool.params.find((candidate) => candidate.name === tool.output!.param);
      if (!param || param.type !== "path" || param.must !== "new-file") ctx.addIssue({ code: "custom", path: ["output", "param"], message: "a saída precisa ser um parâmetro de caminho `new-file`" });
    }
  });
export type AppToolSpec = z.output<typeof appToolSpecSchema>;

/** As ferramentas do conector `app` (vazio se o conector não é desse tipo). */
export const appToolsOf = (app: { provides: { connector?: { kind?: "stdio" | "app"; tools?: AppToolSpec[] } } }): AppToolSpec[] => (app.provides.connector?.kind === "app" ? (app.provides.connector.tools ?? []) : []);

/** Skill que o app entrega: a pasta (com SKILL.md) dentro do app e só os arquivos permitidos (as skills têm limite de tamanho). */
export const appSkillSpecSchema = z.object({
  from: relPathSchema,
  /** Padrões relativos à pasta (`SKILL.md`, `references/*.md`); `*` não atravessa pasta. */
  include: z.array(z.string().min(1).max(120)).min(1).max(20).default(["SKILL.md", "references/*.md"]),
  requires: z.array(z.string().max(60)).max(8).optional(),
});
export type AppSkillSpec = z.output<typeof appSkillSpecSchema>;

export const appConnectorSpecSchema = z
  .object({
    /** `stdio`: o app traz um servidor MCP. `app`: o app não tem MCP; as ferramentas abaixo rodam um comando dele (AppToolRunner). */
    kind: z.enum(["stdio", "app"]).optional(),
    name: z.string().min(1).max(60),
    description: z.string().max(300),
    /** Comando e argumentos (stdio): o primeiro item é relativo à pasta do app (ou nome de binário em `runtimes/`). */
    command: z.array(z.string().min(1).max(300)).min(1).max(20).optional(),
    /** Variáveis fixas do processo (caminhos de cache são acrescentados pelo motor). */
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(300)).default({}),
    /** Tempos do processo do app (segundos): parada por ociosidade, espera para subir e por chamada. */
    limits: z.object({ idleSec: z.number().int().min(10).max(7200), startSec: z.number().int().min(5).max(600), callSec: z.number().int().min(5).max(900) }).optional(),
    /** Ferramentas que o conector deve expor (o mini teste confere que existem). */
    expectTools: z.array(z.string().max(100)).max(30).default([]),
    /** Só `app`: apps com o mesmo grupo dividem UMA fila (os de vídeo pesam: dois renders ao mesmo tempo estourariam a RAM). Padrão: o id do app. */
    queueGroup: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/).optional(),
    /** Só `app`: as ferramentas. */
    tools: z.array(appToolSpecSchema).max(20).optional(),
  })
  .superRefine((spec, ctx) => {
    if (spec.kind !== "app" && !spec.command) ctx.addIssue({ code: "custom", path: ["command"], message: "conector stdio precisa do comando" });
    if (spec.kind === "app") {
      const tools = spec.tools ?? [];
      if (tools.length === 0) ctx.addIssue({ code: "custom", path: ["tools"], message: "conector app precisa de ferramentas" });
      const names = new Set(tools.map((tool) => tool.name));
      if (names.size !== tools.length) ctx.addIssue({ code: "custom", path: ["tools"], message: "nome de ferramenta repetido" });
    }
  });
export type AppConnectorSpec = z.output<typeof appConnectorSpecSchema>;

export const appTestSchema = z.object({
  tool: z.string().min(1).max(100),
  args: z.record(z.string(), z.unknown()).default({}),
  expect: z.object({ contains: z.string().max(200).optional(), matches: z.string().max(200).optional(), notEmpty: z.boolean().optional() }).default({}),
  timeoutSec: z.number().int().min(5).max(900).default(60),
});
export type AppTest = z.output<typeof appTestSchema>;

export const catalogAppSchema = z
  .object({
    id: slugSchema,
    name: z.string().min(1).max(80),
    area: z.enum(APP_AREAS),
    status: z.enum(CATALOG_STATUSES),
    /** O que faz, simples, em pt-BR. */
    summary: z.string().min(1).max(280),
    /** Frase que o Cyno usa para sugerir o app. */
    useWhen: z.string().max(200).default(""),
    repo: z.url(),
    version: z.object({ kind: z.enum(["npm", "pypi", "git"]), ref: z.string().min(1).max(80) }),
    /** Muda quando a receita muda (versão nova do pacote): "atualização disponível". */
    recipeVersion: z.string().min(1).max(40),
    license: z.object({
      spdx: z.string().min(1).max(40),
      level: z.enum(["livre", "aviso", "restrita"]),
      notice: z.string().max(500).optional(),
      url: z.url().optional(),
      mustAccept: z.boolean().default(false),
    }),
    warnings: z.array(z.string().max(300)).max(8).default([]),
    requires: z.array(appRequirementSchema).max(12).default([]),
    recipe: z.array(recipeStepSchema).max(20).default([]),
    provides: z.object({ connector: appConnectorSpecSchema.optional(), skills: z.array(appSkillSpecSchema).max(8).optional() }).default({}),
    test: appTestSchema.optional(),
    resources: z.object({ ramMB: z.number().int().min(0), diskMB: z.number().int().min(0), note: z.string().max(300).optional() }),
    /** Por que ainda não é instalável (em-breve / em-avaliacao). */
    pending: z.string().max(400).optional(),
  })
  .superRefine((app, ctx) => {
    if (app.status !== "disponivel") return;
    if (app.recipe.length === 0) ctx.addIssue({ code: "custom", path: ["recipe"], message: "app disponível precisa de receita" });
    if (!app.provides.connector) ctx.addIssue({ code: "custom", path: ["provides", "connector"], message: "app disponível precisa entregar um conector" });
    if (!app.test) ctx.addIssue({ code: "custom", path: ["test"], message: "app disponível precisa de mini teste" });
    if (app.license.level === "restrita" && !app.license.mustAccept) ctx.addIssue({ code: "custom", path: ["license", "mustAccept"], message: "licença restrita exige aceite" });
  });
export type CatalogApp = z.output<typeof catalogAppSchema>;
export const catalogSchema = z.array(catalogAppSchema).superRefine((list, ctx) => {
  const seen = new Set<string>();
  for (const [index, app] of list.entries()) {
    if (seen.has(app.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: `id repetido: ${app.id}` });
    seen.add(app.id);
  }
});

// ---------- Requisitos e plano ----------

/** `ok` já tem; `baixa` será baixado para a pasta da plataforma; `aviso` pode dar problema; `falta` precisa de você. */
export type RequirementStatus = "ok" | "baixa" | "aviso" | "falta";
export type RequirementResult = {
  kind: AppRequirement["kind"];
  spec: string;
  /** Texto para a tela ("Python 3.12 — será baixado para a pasta do app"). */
  label: string;
  status: RequirementStatus;
  /** O que a máquina tem (ex.: "Python 3.14.4", "6,8 GB livres"). */
  found?: string;
  sudoHint?: string;
};

export type InstallPlan = {
  appId: string;
  name: string;
  repo: string;
  version: string;
  summary: string;
  license: CatalogApp["license"];
  warnings: string[];
  requirements: RequirementResult[];
  /** O que será baixado e de onde. */
  downloads: { what: string; from: string }[];
  /** Os passos da receita em português (o que vai rodar, nessa ordem). */
  steps: string[];
  diskMB: number;
  ramMB: number;
  note?: string;
  /** O que o app entrega ("1 conector, 1 ferramenta"; nada é liberado a ninguém). */
  provides: string;
  /** Conectores locais ligados neste servidor (`CONNECTORS_STDIO=1`)? */
  stdioAllowed: boolean;
  /** Pode instalar agora? Se não, `blockers` diz por quê. */
  canInstall: boolean;
  blockers: string[];
};

// ---------- Andamento (job) ----------

export const INSTALL_PHASES = ["checando", "baixando", "construindo", "registrando", "testando", "pronto", "falhou", "precisa-do-dono", "cancelado", "removendo"] as const;
export type InstallPhase = (typeof INSTALL_PHASES)[number];
export type InstallJobKind = "install" | "update" | "uninstall";
export type InstallStepStatus = "pendente" | "andando" | "feito" | "falhou" | "precisa";
export type InstallJob = {
  id: string;
  appId: string;
  kind: InstallJobKind;
  phase: InstallPhase;
  steps: { label: string; status: InstallStepStatus }[];
  stepIndex: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  needs?: { command: string; reason: string };
  /** Resultado do mini teste (quando chegou lá). */
  test?: { ok: boolean; tool: string; detail: string; ms: number };
};

/** Um runtime compartilhado em `data/platform/runtimes/`. */
export type AppRuntimeInfo = { id: string; label: string; sizeBytes: number; usedBy: string[] };

/** Cartão do catálogo como a aba Apps recebe: a entrada, o que está instalado e o que a máquina tem. */
export type AppCard = {
  entry: CatalogApp;
  app?: LibraryApp;
  requirements: RequirementResult[];
  job?: InstallJob;
  /** O catálogo trouxe receita nova para um app instalado. */
  update?: { from: string; to: string };
};
/** Uma execução de ferramenta de um conector `app` (a fila de um app: uma por vez). */
export const APP_RUN_STATES = ["na-fila", "rodando", "concluida", "falhou", "cancelada"] as const;
export type AppRunState = (typeof APP_RUN_STATES)[number];
export type AppRun = {
  id: string;
  appId: string;
  tool: string;
  state: AppRunState;
  /** 1 = a próxima a rodar (só na fila). */
  queuePosition?: number;
  /** 0-100, quando o programa informa. */
  progress?: number;
  /** Última linha útil do programa. */
  line?: string;
  /** Quem pediu (o teste do instalador não tem agente). */
  workspaceId?: string;
  workspaceName?: string;
  agentId?: string;
  agentName?: string;
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  ms?: number;
  /** Resposta curta ("RENDERED media M-0007 (10.0 s ...)") ou o erro. */
  summary?: string;
  mediaId?: string;
};
export type AppsListing = { stdioAllowed: boolean; cards: AppCard[]; runtimes: AppRuntimeInfo[]; runs: AppRun[] };

export const installAppBodySchema = z.object({ acceptLicense: z.boolean().default(false) });
export type InstallAppBody = z.input<typeof installAppBodySchema>;
export const appParamsSchema = z.object({ appId: slugSchema });
export const appJobParamsSchema = z.object({ jobId: z.string().regex(/^J-\d{4,}$/) });
