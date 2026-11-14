import {
  BRAIN_SOURCE_LABELS,
  deduceForYouType,
  forYouTextLength,
  forYouTypeName,
  LEGACY_FOR_YOU_TYPES,
  legacyForYouLimit as forYouLimit,
  MOCK_PROMPT_MARKERS,
  sliceForYouText,
  type BrainContext,
} from "@cyno/shared";
import { shorten } from "../util/text";
import type { ApprovalDecision, ApprovalDraft, RunInput } from "../engines/runner/types";

export type MockStep = {
  waitMs: number;
  progress: number;
  message: string;
  /** O que o agente "diz" ao começar o passo (entrada `text` no log). */
  narration: string;
  /** Ferramenta simulada do passo (veja mockToolCall), se houver. */
  tool?: MockToolName;
  /** A ferramenta falha na primeira tentativa (e o agente tenta de novo). */
  toolFails: boolean;
};

/** Um subagente simulado: o foco dele e a ferramenta que usa. */
export type MockSubagentPlan = { focus: string; tool: MockToolName };

export type MockPlan = {
  steps: MockStep[];
  /** Índice do passo feito por subagentes em paralelo (-1 = sem subagentes). */
  subagentsAt: number;
  subagents: MockSubagentPlan[];
  /** Índice do passo em que o agente pede aprovação (-1 = não pede). */
  approvalAt: number;
  /** Índice do passo em que a tarefa falha (-1 = não falha). */
  failAt: number;
};

export type MockPlanOptions = {
  minMs: number;
  maxMs: number;
  approvalRate: number;
  /** Chance (0..1) de dividir um passo entre 2–3 subagentes em paralelo (padrão 0). */
  subagentRate?: number;
  /** Número em [0, 1). */
  random: () => number;
};

export type MockToolName = "brain.search" | "web_search" | "read_file" | "write_draft" | "run_checks";

/** Ferramenta simulada de cada passo (os passos sem ferramenta são só narração e espera). */
const STEP_TOOLS: Record<string, MockToolName | undefined> = {
  "Lendo as notas do Cérebro": "brain.search",
  "Pesquisando referências": "web_search",
  "Escrevendo a primeira versão": "write_draft",
  "Conferindo com as notas do time": "read_file",
  "Ajustando os detalhes": "write_draft",
  "Testando as ideias": "run_checks",
  "Revisando o resultado": "read_file",
};

const NARRATIONS: Record<string, string> = {
  "Lendo as notas do Cérebro": "Vou começar pelas notas do Cérebro para entender o contexto.",
  "Entendendo o pedido": "Relendo o pedido para separar o que é obrigatório do que é desejável.",
  "Esboçando um plano": "Plano rápido:\n1. Juntar o que já existe\n2. Escrever uma primeira versão\n3. Revisar com as notas do time",
  "Pesquisando referências": "Vou procurar referências antes de escrever.",
  "Escrevendo a primeira versão": "Tenho material suficiente: escrevendo a primeira versão.",
  "Conferindo com as notas do time": "Conferindo se a versão bate com as decisões registradas pelo time.",
  "Ajustando os detalhes": "Ajustando tom, ordem e os detalhes que ficaram soltos.",
  "Testando as ideias": "Passando um pente-fino nas ideias antes de entregar.",
  "Revisando o resultado": "Última revisão antes de entregar.",
};

/** Frentes possíveis de um subagente (rótulo "Agente · foco"). */
const SUBAGENT_FOCI: MockSubagentPlan[] = [
  { focus: "pesquisa de referências", tool: "web_search" },
  { focus: "levantamento nas notas", tool: "brain.search" },
  { focus: "rascunho alternativo", tool: "write_draft" },
];

const MIDDLE_MESSAGES = [
  "Entendendo o pedido",
  "Esboçando um plano",
  "Pesquisando referências",
  "Escrevendo a primeira versão",
  "Conferindo com as notas do time",
  "Ajustando os detalhes",
  "Testando as ideias",
];

