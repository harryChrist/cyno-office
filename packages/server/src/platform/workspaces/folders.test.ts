import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkFolder } from "@cyno/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkWorkFolderPath, FOLDER_ERRORS, isInside, newFolderId, relativePathError } from "./folders";

describe("validação do caminho de uma pasta de trabalho", () => {
  let root: string;
  let dataDir: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "cyno-folders-"));
    dataDir = path.join(root, "data");
    await mkdir(path.join(dataDir, "workspaces"), { recursive: true });
    await mkdir(path.join(root, "projeto"));
    await mkdir(path.join(root, "vault"));
    await writeFile(path.join(root, "arquivo.txt"), "x");
  });
  afterEach(() => rm(root, { recursive: true, force: true }));
  const check = (input: string, existing: WorkFolder[] = []) => checkWorkFolderPath(input, { dataDir, existing });
  const refused = async (input: string, message: string, existing: WorkFolder[] = []) => {
    await expect(check(input, existing)).rejects.toMatchObject({ statusCode: 400, message });
  };

  it("aceita uma pasta existente e grava o caminho real", async () => {
    expect(await check(path.join(root, "projeto"))).toBe(path.join(await import("node:fs/promises").then((fs) => fs.realpath(root)), "projeto"));
  });

  it("normaliza: link simbólico, .. e barra no fim viram o caminho de verdade", async () => {
    await symlink(path.join(root, "projeto"), path.join(root, "atalho"));
    const real = await check(path.join(root, "projeto"));
    expect(await check(path.join(root, "atalho"))).toBe(real);
    expect(await check(`${path.join(root, "vault", "..", "projeto")}/`)).toBe(real);
  });

  it("recusa caminho relativo, com til ou vazio, com mensagem em português", async () => {
    await refused("projeto", FOLDER_ERRORS.relative);
    await refused("~/projeto", FOLDER_ERRORS.relative);
    await refused("   ", FOLDER_ERRORS.relative);
  });

  it("adapta a mensagem de caminho relativo no Windows mantendo o texto atual no Linux", async () => {
    expect(relativePathError("linux")).toBe(FOLDER_ERRORS.relative);
    expect(relativePathError("win32")).toBe("Use o caminho completo da pasta (ex.: C:\\Users\\voce\\projeto).");
    await expect(checkWorkFolderPath("projeto", { dataDir, existing: [], platform: "win32" })).rejects.toMatchObject({
      statusCode: 400,
      message: "Use o caminho completo da pasta (ex.: C:\\Users\\voce\\projeto).",
    });
  });

  it("recusa o que não existe e arquivo", async () => {
    await refused(path.join(root, "nao-existe"), FOLDER_ERRORS.missing);
    await refused(path.join(root, "arquivo.txt"), FOLDER_ERRORS.notDirectory);
  });

  it("recusa a raiz do computador", async () => {
    await refused("/", FOLDER_ERRORS.root);
  });

  it("recusa o DATA_DIR, o que está dentro dele e o que o contém (inclusive por link)", async () => {
    await refused(dataDir, FOLDER_ERRORS.dataDir);
    await refused(path.join(dataDir, "workspaces"), FOLDER_ERRORS.dataDir);
    await refused(root, FOLDER_ERRORS.dataDir);
    await refused(path.dirname(root), FOLDER_ERRORS.dataDir);
    await symlink(dataDir, path.join(root, "link-dados"));
    await refused(path.join(root, "link-dados"), FOLDER_ERRORS.dataDir);
  });

  it("recusa duplicado (mesmo caminho real, mesmo por link) citando o nome", async () => {
    const real = await check(path.join(root, "projeto"));
    const existing: WorkFolder[] = [{ id: "projeto-1", name: "Meu projeto", path: real, mode: "write" }];
    await refused(path.join(root, "projeto"), FOLDER_ERRORS.duplicate("Meu projeto"), existing);
    await symlink(path.join(root, "projeto"), path.join(root, "atalho"));
    await refused(path.join(root, "atalho"), FOLDER_ERRORS.duplicate("Meu projeto"), existing);
    expect(await check(path.join(root, "vault"), existing)).toContain("vault");
  });

  it("recusa caracteres que quebrariam as regras dos motores", async () => {
    for (const name of ["a,b", "a*b", "a(b)", "a[b]", "a{b}", "a?b"]) {
      await mkdir(path.join(root, name));
      await refused(path.join(root, name), FOLDER_ERRORS.unsafeChars);
    }
    await mkdir(path.join(root, "Meu Vault"));
    expect(await check(path.join(root, "Meu Vault"))).toContain("Meu Vault");
  });

  it("isInside e ids novos", () => {
    expect(isInside("/a/b", "/a")).toBe(true);
    expect(isInside("/a", "/a")).toBe(true);
    expect(isInside("/ab", "/a")).toBe(false);
    expect(isInside("/", "/a")).toBe(false);
    const id = newFolderId("Meu Vault Ótimo!", []);
    expect(id).toMatch(/^meu-vault-otimo-[0-9a-f]{4}$/);
    expect(newFolderId("???", [])).toMatch(/^pasta-[0-9a-f]{4}$/);
  });
});
