/**
 * Ferramentas do escritório na interface. O contrato MCP é em inglês (`submit_result`,
 * `open_request`…), mas o usuário lê tudo em pt-BR. A tabela (ícone, rótulo curto, frase no
 * gerúndio e no passado de cada uma) vive em `@cyno/shared` (`work-phrase.ts`), para o servidor e
 * a cena usarem a mesma; aqui só se reexporta o que a tela já importava daqui.
 */
export { isBrowserTool, officeToolDone, officeToolDoneWith, officeToolName, officeToolShort } from "@cyno/shared";
