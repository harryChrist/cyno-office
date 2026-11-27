import { execFile as nodeExecFile, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import {
  GitCloneService,
  buildAskpassArtifacts,
  buildGitCloneCommand,
  buildGitSshCommand,
  classifyGitError,
  deriveRepoName,
  resolveCloneDestination,
  scrubSecrets,
  validateCloneUrl,
} from "./clone";
import { GitCredentialStore } from "./credentials";

const execFileAsync = promisify(nodeExecFile);
const tempDir = useTempDirs();

async function createLocalGitRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", dir]);
  await writeFile(path.join(dir, "README.md"), "# Projeto de teste\n", "utf8");
  await execFileAsync("git", ["-C", dir, "add", "README.md"]);
  await execFileAsync("git", [
    "-C",
    dir,
    "-c",
    "user.name=Teste",
    "-c",
    "user.email=teste@local",
    "commit",
    "-m",
    "primeiro commit",
  ]);
  // Branch extra para testar `--branch`.
  await execFileAsync("git", ["-C", dir, "checkout", "-b", "feature"]);
  await writeFile(path.join(dir, "FEATURE.txt"), "branch feature\n", "utf8");
  await execFileAsync("git", ["-C", dir, "add", "FEATURE.txt"]);
  await execFileAsync("git", [
    "-C",
    dir,
    "-c",
    "user.name=Teste",
    "-c",
    "user.email=teste@local",
    "commit",
    "-m",
    "commit feature",
  ]);
  await execFileAsync("git", ["-C", dir, "checkout", "main"]);
}

function fakeChildProcess(run: (child: ChildProcess, stderr: PassThrough, stdout: PassThrough) => void): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(emitter, { stdout, stderr, pid: 999_999 });
  queueMicrotask(() => run(emitter, stderr, stdout));
  return emitter;
}

