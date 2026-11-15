import { type Agent, type EffectiveFolder, type OfficeState } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { antigravityFolderRules, antigravitySessionSettings, AntigravityCliAdapter } from "./antigravity-adapter";
import { claudeFolderArgs, claudePermissions, claudeReadOnlyRule, ClaudeCliAdapter, DEFAULT_AGENT_TOOLS } from "./claude-adapter";
import { fencePolicy, readOnlyFolders, writableFolders } from "./fence";
import { HermesAdapter } from "./hermes-adapter";
import { OpenClawAdapter, openclawAgentConfig } from "./openclaw-adapter";
import { agentPrompt, folderRules } from "./prompts";
import { runConfigOf } from "./manager";
import type { TerminalAccess, TerminalSpec } from "./types";

const CWD = "/dados/workspaces/lab/agents/clara";
const projeto: EffectiveFolder = { id: "projeto-1a2b", name: "Projeto", path: "/home/u/projeto", purpose: "Código do app.", write: true };
const vault: EffectiveFolder = { id: "vault-3c4d", name: "Vault", path: "/home/u/Meu Vault", purpose: "Notas do Obsidian.", write: false };
const base: TerminalSpec = { agentId: "clara", cwd: CWD, systemPrompt: "Você é a Clara.", mcpConfigFile: `${CWD}/mcp.json`, tools: DEFAULT_AGENT_TOOLS };
const withFolders: TerminalSpec = { ...base, folders: [projeto, vault] };
const closed: TerminalAccess = { internet: false, browser: false, terminal: false, allowedDomains: [], blockedDomains: [], allowLocalNetwork: false };

describe("Claude Code: pastas de trabalho", () => {
  it("--add-dir de cada pasta; o cwd e a ausência de pastas não mudam", () => {
    const { args } = new ClaudeCliAdapter().command(withFolders, { sessionId: "s", resume: false });
    expect(claudeFolderArgs(withFolders)).toEqual(["--add-dir", "/home/u/projeto", "--add-dir", "/home/u/Meu Vault"]);
    const at = args.indexOf("--add-dir");
    expect(args.slice(at, at + 4)).toEqual(["--add-dir", "/home/u/projeto", "--add-dir", "/home/u/Meu Vault"]);
    expect(new ClaudeCliAdapter().command(base, { sessionId: "s", resume: false }).args).not.toContain("--add-dir");
    // As flags de segurança continuam.
    expect(args).toContain("--restricted");
    expect(args).toContain("--strict-mcp-config");
  });

  it("só leitura = Edit(//pasta/**) no --disallowedTools (cobre Edit, Write e NotebookEdit); pasta de escrita não tem regra", () => {
    expect(claudeReadOnlyRule("/home/u/Meu Vault")).toBe("Edit(//home/u/Meu Vault/**)");
    const perms = claudePermissions({ ...withFolders, access: closed });
    expect(perms.disallowed).toContain("Edit(//home/u/Meu Vault/**)");
    expect(perms.disallowed.some((rule) => rule.includes("/home/u/projeto"))).toBe(false);
    const { args } = new ClaudeCliAdapter().command({ ...withFolders, access: closed }, { sessionId: "s", resume: false });
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("Edit(//home/u/Meu Vault/**)");
  });

  it("o Maestro (terminal interativo) leva as mesmas pastas e regras", () => {
    const { args } = new ClaudeCliAdapter().interactiveCommand(withFolders, { sessionId: "s", resume: false });
    expect(args).toContain("--add-dir");
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("Edit(//home/u/Meu Vault/**)");
  });

  it("o git não sobe acima da pasta dos agentes (GIT_CEILING_DIRECTORIES) com pastas ou sem", () => {
    const env = new ClaudeCliAdapter().env({}, withFolders);
    expect(env.GIT_CEILING_DIRECTORIES).toBe("/dados/workspaces/lab/agents");
  });
});

