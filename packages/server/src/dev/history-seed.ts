/**
 * Semente de histórico para o app de teste (`LAB_HISTORY_DAYS=21 npm run lab:up`): grava, no layout real do
 * workspace, o histórico fabricado de `workspace/metrics/fixtures/make-history.ts` (tarefas, projetos, Para você,
 * gasto, Atividade e uma rotina com entregas), com as datas espalhadas pelos últimos N dias. O server de teste
 * precisa estar PARADO (o `lab:up` para, semeia e sobe de novo): aqui os arquivos são escritos direto.
 *
 * Só roda no DATA_DIR temporário do laboratório (veja `labDataDirError`) e marca tudo como semente: `source:"seed"`
 * no gasto, `data.seed:true` na Atividade, ids `seed-…`/`R-0900` a `R-0902` e `meta.seed` nos itens do Para você. Rodar de novo
 * troca a semente anterior pela nova (nada de dado de verdade é tocado).
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentBodySchema, findMaestroAgent, type ActivityEntry, type Agent, type ForYouItem, type Project, type UsageRecord } from "@cyno/shared";
import { writeJsonAtomic } from "../store/atomic-write";
import { readRoutinesFile } from "../store/files";
import { OfficeStore } from "../store/office-store";
import { dataPaths, rootPaths } from "../store/paths";
import { usageDir } from "../engines/usage/usage-history";
import { monthKeyOf } from "../engines/usage/usage-time";
import { activityDay } from "../workspace/activity/time";
import { makeHistory, PROFILE_IDS, PROFILES, SEED_ROUTINE_IDS, type HistoryAgent } from "../workspace/metrics/fixtures/make-history";
import { LAB, offlineLabApi } from "./lab";

/** Os agentes da semente, um por perfil (a ordem é a dos perfis). */
export const SEED_AGENTS: { name: string; role: string; profile: (typeof PROFILE_IDS)[number] }[] = [
  { name: "Clara", role: "Comentários e posts rápidos", profile: "rapido" },
  { name: "Eco", role: "Comentários com emoji", profile: "editado" },
  { name: "Beto", role: "Comentários e convites formais", profile: "recusado" },
  { name: "Dani", role: "Posts mais longos", profile: "lento" },
  { name: "Leo", role: "Posts e comentários (motor com pouca cota)", profile: "cota" },
];

/**
 * Por que NÃO se pode semear neste DATA_DIR (undefined = pode). Só vale o diretório temporário do `lab:up`:
 * dentro da pasta temporária do sistema, com nome `cyno-…`, sem senha (`auth.json`) e declarado pelo próprio `lab:up`
 * (`CYNO_LAB_DATA_DIR`). O DATA_DIR do app real nunca passa.
 */
export function labDataDirError(dataDir: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!dataDir) return "DATA_DIR não definido";
  const resolved = path.resolve(dataDir);
  const declared = env.CYNO_LAB_DATA_DIR ? path.resolve(env.CYNO_LAB_DATA_DIR) : undefined;
  if (declared !== resolved) return "este DATA_DIR não foi declarado pelo lab:up (CYNO_LAB_DATA_DIR); a semente só roda no app de teste";
  const roots = [path.resolve(tmpdir()), "/var/tmp", "/tmp"];
  if (!roots.some((root) => resolved.startsWith(`${root}${path.sep}`))) return "o DATA_DIR do laboratório precisa estar na pasta temporária do sistema";
  if (!path.basename(resolved).startsWith("cyno-")) return 'o nome da pasta do laboratório precisa começar com "cyno-"';
  if (existsSync(path.join(resolved, "auth.json"))) return "este DATA_DIR tem senha (auth.json): é um app de verdade, não o laboratório";
  return undefined;
}

type Options = { dataDir: string; workspaceId?: string; days: number; seed?: number; now?: number; log?: (line: string) => void };

