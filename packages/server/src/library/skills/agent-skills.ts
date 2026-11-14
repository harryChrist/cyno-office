import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_SKILLS_DIR, estimateTokens, SKILL_LIMITS } from "@cyno/shared";

/** O que a entrega a um agente precisa saber de cada skill liberada a ele. */
export type AgentSkill = {
  id: string;
  name: string;
  description: string;
  /** Pasta da skill na Biblioteca (a cópia sai daqui). */
  sourceDir: string;
  /** `id@versão`: muda quando a skill é atualizada (a cópia só se refaz se algo mudou). */
  revision: string;
};

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** A linha do índice: nome (e o id, se for outro), quando usar (até 200 caracteres) e o caminho do SKILL.md na pasta do agente. */
export function skillIndexLine(skill: Pick<AgentSkill, "id" | "name" | "description">): string {
  const max = SKILL_LIMITS.indexDescriptionChars;
  const description = oneLine(skill.description);
  const short = description.length > max ? `${description.slice(0, max - 1).trimEnd()}…` : description;
  const name = oneLine(skill.name);
  // O id só aparece quando difere do nome (poupa tokens em toda conversa).
  return `- ${name === skill.id ? name : `${name} (${skill.id})`}: ${short} -> ${AGENT_SKILLS_DIR}/${skill.id}/SKILL.md`;
}

/** Tokens estimados de uma linha do índice. */
export const skillIndexTokens = (skill: Pick<AgentSkill, "id" | "name" | "description">): number => estimateTokens(skillIndexLine(skill));

const INDEX_INTRO = [
  "## Skills (instruções prontas da Biblioteca)",
  `Estas skills estão copiadas na sua pasta de trabalho (caminhos relativos a ela). Quando a tarefa combina com a descrição de uma, LEIA o SKILL.md dela com a ferramenta de ler arquivos ANTES de começar e siga o que ele manda; os arquivos de apoio ficam na mesma pasta. Não procure skills em outro lugar.`,
];

/** O bloco `## Skills` do prompt (vazio sem skills). Ordem estável: por id. */
export function skillsIndexBlock(skills: readonly Pick<AgentSkill, "id" | "name" | "description">[]): string {
  if (skills.length === 0) return "";
  const ordered = [...skills].sort((a, b) => a.id.localeCompare(b.id));
  return [...INDEX_INTRO, ...ordered.map(skillIndexLine)].join("\n");
}

/** Acrescenta o índice ao fim das instruções (o ponto de montagem do prompt do agente). */
export function withSkillsIndex(prompt: string, skills: readonly Pick<AgentSkill, "id" | "name" | "description">[]): string {
  const block = skillsIndexBlock(skills);
  return block ? `${prompt.trimEnd()}\n\n${block}` : prompt;
}

const MARKER = ".revision.json";

/**
 * Deixa `<pasta do agente>/skills/` com SÓ as skills liberadas (cópia). Se nada mudou desde a última
 * cópia (mesmas revisões), não mexe. Sem skills, apaga a pasta. Devolve se mudou algo.
 */
export async function materializeAgentSkills(agentDir: string, skills: readonly AgentSkill[]): Promise<boolean> {
  const target = path.join(agentDir, AGENT_SKILLS_DIR);
  const wanted = [...skills].sort((a, b) => a.id.localeCompare(b.id));
  const revisions = wanted.map((skill) => skill.revision);
  let current: string[] | undefined;
  try {
    current = JSON.parse(await readFile(path.join(target, MARKER), "utf8")) as string[];
  } catch {
    current = undefined;
  }
  if (wanted.length === 0) {
    if (current === undefined && !(await exists(target))) return false;
    await rm(target, { recursive: true, force: true });
    return true;
  }
  if (current && JSON.stringify(current) === JSON.stringify(revisions) && (await allThere(target, wanted))) return false;
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const skill of wanted) await cp(skill.sourceDir, path.join(target, skill.id), { recursive: true, dereference: false, verbatimSymlinks: true });
  await writeFile(path.join(target, MARKER), JSON.stringify(revisions), "utf8");
  return true;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function allThere(target: string, skills: readonly AgentSkill[]): Promise<boolean> {
  for (const skill of skills) if (!(await exists(path.join(target, skill.id, "SKILL.md")))) return false;
  return true;
}