/** Roteiro de uma execução simulada: 4 a 6 passos dentro da duração sorteada. */
export function planMockRun(prompt: string, options: MockPlanOptions): MockPlan {
  const { minMs, maxMs, approvalRate, random } = options;
  const totalMs = Math.round(minMs + random() * (maxMs - minMs));
  const stepCount = Math.min(6, 4 + Math.floor(random() * 3));
  const wantsApproval = random() < approvalRate || prompt.includes(MOCK_PROMPT_MARKERS.approve);
  const shouldFail = prompt.includes(MOCK_PROMPT_MARKERS.fail);

  const pool = [...MIDDLE_MESSAGES];
  const messages = ["Lendo as notas do Cérebro"];
  while (messages.length < stepCount - 1) {
    const [picked] = pool.splice(Math.floor(random() * pool.length), 1);
    messages.push(picked ?? "Trabalhando");
  }
  messages.push("Revisando o resultado");

  const middle = Math.floor(stepCount / 2);
  // Os sorteios novos vêm depois dos antigos (a ordem dos primeiros não muda).
  const steps: MockStep[] = messages.map((message, index) => {
    const tool = STEP_TOOLS[message];
    return {
      waitMs: Math.round(totalMs / stepCount),
      progress: (index + 1) / stepCount,
      message,
      narration: NARRATIONS[message] ?? `${message}…`,
      ...(tool ? { tool } : {}),
      toolFails: tool !== undefined && random() > 0.85,
    };
  });
  const spawns = random() < (options.subagentRate ?? 0);
  const subagents = spawns ? SUBAGENT_FOCI.slice(0, 2 + Math.floor(random() * 2)) : [];
  return {
    steps,
    // O segundo passo (antes de qualquer aprovação ou falha, que ficam no meio).
    subagentsAt: spawns ? 1 : -1,
    subagents,
    approvalAt: wantsApproval ? middle : -1,
    failAt: shouldFail ? (wantsApproval ? middle + 1 : middle) : -1,
  };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function approvalQuestion({ agent, task }: RunInput): string {
  // A UI mostra a mensagem entre aspas duplas (“…”): o pedido vai entre aspas simples curvas (‘…’).
  return `${agent.name} quer sua aprovação para continuar: ‘${shorten(task.prompt, 80)}’`;
}

export function failureResult({ task }: RunInput): string {
  return `Falha simulada: o pedido "${shorten(task.prompt, 80)}" pediu para falhar (${MOCK_PROMPT_MARKERS.fail}).`;
}

function contextSummary(context: BrainContext): string[] {
  const notes = context.sources.reduce((sum, source) => sum + source.notes.length, 0);
  return [
    `Recebi ${plural(context.sources.length, "fonte", "fontes")} de contexto com ${plural(notes, "nota", "notas")} no total:`,
    ...context.sources.map(
      (source) =>
        `- ${BRAIN_SOURCE_LABELS[source.kind]}: ${source.name} (${plural(source.notes.length, "nota", "notas")})`,
    ),
  ];
}

/** Texto aprovado e resposta/nota do usuário, quando a tarefa passou pelo "Para você". */
function approvalSection(prompt: string, approval: ApprovalDecision | undefined): string[] {
  if (!approval?.approved) return [];
  if (approval.cancelled) {
    const who = approval.cancelled.by === "usuario" ? "descartado pelo usuário" : approval.cancelled.by === "maestro" ? "cancelado pelo Maestro" : "cancelado pelo agente";
    return ["", "### Sem aprovação", "", `O pedido no Para você foi ${who}${approval.cancelled.reason ? ` (${approval.cancelled.reason})` : ""}: segui sem ele.`];
  }
  const question = deduceForYouType(prompt) === "pergunta";
  const lines: string[] = [];
  if (approval.text && !question) lines.push("", "### Texto aprovado", "", approval.text);
  if (approval.response) lines.push("", question ? "### Sua resposta" : "### Nota para o time", "", approval.response);
  return lines;
}

/** Texto fake em markdown devolvido pelo MockRunner ao concluir (com o texto final aprovado). */
export function mockResult({ task, agent, team, room, context }: RunInput, approval?: ApprovalDecision): string {
  return [
    "## Resultado (simulado)",
    "",
    `**Pedido:** ${task.prompt}`,
    "",
    `${agent.name} (${agent.role}, time ${team.name}) trabalhou no quarto **${room.name}**.`,
    "",
    "### Contexto usado",
    ...contextSummary(context),
    "",
    "### Entrega",
    "- Rascunho da solução organizado em passos curtos.",
    "- Pontos de atenção levantados a partir das notas do Cérebro.",
    "- Próximo passo sugerido: revisar com o time e registrar a decisão.",
    ...approvalSection(task.prompt, approval),
    "",
    "> Gerado pelo MockRunner: nenhum modelo de IA foi chamado.",
  ].join("\n");
}

// ---------- Rascunho para o "Para você" ----------

/** Marca dos rascunhos do MockRunner (nenhum modelo de IA foi chamado). */
export const SIMULATED_DRAFT_MARK = "(rascunho simulado)";

/** Pedido sem os marcadores do mock ("[aprovar]", "[falhar]"). */
function cleanPrompt(prompt: string): string {
  return prompt.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
}

const NAME = String.raw`(\p{Lu}[\p{L}'-]*(?:\s+(?:d[aeo]s?\s+)?\p{Lu}[\p{L}'-]*)?)`;
const AFTER_PARA = new RegExp(String.raw`\bpara\s+(?:(?:o|a|os|as)\s+)?` + NAME, "u");
const AFTER_DE = new RegExp(String.raw`\bd[aeo]\s+` + NAME, "u");

/** "Convite para Ana Souza" -> "Ana Souza" (nome com inicial maiúscula depois de "para"). */
export function recipientOf(prompt: string): string | undefined {
  return AFTER_PARA.exec(prompt)?.[1];
}

/** "Comentário no post do Caio" -> "Caio" (nome depois de "de/do/da"). */
function authorOf(prompt: string): string | undefined {
  return AFTER_DE.exec(prompt)?.[1];
}

/**
 * Corta o texto para caber no limite, mantendo a marca de simulado no fim (contado como o
 * contador do "Para você" e a checagem do request_approval contam).
 */
function fitDraft(body: string, max?: number): string {
  const full = `${body} ${SIMULATED_DRAFT_MARK}`;
  if (max === undefined || forYouTextLength(full) <= max) return full;
  const room = max - forYouTextLength(SIMULATED_DRAFT_MARK) - 2;
  return `${sliceForYouText(body, room).trimEnd()}… ${SIMULATED_DRAFT_MARK}`;
}

/** Onde, no perfil, o texto vai sair (pelo pedido). */
function profileSection(prompt: string): string {
  const text = prompt.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/headline|titulo/.test(text)) return "Headline";
  if (/experiencia/.test(text)) return "Experiência";
  if (/projeto/.test(text)) return "Projeto";
  return "Sobre";
}

