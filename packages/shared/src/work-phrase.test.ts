// Parte dos casos vem do `activity.test.ts` do Habblaud (github.com/marmottajr/habblaud, MIT,
// Copyright (c) 2026 Márcio Junior; licença em THIRD_PARTY/habblaud-LICENSE.txt), adaptada.
import { describe, expect, it } from "vitest";
import { LEGACY_OFFICE_TOOL_NAMES } from "./terminal";
import {
  ANTIGRAVITY_TOOL_NAMES,
  basename,
  canonicalToolName,
  describeWork,
  describeWorkDone,
  fraseDeAtividade,
  officeToolDone,
  officeToolDoneWith,
  officeToolName,
  OFFICE_TOOL_PHRASES,
  officeToolShort,
  truncate,
} from "./work-phrase";

describe("describeWork: ferramentas de arquivo, busca e web (Claude Code)", () => {
  it("arquivos", () => {
    expect(describeWork("Read", { file_path: "/a/b/package.json" })).toEqual({ icon: "📖", text: "Lendo package.json", detail: "/a/b/package.json" });
    expect(describeWork("Read", { file_path: "/a/foto.png" }).icon).toBe("🖼️");
    expect(describeWork("Read", { file_path: "/a/doc.pdf" }).icon).toBe("📕");
    expect(describeWork("Read", {}).text).toBe("Lendo arquivo");
    expect(describeWork("Edit", { file_path: "/x/App.tsx" }).text).toBe("Editando App.tsx");
    expect(describeWork("MultiEdit", { file_path: "/x/App.tsx" }).text).toBe("Editando App.tsx");
    expect(describeWork("Write", { file_path: "/x/nota.md" })).toMatchObject({ icon: "📝", text: "Escrevendo nota.md" });
    expect(describeWork("NotebookEdit", { notebook_path: "/x/a.ipynb" }).text).toBe("Editando notebook a.ipynb");
  });

  it("busca e web", () => {
    expect(describeWork("Glob", { pattern: "**/*.ts" }).text).toBe("Procurando **/*.ts");
    expect(describeWork("Grep", { pattern: "maskSecrets" }).text).toBe("Buscando “maskSecrets”");
    expect(describeWork("Grep", {}).text).toBe("Buscando no código");
    expect(describeWork("WebSearch", { query: "café coado" })).toEqual({ icon: "🌐", text: "Pesquisando “café coado”", detail: "café coado" });
    expect(describeWork("WebFetch", { url: "https://www.example.com/a/b" }).text).toBe("Lendo example.com");
  });

  it("subagente e desconhecida", () => {
    expect(describeWork("Agent", { description: "Revisar código" }).text).toBe("Delegando: Revisar código");
    expect(describeWork("Coisa", {})).toEqual({ icon: "🛠️", text: "Usando Coisa" });
    expect(describeWork("Read", null).text).toBe("Lendo arquivo");
  });

  it("até 46 caracteres, com a máscara antes do corte", () => {
    const long = describeWork("Grep", { pattern: "x".repeat(200) });
    expect(long.text.length).toBeLessThanOrEqual(46);
    const secret = describeWork("Grep", { pattern: "sk-ant-api03-TESTE-0000000000000000000000000000" });
    expect(secret.text).toBe("Buscando “sk-***”");
    expect(secret.detail).toBe("sk-***");
    expect(describeWork("Bash", { command: "curl -u admin:s3cr3t https://x.com" }).detail).toBe("curl -u admin:*** https://x.com");
  });
});

