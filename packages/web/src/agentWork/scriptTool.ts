import { officeToolName } from "./officeTools";

/** As ferramentas do escritório que falam de um script (o nome pode vir com o prefixo MCP). */
const SCRIPT_TOOLS = new Set(["start_script", "check_script", "stop_script"]);

export function isScriptTool(rawName: string): boolean {
  const office = officeToolName(rawName);
  return office !== undefined && SCRIPT_TOOLS.has(office);
}

/** A primeira linha do resultado das três ferramentas: `Script <id> · <status>` (ex.: `Script s12 · running`). */
const HEADLINE = /^Script (s\d{1,7}) · (\S+)/;

export type ScriptToolResult = { id: string; status: string };

/** Lê a primeira linha do resultado; `undefined` se não for essa (erro, saída cortada, outra ferramenta). */
export function parseScriptToolResult(output: string | undefined): ScriptToolResult | undefined {
  if (!output) return undefined;
  const first = output.trimStart().split(/\r?\n/, 1)[0] ?? "";
  const match = HEADLINE.exec(first);
  return match ? { id: match[1]!, status: match[2]! } : undefined;
}

/** O id do script de uma chamada de ferramenta de script (ou `undefined`). */
export function scriptIdOfTool(rawName: string, output: string | undefined): string | undefined {
  return isScriptTool(rawName) ? parseScriptToolResult(output)?.id : undefined;
}

/**
 * O script que a linha do tempo oferece abrir: só na chamada que o LANÇOU (`start_script`). As consultas e a parada
 * falam do mesmo script; um botão em cada uma repetiria o mesmo atalho várias vezes seguidas.
 */
export function scriptLaunchedBy(rawName: string, output: string | undefined): string | undefined {
  return officeToolName(rawName) === "start_script" ? parseScriptToolResult(output)?.id : undefined;
}
