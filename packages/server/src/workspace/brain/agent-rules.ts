import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { BRAIN_RULE_LIMITS } from "@cyno/shared";
import { HttpError } from "../../platform/http/errors";
import { writeFileAtomic } from "../../store/atomic-write";

/** Arquivo das regras dentro da pasta do agente (`agents/<id>/regras.md`, ao lado do `diario.md`). */
export const AGENT_RULES_FILE = "regras.md";

export type AgentRulesState = { content: string; updatedAt: string | null };

/** Para comparar linhas: sem acento, caixa, marcador de lista e espaços repetidos. */
const normalize = (line: string) =>
  line
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Regras de cada agente (`agents/<id>/regras.md`): markdown simples, sem frontmatter, que SÓ aquele
 * agente recebe, em toda tarefa. O dono edita o texto inteiro; o Maestro, o próprio agente e a
 * retrospectiva acrescentam uma linha por vez. Escritas atômicas e em fila por agente.
 */
export class AgentRules {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly agentDir: (agentId: string) => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private file(agentId: string): string {
    return path.join(this.agentDir(agentId), AGENT_RULES_FILE);
  }

  private async load(agentId: string): Promise<AgentRulesState> {
    const file = this.file(agentId);
    try {
      const [content, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
      return { content: content.trim(), updatedAt: info.mtime.toISOString() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: "", updatedAt: null };
      throw error;
    }
  }

  /** Roda `task` depois das outras escritas do mesmo agente. */
  private serial<T>(agentId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.chains.set(agentId, next);
    void next.finally(() => {
      if (this.chains.get(agentId) === next) this.chains.delete(agentId);
    }).catch(() => undefined);
    return next;
  }

  /** O texto atual (arquivo ausente = vazio). */
  async read(agentId: string): Promise<AgentRulesState> {
    await this.chains.get(agentId)?.catch(() => undefined);
    return this.load(agentId);
  }

  /** Troca o texto inteiro (aparado). Vazio remove o arquivo. */
  async write(agentId: string, content: string): Promise<AgentRulesState> {
    const text = content.trim();
    if (text.length > BRAIN_RULE_LIMITS.rulesFile) throw new HttpError(400, `As regras do agente passam de ${BRAIN_RULE_LIMITS.rulesFile} caracteres (${text.length}): encurte.`);
    return this.serial(agentId, async () => {
      const file = this.file(agentId);
      if (text.length === 0) {
        await rm(file, { force: true });
        return { content: "", updatedAt: null };
      }
      await mkdir(path.dirname(file), { recursive: true });
      await writeFileAtomic(file, `${text}\n`);
      return { content: text, updatedAt: this.now().toISOString() };
    });
  }

  /** Acrescenta "- <regra>" numa linha só, sem repetir uma linha que já existe. */
  async append(agentId: string, text: string): Promise<{ added: boolean; content: string }> {
    const line = text.replace(/\s+/g, " ").replace(/^\s*[-*]\s+/, "").trim();
    if (line.length === 0) throw new Error("The rule is empty");
    if (line.length > BRAIN_RULE_LIMITS.agentRule) throw new Error(`The rule is too long (${line.length} characters; max ${BRAIN_RULE_LIMITS.agentRule}): keep it to one short sentence.`);
    return this.serial(agentId, async () => {
      const current = (await this.load(agentId)).content;
      const wanted = normalize(line);
      if (current.split(/\r?\n/).some((existing) => normalize(existing) === wanted)) return { added: false, content: current };
      const next = `${current ? `${current}\n` : ""}- ${line}`;
      if (next.length > BRAIN_RULE_LIMITS.rulesFile) {
        throw new Error(`The agent's rules would pass ${BRAIN_RULE_LIMITS.rulesFile} characters: the owner needs to shorten the existing rules before adding another.`);
      }
      const file = this.file(agentId);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFileAtomic(file, `${next}\n`);
      return { added: true, content: next };
    });
  }
}
