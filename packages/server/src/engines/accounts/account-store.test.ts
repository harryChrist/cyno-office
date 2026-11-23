import { lstat, mkdir, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_ACCOUNTS_PER_ENGINE } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { EngineAccountStore } from "./account-store";

const tempDir = useTempDirs();

describe("EngineAccountStore", () => {
  it("cria conta Claude com pasta 0700, CLAUDE_CONFIG_DIR e persiste atomicamente", async () => {
    const dataDir = await tempDir();
    const fakeHome = await tempDir();
    const store = await EngineAccountStore.open(dataDir, {
      realHomeDir: fakeHome,
      now: () => new Date("2026-11-23T10:00:00.000Z"),
    });

    const created = await store.create("claude", "  Trabalho Principal  ");
    expect(created).toEqual({
      id: "trabalho-principal",
      engine: "claude",
      label: "Trabalho Principal",
      createdAt: "2026-11-23T10:00:00.000Z",
    });

    const env = store.profileEnv(created);
    const expectedDir = path.resolve(dataDir, "platform", "engines", "claude", "accounts", "trabalho-principal");
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: expectedDir });
    expect(store.credentialsFile(created)).toBe(path.join(expectedDir, ".credentials.json"));

    const info = await stat(expectedDir);
    expect(info.mode & 0o777).toBe(0o700);

    // Recarrega do disco: continua igual.
    const reloaded = await EngineAccountStore.open(dataDir, { realHomeDir: fakeHome });
    expect(reloaded.list()).toEqual([created]);
    expect(reloaded.get(created.id)).toEqual(created);
  });

  it("gera sufixo curto aleatório quando o slug colide entre motores ou fica curto", async () => {
    const dataDir = await tempDir();
    const fakeHome = await tempDir();
    let seq = 0;
    const store = await EngineAccountStore.open(dataDir, {
      realHomeDir: fakeHome,
      randomSuffix: () => `a${++seq}b2`,
    });

    const first = await store.create("claude", "Equipe");
    const second = await store.create("gemini", "Equipe");
    const short = await store.create("claude", "A");

    expect(first.id).toBe("equipe");
    expect(second.id).toBe("equipe-a1b2");
    expect(short.id).toBe("a-a2b2");
  });

  it("cria conta Gemini com HOME isolado, symlinks de .gitconfig/.local/.npmrc (NUNCA .ssh) e remover NÃO apaga os alvos", async () => {
    const dataDir = await tempDir();
    const fakeHome = await tempDir();

    // Cria arquivos/pastas no HOME falso (nunca o HOME real)
    const gitconfig = path.join(fakeHome, ".gitconfig");
    const localBin = path.join(fakeHome, ".local", "bin");
    const localTool = path.join(localBin, "agy");
    const npmrc = path.join(fakeHome, ".npmrc");
    const sshDir = path.join(fakeHome, ".ssh");
    const sshKey = path.join(sshDir, "id_ed25519");

    await writeFile(gitconfig, "[user]\n\tname = Teste\n");
    await mkdir(localBin, { recursive: true });
    await writeFile(localTool, "#!/bin/sh\n");
    await writeFile(npmrc, "registry=https://registry.npmjs.org/\n");
    await mkdir(sshDir, { recursive: true });
    await writeFile(sshKey, "chave-falsa-de-teste");

    const store = await EngineAccountStore.open(dataDir, { realHomeDir: fakeHome });
    const account = await store.create("gemini", "Conta Extra");

    const env = store.profileEnv(account);
    const expectedHome = path.resolve(dataDir, "platform", "engines", "gemini", "accounts", account.id, "home");
    expect(env).toEqual({ HOME: expectedHome });
    expect((await stat(expectedHome)).mode & 0o777).toBe(0o700);

    // Symlinks permitidos existem e apontam para o HOME falso
    expect((await lstat(path.join(expectedHome, ".gitconfig"))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(expectedHome, ".gitconfig"))).toBe(gitconfig);
    expect((await lstat(path.join(expectedHome, ".local"))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(expectedHome, ".local"))).toBe(path.join(fakeHome, ".local"));
    expect((await lstat(path.join(expectedHome, ".npmrc"))).isSymbolicLink()).toBe(true);

    // .ssh NUNCA é ligado
    await expect(lstat(path.join(expectedHome, ".ssh"))).rejects.toThrow();

    // Remover a conta apaga a pasta do perfil mas NÃO toca nos alvos dos symlinks
    await store.remove(account.id);
    await expect(lstat(path.dirname(expectedHome))).rejects.toThrow();
    expect(await readFile(gitconfig, "utf8")).toBe("[user]\n\tname = Teste\n");
    expect(await readFile(localTool, "utf8")).toBe("#!/bin/sh\n");
    expect(await readFile(npmrc, "utf8")).toBe("registry=https://registry.npmjs.org/\n");
    expect(await readFile(sshKey, "utf8")).toBe("chave-falsa-de-teste");
    expect(store.list()).toEqual([]);
  });

  it("recusa id/caminho malicioso e recusa apagar se a pasta do perfil virar symlink para fora", async () => {
    const dataDir = await tempDir();
    const fakeHome = await tempDir();
    const outsideDir = await tempDir();
    await writeFile(path.join(outsideDir, "seguro.txt"), "intacto");

    const store = await EngineAccountStore.open(dataDir, { realHomeDir: fakeHome });

    for (const badId of ["../fora", "../../etc", "a/b", "..", "-abc", "ab", "foo\\bar"]) {
      expect(() => store.profileEnv({ id: badId, engine: "claude" })).toThrow();
      await expect(store.rename(badId, "Novo")).rejects.toThrow();
      await expect(store.remove(badId)).rejects.toThrow();
    }

    // Se alguém trocar a pasta da conta por um symlink apontando para fora, `remove` recusa e não apaga o alvo.
    const account = await store.create("claude", "Teste Escape");
    const profilePath = store.profileDir(account);
    const { rm } = await import("node:fs/promises");
    await rm(profilePath, { recursive: true, force: true });
    await symlink(outsideDir, profilePath);

    await expect(store.remove(account.id)).rejects.toThrow(/symlink/i);
    expect(await readFile(path.join(outsideDir, "seguro.txt"), "utf8")).toBe("intacto");
  });

  it("rename valida duplicata no mesmo motor, permite mesmo nome em motor diferente e respeita o teto técnico por motor", async () => {
    const dataDir = await tempDir();
    const fakeHome = await tempDir();
    const store = await EngineAccountStore.open(dataDir, { realHomeDir: fakeHome });

    const a = await store.create("claude", "Conta Um");
    const b = await store.create("claude", "Conta Dois");
    await expect(store.create("claude", "conta um")).rejects.toThrow(/Já existe/);
    await expect(store.rename(b.id, "CONTA UM")).rejects.toThrow(/Já existe/);

    const renamed = await store.rename(b.id, "Conta Renomeada");
    expect(renamed.label).toBe("Conta Renomeada");
    expect(store.get(b.id)?.label).toBe("Conta Renomeada");

    // Mesmo rótulo em outro motor é permitido
    const g = await store.create("gemini", "Conta Um");
    expect(g.engine).toBe("gemini");

    // Chega até o teto de contas no Claude e recusa a seguinte
    for (let i = 3; i <= MAX_ACCOUNTS_PER_ENGINE; i += 1) {
      await store.create("claude", `Conta ${i}`);
    }
    expect(store.list("claude")).toHaveLength(MAX_ACCOUNTS_PER_ENGINE);
    await expect(store.create("claude", `Conta ${MAX_ACCOUNTS_PER_ENGINE + 1}`)).rejects.toThrow(/Limite/);
    expect(a.id).toBe("conta-um");
  });
});
