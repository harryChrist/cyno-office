/**
 * `npm run lab:setup`: cria (ou acerta) o workspace "Laboratório" para testar os agentes reais.
 * Com o server no ar, vai pela API HTTP; com ele parado, abre os dados direto (sem retomar filas).
 * Para testar sem tocar no app real nem na senha dele, use `npm run lab:up` (app de teste isolado).
 */
import { loadConfig } from "../config";
import { httpLabApi, LAB, offlineLabApi, setupLab, type LabResult } from "./lab";
import { seedDataDir } from "../workspace/office/seed";
import { migrateLegacyLayout } from "../store/legacy-layout";

const config = loadConfig();
const baseUrl = process.env.LAB_API_URL ?? `http://127.0.0.1:${config.port}`;

async function serverUp(): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function run(): Promise<LabResult> {
  if (await serverUp()) {
    console.log(`Server no ar em ${baseUrl}: usando a API.`);
    return setupLab(httpLabApi(baseUrl));
  }
  console.log(`Server parado: abrindo os dados em ${config.dataDir} direto.`);
  await migrateLegacyLayout(config.dataDir);
  await seedDataDir(config.dataDir);
  const api = await offlineLabApi(config.dataDir);
  try {
    return await setupLab(api);
  } finally {
    await api.close();
  }
}

let result: LabResult;
try {
  result = await run();
} catch (error) {
  console.error(`lab:setup falhou: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

console.log(result.changes.length > 0 ? `Feito: ${result.changes.join("; ")}.` : "O Laboratório já estava pronto.");
const { research } = result;
console.log(`
Workspace: ${result.workspace.name} (${LAB.id})
- ${result.maestro.name} (Sala do Maestro) — motor claude
- Quarto ${result.room.name} / time ${result.team.name} — ${result.agent.name} (${result.agent.id}), motor claude
- Quarto ${research.room.name} / time ${research.team.name} — ${research.agent.name} (${research.agent.id}), motor gemini (Antigravity, ${research.agent.model ?? "modelo padrão"})

Teste (com o server no ar; gasta um pouco da sua assinatura):
  # Claude Code (Maestro) -> Claude Code (Redator)
  curl -s -X POST ${baseUrl}/api/w/${LAB.id}/tasks -H 'content-type: application/json' \\
    -d '{"prompt":"Escreva um slogan curto para uma pizzaria"}'
  # Claude Code (Maestro) -> Antigravity (Pesquisador)
  curl -s -X POST ${baseUrl}/api/w/${LAB.id}/tasks -H 'content-type: application/json' \\
    -d '{"prompt":"Peça ao Pesquisador 3 curiosidades curtas sobre pizza"}'
Acompanhe no app (workspace Laboratório, Ctrl/⌘+K) ou em GET /api/w/${LAB.id}/tasks.`);
