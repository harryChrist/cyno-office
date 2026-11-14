import { libraryUsage, SKILL_LIMITS, skillBudgetWarnings, type LibrarySkillView, type LibraryWorkspaceInfo, type ServerEvent } from "@cyno/shared";
import type { GrantDraft } from "./libraryView";

// ---------- Filtros e busca ----------

export const SKILL_FILTERS = [
  { id: "todas", label: "Todas" },
  { id: "em-uso", label: "Em uso" },
  { id: "sem-uso", label: "Sem uso" },
  { id: "com-aviso", label: "Com aviso" },
] as const;
export type SkillFilterId = (typeof SKILL_FILTERS)[number]["id"];

/** Origens para o filtro (a de URL só chega numa fatia futura, mas já tem nome). */
export const SKILL_ORIGINS = [
  { id: "todas", label: "Qualquer origem" },
  { id: "manual", label: "Escritas na tela" },
  { id: "upload", label: "Enviadas" },
  { id: "folder", label: "Importadas do computador" },
  { id: "app", label: "De um app" },
  { id: "url", label: "De uma URL" },
] as const;
export type SkillOriginFilter = (typeof SKILL_ORIGINS)[number]["id"];

export const SKILL_ORIGIN_LABELS: Record<LibrarySkillView["origin"]["kind"], string> = {
  manual: "Escrita na tela",
  upload: "Enviada (pasta ou zip)",
  folder: "Importada do computador",
  app: "De um app",
  url: "De uma URL",
};

const plain = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

export type SkillQuery = { filter: SkillFilterId; origin: SkillOriginFilter; query: string; workspaceId?: string | null };

/** Filtra e busca (nome, descrição, id, workspaces e agentes que usam). */
export function filterSkills(list: readonly LibrarySkillView[], { filter, origin, query, workspaceId }: SkillQuery): LibrarySkillView[] {
  const needle = plain(query.trim());
  return list.filter((skill) => {
    if (workspaceId && !(workspaceId in skill.grants)) return false;
    const used = libraryUsage(skill).agents > 0;
    if (filter === "em-uso" && !used) return false;
    if (filter === "sem-uso" && used) return false;
    if (filter === "com-aviso" && skill.warnings.length === 0) return false;
    if (origin !== "todas" && skill.origin.kind !== origin) return false;
    if (!needle) return true;
    const haystack = [skill.name, skill.id, skill.description, ...skill.uses.flatMap((use) => [use.workspaceName, ...use.agents.map((agent) => agent.name)])].map(plain).join("\n");
    return haystack.includes(needle);
  });
}

/** Quantas skills cada filtro mostraria. */
export function skillFilterCounts(list: readonly LibrarySkillView[], origin: SkillOriginFilter, workspaceId?: string | null): Record<SkillFilterId, number> {
  return Object.fromEntries(SKILL_FILTERS.map((item) => [item.id, filterSkills(list, { filter: item.id, origin, query: "", workspaceId }).length])) as Record<SkillFilterId, number>;
}

// ---------- Eventos ----------

/** Aplica library:skill-upserted / library:skill-deleted a uma lista (antes do GET, ignora). */
export function applySkillEvent(list: LibrarySkillView[] | null, event: ServerEvent): LibrarySkillView[] | null {
  if (list === null) return list;
  if (event.type === "library:skill-deleted") return list.some((item) => item.id === event.id) ? list.filter((item) => item.id !== event.id) : list;
  if (event.type !== "library:skill-upserted") return list;
  const index = list.findIndex((item) => item.id === event.item.id);
  if (index === -1) return [...list, event.item];
  return list.map((item, i) => (i === index ? event.item : item));
}

// ---------- Texto ----------

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0).replace(".", ",")} KB`;
}

/** "~1,2 mil tokens" / "~340 tokens". */
export function tokensLabel(tokens: number): string {
  if (tokens < 1000) return `~${tokens} tokens`;
  return `~${(tokens / 1000).toFixed(1).replace(".", ",")} mil tokens`;
}

export function skillUsageLabel(skill: Pick<LibrarySkillView, "uses">): string {
  const { workspaces, agents } = libraryUsage(skill);
  if (workspaces === 0) return "Ninguém usa ainda";
  const ws = workspaces === 1 ? "1 workspace" : `${workspaces} workspaces`;
  const ag = agents === 0 ? "nenhum agente" : agents === 1 ? "1 agente" : `${agents} agentes`;
  return `${ws} · ${ag}`;
}

export function readsLabel(skill: Pick<LibrarySkillView, "usage">): string {
  const { reads } = skill.usage;
  return reads === 0 ? "Nunca lida por um agente" : reads === 1 ? "Lida 1 vez" : `Lida ${reads} vezes`;
}

// ---------- Limites por agente ----------

/** As skills que um agente recebe num workspace (liberadas ao workspace E entregues a ele). */
export function skillsOfAgent(list: readonly LibrarySkillView[] | null, workspaceId: string | null, agentId: string): LibrarySkillView[] {
  if (!list || !workspaceId) return [];
  return list.filter((skill) => skill.grants[workspaceId]?.agentIds.includes(agentId)).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

export type AgentSkillBudget = { count: number; indexTokens: number; warnings: string[] };

export function agentSkillBudget(skills: readonly Pick<LibrarySkillView, "indexTokens">[]): AgentSkillBudget {
  return { count: skills.length, indexTokens: skills.reduce((total, skill) => total + skill.indexTokens, 0), warnings: skillBudgetWarnings(skills) };
}

/**
 * Avisos da janela de liberar: para cada agente marcado, como ficariam as skills dele com esta
 * liberação (só avisa, nunca bloqueia). Ex.: "Clara (Principal): 13 skills (acima de 12)".
 */
export function grantBudgetWarnings(all: readonly LibrarySkillView[], skill: LibrarySkillView, draft: GrantDraft, workspaces: readonly LibraryWorkspaceInfo[]): string[] {
  const lines: string[] = [];
  for (const [workspaceId, grant] of Object.entries(draft)) {
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    for (const agentId of grant.agentIds) {
      const others = all.filter((candidate) => candidate.id !== skill.id && candidate.grants[workspaceId]?.agentIds.includes(agentId));
      const budget = agentSkillBudget([...others, skill]);
      if (budget.warnings.length === 0) continue;
      const name = workspace?.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
      lines.push(`${name}${workspace ? ` (${workspace.name})` : ""}: ${budget.count} skills, índice ${tokensLabel(budget.indexTokens)} (limites: ${SKILL_LIMITS.maxPerAgent} skills e ~${SKILL_LIMITS.maxIndexTokens / 1000} mil tokens)`);
    }
  }
  return lines;
}

// ---------- Editor ----------

/** Frase secreta aleatória do autoteste (a mesma ideia do `cyno-selftest`). */
export function randomSelftestPhrase(random: () => number = Math.random): string {
  const words = ["abacaxi", "pizza", "mango", "dragao", "foguete", "cometa", "biscoito", "jabuticaba"];
  const pick = () => words[Math.floor(random() * words.length)]!;
  return `${pick()}-${pick()}-${Math.floor(random() * 9000 + 1000)}`;
}