/** Troca as linhas de semente de um JSONL (`isSeed`) pelas novas. */
async function rewriteJsonl(file: string, isSeed: (line: string) => boolean, added: string[]): Promise<void> {
  let kept: string[] = [];
  try {
    kept = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim() && !isSeed(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${[...kept, ...added].join("\n")}\n`, "utf8");
}

const markedSeed = (line: string): boolean => /"seed":true|"source":"seed"/.test(line);

/** Cria os agentes que faltam no time do Laboratório (server parado) e devolve a lista na ordem dos perfis. */
async function ensureSeedAgents(dataDir: string, workspaceId: string): Promise<{ agents: HistoryAgent[]; maestroId: string }> {
  const api = await offlineLabApi(dataDir);
  try {
    const office = await api.office(workspaceId);
    const maestro = findMaestroAgent(office);
    if (!maestro) throw new Error("O workspace ficou sem o Maestro");
    const team = office.teams.find((candidate) => candidate.name === LAB.team.name) ?? office.teams.find((candidate) => office.rooms.find((room) => room.id === candidate.roomId)?.kind === "team");
    if (!team) throw new Error("O workspace não tem um time (rode o lab:setup antes)");
    const agents: HistoryAgent[] = [];
    for (const spec of SEED_AGENTS) {
      let agent: Agent | undefined = office.agents.find((candidate) => candidate.name === spec.name && candidate.teamId === team.id);
      if (!agent) {
        const profile = PROFILES[spec.profile];
        agent = await api.createAgent(
          workspaceId,
          createAgentBodySchema.parse({
            teamId: team.id,
            name: spec.name,
            role: spec.role,
            instructions: "Agente de semente do histórico de teste: não recebe trabalho de verdade.",
            avatar: { ...LAB.agent.avatar },
            engine: profile.engine,
          }),
        );
      }
      agents.push({ id: agent.id, name: agent.name, roomId: team.roomId, teamId: team.id });
    }
    return { agents, maestroId: maestro.id };
  } finally {
    await api.close();
  }
}

export async function seedHistory(options: Options): Promise<{ tasks: number; forYou: number; usage: number; activity: number; projects: number }> {
  const log = options.log ?? (() => undefined);
  const workspaceId = options.workspaceId ?? LAB.id;
  const { agents, maestroId } = await ensureSeedAgents(options.dataDir, workspaceId);
  const workspaceDir = rootPaths(options.dataDir).workspaceDir(workspaceId);
  const paths = dataPaths(workspaceDir);
  const history = makeHistory({ now: options.now ?? Date.now(), days: options.days, seed: options.seed ?? 1, agents, maestroId, workspaceId, goals: true, retro: true });

  // Para você: os ids da semente continuam depois dos que já existem (a semente anterior sai primeiro).
  const store = await OfficeStore.open(workspaceDir);
  const keptForYou = store.forYouSnapshot().filter((item) => item.meta.seed !== "1");
  const highest = Math.max(0, ...keptForYou.map((item) => Number(item.id.slice(2))));
  const renamed = new Map(history.forYou.map((item, index) => [item.id, `A-${String(highest + index + 1).padStart(4, "0")}`]));
  const forYou: ForYouItem[] = history.forYou.map((item) => ({ ...item, id: renamed.get(item.id)! }));
  const activity: ActivityEntry[] = history.activity.map((entry) => (entry.refs?.forYouId ? { ...entry, refs: { ...entry.refs, forYouId: renamed.get(entry.refs.forYouId) ?? entry.refs.forYouId } } : entry));

  await store.commitTasks([...store.snapshot().tasks.filter((task) => !task.id.startsWith("seed-")), ...history.tasks]);
  await store.commitForYou([...keptForYou, ...forYou]);
  const existing = store.projectsSnapshot();
  const seedAvulsas = history.projects.find((project) => project.system === "avulsas")!;
  const current = existing.find((project) => project.system === "avulsas");
  const avulsas: Project = current
    ? { ...current, tasks: [...current.tasks.filter((leaf) => !leaf.ref.startsWith("S")), ...seedAvulsas.tasks], updatedAt: seedAvulsas.updatedAt }
    : seedAvulsas;
  const stale = existing.filter((project) => project.id.startsWith("seed-")).map((project) => project.id);
  await store.commitProjects([avulsas, ...history.projects.filter((project) => project.system !== "avulsas")], stale.filter((id) => !history.projects.some((project) => project.id === id)));
  await store.flush();

  // Rotinas: a rotina e as entradas da semente.
  const routines = await readRoutinesFile(paths.routinesFile);
  routines.routines = [...routines.routines.filter((routine) => !SEED_ROUTINE_IDS.includes(routine.id)), ...history.routines];
  routines.entries = [...routines.entries.filter((entry) => !entry.id.startsWith("seed-")), ...history.entries];
  await writeJsonAtomic(paths.routinesFile, routines);

  // Gasto (um arquivo por mês) e Atividade (um por dia).
  const byMonth = new Map<string, string[]>();
  for (const record of history.usage as UsageRecord[]) byMonth.set(monthKeyOf(Date.parse(record.at)), [...(byMonth.get(monthKeyOf(Date.parse(record.at))) ?? []), JSON.stringify(record)]);
  const dir = usageDir(workspaceDir);
  await mkdir(dir, { recursive: true });
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const month = /^(\d{4}-\d{2})\.jsonl$/.exec(name)?.[1];
    if (month && !byMonth.has(month)) byMonth.set(month, []);
  }
  for (const [month, lines] of byMonth) await rewriteJsonl(path.join(dir, `${month}.jsonl`), markedSeed, lines);
  const byDay = new Map<string, string[]>();
  for (const entry of activity) byDay.set(activityDay(Date.parse(entry.at)), [...(byDay.get(activityDay(Date.parse(entry.at))) ?? []), JSON.stringify(entry)]);
  const activityFolder = path.join(workspaceDir, "activity");
  await mkdir(activityFolder, { recursive: true });
  for (const name of await readdir(activityFolder).catch(() => [] as string[])) {
    const day = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1];
    if (day && !byDay.has(day)) byDay.set(day, []);
  }
  for (const [day, lines] of byDay) await rewriteJsonl(path.join(activityFolder, `${day}.jsonl`), markedSeed, lines);

  const summary = { tasks: history.tasks.length, forYou: forYou.length, usage: history.usage.length, activity: activity.length, projects: history.projects.length };
  log(`história semeada em "${workspaceId}": ${summary.tasks} tarefas, ${summary.forYou} itens do Para você, ${summary.usage} registros de gasto, ${summary.activity} linhas de Atividade, ${summary.projects} projetos (${options.days} dias)`);
  return summary;
}

/** `tsx src/dev/history-seed.ts` (chamado pelo `lab:up` com o server parado). */
async function main(): Promise<void> {
  const days = Number(process.env.LAB_HISTORY_DAYS);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    console.error("history-seed: LAB_HISTORY_DAYS precisa ser um inteiro de 1 a 90.");
    process.exit(1);
  }
  const dataDir = process.env.DATA_DIR;
  const refusal = labDataDirError(dataDir);
  if (refusal) {
    console.error(`history-seed: recusado, ${refusal}.`);
    process.exit(1);
  }
  await seedHistory({ dataDir: dataDir!, days, seed: Number(process.env.LAB_HISTORY_SEED ?? 1), log: (line) => console.log(`lab:up: ${line}`) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error: unknown) => {
    console.error(`history-seed falhou: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
