import { describe, expect, it } from "vitest";
import {
  fileCreateBodySchema,
  fileDeleteBodySchema,
  fileNameError,
  fileRenameBodySchema,
  fileUploadPath,
  fileWriteBodySchema,
  compareFileEntries,
  compareFileNames,
  fileDirOf,
  fileExtension,
  fileListPath,
  fileListQuerySchema,
  fileNameOf,
  fileRawPath,
  fileReadPath,
  fileSearchQuerySchema,
  fileSegments,
  fileSizeLabel,
  fileVersion,
  fileViewByName,
  isLockedDirName,
  isLockedFileName,
  joinFilePath,
  normalizeFilePath,
} from "./files";

describe("arquivos: caminhos relativos", () => {
  it("normaliza barras e recusa o que sairia da raiz", () => {
    expect(normalizeFilePath("")).toBe("");
    expect(normalizeFilePath("a/b/c.md")).toBe("a/b/c.md");
    expect(normalizeFilePath("a//b/")).toBe("a/b");
    for (const bad of ["/etc/passwd", "../x", "a/../b", "a/./b", "a\\b", "a\0b", "x".repeat(5000)]) expect(normalizeFilePath(bad)).toBeNull();
  });

  it("junta e separa caminhos", () => {
    expect(joinFilePath("", "a")).toBe("a");
    expect(joinFilePath("a/b", "c")).toBe("a/b/c");
    expect(fileNameOf("a/b/c.md")).toBe("c.md");
    expect(fileDirOf("a/b/c.md")).toBe("a/b");
    expect(fileDirOf("c.md")).toBe("");
    expect(fileSegments("")).toEqual([]);
    expect(fileSegments("a/b")).toEqual(["a", "b"]);
  });

  it("os esquemas das consultas normalizam o caminho e recusam o inválido", () => {
    expect(fileListQuerySchema.parse({ root: "dados" })).toMatchObject({ root: "dados", path: "", offset: 0, limit: 200 });
    expect(fileListQuerySchema.parse({ root: "f1", path: "a//b/", offset: "400", limit: "50", filter: " i1 " })).toMatchObject({ path: "a/b", offset: 400, limit: 50, filter: "i1" });
    expect(fileListQuerySchema.safeParse({ root: "f1", path: "../fora" }).success).toBe(false);
    expect(fileListQuerySchema.safeParse({ root: "f1", limit: "5000" }).success).toBe(false);
    expect(fileSearchQuerySchema.safeParse({ root: "f1", q: "  " }).success).toBe(false);
  });

  it("os endereços levam raiz e caminho codificados", () => {
    expect(fileListPath("meu ws", "f1", "a b/c&d", { offset: 200 })).toBe("/api/w/meu%20ws/files/list?root=f1&path=a%20b%2Fc%26d&offset=200");
    expect(fileListPath("w", "dados", "")).toBe("/api/w/w/files/list?root=dados");
    expect(fileReadPath("w", "f1", "a.md", "9-1")).toBe("/api/w/w/files/read?root=f1&path=a.md&known=9-1");
    expect(fileReadPath("w", "f1", "a.md", undefined, true)).toBe("/api/w/w/files/read?root=f1&path=a.md&edit=1");
    expect(fileRawPath("w", "f1", "a.png", true)).toBe("/api/w/w/files/raw?root=f1&path=a.png&download=1");
  });
});

