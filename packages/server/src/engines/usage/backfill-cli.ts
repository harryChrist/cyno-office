import { loadConfig } from "../../config";
import { readWorkspaceList } from "../../store/workspace-registry";
import { rootPaths } from "../../store/paths";
import { backfillClaudeTranscripts } from "./backfill";

/**
 * Importa os gastos antigos dos agentes de Claude Code (as conversas gravadas pela CLI) para o
 * histórico da página Gastos. Idempotente: rodar de novo não duplica nada.
 *
 *   npm run usage:backfill -w @cyno/server -- [--workspace <id>]... [--dry-run]
 *     [--data-dir <DATA_DIR>] [--projects <pasta de projetos do Claude Code>]
 *
 * Padrões: DATA_DIR e CLAUDE_CONFIG_DIR do ambiente (os mesmos do server). Sem --workspace: todos.
 */

function argValues(name: string): string[] {
  const values: string[] = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) if (args[i] === name && args[i + 1]) values.push(args[i + 1]!);
  return values;
}

const config = loadConfig();
const dataDir = argValues("--data-dir")[0] ?? config.dataDir;
const projectsDir = argValues("--projects")[0] ?? config.retention.claudeProjectsDir;
const dryRun = process.argv.includes("--dry-run");
const root = rootPaths(dataDir);
const wanted = argValues("--workspace");
const ids = wanted.length > 0 ? wanted : ((await readWorkspaceList(root.workspacesFile)) ?? []).map((workspace) => workspace.id);

if (ids.length === 0) {
  console.log(`Nenhum workspace em ${root.workspacesFile}.`);
  process.exit(0);
}

console.log(`${dryRun ? "[simulação] " : ""}Conversas do Claude Code em ${projectsDir}`);
for (const id of ids) {
  const report = await backfillClaudeTranscripts({ workspaceDir: root.workspaceDir(id), projectsDir, dryRun });
  console.log(
    `• ${id}: ${report.imported} mensagens importadas de ${report.files} conversas (${report.agents} agentes) · ` +
      `${report.duplicates} já estavam · ${report.afterLive} depois do registro ao vivo · ${report.withTask} com tarefa · ${report.unpriced} sem preço`,
  );
  for (const [month, total] of Object.entries(report.months)) console.log(`    ${month}: ${total}`);
}
