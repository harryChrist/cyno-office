import { BRAIN_FIXED_FILES } from "@cyno/shared";
import { shorten } from "../../util/text";

/** O que o Cérebro é: o lobby (global), a Sala do Maestro ou um quarto de time. */
export type BrainScope = { name: string; kind: "lobby" | "maestro" | "team" };

/** Nota curta já existente (para montar o índice e o briefing iniciais). */
export type ExistingNote = { file: string; title: string; excerpt: string };

const link = (file: string) => `[[${file.replace(/\.md$/i, "")}]]`;

/** Notas que parecem um briefing/visão geral (o `_briefing` inicial aponta para elas). */
const BRIEFING_LIKE = /^(briefing|visao-geral|sobre-|resumo|overview|readme)/i;

function regras(scope: BrainScope): string {
  const where = scope.kind === "lobby" ? "em todo o workspace" : "nesta sala";
  return [
    "---",
    "tipo: regras",
    "---",
    `# Regras — ${scope.name}`,
    "",
    `Regras que valem ${where}. O usuário edita; os agentes seguem. Curto: entra em toda tarefa.`,
    "",
    "- Nada sai (publicar, enviar, responder alguém) sem aprovação do usuário no \"Para você\".",
    "- Antes de supor, busque no Cérebro (`search_notes`) e leia a nota (`read_note`).",
    "- Decisões, preferências e aprendizados duráveis viram nota curta (`save_note`); o entregável não.",
    "",
  ].join("\n");
}

function indice(scope: BrainScope, notes: ExistingNote[]): string {
  const lines = notes.map((note) => `- ${link(note.file)} — ${shorten(note.excerpt || note.title, 100)}`);
  return [
    "---",
    "tipo: indice",
    "---",
    `# Índice — ${scope.name}`,
    "",
    "Mapa das notas deste Cérebro: uma linha por nota, `[[nota]] — do que se trata`. O histórico de tarefas fica em `historico/` (só por busca).",
    "",
    ...(lines.length > 0 ? lines : ["- (ainda sem notas)"]),
    "",
  ].join("\n");
}

function briefing(scope: BrainScope, notes: ExistingNote[]): string {
  const related = notes.filter((note) => BRIEFING_LIKE.test(note.file));
  const intro =
    scope.kind === "lobby"
      ? "O que é este workspace: objetivo, público, tom e o estado atual, em poucas linhas."
      : scope.kind === "maestro"
        ? "Sala do Maestro: coordena os pedidos do usuário e os times do workspace. Estado atual e prioridades, em poucas linhas."
        : "O que é esta sala/projeto: objetivo, público, entregas e o estado atual, em poucas linhas.";
  return [
    "---",
    "tipo: briefing",
    "---",
    `# Briefing — ${scope.name}`,
    "",
    intro,
    "Mantenha curto (entra em toda tarefa) e atualize quando o projeto mudar.",
    "",
    ...(related.length > 0 ? [`Veja: ${related.map((note) => link(note.file)).join(", ")}.`, ""] : []),
  ].join("\n");
}

/** Conteúdo inicial dos três fixos (`_regras`, `_indice`, `_briefing`). */
export function fixedTemplates(scope: BrainScope, notes: ExistingNote[]): Record<string, string> {
  return {
    [BRAIN_FIXED_FILES.regras]: regras(scope),
    [BRAIN_FIXED_FILES.indice]: indice(scope, notes),
    [BRAIN_FIXED_FILES.briefing]: briefing(scope, notes),
  };
}
