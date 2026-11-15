import { describe, expect, it } from "vitest";
import { addWorkFolderBodySchema, effectiveFolders, folderEngineNote, folderSummary, updateWorkFolderBodySchema, type WorkFolder } from "./folders";

const projeto: WorkFolder = { id: "projeto", name: "Projeto", path: "/home/x/projeto", purpose: "Código do app.", mode: "write" };
const vault: WorkFolder = { id: "vault", name: "Vault", path: "/home/x/vault", mode: "read" };

describe("pastas de trabalho efetivas", () => {
  it("agente sem ajuste recebe o que o workspace dá, na ordem", () => {
    expect(effectiveFolders({ folders: [projeto, vault] }, {})).toEqual([
      { id: "projeto", name: "Projeto", path: "/home/x/projeto", purpose: "Código do app.", write: true },
      { id: "vault", name: "Vault", path: "/home/x/vault", write: false },
    ]);
  });

  it("workspace sem pastas (ou antigo, sem o campo) = nenhuma", () => {
    expect(effectiveFolders({}, {})).toEqual([]);
    expect(effectiveFolders(undefined, undefined)).toEqual([]);
  });

  it('"off" tira a pasta e "read" tira a escrita só dele', () => {
    const result = effectiveFolders([projeto, vault], { folders: { projeto: "read", vault: "off" } });
    expect(result).toEqual([{ id: "projeto", name: "Projeto", path: "/home/x/projeto", purpose: "Código do app.", write: false }]);
  });

  it("o agente nunca ganha mais que o workspace: pasta de leitura continua de leitura e pasta desconhecida não aparece", () => {
    const result = effectiveFolders([vault], { folders: { vault: "read", fantasma: "read" } });
    expect(result).toHaveLength(1);
    expect(result[0]?.write).toBe(false);
  });

  it("resume em português", () => {
    expect(folderSummary([])).toBe("Sem pastas de trabalho");
    expect(folderSummary(effectiveFolders([projeto, vault], {}))).toBe("2 pastas (1 com escrita)");
    expect(folderSummary(effectiveFolders([vault], {}))).toBe("1 pasta (só leitura)");
  });
});

describe("corpo das rotas de pastas", () => {
  it("cadastro: modo padrão é só leitura, textos aparados e limites com mensagem em pt-BR", () => {
    expect(addWorkFolderBodySchema.parse({ name: "  Vault ", path: " /home/x/vault " })).toEqual({ name: "Vault", path: "/home/x/vault", mode: "read" });
    expect(addWorkFolderBodySchema.safeParse({ name: "", path: "/x" }).error?.issues[0]?.message).toBe("Dê um nome para a pasta.");
    expect(addWorkFolderBodySchema.safeParse({ name: "a", path: "" }).error?.issues[0]?.message).toBe("Digite o caminho da pasta.");
    expect(addWorkFolderBodySchema.safeParse({ name: "a", path: "/x", purpose: "y".repeat(501) }).success).toBe(false);
    expect(addWorkFolderBodySchema.safeParse({ name: "a", path: "/x", mode: "tudo" }).success).toBe(false);
  });

  it("edição: pelo menos um campo e o caminho não muda", () => {
    expect(updateWorkFolderBodySchema.safeParse({}).success).toBe(false);
    expect(updateWorkFolderBodySchema.safeParse({ path: "/outro" }).success).toBe(false);
    expect(updateWorkFolderBodySchema.parse({ mode: "write" })).toEqual({ mode: "write" });
  });
});

describe("onde só leitura não é trava", () => {
  it("avisa por motor e some onde a regra vale", () => {
    expect(folderEngineNote("claude", false)).toBeNull();
    expect(folderEngineNote("gemini", false)).toBeNull();
    expect(folderEngineNote("claude", true)).toContain("terminal");
    expect(folderEngineNote("gemini", true)).toContain("terminal");
    expect(folderEngineNote("hermes", false)).toContain("cerca");
    expect(folderEngineNote("openclaw", false)).toContain("cerca");
    expect(folderEngineNote("freebuff", false)).toContain("só orientação");
    expect(folderEngineNote("mock", true)).toBeNull();
  });
});