/**
 * Rascunho plausível (e claramente simulado) para o tipo deduzido do pedido: convite curto
 * citando o "para", mensagem, comentário, post, trecho de perfil, pergunta ou um rascunho genérico.
 * Sempre dentro do limite de caracteres do tipo (o dos tipos de antes). Se o workspace ainda não
 * tem o tipo, o "Para você" o cria na hora (como faria o Maestro).
 */
export function mockDraft({ task, agent, team }: RunInput): ApprovalDraft {
  const prompt = cleanPrompt(task.prompt);
  const type = deduceForYouType(task.prompt);
  const to = recipientOf(prompt);
  const hello = to ? `Oi, ${to.split(/\s+/)[0]}!` : "Oi!";
  const topic = shorten(prompt, 70);
  const meta: Record<string, string> = {
    pedido: shorten(prompt, 160),
    crivo: "aprovado (simulado)",
    simulado: "sim: MockRunner, nenhum modelo de IA foi chamado",
  };
  const why = `${agent.name} (time ${team.name}) preparou este ${forYouTypeName(LEGACY_FOR_YOU_TYPES, type).toLowerCase()} e precisa do seu ok antes de seguir.`;
  const base = { type, why, meta, to };

  switch (type) {
    case "convite":
      return { ...base, to: to ?? "Contato do pedido", text: fitDraft(`${hello} Vi seu trabalho com ${team.focus.toLowerCase()} e acho que temos interesses em comum. Vamos nos conectar?`, forYouLimit(type)?.max) };
    case "boas-vindas":
      return { ...base, text: fitDraft(`${hello} Que bom ter você por aqui, obrigado por aceitar o convite. Se quiser trocar ideias sobre ${team.focus.toLowerCase()}, é só chamar. Boa semana!`, forYouLimit(type)?.max) };
    case "mensagem":
      return {
        ...base,
        text: fitDraft(`${hello}\n\nTudo certo? Estou escrevendo por causa disto: ${topic}.\n\nAcho que uma conversa rápida ajudaria os dois lados. Você teria 15 minutos esta semana?\n\nAbraço,`, forYouLimit(type)?.max),
      };
    case "resposta":
      return { ...base, where: "Resposta na conversa", text: fitDraft(`${hello} Obrigado pelo retorno. Sobre "${topic}": faz sentido, e posso mandar mais detalhes ainda hoje.`, forYouLimit(type)?.max) };
    case "comentario": {
      const author = to ?? authorOf(prompt);
      return { ...base, where: author ? `Post de ${author}` : "Post do feed", text: fitDraft(`Ótimo ponto! Aqui a gente viu algo parecido: ${topic}. Obrigado por compartilhar.`) };
    }
    case "post":
      return {
        ...base,
        where: "Feed",
        text: fitDraft(`${topic}\n\nNas últimas semanas o time ${team.name} aprendeu três coisas:\n1. Começar pequeno.\n2. Medir antes de mudar.\n3. Contar o que deu errado também.\n\nE você, como faz?`),
      };
    case "perfil": {
      const where = profileSection(prompt);
      const limit = forYouLimit(type, where)?.max;
      const text =
        where === "Headline"
          ? `${agent.role} | ${team.name} | ${topic}`
          : `Trabalho com ${team.name.toLowerCase()} e gosto de transformar pedidos como "${topic}" em entregas simples e medidas.`;
      return { ...base, where, text: fitDraft(text, limit) };
    }
    case "pergunta":
      return {
        ...base,
        title: shorten(prompt, 140),
        text: `${agent.name} precisa da sua resposta antes de seguir:\n1. ${prompt}\n2. Tem prazo ou formato preferido?\n\n${SIMULATED_DRAFT_MARK}`,
      };
    default:
      return { ...base, text: fitDraft(`Proposta para "${topic}":\n- Fazer uma primeira versão curta.\n- Revisar com o time ${team.name}.\n- Entregar e registrar no Cérebro.`) };
  }
}