describe("Antigravity: pastas de trabalho", () => {
  it("lê e escreve nas de escrita; nas só leitura nega write_file (deny vence)", () => {
    expect(antigravityFolderRules([projeto, vault])).toEqual({
      allow: ["read_file(/home/u/projeto)", "write_file(/home/u/projeto)", "read_file(/home/u/Meu Vault)"],
      deny: ["write_file(/home/u/Meu Vault)"],
    });
    const settings = antigravitySessionSettings(CWD, closed, [projeto, vault]) as { allowNonWorkspaceAccess: boolean; permissions: { allow: string[]; deny: string[] } };
    expect(settings.allowNonWorkspaceAccess).toBe(false);
    expect(settings.permissions.allow).toEqual(expect.arrayContaining([`read_file(${CWD})`, `write_file(${CWD})`, "write_file(/home/u/projeto)", "read_file(/home/u/Meu Vault)"]));
    expect(settings.permissions.allow).not.toContain("write_file(/home/u/Meu Vault)");
    expect(settings.permissions.deny).toContain("write_file(/home/u/Meu Vault)");
  });

  it("sem pastas a configuração é a de sempre", () => {
    expect(antigravitySessionSettings(CWD, closed, [])).toEqual(antigravitySessionSettings(CWD, closed));
  });

  it("--add-dir de cada pasta e o --settings com as regras", () => {
    const { args } = new AntigravityCliAdapter().command({ ...withFolders, access: closed }, { sessionId: "s", resume: false });
    const adds = args.flatMap((arg, i) => (arg === "--add-dir" ? [args[i + 1]] : []));
    expect(adds).toEqual(["/home/u/projeto", "/home/u/Meu Vault"]);
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!) as { permissions: { deny: string[] } };
    expect(settings.permissions.deny).toContain("write_file(/home/u/Meu Vault)");
    expect(new AntigravityCliAdapter().command(base, { sessionId: "s", resume: false }).args).not.toContain("--add-dir");
  });
});

describe("Hermes e OpenClaw: pastas pela cerca de arquivos", () => {
  it("a cerca lista as de escrita em --rw e as só leitura em --ro", () => {
    expect(writableFolders(withFolders)).toEqual(["/home/u/projeto"]);
    expect(readOnlyFolders(withFolders)).toEqual(["/home/u/Meu Vault"]);
    const policy = fencePolicy({ readOnly: readOnlyFolders(withFolders), readWrite: writableFolders(withFolders) });
    expect(policy.readWrite).toContain("/home/u/projeto");
    expect(policy.readOnly).toContain("/home/u/Meu Vault");
    expect(policy.readWrite).not.toContain("/home/u/Meu Vault");
  });

  const support = () => ({ available: true, abi: 3, python: "/usr/bin/python3" });

  it("Hermes: a política da cerca inclui as pastas", () => {
    const adapter = new HermesAdapter({ homeDir: "/x/hermes", fence: () => true, fenceSupport: support });
    const policy = adapter.fencePolicy({ ...withFolders });
    expect(policy.readWrite).toContain("/home/u/projeto");
    expect(policy.readOnly).toContain("/home/u/Meu Vault");
    expect(adapter.fence({ ...withFolders })?.policy.readOnly).toContain("/home/u/Meu Vault");
  });

  it("OpenClaw: com cerca ligada e sem terminal as pastas entram na política e os arquivos deixam de ser só da pasta do agente", () => {
    const adapter = new OpenClawAdapter({ homeDir: "/x/openclaw", fence: () => true, fenceSupport: support });
    const spec = { ...withFolders, access: closed };
    const policy = adapter.fencePolicy(spec);
    expect(policy.readWrite).toContain("/home/u/projeto");
    expect(policy.readOnly).toContain("/home/u/Meu Vault");
    const config = JSON.parse(adapter.agentFiles({ spec, mcpUrl: "", token: "" })[0]!.content) as { tools: { fs: { workspaceOnly: boolean } } };
    expect(config.tools.fs.workspaceOnly).toBe(false);
  });

  it("OpenClaw: sem cerca (ou com terminal) continua preso à pasta do agente, mesmo com pastas cadastradas", () => {
    const noFence = new OpenClawAdapter({ homeDir: "/x/openclaw" });
    const config = (adapter: OpenClawAdapter, spec: TerminalSpec) => JSON.parse(adapter.agentFiles({ spec, mcpUrl: "", token: "" })[0]!.content) as { tools: { fs: { workspaceOnly: boolean }; exec: { applyPatch: { workspaceOnly: boolean } } } };
    expect(config(noFence, { ...withFolders, access: closed }).tools.fs.workspaceOnly).toBe(true);
    const fenced = new OpenClawAdapter({ homeDir: "/x/openclaw", fence: () => true, fenceSupport: support });
    expect(config(fenced, { ...withFolders, access: { ...closed, terminal: true } }).tools.fs.workspaceOnly).toBe(true);
    expect(config(fenced, { ...base, access: closed }).tools.fs.workspaceOnly).toBe(true);
    expect(openclawAgentConfig({}, { mcpUrl: "", token: "", denied: [] })).toMatchObject({ tools: { fs: { workspaceOnly: true } } });
  });
});

