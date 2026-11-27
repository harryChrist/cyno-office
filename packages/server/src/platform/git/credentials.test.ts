import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { GitCredentialStore } from "./credentials";

const tempDir = useTempDirs();

const SAMPLE_TOKEN = "tok_exemplo_secreto_nao_expor_987654321";
const SAMPLE_SSH_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAACmZha2Uta2V5LWJvZHktc2VjcmV0",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

describe("cofre de credenciais do git (GitCredentialStore)", () => {
  it("salva metadados e segredo separados com permissão 0600, nunca devolve o segredo e recarrega do disco", async () => {
    const dataDir = await tempDir();
    const store = await GitCredentialStore.open(dataDir, { now: () => new Date("2026-11-25T12:00:00Z") });

    const created = await store.create({
      label: "GitHub Trabalho",
      host: "GitHub.COM",
      kind: "token",
      username: "octocat",
      secret: SAMPLE_TOKEN,
    });

    expect(created).toMatchObject({
      label: "GitHub Trabalho",
      host: "github.com",
      kind: "token",
      username: "octocat",
      createdAt: "2026-11-25T12:00:00.000Z",
      hasSecret: true,
    });
    expect(JSON.stringify(created)).not.toContain(SAMPLE_TOKEN);
    expect(JSON.stringify(store.list())).not.toContain(SAMPLE_TOKEN);
    expect(JSON.stringify(store.get(created.id))).not.toContain(SAMPLE_TOKEN);

    // Metadados no disco não guardam o segredo.
    const indexRaw = await readFile(store.indexFile, "utf8");
    expect(indexRaw).not.toContain(SAMPLE_TOKEN);
    expect(indexRaw).toContain(created.id);

    // Permissões POSIX no Linux: 0600 para arquivos e 0700 para secrets/.
    if (process.platform !== "win32") {
      const indexStat = await stat(store.indexFile);
      expect(indexStat.mode & 0o777).toBe(0o600);
      const secretsDirStat = await stat(store.secretsDir);
      expect(secretsDirStat.mode & 0o777).toBe(0o700);
      const secretFileStat = await stat(path.join(store.secretsDir, created.id));
      expect(secretFileStat.mode & 0o777).toBe(0o600);
    }

    // Recarregando do disco, lista e leitura interna continuam funcionando.
    const reloaded = await GitCredentialStore.open(dataDir);
    expect(reloaded.list()).toEqual([created]);
    const internal = await reloaded.readSecret(created.id);
    expect(internal.secret).toBe(SAMPLE_TOKEN);
    expect(internal.credential).toEqual(created);

    // Remoção apaga tanto o índice quanto o arquivo do segredo.
    const removed = await reloaded.remove(created.id);
    expect(removed.id).toBe(created.id);
    expect(JSON.stringify(removed)).not.toContain(SAMPLE_TOKEN);
    expect(reloaded.list()).toEqual([]);
    await expect(stat(path.join(store.secretsDir, created.id))).rejects.toThrow();
    await expect(reloaded.remove(created.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("aceita chave SSH válida, normaliza quebra de linha final e funciona simulando win32 sem erro de chmod", async () => {
    const dataDir = await tempDir();
    const store = await GitCredentialStore.open(dataDir, { platform: "win32" });

    const ssh = await store.create({
      label: "Chave Deploy",
      host: "git.empresa.local",
      kind: "ssh",
      secret: SAMPLE_SSH_KEY.replace(/\n/g, "\r\n"),
    });

    expect(ssh).toMatchObject({ label: "Chave Deploy", host: "git.empresa.local", kind: "ssh", hasSecret: true });
    expect(ssh.username).toBeUndefined();
    expect(JSON.stringify(ssh)).not.toContain("b3BlbnNzaC1rZXktdjE");

    const loaded = await store.readSecret(ssh.id);
    expect(loaded.secret.endsWith("\n")).toBe(true);
    expect(loaded.secret).not.toContain("\r");
  });

  it("valida host simples, token até 4 KB e formato -----BEGIN / -----END da chave SSH sem vazar o segredo no erro", async () => {
    const dataDir = await tempDir();
    const store = await GitCredentialStore.open(dataDir);

    // Host inválido
    for (const badHost of ["https://github.com", "github.com/org", "git hub.com", "github.com:443", "-bad.com", ""]) {
      await expect(
        store.create({ label: "X", host: badHost, kind: "token", secret: SAMPLE_TOKEN }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }

    // Token com mais de 4 KB e token com quebra de linha
    const oversized = "t".repeat(4097);
    await expect(
      store.create({ label: "Grande", host: "github.com", kind: "token", secret: oversized }),
    ).rejects.toMatchObject({ statusCode: 400 });

    const exact4kb = "a".repeat(4096);
    const ok = await store.create({ label: "Exato 4KB", host: "github.com", kind: "token", secret: exact4kb });
    expect(ok.hasSecret).toBe(true);

    const multilineToken = "segredo_linha1\nsegredo_linha2";
    try {
      await store.create({ label: "Quebra", host: "github.com", kind: "token", secret: multilineToken });
      expect.unreachable("deveria rejeitar token com quebra de linha");
    } catch (error) {
      expect(String(error)).not.toContain("segredo_linha1");
      expect(String(error)).not.toContain("segredo_linha2");
    }

    // Chave SSH inválida (sem BEGIN, sem END, ou corpo vazio)
    const badSsh = "chave-secreta-sem-cabecalho-123456";
    try {
      await store.create({ label: "SSH ruim", host: "github.com", kind: "ssh", secret: badSsh });
      expect.unreachable("deveria rejeitar chave sem BEGIN");
    } catch (error) {
      expect(String(error)).not.toContain(badSsh);
    }

    await expect(
      store.create({
        label: "Sem END",
        host: "github.com",
        kind: "ssh",
        secret: "-----BEGIN OPENSSH PRIVATE KEY-----\nconteudosemfim",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      store.create({
        label: "Sem corpo",
        host: "github.com",
        kind: "ssh",
        secret: "-----BEGIN OPENSSH PRIVATE KEY-----\n-----END OPENSSH PRIVATE KEY-----",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