// ---------- Ferramentas simuladas ----------

/** Uma chamada de ferramenta simulada: o input e a saída (de sucesso ou de erro). */
export type MockToolCall = { input: Record<string, unknown>; output: string; error: string };

/** Notas do contexto (primeiro as do próprio quarto). */
function contextNotes(context: BrainContext) {
  return context.sources.flatMap((source) => source.notes.map((note) => ({ ...note, source: source.name })));
}

/** Input e saída plausíveis de cada ferramenta simulada, a partir do pedido e do contexto. */
export function mockToolCall(name: MockToolName, { task, context }: RunInput): MockToolCall {
  const query = shorten(cleanPrompt(task.prompt), 60);
  const notes = contextNotes(context);
  const error = "Tempo esgotado (simulado)";
  switch (name) {
    case "brain.search": {
      const found = notes.slice(0, 3).map((note) => `- ${note.title} (${note.source})`);
      return {
        input: { query, limit: 3 },
        output: found.length > 0 ? [`${plural(notes.length, "nota", "notas")} no contexto; as mais próximas:`, ...found].join("\n") : "Nenhuma nota encontrada.",
        error,
      };
    }
    case "web_search":
      return {
        input: { query },
        output: ["3 resultados (simulado):", `1. Guia prático: ${query}`, "2. Estudo de caso parecido", "3. Checklist de boas práticas"].join("\n"),
        error,
      };
    case "read_file": {
      const note = notes[0];
      return note
        ? { input: { path: note.file }, output: shorten(note.content, 200) || "(nota vazia)", error }
        : { input: { path: "rascunho.md" }, output: "# Rascunho (simulado)", error };
    }
    case "write_draft":
      return { input: { path: "rascunho.md", content: `Rascunho para: ${query}` }, output: "rascunho.md salvo (simulado)", error };
    case "run_checks":
      return { input: { target: "rascunho.md" }, output: "3 de 3 verificações ok (simulado)", error };
  }
}

/** Rótulo de um subagente: "Ana · pesquisa de referências". */
export function subagentLabel({ agent }: RunInput, plan: MockSubagentPlan): string {
  return `${agent.name} · ${plan.focus}`;
}

/** Objetivo de um subagente. */
export function subagentGoal({ task }: RunInput, plan: MockSubagentPlan): string {
  return `Cuidar só da ${plan.focus} para o pedido ‘${shorten(cleanPrompt(task.prompt), 120)}’ e devolver um resumo curto.`;
}