describe("validação de URL, destino e montador de comando git", () => {
  it("aceita https://, ssh:// e git@host:caminho e recusa file://, ext::, hífen inicial, espaços e caminhos locais por padrão", () => {
    expect(validateCloneUrl("https://github.com/org/meu-app.git")).toEqual({
      url: "https://github.com/org/meu-app.git",
      protocol: "https",
      host: "github.com",
    });
    expect(validateCloneUrl("ssh://git@gitlab.com/org/app.git")).toEqual({
      url: "ssh://git@gitlab.com/org/app.git",
      protocol: "ssh",
      host: "gitlab.com",
    });
    expect(validateCloneUrl("git@github.com:org/meu-app.git")).toEqual({
      url: "git@github.com:org/meu-app.git",
      protocol: "ssh",
      host: "github.com",
    });

    for (const bad of [
      "",
      "   ",
      "file:///tmp/repo",
      "FILE:///etc/passwd",
      "ext::sh -c touch% /tmp/pwn",
      "EXT::echo hi",
      "-u/tmp/repo",
      "--upload-pack=evil",
      "https://github.com/org/com espaco.git",
      "http://github.com/org/repo.git",
      "https://user:segredo@github.com/org/repo.git",
      "/tmp/repositorio-local",
    ]) {
      expect(() => validateCloneUrl(bad)).toThrow();
    }

    // Caminho local só é aceito quando a opção interna de teste está ligada.
    expect(validateCloneUrl("/tmp/repositorio-local", { allowLocalPaths: true })).toEqual({
      url: "/tmp/repositorio-local",
      protocol: "local",
    });
    // Mesmo com allowLocalPaths, file://, ext::, espaços e hífen seguem recusados.
    expect(() => validateCloneUrl("file:///tmp/repo", { allowLocalPaths: true })).toThrow();
    expect(() => validateCloneUrl("ext::sh -c id", { allowLocalPaths: true })).toThrow();
    expect(() => validateCloneUrl("-flag", { allowLocalPaths: true })).toThrow();
  });

  it("deriva nome sanitizado, adiciona sufixo -2/-3 e impede sair do parent com '..'", () => {
    expect(deriveRepoName("https://github.com/org/Meu-App.git")).toBe("Meu-App");
    expect(deriveRepoName("git@github.com:org/projeto_legal.git/")).toBe("projeto_legal");
    expect(deriveRepoName("https://github.com/org/projeto%20com%20nome!")).toBe("projeto-20com-20nome");

    const taken = new Set(["/repos/app", "/repos/app-2"]);
    const resolved = resolveCloneDestination("/repos", {
      url: "https://github.com/org/app.git",
      exists: (candidate) => taken.has(candidate),
      platform: "linux",
    });
    expect(resolved).toEqual({ name: "app-3", targetDir: "/repos/app-3" });

    // Nome explícito que já existe -> 409 "pasta já existe"
    expect(() =>
      resolveCloneDestination("/repos", {
        url: "https://github.com/org/app.git",
        name: "app",
        exists: (candidate) => taken.has(candidate),
        platform: "linux",
      }),
    ).toThrow(/pasta já existe/i);

    // Tentativas de sair do parent (`..`, barras, hífen) são recusadas.
    for (const badName of ["..", "../fora", "a/b", "a\\b", "-repo", "a,b", "."]) {
      expect(() =>
        resolveCloneDestination("/repos", {
          url: "https://github.com/org/app.git",
          name: badName,
          exists: () => false,
          platform: "linux",
        }),
      ).toThrow();
    }
  });

  it("monta comando seguro com flags -c, -- antes de URL/destino, askpass (Linux/Windows) e SSH sem segredo no argv", () => {
    const token = "ghp_segredo_jamais_no_argv_123456";
    const built = buildGitCloneCommand({
      url: "https://github.com/org/privado.git",
      targetDir: "/dados/repos/privado",
      branch: "main",
      askpassPath: "/dados/platform/git/tmp/askpass-1.sh",
      username: "meu-user",
      token,
      platform: "linux",
    });

    expect(built.command).toBe("git");
    expect(built.args).toEqual([
      "-c",
      "core.fsmonitor=false",
      "-c",
      "protocol.ext.allow=never",
      "-c",
      "protocol.file.allow=never",
      "-c",
      "credential.helper=",
      "clone",
      "--progress",
      "--branch",
      "main",
      "--",
      "https://github.com/org/privado.git",
      "/dados/repos/privado",
    ]);
    expect(built.args.join(" ")).not.toContain(token);
    expect(built.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(built.env.GIT_ASKPASS).toBe("/dados/platform/git/tmp/askpass-1.sh");
    expect(built.env.CYNO_GIT_USERNAME).toBe("meu-user");
    expect(built.env.CYNO_GIT_TOKEN).toBe(token);

    // Scripts askpass Linux (.sh) e Windows (.cmd chamando node)
    const linuxAskpass = buildAskpassArtifacts("/dados/tmp", "job-1", { platform: "linux" });
    expect(linuxAskpass.mainPath).toBe("/dados/tmp/askpass-job-1.sh");
    expect(linuxAskpass.files[0]?.mode).toBe(0o700);
    expect(linuxAskpass.files[0]?.content).toContain("CYNO_GIT_TOKEN");

    const winAskpass = buildAskpassArtifacts("C:\\dados\\tmp", "job-1", {
      platform: "win32",
      nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
    });
    expect(winAskpass.mainPath).toBe("C:\\dados\\tmp\\askpass-job-1.cmd");
    expect(winAskpass.files).toHaveLength(2);
    expect(winAskpass.files[1]?.content).toContain("node.exe");
    expect(winAskpass.files[0]?.content).toContain("CYNO_GIT_TOKEN");

    // SSH no Linux e no Windows (barras normais e aspas)
    const sshLinux = buildGitSshCommand("/dados/tmp/ssh-1.key", "linux");
    expect(sshLinux).toContain("-i '/dados/tmp/ssh-1.key'");
    expect(sshLinux).toContain("-o IdentitiesOnly=yes");
    expect(sshLinux).toContain("-o StrictHostKeyChecking=accept-new");
    expect(sshLinux).toContain("-o BatchMode=yes");

    const sshWin = buildGitSshCommand("C:\\Users\\Ana\\cyno\\tmp\\ssh-1.key", "win32");
    expect(sshWin).toContain('-i "C:/Users/Ana/cyno/tmp/ssh-1.key"');
    expect(sshWin).not.toContain("\\");

    const sshBuilt = buildGitCloneCommand({
      url: "git@github.com:org/privado.git",
      targetDir: "C:\\dados\\repos\\privado",
      sshKeyFile: "C:\\Users\\Ana\\cyno\\tmp\\ssh-1.key",
      platform: "win32",
    });
    expect(sshBuilt.env.GIT_SSH_COMMAND).toBe(sshWin);
    expect(sshBuilt.args.indexOf("--")).toBe(sshBuilt.args.length - 3);
  });

  it("remove segredos dos logs e traduz erros do git para pt-BR", () => {
    const secret = "tok_ultra_secreto_xyz";
    expect(scrubSecrets(`fatal: could not access https://user:${secret}@github.com/a/b`, [secret])).not.toContain(secret);
    expect(scrubSecrets(`erro com ${encodeURIComponent("tok/a+b")}`, ["tok/a+b"])).not.toContain("tok%2Fa%2Bb");

    expect(classifyGitError("", { errorCode: "ENOENT", platform: "linux" })).toMatch(/Git não está instalado.*apt install git/i);
    expect(classifyGitError("", { errorCode: "ENOENT", platform: "win32" })).toMatch(/Git para Windows/i);
    expect(classifyGitError("", { timedOut: true })).toMatch(/Tempo esgotado/i);
    expect(classifyGitError("fatal: Authentication failed for 'https://github.com/a/b'")).toMatch(/Credencial recusada/i);
    expect(classifyGitError("ERROR: Repository not found.")).toMatch(/não encontrado ou sem acesso/i);
    expect(classifyGitError("fatal: destination path '/x' already exists and is not an empty directory.")).toMatch(/pasta já existe/i);
  });
});

describe("GitCloneService: clone real com repositório local temporário, fila e limpeza", () => {
  it("clona repositório local temporário, cria sufixo -2 ao repetir, suporta branch e cadastra no workspace", async () => {
    const dataDir = await tempDir();
    const originParent = await tempDir();
    const originRepo = path.join(originParent, "meu-projeto");
    await createLocalGitRepo(originRepo);

    const credentials = await GitCredentialStore.open(dataDir);
    const addedFolders: Array<{ workspaceId: string; name: string; path: string }> = [];
    const service = new GitCloneService({
      dataDir,
      credentials,
      allowLocalPaths: true,
      addFolder: async (workspaceId, body) => {
        addedFolders.push({ workspaceId, name: body.name, path: body.path });
      },
    });

    const job1 = await service.start({ url: originRepo, addToWorkspace: "principal" });
    expect(job1.status).toBe("running");
    await service.idle();

    const done1 = service.get(job1.id);
    expect(done1?.status).toBe("done");
    expect(done1?.result?.path).toBe(path.join(dataDir, "repos", "meu-projeto"));
    expect(done1?.result?.folderAdded).toBe(true);
    expect(await readFile(path.join(done1!.result!.path, "README.md"), "utf8")).toContain("Projeto de teste");
    expect(addedFolders).toEqual([{ workspaceId: "principal", name: "meu-projeto", path: done1!.result!.path }]);

    // Segundo clone da mesma URL sem `name` -> recebe sufixo `-2` e respeita `branch`.
    const job2 = await service.start({ url: originRepo, branch: "feature" });
    await service.idle();
    const done2 = service.get(job2.id);
    expect(done2?.status).toBe("done");
    expect(done2?.result?.path).toBe(path.join(dataDir, "repos", "meu-projeto-2"));
    expect(await readFile(path.join(done2!.result!.path, "FEATURE.txt"), "utf8")).toContain("branch feature");
  });

  it("erro ao cadastrar a pasta no workspace não apaga o repositório clonado e devolve aviso", async () => {
    const dataDir = await tempDir();
    const originParent = await tempDir();
    const originRepo = path.join(originParent, "repo-aviso");
    await createLocalGitRepo(originRepo);

    const credentials = await GitCredentialStore.open(dataDir);
    const service = new GitCloneService({
      dataDir,
      credentials,
      allowLocalPaths: true,
      addFolder: async () => {
        throw new Error("O workspace já tem 12 pastas de trabalho.");
      },
    });

    const job = await service.start({ url: originRepo, addToWorkspace: "principal" });
    await service.idle();
    const done = service.get(job.id);
    expect(done?.status).toBe("done");
    expect(done?.result?.folderAdded).toBe(false);
    expect(done?.result?.folderWarning).toContain("12 pastas");
    expect(existsSync(path.join(done!.result!.path, "README.md"))).toBe(true);
  });

  it("nunca vaza segredo no log/erro, remove arquivos temporários de credencial ao fim e respeita timeout", async () => {
    const dataDir = await tempDir();
    const credentials = await GitCredentialStore.open(dataDir);
    const token = "tok_secreto_no_stderr_999999";
    const cred = await credentials.create({
      label: "Token Teste",
      host: "github.com",
      kind: "token",
      secret: token,
    });

    const seenArgs: string[][] = [];
    const service = new GitCloneService({
      dataDir,
      credentials,
      execFile: (_file, args, opts) => {
        seenArgs.push([...args]);
        expect(opts.env?.GIT_ASKPASS).toBeTruthy();
        expect(existsSync(opts.env!.GIT_ASKPASS!)).toBe(true);
        return fakeChildProcess((child, stderr) => {
          stderr.write(`fatal: Authentication failed with ${token}\n`);
          stderr.end();
          child.emit("close", 128);
        });
      },
    });

    const job = await service.start({
      url: "https://github.com/org/privado.git",
      credentialId: cred.id,
    });
    await service.idle();
    const failed = service.get(job.id);
    expect(failed?.status).toBe("error");
    expect(failed?.error).toMatch(/Credencial recusada/i);
    expect(JSON.stringify(failed)).not.toContain(token);
    expect(seenArgs[0]?.join(" ")).not.toContain(token);
    // Arquivo auxiliar de askpass foi removido ao terminar.
    const leftover = await readdir(service.tmpDir).catch(() => []);
    expect(leftover).toEqual([]);

    // Teste de timeout
    const slowService = new GitCloneService({
      dataDir,
      credentials,
      timeoutMs: 30,
      execFile: () =>
        fakeChildProcess(() => {
          // nunca encerra sozinho
        }),
    });
    const slowJob = await slowService.start({ url: "https://github.com/org/lento.git" });
    await slowService.idle();
    expect(slowService.get(slowJob.id)?.status).toBe("error");
    expect(slowService.get(slowJob.id)?.error).toMatch(/Tempo esgotado/i);
    await slowService.close();
  });
});
