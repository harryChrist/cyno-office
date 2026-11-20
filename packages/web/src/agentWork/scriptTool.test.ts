import { describe, expect, it } from "vitest";
import { isScriptTool, parseScriptToolResult, scriptIdOfTool, scriptLaunchedBy } from "./scriptTool";

describe("primeira linha do resultado", () => {
  it("lê o id e o estado", () => {
    expect(parseScriptToolResult("Script s12 · running")).toEqual({ id: "s12", status: "running" });
    expect(parseScriptToolResult("Script s3 · failed\n\nexit 2\nlinha")).toEqual({ id: "s3", status: "failed" });
    expect(parseScriptToolResult("\nScript s7 · done\r\nok")).toEqual({ id: "s7", status: "done" });
  });
  it("só vale na primeira linha", () => {
    expect(parseScriptToolResult("saída\nScript s1 · done")).toBeUndefined();
  });
  it("ignora o que não tem esse formato", () => {
    expect(parseScriptToolResult(undefined)).toBeUndefined();
    expect(parseScriptToolResult("")).toBeUndefined();
    expect(parseScriptToolResult("Erro: o terminal está desligado")).toBeUndefined();
    expect(parseScriptToolResult("Script x1 · running")).toBeUndefined();
    expect(parseScriptToolResult("Script s12 - running")).toBeUndefined();
  });
});

describe("ferramentas de script", () => {
  it("reconhece as três, com o prefixo MCP", () => {
    for (const tool of ["start_script", "check_script", "stop_script"]) expect(isScriptTool(`mcp__office__${tool}`)).toBe(true);
  });
  it("outras ferramentas não", () => {
    expect(isScriptTool("Bash")).toBe(false);
    expect(isScriptTool("start_script")).toBe(false);
    expect(isScriptTool("mcp__office__submit_result")).toBe(false);
  });
  it("o id só sai de ferramenta de script com o resultado certo", () => {
    expect(scriptIdOfTool("mcp__office__check_script", "Script s5 · running")).toBe("s5");
    expect(scriptIdOfTool("Bash", "Script s5 · running")).toBeUndefined();
    expect(scriptIdOfTool("mcp__office__check_script", "Falhou")).toBeUndefined();
  });

  it("o botão da linha do tempo só sai na chamada que lançou o script", () => {
    expect(scriptLaunchedBy("mcp__office__start_script", "Script s7 · running\nTitle: x")).toBe("s7");
    expect(scriptLaunchedBy("mcp__office__check_script", "Script s7 · running")).toBeUndefined();
    expect(scriptLaunchedBy("mcp__office__stop_script", "Script s7 · stopped")).toBeUndefined();
    expect(scriptLaunchedBy("mcp__office__start_script", "You already have 2 scripts running")).toBeUndefined();
  });
});
