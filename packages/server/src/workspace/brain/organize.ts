import {
  BRAIN_FIXED_FILES,
  BRAIN_HISTORY_DIR,
  BRAIN_ORGANIZE_LIMITS,
  BRAIN_RULE_LIMITS,
  brainOrganizeActionSchema,
  brainOrganizeFiles,
  forYouKind,
  GLOBAL_BRAIN_ID,
  isBrainRuleNote,
  type BrainOrganizeAction,
  type BrainOrganizePlan,
  type BrainOrganizeWeight,
  type ForYouItem,
  type ServerEvent,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { HttpError } from "../../platform/http/errors";
import { shorten } from "../../util/text";
import type { AgentRules } from "./agent-rules";
import type { Brain } from "./brain";
import { noteExcerpt, noteTags } from "./browse";
import { parseFrontmatter } from "./frontmatter";
import { isFixedFile, type StoredNote } from "./notes";

/** Janela em que o `propose_brain_cleanup` vale depois do clique do dono (igual à da retrospectiva). */
const ASK_WINDOW_MS = 20 * 60_000;

/** Um agente do workspace, como a proposta precisa dele (o `roomId` é o quarto do time dele). */
export type OrganizeAgent = { id: string; name: string; role: string; roomId: string | undefined };

export type BrainOrganizeDeps = {
  brain: Pick<
    Brain,
    "hasBrain" | "scope" | "readNotes" | "readHistory" | "archiveRootNote" | "makeRootNoteRule" | "rewriteRootNote" | "mergeRootNotes" | "replaceRulesWithHistory"
  >;
  agentRules: Pick<AgentRules, "read" | "append">;
  agents: () => OrganizeAgent[];
  forYou: {
    list(): ForYouItem[];
    openSpecial(input: { kind: "organizacao"; agentId: string; roomId: string; title: string; text: string; organize: BrainOrganizePlan }): ForYouItem;
    updateOrganize(id: string, plan: BrainOrganizePlan): Promise<ForYouItem>;
  };
  /** O Maestro de CLI: abre o pedido de organizar. `agentId` e `roomId` são os dele (o cartão do Cérebro global fica na Sala do Maestro). */
  maestro: { available(): boolean; agentId(): string | undefined; roomId(): string | undefined; ask(input: { title: string; message: string }): { id: string } };
  /** Eventos do workspace (o pedido ao Maestro acabou: `task:upserted`). */
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
};

type Asking = { taskId: string; at: number };

/** Uma nota da raiz como a proposta a enxerga. */
type RootNote = { file: string; title: string; tipo: string; date: string | null; chars: number; rule: boolean; tags: string[]; excerpt: string };

const EXCERPT_CHARS = 200;

/** Notas da raiz que não são fixas, já com o que a mensagem e a conta do antes/depois precisam. */
function rootNotes(notes: readonly StoredNote[]): RootNote[] {
  return notes
    .filter((note) => note.layer === "note")
    .map((note) => {
      const { frontmatter, body } = parseFrontmatter(note.content);
      const tags = noteTags(frontmatter);
      const tipo = frontmatter.tipo;
      const dateRaw = frontmatter.data ?? frontmatter.date;
      const date = typeof dateRaw === "string" && !Number.isNaN(Date.parse(dateRaw)) ? new Date(dateRaw).toISOString().slice(0, 10) : null;
      return {
        file: note.file,
        title: note.title,
        tipo: (Array.isArray(tipo) ? tipo[0] : tipo) ?? "-",
        date,
        chars: body.trim().length,
        rule: isBrainRuleNote({ layer: "note", tags, title: note.title }),
        tags,
        excerpt: noteExcerpt(body, EXCERPT_CHARS),
      };
    });
}

/** O peso do Cérebro: notas de referência (e os caracteres delas) e regras (as notas de regra mais o `_regras.md`). */
function weightOf(notes: ReadonlyMap<string, { rule: boolean; chars: number }>): BrainOrganizeWeight {
  let reference = 0;
  let chars = 0;
  let rules = 1;
  for (const note of notes.values()) {
    if (note.rule) rules += 1;
    else {
      reference += 1;
      chars += note.chars;
    }
  }
  return { notes: reference, chars, rules };
}

const noteIndex = (notes: readonly RootNote[]) => new Map(notes.map((note) => [note.file, { rule: note.rule, chars: note.chars }]));

/**
 * "Organizar o Cérebro": o dono clica, o Maestro lê o Cérebro e devolve UMA proposta (`propose_brain_cleanup`) que vira um
 * cartão `kind: "organizacao"` no Para você. Nada muda sem o clique de aprovação; ao aprovar, só as ações que o dono deixou
 * marcadas são aplicadas, cada uma sozinha (uma que falha não derruba as outras). NADA é apagado: o que sai da raiz vai
 * para `historico/`, que a busca continua achando.
 */
export class BrainOrganizeService {
  /** Um pedido aberto por Cérebro (vários Cérebros podem ser organizados ao mesmo tempo). */
  private readonly asking = new Map<string, Asking>();

  constructor(private readonly deps: BrainOrganizeDeps) {}

  /** O Maestro está organizando este Cérebro agora? (a web desliga o botão) */
  isAsking(brainId: string): boolean {
    return this.asking.has(brainId);
  }

  // ---------- O pedido ao Maestro ----------

  async ask(brainId: string): Promise<{ taskId: string }> {
    const scope = this.deps.brain.scope(brainId);
    if (!scope) throw new HttpError(404, `Cérebro "${brainId}" não encontrado`);
    if (!this.deps.maestro.available()) throw new HttpError(409, "O Maestro deste workspace não roda numa CLI: ligue-o em Configurações para ele organizar o Cérebro.");
    if (this.asking.has(brainId)) throw new HttpError(409, "O Maestro já está organizando este Cérebro: espere ele terminar.");
    if (this.deps.forYou.list().some((item) => forYouKind(item) === "organizacao" && item.status === "pendente" && item.organize?.brainId === brainId)) {
      throw new HttpError(409, "Já existe uma proposta de organização deste Cérebro esperando você em Aprovações.");
    }
    const [notes, history] = await Promise.all([this.deps.brain.readNotes(brainId), this.deps.brain.readHistory(brainId)]);
    const roots = rootNotes(notes);
    if (roots.length === 0) throw new HttpError(409, "Este Cérebro ainda não tem notas para organizar.");
    const rules = notes.find((note) => note.file === BRAIN_FIXED_FILES.regras);
    const agents = brainId === GLOBAL_BRAIN_ID ? undefined : await this.agentsBlock(brainId);
    const message = this.message({ brainId, name: scope.name, roots, rulesBody: rules ? parseFrontmatter(rules.content).body.trim() : "", historyCount: history.length, agents });
    const task = this.deps.maestro.ask({ title: `Organizar o Cérebro: ${scope.name}`, message });
    const asking: Asking = { taskId: task.id, at: Date.now() };
    this.asking.set(brainId, asking);
    const done = (): void => {
      unsubscribe();
      clearTimeout(timer);
      if (this.asking.get(brainId) === asking) this.asking.delete(brainId);
    };
    const unsubscribe = this.deps.subscribe((event) => {
      if (event.type === "task:upserted" && event.task.id === task.id && (event.task.status === "done" || event.task.status === "failed")) done();
    });
    const timer = setTimeout(done, ASK_WINDOW_MS);
    timer.unref();
    return { taskId: task.id };
  }

  private async agentsBlock(brainId: string): Promise<string[]> {
    const agents = this.deps.agents().filter((agent) => agent.roomId === brainId);
    return Promise.all(
      agents.map(async (agent) => {
        const rules = (await this.deps.agentRules.read(agent.id)).content.trim();
        return `- ${agent.id} | ${agent.name} | ${agent.role}${rules ? `\n  rules: ${shorten(rules.replace(/\s+/g, " "), 500)}` : "\n  rules: (none)"}`;
      }),
    );
  }

  /** A mensagem ao Maestro (inglês, compacta): o trabalho, as regras dele e o inventário do Cérebro. */
  private message(input: { brainId: string; name: string; roots: readonly RootNote[]; rulesBody: string; historyCount: number; agents: string[] | undefined }): string {
    const { brainId } = input;
    const lines = input.roots.map((note) =>
      [
        `- path: ${brainId}/${note.file} | title: ${note.title} | tipo: ${note.tipo} | date: ${note.date ?? "-"} | ${note.chars} chars | rule: ${note.rule ? "yes" : "no"} | tags: ${note.tags.join(", ") || "-"}`,
        `  excerpt: ${note.excerpt || "(empty)"}`,
      ].join("\n"),
    );
    return [
      `The owner asked you to organize the Brain "${input.name}" (id \`${brainId}\`). Read it and send ONE proposal; the owner reviews it in Aprovações and nothing changes until they approve. Nothing is ever deleted: notes that leave the root go to the \`historico/\` folder (still found by \`search_notes\`).`,
      "",
      "How to work:",
      "(a) Read with `read_note` every note you are unsure about and every note you intend to merge or rewrite. Never guess from the title or the excerpt.",
      "(b) Classify. What the team must always FOLLOW becomes a rule (`make_rule`; when the note is long, pass a short `content`: one to three imperative lines). How things work, decisions with their reason and user preferences stay as reference: `merge` when several notes cover the same subject, `rewrite` when a note is bloated. Reports of a finished step, checks, results, alerts and \"state of the moment\" notes that no longer guide future work go to the history (`archive`). A rule that only concerns one agent becomes `agent_rule`. Use `set_rules` only if the `_regras` file itself needs consolidating.",
      "(c) Keep what is still useful: do not archive knowledge just because it is old. Never invent facts. Write in Brazilian Portuguese.",
      "(d) Nothing is deleted and nothing changes until the owner approves.",
      `(e) Call \`propose_brain_cleanup({ brain: "${brainId}", summary, actions })\` exactly ONCE with all the actions and a one or two sentence \`summary\`, then call \`complete_request\` with a one-line result. If nothing needs changing, call \`complete_request\` saying so, without proposing. A note can appear in only one action. Use the paths below.`,
      "",
      `## Current \`_regras\` of this Brain (${input.rulesBody.length} chars)`,
      input.rulesBody ? shorten(input.rulesBody, BRAIN_RULE_LIMITS.rulesFile) : "(empty)",
      "",
      `## Notes in the root (${input.roots.length}); ${input.historyCount} more file(s) already in historico/ (not listed)`,
      ...lines,
      ...(input.agents ? ["", `## Agents of this room (id | name | role) and their own rules`, ...(input.agents.length > 0 ? input.agents : ["(no agents)"])] : []),
    ].join("\n");
  }

  // ---------- A proposta ----------

  /** O arquivo da raiz que o Maestro quis dizer (`<cérebro>/<arquivo>`, com ou sem `.md`) ou o erro, em inglês, para ele corrigir. */
  private resolveFile(brainId: string, raw: string, root: ReadonlyMap<string, RootNote>): { file: string } | { error: string } {
    let name = raw.trim().replace(/^\[\[|\]\]$/g, "");
    if (name.startsWith(`${BRAIN_HISTORY_DIR}/`)) return { error: `"${raw}" is in historico/: only notes in the root of the Brain can be organized.` };
    if (name.startsWith(`${brainId}/`)) name = name.slice(brainId.length + 1);
    if (name.includes("/")) return { error: `"${raw}" does not belong to this Brain: use paths like "${brainId}/<file>.md" (or only "<file>.md").` };
    if (!/\.md$/i.test(name)) name = `${name}.md`;
    if (isFixedFile(name)) return { error: `"${raw}" is a fixed file (_regras, _briefing, _indice): it cannot be archived, merged or rewritten here${name === BRAIN_FIXED_FILES.regras ? "; to consolidate the rules use set_rules" : ""}.` };
    if (!root.has(name)) {
      const near = [...root.keys()].filter((file) => file.toLowerCase() === name.toLowerCase());
      return { error: `Note "${raw}" does not exist in the root of this Brain${near.length > 0 ? ` (did you mean "${brainId}/${near[0]}"?)` : ""}.` };
    }
    return { file: name };
  }

  /** `propose_brain_cleanup` (só o Maestro, só enquanto o pedido do dono está aberto): valida tudo e abre o cartão da proposta. */
  async propose(input: { brain: string; summary: string; actions: readonly BrainOrganizeAction[] }): Promise<string> {
    const brainId = input.brain.trim();
    if (!this.asking.has(brainId)) {
      throw new Error(`propose_brain_cleanup only works while the owner's request to organize the Brain "${brainId}" is open (the owner asks for it with the "Organizar" button on that Brain).`);
    }
    const scope = this.deps.brain.scope(brainId);
    if (!scope) throw new Error(`The Brain "${brainId}" no longer exists.`);
    const summary = input.summary.replace(/\s+/g, " ").trim();
    if (summary.length === 0) throw new Error("`summary` is required: one or two sentences saying what you saw and what you propose.");
    if (summary.length > BRAIN_ORGANIZE_LIMITS.summary) throw new Error(`\`summary\` has ${summary.length} characters (max ${BRAIN_ORGANIZE_LIMITS.summary}): shorten it.`);
    if (input.actions.length === 0) throw new Error("`actions` is empty: if nothing needs changing, call complete_request saying so instead of proposing.");
    if (input.actions.length > BRAIN_ORGANIZE_LIMITS.actions) throw new Error(`Too many actions (${input.actions.length}; max ${BRAIN_ORGANIZE_LIMITS.actions}): keep the most valuable ones.`);

    const roots = rootNotes(await this.deps.brain.readNotes(brainId));
    const root = new Map(roots.map((note) => [note.file, note]));
    const agents = this.deps.agents().filter((agent) => brainId === GLOBAL_BRAIN_ID || agent.roomId === brainId);
    const seen = new Map<string, number>();
    let rulesActions = 0;
    const actions: BrainOrganizeAction[] = [];
    const errors: string[] = [];
    input.actions.forEach((raw, index) => {
      const label = `Action ${index + 1} (${raw.type})`;
      const fail = (message: string) => errors.push(`${label}: ${message}`);
      const resolveAll = (files: readonly string[]): string[] => {
        const out: string[] = [];
        for (const file of files) {
          const found = this.resolveFile(brainId, file, root);
          if ("error" in found) fail(found.error);
          else out.push(found.file);
        }
        return out;
      };
      let action: BrainOrganizeAction = raw;
      if (raw.type === "merge") action = { ...raw, files: resolveAll(raw.files) };
      else if (raw.type === "make_rule" || raw.type === "archive" || raw.type === "rewrite") action = { ...raw, file: resolveAll([raw.file])[0] ?? raw.file };
      else if (raw.type === "agent_rule") {
        const wanted = raw.agentId.trim().toLowerCase();
        const agent = agents.find((candidate) => candidate.id.toLowerCase() === wanted) ?? agents.find((candidate) => candidate.name.toLowerCase() === wanted);
        if (!agent) fail(`agent "${raw.agentId}" is not an agent of this ${brainId === GLOBAL_BRAIN_ID ? "workspace" : "room"}. Known: ${agents.map((candidate) => `${candidate.id} (${candidate.name})`).join(", ") || "(none)"}.`);
        else action = { ...raw, agentId: agent.id, agentName: agent.name };
      } else rulesActions += 1;
      if (action.type === "set_rules" && rulesActions > 1) fail("set_rules can appear only once.");
      const files = brainOrganizeFiles(action);
      for (const file of files) {
        const previous = seen.get(file);
        if (previous !== undefined) fail(`"${brainId}/${file}" already appears in action ${previous + 1}: a note can be in only one action.`);
        else seen.set(file, index);
      }
      if (new Set(files).size !== files.length) fail("the same note is listed twice in `paths`.");
      if (action.type === "make_rule") {
        const note = root.get(action.file);
        if (note && action.content === undefined) {
          if (note.rule) fail(`"${brainId}/${action.file}" is already a rule: drop this action, or pass \`content\` to replace it with a shorter text.`);
          else if (note.chars > BRAIN_RULE_LIMITS.ruleNote) fail(`"${brainId}/${action.file}" has ${note.chars} characters: too long for a rule (max ${BRAIN_RULE_LIMITS.ruleNote}). Pass \`content\` with the rule in one to three short lines.`);
        }
      }
      const parsed = brainOrganizeActionSchema.safeParse(action);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) fail(`\`${issue.path.join(".") || "action"}\`: ${issue.message}`);
        return;
      }
      // Os campos só de exibição do cartão: o título de cada nota e o nome do agente.
      const titleOf = (file: string) => root.get(file)?.title ?? file;
      const parsedAction = parsed.data;
      if (parsedAction.type === "merge") actions.push({ ...parsedAction, titles: parsedAction.files.map(titleOf) });
      else if (parsedAction.type === "make_rule" || parsedAction.type === "archive" || parsedAction.type === "rewrite") actions.push({ ...parsedAction, title: titleOf(parsedAction.file) });
      else actions.push(parsedAction);
    });
    if (errors.length > 0) throw new Error(`The proposal was not opened. Fix and call propose_brain_cleanup again:\n${errors.slice(0, 20).join("\n")}${errors.length > 20 ? `\n(+${errors.length - 20} more)` : ""}`);

    const before = weightOf(noteIndex(roots));
    const after = weightOf(this.simulate(roots, actions));
    const plan: BrainOrganizePlan = { brainId, brainName: scope.name, summary, actions, before, after };
    const maestroId = this.deps.maestro.agentId();
    const roomId = brainId === GLOBAL_BRAIN_ID ? this.deps.maestro.roomId() : brainId;
    if (!maestroId || !roomId) throw new Error("This workspace has no Maestro room to hold the proposal.");
    const item = this.deps.forYou.openSpecial({ kind: "organizacao", agentId: maestroId, roomId, title: `Organizar o Cérebro de ${scope.name}`, text: summary, organize: plan });
    // Um cartão por pedido: a janela fecha (o Maestro não manda uma segunda proposta).
    this.asking.delete(brainId);
    this.deps.log.info({ itemId: item.id, brainId, actions: actions.length }, "proposta de organização do Cérebro aberta");
    return `Proposal card ${item.id} opened for the owner (${actions.length} actions).`;
  }

  /** Como a raiz fica se TODAS as ações forem aplicadas (só para o "depois" do cartão). */
  private simulate(roots: readonly RootNote[], actions: readonly BrainOrganizeAction[]): Map<string, { rule: boolean; chars: number }> {
    const notes = noteIndex(roots);
    const titles = new Map(roots.map((note) => [note.file, note.title]));
    let merged = 0;
    for (const action of actions) {
      if (action.type === "archive") notes.delete(action.file);
      else if (action.type === "make_rule") {
        const current = notes.get(action.file);
        if (current) notes.set(action.file, { rule: true, chars: action.content ? action.content.length + (titles.get(action.file)?.length ?? 0) + 4 : current.chars });
      } else if (action.type === "rewrite") {
        const current = notes.get(action.file);
        if (current) notes.set(action.file, { rule: current.rule, chars: action.content.length + (titles.get(action.file)?.length ?? 0) + 4 });
      } else if (action.type === "merge") {
        for (const file of action.files) notes.delete(file);
        merged += 1;
        notes.set(`(merged-${merged})`, { rule: false, chars: action.content.length + action.title.length + 4 });
      }
    }
    return notes;
  }

  // ---------- A decisão do dono ----------

  /** Aprovar aplica as ações que o dono deixou marcadas (cada uma sozinha); recusar não faz nada. Só o clique do dono chega aqui (via `ForYouService.decide`). */
  async decide(item: ForYouItem, decision: { status: "aprovado" | "rejeitado"; organize?: { skip?: number[] } }): Promise<void> {
    const plan = item.organize;
    if (!plan) throw new HttpError(409, `O item ${item.id} não tem proposta de organização`);
    if (decision.status === "rejeitado") return;
    if (!this.deps.brain.hasBrain(plan.brainId)) throw new HttpError(409, `O Cérebro "${plan.brainName}" não existe mais: recuse ou cancele esta proposta.`);
    const skip = new Set(decision.organize?.skip ?? []);
    const outOfRange = [...skip].filter((index) => index >= plan.actions.length);
    if (outOfRange.length > 0) throw new HttpError(400, `Ação inexistente na proposta: ${outOfRange.join(", ")}`);
    const failed: { index: number; error: string }[] = [];
    for (const [index, action] of plan.actions.entries()) {
      if (skip.has(index)) continue;
      try {
        await this.apply(plan.brainId, action);
      } catch (error) {
        failed.push({ index, error: this.errorText(error) });
        this.deps.log.warn({ itemId: item.id, index, type: action.type, err: error }, "organizar o Cérebro: ação não aplicada");
      }
    }
    const skipped = [...skip].sort((a, b) => a - b);
    const { skipped: _s, failed: _f, ...rest } = plan;
    await this.deps.forYou.updateOrganize(item.id, { ...rest, ...(skipped.length > 0 ? { skipped } : {}), ...(failed.length > 0 ? { failed } : {}) });
    this.deps.log.info({ itemId: item.id, brainId: plan.brainId, applied: plan.actions.length - skip.size - failed.length, skipped: skip.size, failed: failed.length }, "organização do Cérebro aprovada");
  }

  private errorText(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return shorten(message.replace(/\s+/g, " "), 300);
  }

  private async apply(brainId: string, action: BrainOrganizeAction): Promise<void> {
    const { brain } = this.deps;
    switch (action.type) {
      case "archive":
        await brain.archiveRootNote(brainId, action.file);
        return;
      case "make_rule":
        await brain.makeRootNoteRule(brainId, action.file, action.content);
        return;
      case "rewrite":
        await brain.rewriteRootNote(brainId, action.file, action.content);
        return;
      case "merge":
        await brain.mergeRootNotes(brainId, { files: action.files, title: action.title, content: action.content });
        return;
      case "set_rules":
        await brain.replaceRulesWithHistory(brainId, action.content);
        return;
      case "agent_rule": {
        if (!this.deps.agents().some((agent) => agent.id === action.agentId)) throw new Error("O agente não existe mais");
        try {
          // "Já estava lá" conta como aplicada.
          await this.deps.agentRules.append(action.agentId, action.text);
        } catch (error) {
          if (error instanceof Error && /would pass/.test(error.message)) throw new Error("As regras do agente já estão cheias: o limite seria passado", { cause: error });
          throw error;
        }
        return;
      }
    }
  }
}
