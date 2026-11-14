import type { CatalogApp } from "@cyno/shared";

/**
 * MarkItDown (Microsoft): converte PDF, Office, páginas e outros arquivos em Markdown.
 * Receita conferida em 11/11/2026: `markitdown-mcp 0.0.1a8` (PyPI, MCP oficial em
 * https://github.com/microsoft/markitdown/tree/main/packages/markitdown-mcp) depende de
 * `markitdown[all]>=0.1.9,<0.2` e `mcp>=2.1.1`; o comando é `markitdown-mcp` (stdio) e a única
 * ferramenta é `convert_to_markdown(uri)` (http:, https:, file: ou data:).
 */
export const markitdown: CatalogApp = {
  id: "markitdown",
  name: "MarkItDown",
  area: "documentos",
  status: "disponivel",
  summary: "Lê PDF, Word, Excel, PowerPoint, páginas da web e outros arquivos e devolve o texto em Markdown, para o agente conseguir ler o que está dentro do arquivo.",
  useWhen: "o agente precisa ler o conteúdo de um PDF, DOCX, planilha ou página da web",
  repo: "https://github.com/microsoft/markitdown",
  version: { kind: "pypi", ref: "markitdown-mcp 0.0.1a8 (markitdown 0.1.9)" },
  recipeVersion: "1",
  license: { spdx: "MIT", level: "livre", url: "https://github.com/microsoft/markitdown/blob/main/LICENSE", mustAccept: false },
  warnings: [
    "O MCP não tem login: ele lê qualquer arquivo da máquina onde o servidor roda e acessa a rede. Libere só para os agentes que precisam.",
    "O pacote ainda é alfa (0.0.1a8), mas é o MCP oficial da Microsoft.",
  ],
  requires: [
    { kind: "python", spec: ">=3.12", provision: "uv-python", note: "o Python vem do uv, baixado para a pasta de runtimes" },
    { kind: "disk", spec: "700MB" },
    { kind: "ram", spec: "300MB" },
  ],
  recipe: [
    { run: "download-runtime", runtime: "uv", label: "Baixar o uv (instala o Python e os pacotes)" },
    { run: "venv", python: "3.12", label: "Criar o ambiente Python do app" },
    { run: "pip-install", packages: ["markitdown-mcp==0.0.1a8", "markitdown[all]==0.1.9", "mcp==2.3.0"], timeoutSec: 900, label: "Instalar o MarkItDown e o servidor MCP" },
  ],
  provides: {
    connector: {
      name: "MarkItDown",
      description: "Converte um arquivo ou página (PDF, DOCX, XLSX, PPTX, HTML...) em Markdown. Passe o endereço (file:, http(s): ou data:).",
      command: [".venv/bin/markitdown-mcp"],
      env: {},
      limits: { idleSec: 600, startSec: 60, callSec: 120 },
      expectTools: ["convert_to_markdown"],
    },
  },
  test: { tool: "convert_to_markdown", args: { uri: "data:text/html;base64,PGgxPk9sYTwvaDE+" }, expect: { contains: "# Ola" }, timeoutSec: 60 },
  resources: { ramMB: 300, diskMB: 450, note: "Cerca de 340 MB de ambiente Python mais o Python do uv (compartilhado)." },
};