const OFFICE = {
  rooms: [
    { id: "gerencia", name: "Sala do Maestro", kind: "maestro" },
    { id: "conteudo", name: "Conteúdo", kind: "team" },
  ],
  teams: [
    { id: "t-ger", roomId: "gerencia", name: "Gerência", focus: "coordenar" },
    { id: "t-cont", roomId: "conteudo", name: "Conteúdo", focus: "textos" },
  ],
  agents: [],
} as unknown as Pick<OfficeState, "rooms" | "teams" | "agents">;
const clara = { id: "clara", teamId: "t-cont", name: "Clara", role: "Redatora", instructions: "", engine: "claude" } as unknown as Agent;
const maestro = { id: "maestro", teamId: "t-ger", name: "Maestro", role: "Maestro", instructions: "", engine: "claude" } as unknown as Agent;

describe("instruções com pastas de trabalho", () => {
  it("lista nome, caminho, modo e para que serve; avisa que a pasta própria é rascunho e que só leitura não se altera", () => {
    const text = folderRules([projeto, vault]).join("\n");
    expect(text).toContain("## Pastas de trabalho");
    expect(text).toContain("Projeto: `/home/u/projeto` (leitura e escrita). Para que serve: Código do app.");
    expect(text).toContain("Vault: `/home/u/Meu Vault` (SÓ LEITURA). Para que serve: Notas do Obsidian.");
    expect(text).toContain("é só rascunho");
    expect(text).toContain("nunca crie, edite, mova nem apague");
  });

  it("sem aviso de só leitura quando todas são de escrita; sem pastas nada entra", () => {
    expect(folderRules([projeto]).join("\n")).not.toContain("Pasta SÓ LEITURA");
    expect(folderRules([])).toEqual([]);
    expect(folderRules(undefined)).toEqual([]);
  });

  it("agente de time e Maestro recebem a seção; sem pastas o prompt é idêntico ao de hoje", () => {
    for (const agent of [clara, maestro]) {
      expect(agentPrompt(agent, OFFICE, "Principal", undefined, { folders: [projeto] })).toContain("## Pastas de trabalho");
      expect(agentPrompt(agent, OFFICE, "Principal", undefined, { folders: [] })).toBe(agentPrompt(agent, OFFICE, "Principal", undefined, {}));
      expect(agentPrompt(agent, OFFICE, "Principal", undefined, {})).not.toContain("Pastas de trabalho");
    }
  });

  it("com terminal ligado a regra do terminal cita as pastas e a proibição nas só leitura", () => {
    const policy = { internet: true, browser: true, terminal: true, approveSensitiveActions: true, allowLocalNetwork: false, allowedDomains: [], blockedDomains: [] };
    const prompt = agentPrompt(clara, OFFICE, "Principal", undefined, { access: policy, folders: [projeto, vault] });
    expect(prompt).toContain("e das pastas de trabalho listadas abaixo");
    expect(agentPrompt(clara, OFFICE, "Principal", undefined, { access: policy })).toContain("Trabalhe só dentro da sua pasta:");
  });
});

describe("reinício ao mudar as pastas", () => {
  const ws = { internet: true, browser: true, terminal: false, approveSensitiveActions: true, allowLocalNetwork: false, allowedDomains: [], blockedDomains: [] };
  const folders = [
    { id: "p", name: "P", path: "/a", mode: "write" as const },
    { id: "v", name: "V", path: "/b", mode: "read" as const },
  ];
  it("a configuração da subida muda com as pastas efetivas do agente (e só com elas)", () => {
    const none = runConfigOf(clara, ws);
    const all = runConfigOf(clara, ws, folders);
    expect(all).not.toBe(none);
    expect(runConfigOf(clara, ws, [{ ...folders[0]!, mode: "read" }, folders[1]!])).not.toBe(all);
    // Outro nome ou "para que serve" não pede reinício do processo.
    expect(runConfigOf(clara, ws, [{ ...folders[0]!, name: "Outro" }, folders[1]!])).toBe(all);
    // O agente que desliga uma pasta fica como se ela não existisse; "read" numa pasta de leitura não muda nada.
    expect(runConfigOf({ ...clara, folders: { p: "off", v: "off" } } as Agent, ws, folders)).toBe(none);
    expect(runConfigOf({ ...clara, folders: { v: "read" } } as Agent, ws, folders)).toBe(all);
  });
});