describe("os dois motores: o Antigravity (Gemini) chama as mesmas coisas por outros nomes", () => {
  it("traduz cada nome do Antigravity para o do Claude Code", () => {
    expect(canonicalToolName("view_file")).toBe("Read");
    expect(canonicalToolName("write_to_file")).toBe("Write");
    expect(canonicalToolName("replace_file_content")).toBe("Edit");
    expect(canonicalToolName("grep_search")).toBe("Grep");
    expect(canonicalToolName("find_by_name")).toBe("Glob");
    expect(canonicalToolName("list_dir")).toBe("LS");
    expect(canonicalToolName("search_web")).toBe("WebSearch");
    expect(canonicalToolName("read_url_content")).toBe("WebFetch");
    expect(canonicalToolName("run_command")).toBe("Bash");
    expect(canonicalToolName("Read")).toBe("Read");
    expect(ANTIGRAVITY_TOOL_NAMES).toContain("view_file");
  });

  it("a mesma frase nos dois motores, com as chaves de entrada de cada um", () => {
    expect(describeWork("view_file", { AbsolutePath: "/p/a/notas.txt" }).text).toBe("Lendo notas.txt");
    expect(describeWork("read_file", { Path: "/p/a/notas.txt" }).text).toBe("Lendo notas.txt");
    expect(describeWork("write_to_file", { TargetFile: "/p/a/resumo.md" }).text).toBe("Escrevendo resumo.md");
    expect(describeWork("replace_file_content", { TargetFile: "/p/App.tsx" }).text).toBe("Editando App.tsx");
    expect(describeWork("grep_search", { Query: "TODO", SearchPath: "/p" }).text).toBe("Buscando “TODO”");
    expect(describeWork("find_by_name", { Pattern: "*.md", SearchDirectory: "/p" }).text).toBe("Procurando *.md");
    expect(describeWork("list_dir", { DirectoryPath: "/p/src" }).text).toBe("Listando src");
    expect(describeWork("search_web", { query: "café coado" }).text).toBe("Pesquisando “café coado”");
    expect(describeWork("read_url_content", { Url: "https://pt.wikipedia.org/wiki/Café" }).text).toBe("Lendo pt.wikipedia.org");
    expect(describeWork("run_command", { CommandLine: "npm test" }).text).toBe("Rodando os testes");
  });
});

describe("terminal (quando o dono liga): comando simples", () => {
  it("reconhece o básico e pula cd/atribuições", () => {
    expect(describeWork("Bash", { command: "cd /x && git status" }).text).toBe("Usando git status");
    expect(describeWork("Bash", { command: "FOO=1 npm run build" }).text).toBe("Montando o projeto (build)");
    expect(describeWork("Bash", { command: "ls -la" }).text).toBe("Listando arquivos");
    expect(describeWork("Bash", { command: "meu-programa --x" }).text).toBe("Rodando meu-programa");
    expect(describeWork("Bash", {}).text).toBe("Rodando um comando no terminal");
  });
});