describe("arquivos: tipos, trancados, ordem e rótulos", () => {
  it("o nome decide Markdown, imagem e texto; o resto fica para o servidor olhar o conteúdo", () => {
    expect(fileExtension("a.TAR.GZ")).toBe("gz");
    expect(fileExtension("Makefile")).toBe("");
    expect(fileViewByName("progresso.md")).toBe("markdown");
    expect(fileViewByName("capa.PNG")).toBe("image");
    expect(fileViewByName("v0_i12.json")).toBe("text");
    expect(fileViewByName("Dockerfile")).toBe("text");
    expect(fileViewByName(".gitignore")).toBe("text");
    // SVG é texto com script: nunca vai para uma tag de imagem.
    expect(fileViewByName("logo.svg")).toBe("text");
    expect(fileViewByName("dados.bin")).toBeUndefined();
    expect(fileViewByName("sem-extensao")).toBeUndefined();
  });

  it("tranca chaves, senhas e credenciais, e deixa os modelos sem segredo", () => {
    for (const name of [".env", ".env.local", ".ENV.production", "id_rsa", "id_ed25519", "server.pem", "chave.key", ".npmrc", ".netrc", "credentials.json", "google-credentials.json", "secrets.yaml", "auth.json", "device-key.json", "token.json", ".credentials.json", ".secrets"]) {
      expect(isLockedFileName(name), name).toBe(true);
    }
    for (const name of [".env.example", ".env.sample", "id_rsa.pub", "envelope.md", "tokens-do-capitulo.md", "keyboard.json", "package.json", "glossario.md", "monkey.txt"]) {
      expect(isLockedFileName(name), name).toBe(false);
    }
    expect(isLockedDirName(".ssh")).toBe(true);
    expect(isLockedDirName("src")).toBe(false);
  });

  it("ordem natural, com as pastas na frente", () => {
    expect(["v0_i10.json", "v0_i2.json", "v0_i1.json"].sort(compareFileNames)).toEqual(["v0_i1.json", "v0_i2.json", "v0_i10.json"]);
    expect(["b", "A", "á", "a"].sort(compareFileNames).map((name) => name.toLowerCase().normalize("NFD")[0])).toEqual(["a", "a", "a", "b"]);
    const entries = [
      { name: "z.md", kind: "file" as const },
      { name: "pt", kind: "dir" as const },
      { name: "a.md", kind: "file" as const },
      { name: "raw", kind: "dir" as const },
    ];
    expect(entries.sort(compareFileEntries).map((entry) => entry.name)).toEqual(["pt", "raw", "a.md", "z.md"]);
  });

  it("tamanho legível e versão", () => {
    expect(fileSizeLabel(812)).toBe("812 B");
    expect(fileSizeLabel(48 * 1024)).toBe("48 KB");
    expect(fileSizeLabel(1.4 * 1024 * 1024)).toBe("1,4 MB");
    expect(fileSizeLabel(2 * 1024 * 1024)).toBe("2 MB");
    expect(fileSizeLabel(212 * 1024)).toBe("212 KB");
    expect(fileVersion(9000, 1795105442687.4)).toBe("9000-1795105442687");
  });
});

describe("arquivos: alterações", () => {
  it("nome de item: recusa vazio, barra, controle, ponto e nome trancado", () => {
    for (const ok of ["notas.md", "Capítulo 12.json", ".gitignore", ".env.example", "a b c"]) expect(fileNameError(ok), ok).toBeNull();
    for (const bad of ["", "  ", " a", "a ", ".", "..", "a/b", "a\\b", "a\u0000b", "a\nb", "x".repeat(256), ".env", "id_rsa", "credentials.json"]) expect(fileNameError(bad), JSON.stringify(bad)).not.toBeNull();
    expect(fileNameError(".ssh", "dir")).not.toBeNull();
    expect(fileNameError("src", "dir")).toBeNull();
    // Como pasta, um nome que só é trancado como arquivo passa.
    expect(fileNameError("credentials", "dir")).toBeNull();
  });

  it("os corpos recusam a própria raiz, a travessia e campo a mais", () => {
    expect(fileWriteBodySchema.parse({ root: "f1", path: "a//b.md", text: "oi", baseVersion: "2-1" })).toMatchObject({ path: "a/b.md", text: "oi", baseVersion: "2-1" });
    expect(fileWriteBodySchema.safeParse({ root: "f1", path: "", text: "" }).success).toBe(false);
    expect(fileWriteBodySchema.safeParse({ root: "f1", path: "../x", text: "" }).success).toBe(false);
    expect(fileWriteBodySchema.safeParse({ root: "f1", path: "a.md", text: "", extra: 1 }).success).toBe(false);
    expect(fileCreateBodySchema.safeParse({ root: "f1", path: "nova", kind: "dir" }).success).toBe(true);
    expect(fileCreateBodySchema.safeParse({ root: "f1", path: "nova", kind: "link" }).success).toBe(false);
    expect(fileRenameBodySchema.safeParse({ root: "f1", from: "a", to: "" }).success).toBe(false);
    expect(fileDeleteBodySchema.safeParse({ root: "f1", path: "" }).success).toBe(false);
    expect(fileDeleteBodySchema.safeParse({ root: "f1", path: "a/b" }).success).toBe(true);
  });

  it("o endereço do envio leva a pasta e o nome codificados", () => {
    expect(fileUploadPath("w", "f1", "a b", "foto 1.png")).toBe("/api/w/w/files/upload?root=f1&path=a%20b&name=foto%201.png");
    expect(fileUploadPath("w", "f1", "", "a.txt", true)).toBe("/api/w/w/files/upload?root=f1&name=a.txt&overwrite=1");
  });
});
