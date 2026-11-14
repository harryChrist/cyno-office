import { execFile } from "node:child_process";
import { homedir } from "node:os";
import type { ConnectorImportCandidate, ConnectorImportResponse, ConnectorKind } from "@cyno/shared";
import { sanitizeChildEnv } from "../../engines/terminals/env";
import { maskUrl, type StoredConnector } from "./store";

/**
 * Importar do Claude Code do usuário: lê (só leitura) a saída de `claude mcp list` e oferece os
 * servidores para o usuário escolher. Copia nome e URL/comando; segredos NÃO (nada é lido dos
 * arquivos de configuração do usuário nem do `claude mcp get`): o usuário preenche no formulário.
 *
 * Formato de cada linha (Claude Code 2.x):
 *   <nome>: <alvo>[ (HTTP|SSE|stdio)] - <símbolo> <estado>
 * ex.: "notion: https://mcp.notion.com/mcp (HTTP) - ! Needs authentication",
 *      "claude.ai Figma: https://mcp.figma.com/mcp - ✔ Connected",
 *      "desktop-commander: npx -y @wonderwhy-er/desktop-commander@latest - ✔ Connected",
 *      "plugin:design:gmail:  (HTTP) - - Not configured".
 * O nome pode ter ":" (plugin:design:slack) e espaços, mas nunca ": " (é o separador).
 */

export type ParsedMcpEntry = { sourceName: string; target: string; transport?: string; status: string };

const STATUS_WORDS: [RegExp, string][] = [
  [/connected/i, "connected"],
  [/auth/i, "needs_auth"],
  [/fail/i, "failed"],
  [/pending/i, "pending"],
  [/not configured/i, "not_configured"],
];

function statusOf(text: string): string {
  if (/not configured/i.test(text)) return "not_configured";
  for (const [pattern, status] of STATUS_WORDS) if (pattern.test(text)) return status;
  return "unknown";
}

/** Lê a saída do `claude mcp list` (linhas que não casam, como "Checking MCP server health…", ficam de fora). */
export function parseClaudeMcpList(output: string): ParsedMcpEntry[] {
  const entries: ParsedMcpEntry[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const colon = line.indexOf(": ");
    if (colon <= 0) continue;
    const sourceName = line.slice(0, colon).trim();
    const rest = line.slice(colon + 2).trim();
    // "<alvo> - <símbolo> <estado>" (o símbolo pode ser o próprio "-", como em "- - Not configured").
    const match = /^(.*?)\s*-\s+([✔✓!✗✘×⏸-])\s+(.+)$/u.exec(rest) ?? /^(.*)\s-\s(.+)$/.exec(rest);
    if (!match) continue;
    let target = (match[1] ?? "").trim();
    const statusText = (match[3] ?? match[2] ?? "").trim();
    const transport = /(?:^|\s)\((HTTP|SSE|stdio)\)$/i.exec(target)?.[1];
    if (transport) target = target.slice(0, target.length - transport.length - 2).trim();
    entries.push({ sourceName, target, ...(transport ? { transport: transport.toLowerCase() } : {}), status: statusOf(statusText) });
  }
  return entries;
}

/** Nome bonito: sem "claude.ai " e sem o "plugin:<grupo>:" na frente. */
export function candidateName(sourceName: string): string {
  const name = sourceName
    .replace(/^claude\.ai\s+/i, "")
    .replace(/^plugin:[^:]+:/i, "")
    .trim();
  const pretty = name.length > 0 ? name : sourceName;
  return (pretty.charAt(0).toUpperCase() + pretty.slice(1)).slice(0, 60);
}

/** Separa um comando stdio em executável e argumentos (aspas simples/duplas respeitadas). */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) out.push(match[1] ?? match[2] ?? match[3] ?? "");
  return out;
}

/** Candidatos a importar a partir da saída, marcando os que já existem no workspace. */
export function importCandidates(output: string, existing: readonly Pick<StoredConnector, "url" | "command" | "args">[]): ConnectorImportCandidate[] {
  const candidates: ConnectorImportCandidate[] = [];
  for (const entry of parseClaudeMcpList(output)) {
    if (!entry.target) continue; // "Not configured": sem alvo para copiar
    const isUrl = /^https?:\/\//i.test(entry.target);
    if (entry.transport === "sse") continue; // transporte HTTP+SSE antigo: o gateway não fala
    const kind: ConnectorKind = isUrl ? "http" : "stdio";
    const base = {
      sourceName: entry.sourceName,
      name: candidateName(entry.sourceName),
      kind,
      sourceStatus: entry.status,
      hostedByClaudeAi: /^claude\.ai\s/i.test(entry.sourceName),
    };
    if (kind === "http") {
      const url = entry.target;
      if (!URL.canParse(url)) continue;
      // Chave na URL (query ou caminho) não é copiada: o usuário cola a URL inteira ao importar.
      const masked = maskUrl(url);
      const shown = masked === new URL(url).toString() ? url : masked;
      candidates.push({ ...base, url: shown, ...(shown !== url ? { urlMasked: true } : {}), alreadyImported: existing.some((record) => record.url === url) });
    } else {
      const [command = "", ...args] = splitCommand(entry.target);
      if (!command) continue;
      const already = existing.some((record) => record.command === command && JSON.stringify(record.args ?? []) === JSON.stringify(args));
      candidates.push({ ...base, command, args, alreadyImported: already });
    }
  }
  return candidates;
}

export type ClaudeMcpListOptions = {
  /** Executável do Claude Code (o mesmo dos agentes) e argumentos antes de `mcp list` (testes: o script falso). */
  command: string;
  prefixArgs?: string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

/** Roda `claude mcp list` (só leitura; cwd = pasta do usuário, para não pegar o .mcp.json de um projeto). */
export function runClaudeMcpList(options: ClaudeMcpListOptions): Promise<{ ok: true; output: string } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    execFile(
      options.command,
      [...(options.prefixArgs ?? []), "mcp", "list"],
      { cwd: homedir(), env: sanitizeChildEnv(options.env ?? process.env), timeout: options.timeoutMs ?? 60_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          const reason = code === "ENOENT" ? "o Claude Code (claude) não está instalado neste computador" : error.killed ? "o `claude mcp list` demorou demais" : "o `claude mcp list` falhou";
          // Mesmo com erro, a saída pode ter a lista (o comando sai com código ≠ 0 quando algum servidor falha).
          if (stdout && parseClaudeMcpList(stdout).length > 0) resolve({ ok: true, output: stdout });
          else resolve({ ok: false, reason });
          return;
        }
        resolve({ ok: true, output: stdout });
      },
    );
  });
}

/** GET …/connectors/import/claude */
export async function claudeImportCandidates(options: ClaudeMcpListOptions, existing: readonly Pick<StoredConnector, "url" | "command" | "args">[]): Promise<ConnectorImportResponse> {
  const result = await runClaudeMcpList(options);
  if (!result.ok) return { available: false, reason: result.reason, candidates: [] };
  return { available: true, candidates: importCandidates(result.output, existing) };
}