describe("ferramentas do escritório", () => {
  it("frase no gerúndio, com o que veio na chamada", () => {
    expect(describeWork("mcp__office__request_approval", {})).toEqual({ icon: "✋", text: "Pedindo seu OK" });
    expect(describeWork("mcp__office__submit_result", { result: "x" }).text).toBe("Entregando o resultado");
    expect(describeWork("mcp__office__request_help", { what: "falta acesso" })).toMatchObject({ icon: "🆘", text: "Pedindo ajuda ao Maestro", detail: "falta acesso" });
    expect(describeWork("mcp__office__send_to_colleague", { to: "Rafa", message: "olha isso", intent: "ask" }).text).toBe("Passando a vez para Rafa");
    expect(describeWork("mcp__office__save_note", { title: "Café coado", content: "…" }).text).toBe("Anotando “Café coado” no Cérebro");
    expect(describeWork("mcp__office__save_note", {}).text).toBe("Anotando no Cérebro");
    expect(describeWork("mcp__office__browser_open", { url: "https://www.google.com/x" }).text).toBe("Abrindo google.com");
    expect(describeWork("mcp__office__agenda_book", {}).icon).toBe("📅");
    expect(describeWork("mcp__office__media_render_html", {}).icon).toBe("🖼️");
    expect(describeWork("mcp__office__routine_pause", {}).text).toBe("Pausando uma rotina");
    expect(describeWork("mcp__office__start_script", { title: "Baixar capítulos", command: "bash baixar.sh" })).toMatchObject({ icon: "⚙️", text: "Lançando um script: Baixar capítulos", detail: "bash baixar.sh" });
    expect(describeWork("mcp__office__start_script", { title: "x".repeat(100), command: "c" }).text.length).toBeLessThanOrEqual(46);
    expect(describeWork("mcp__office__start_script", {}).text).toBe("Lançando um script");
    expect(describeWork("mcp__office__check_script", { id: "s1" }).text).toBe("Acompanhando um script");
    expect(describeWork("mcp__office__stop_script", { id: "s1" }).text).toBe("Parando um script");
    expect(describeWork("mcp__office__list_scripts", {}).text).toBe("Conferindo os scripts");
    expect(officeToolDoneWith("start_script", { title: "Baixar capítulos" })).toBe("Lançou um script: Baixar capítulos");
    expect(officeToolDone("stop_script")).toBe("Parou um script");
  });

  it("nome antigo (pt-BR) acha a mesma frase; desconhecida cai numa frase genérica com o nome", () => {
    expect(describeWork("mcp__office__entregar", {}).text).toBe("Entregando o resultado");
    expect(officeToolName("mcp__office__pedir_ajuda")).toBe("request_help");
    expect(describeWork("mcp__office__coisa_nova", {})).toEqual({ icon: "🛠️", text: "Usando coisa nova" });
    expect(officeToolName("mcp__office__notion__create_page")).toBeUndefined();
  });

  it("rótulos curtos e passado (os que a interface já usava)", () => {
    expect(officeToolShort("submit_result")).toBe("entregar");
    expect(officeToolShort("algo_novo")).toBe("algo novo");
    expect(officeToolDone("request_approval")).toBe("Pediu sua aprovação");
    expect(officeToolDone("algo_novo")).toBe("Usou algo novo");
    expect(officeToolDoneWith("browser_open", { url: "google.com" })).toBe("Abriu google.com");
    expect(officeToolDoneWith("browser_type", { text: "pizza", submit: true })).toBe("Digitou “pizza” e enviou");
    expect(officeToolDoneWith("browser_press", { key: "Enter" })).toBe("Apertou Enter");
    expect(describeWorkDone("mcp__office__browser_scroll", { direction: "up" })).toBe("Rolou a página para cima");
    expect(describeWorkDone("Read", { file_path: "/a/x.ts" })).toBe("Lendo x.ts");
  });

  it("toda linha tem ícone e as três frases, e os nomes antigos apontam para linhas que existem", () => {
    for (const [tool, phrase] of Object.entries(OFFICE_TOOL_PHRASES)) {
      expect(phrase.icon, tool).not.toBe("");
      expect(phrase.short, tool).not.toBe("");
      expect(phrase.doing.length, tool).toBeLessThanOrEqual(60);
      expect(phrase.done, tool).not.toBe("");
    }
    for (const novo of Object.values(LEGACY_OFFICE_TOOL_NAMES)) expect(OFFICE_TOOL_PHRASES[novo], novo).toBeDefined();
  });
});

describe("conectores e navegador de fora", () => {
  it("esqueleto do Habblaud", () => {
    expect(describeWork("mcp__playwright__browser_navigate", { url: "https://www.google.com" }).text).toBe("Abrindo google.com");
    expect(describeWork("mcp__playwright__browser_take_screenshot", {}).text).toBe("Tirando print da página");
    expect(describeWork("mcp__github__list_issues", {}).text).toBe("GitHub: list issues");
    expect(describeWork("mcp__outro__fazer_algo", {}).icon).toBe("🔌");
  });
});

describe("a função da cena", () => {
  it("fraseDeAtividade devolve só o ícone e o texto, já mascarados", () => {
    expect(fraseDeAtividade({ name: "Edit", input: { file_path: "/x/App.tsx" } })).toEqual({ icon: "✏️", text: "Editando App.tsx" });
    expect(fraseDeAtividade({ name: "mcp__office__save_note" })).toEqual({ icon: "🧠", text: "Anotando no Cérebro" });
  });
});

describe("truncate e basename", () => {
  it("colapsa espaços e corta com reticências", () => {
    expect(truncate("a   b\nc", 10)).toBe("a b c");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
    expect(basename("/a/b/c.txt")).toBe("c.txt");
    expect(basename("C:\\x\\y.md")).toBe("y.md");
  });
});
