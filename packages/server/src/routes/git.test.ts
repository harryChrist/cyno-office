import { execFile as nodeExecFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  GIT_CLONE_PATH,
  GIT_CREDENTIALS_PATH,
  gitCloneJobPath,
  gitCredentialItemPath,
  type ActivityEntry,
  type GitCloneJobResponse,
  type GitCredentialResponse,
  type GitCredentialsResponse,
} from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { call } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";
import { useTempDirs } from "../dev/test-utils";
import { checkWorkFolderPath, FOLDER_ERRORS } from "../platform/workspaces/folders";
import { ActivityLog, setActivityLog } from "../workspace/activity/log";
import { seedDataDir } from "../workspace/office/seed";

const execFileAsync = promisify(nodeExecFile);
const setupApp = useTestApp();
const tempDir = useTempDirs();

afterEach(() => {
  setActivityLog(undefined);
});

async function makeTempRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", dir]);
  await writeFile(path.join(dir, "index.txt"), "ola\n", "utf8");
  await execFileAsync("git", ["-C", dir, "add", "index.txt"]);
  await execFileAsync("git", [
    "-C",
    dir,
    "-c",
    "user.name=Teste",
    "-c",
    "user.email=teste@local",
    "commit",
    "-m",
    "init",
  ]);
}

describe("API: credenciais e clone de repositórios (/api/git/*)", () => {
  it("CRUD de credenciais nunca devolve segredo na resposta nem na Atividade e valida entrada", async () => {
    const dataDir = await tempDir();
    await seedDataDir(dataDir);
    const activityLog = new ActivityLog({ dataDir });
    const entries: ActivityEntry[] = [];
    activityLog.onAppend((entry) => entries.push(entry));

    const test = await setupApp({ dataDir, activity: activityLog });
    const secretToken = "ghp_segredo_api_nunca_retornar_4242";
    const secretKey = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEtYXBpLXRlc3RlLXNlY3JldG8=",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");

    expect(await call<GitCredentialsResponse>(test.app, "GET", GIT_CREDENTIALS_PATH)).toEqual({
      credentials: [],
    });

    // Validação recusa host com protocolo e chave SSH inválida
    await call(test.app, "POST", GIT_CREDENTIALS_PATH, { label: "Ruim", host: "https://github.com", kind: "token", secret: secretToken }, 400);
    await call(test.app, "POST", GIT_CREDENTIALS_PATH, { label: "SSH ruim", host: "github.com", kind: "ssh", secret: "invalida" }, 400);

    // Criação de token e SSH
    const resToken = await test.app.inject({
      method: "POST",
      url: GIT_CREDENTIALS_PATH,
      payload: { label: "GitHub", host: "github.com", kind: "token", username: "dev", secret: secretToken },
    });
    expect(resToken.statusCode).toBe(201);
    expect(resToken.body).not.toContain(secretToken);
    const { credential: tokenCred } = resToken.json<GitCredentialResponse>();
    expect(tokenCred).toMatchObject({ label: "GitHub", host: "github.com", kind: "token", username: "dev", hasSecret: true });

    const resSsh = await test.app.inject({
      method: "POST",
      url: GIT_CREDENTIALS_PATH,
      payload: { label: "GitLab SSH", host: "gitlab.com", kind: "ssh", secret: secretKey },
    });
    expect(resSsh.statusCode).toBe(201);
    expect(resSsh.body).not.toContain("b3BlbnNzaC1rZXktdjEtYXBpLXRlc3RlLXNlY3JldG8=");
    const { credential: sshCred } = resSsh.json<GitCredentialResponse>();
    expect(sshCred.hasSecret).toBe(true);

    // Listagem nunca devolve segredo
    const listRes = await test.app.inject({ method: "GET", url: GIT_CREDENTIALS_PATH });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body).not.toContain(secretToken);
    expect(listRes.body).not.toContain("b3BlbnNzaC1rZXktdjEtYXBpLXRlc3RlLXNlY3JldG8=");
    expect(listRes.json<GitCredentialsResponse>().credentials).toHaveLength(2);

    // Remoção (204) e repetida (404)
    const del = await test.app.inject({ method: "DELETE", url: gitCredentialItemPath(tokenCred.id) });
    expect(del.statusCode).toBe(204);
    await call(test.app, "DELETE", gitCredentialItemPath(tokenCred.id), undefined, 404);
    await call(test.app, "DELETE", gitCredentialItemPath("../etc"), undefined, 404);

    // Atividade registrou ações sem nenhum segredo
    const activityJson = JSON.stringify(entries);
    expect(activityJson).toContain("git_credencial_criada");
    expect(activityJson).toContain("git_credencial_removida");
    expect(activityJson).not.toContain(secretToken);
    expect(activityJson).not.toContain("b3BlbnNzaC1rZXktdjEtYXBpLXRlc3RlLXNlY3JldG8=");
  });

  it("recusa URLs proibidas e caminhos locais na API padrão, e clona + cadastra pasta quando allowLocalPaths está ligado nos testes", async () => {
    const dataDir = await tempDir();
    const repoRoot = await tempDir();
    const localRepo = path.join(repoRoot, "app-demo");
    await makeTempRepo(localRepo);
    await seedDataDir(dataDir);

    // Padrão (sem allowLocalPaths): recusa caminho local, file://, ext:: e hífen inicial
    const prodApp = await setupApp({ dataDir });
    await call(prodApp.app, "POST", GIT_CLONE_PATH, { url: localRepo }, 400);
    await call(prodApp.app, "POST", GIT_CLONE_PATH, { url: "file:///tmp/repo" }, 400);
    await call(prodApp.app, "POST", GIT_CLONE_PATH, { url: "ext::sh -c id" }, 400);
    await call(prodApp.app, "POST", GIT_CLONE_PATH, { url: "-u/tmp/repo" }, 400);
    await call(prodApp.app, "GET", gitCloneJobPath("clone-inexistente"), undefined, 404);
    await prodApp.app.close();

    // Com opção interna de teste: clona em <DATA_DIR>/repos/app-demo e cadastra no workspace
    const testApp = await setupApp({ dataDir, git: { allowLocalPaths: true } });
    const wsId = testApp.app.workspaces.list()[0]!.id;

    const startRes = await testApp.app.inject({
      method: "POST",
      url: GIT_CLONE_PATH,
      payload: { url: localRepo, addToWorkspace: wsId },
    });
    expect(startRes.statusCode).toBe(202);
    const { job: initial } = startRes.json<GitCloneJobResponse>();
    expect(initial.id).toMatch(/^clone-/);

    let current = initial;
    for (let i = 0; i < 60 && current.status === "running"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const poll = await call<GitCloneJobResponse>(testApp.app, "GET", gitCloneJobPath(initial.id));
      current = poll.job;
    }

    expect(current.status).toBe("done");
    expect(current.result?.path).toBe(path.join(dataDir, "repos", "app-demo"));
    expect(current.result?.folderAdded).toBe(true);

    // Pasta aparece cadastrada no workspace!
    const folders = testApp.app.workspaces.list().find((ws) => ws.id === wsId)?.folders ?? [];
    expect(folders.some((f) => f.name === "app-demo")).toBe(true);

    // Segurança preservada: `<DATA_DIR>/repos` em si continua proibido como pasta de trabalho.
    await expect(
      checkWorkFolderPath(path.join(dataDir, "repos"), { dataDir, existing: [] }),
    ).rejects.toMatchObject({ statusCode: 400, message: FOLDER_ERRORS.dataDir });
  });
});
