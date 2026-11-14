import type { RoutineProposalPayload } from "./routines";

/**
 * "Para você": tudo que precisa do usuário (aprovar, editar, responder). Cada item nasce quando
 * um agente pede aprovação numa tarefa (`taskId`) e traz o rascunho do texto que vai sair.
 */

/**
 * Id do tipo do item (slug): os tipos são de cada workspace (veja for-you-types.ts). "pergunta" e
 * "outro" existem em todos.
 */
export type ForYouType = string;

/**
 * pendente = esperando você; aprovado/rejeitado/respondido são decisões (Reabrir volta para
 * pendente); cancelado = retirado sem decisão (pelo Maestro, pelo agente que pediu ou descartado
 * por você), com o motivo em `cancelReason`. Cancelado não reabre.
 */
export const FOR_YOU_STATUSES = ["pendente", "aprovado", "rejeitado", "respondido", "cancelado"] as const;
export type ForYouStatus = (typeof FOR_YOU_STATUSES)[number];
/** O que o usuário decide pela rota de decisão (cancelar tem rota própria). */
export const FOR_YOU_DECISION_STATUSES = ["pendente", "aprovado", "rejeitado", "respondido"] as const;
export type ForYouDecisionStatus = (typeof FOR_YOU_DECISION_STATUSES)[number];

export const FOR_YOU_STATUS_LABELS: Record<ForYouStatus, string> = {
  pendente: "Pendente",
  aprovado: "Aprovado",
  rejeitado: "Recusado",
  respondido: "Respondido",
  cancelado: "Cancelado",
};

/** Quem mexeu no item depois de criado: o Maestro, o agente que pediu ou você. */
export const FOR_YOU_ACTORS = ["maestro", "agente", "usuario", "servidor"] as const;
export type ForYouActor = (typeof FOR_YOU_ACTORS)[number];

/** Entrada do histórico do item: alterado (perguntas/texto trocados) ou cancelado, com o motivo. */
export type ForYouHistoryEntry = { at: string; by: ForYouActor; action: "alterado" | "cancelado"; reason?: string };

/**
 * O que o item pede: aprovacao (padrão, ausente nos itens antigos) = aprovar/editar/responder um
 * texto; plano = aprovar o plano de um pedido (aprovar / ajustar / cancelar); questionario = várias
 * perguntas que o usuário responde no tempo dele (rascunho salvo no server, sem acordar ninguém) e
 * manda de uma vez; rotina = proposta ou pergunta sobre uma rotina; sprint = o resumo de entrega de
 * uma sprint que fechou (aprovar a entrega, ou devolver com o motivo); regra = uma regra proposta pela
 * retrospectiva da Gestão (aprovar grava uma nota no Cérebro; recusar a esconde por 8 semanas).
 */
/** Motivo da recusa em uma palavra (escolha rápida no diálogo; opcional): a retrospectiva da Gestão agrupa por ele. */
export const REJECTION_CATEGORIES = ["texto", "tom", "fato_errado", "formato", "fora_do_pedido", "outro"] as const;
export type RejectionCategory = (typeof REJECTION_CATEGORIES)[number];
export const REJECTION_CATEGORY_LABELS: Record<RejectionCategory, string> = { texto: "Texto", tom: "Tom", fato_errado: "Fato errado", formato: "Formato", fora_do_pedido: "Fora do pedido", outro: "Outro" };

export const FOR_YOU_KINDS = ["aprovacao", "plano", "questionario", "rotina", "sprint", "regra"] as const;
export type ForYouKind = (typeof FOR_YOU_KINDS)[number];

/**
 * Onde a regra aprovada vale: `agentId` (com o `roomId` do quarto dele) = só aquele agente, no Cérebro do quarto; `global` = todo o
 * workspace, no Cérebro global; `roomId` sozinho = todos os agentes daquele quarto. Os campos são exclusivos na prática: o dono troca antes de aprovar.
 */
export type ForYouRuleScope = { roomId?: string; agentId?: string; global?: true };

/** Um trecho do que o dono mexeu ou recusou (a evidência da regra): o rascunho do agente e, se houve, o que ficou. */
export type ForYouRuleExcerpt = { itemId: string; before: string; after?: string };

/** kind "regra": a regra proposta (o texto e o escopo o dono pode mudar antes de aprovar) e a evidência de onde ela veio. */
export type ForYouRule = {
  text: string;
  scope: ForYouRuleScope;
  /** `count` itens em `days` dias diferentes, na retrospectiva; `line` é a frase pronta ("cortou emojis em 6 de 7 comentários"). */
  evidence: { itemIds: string[]; count: number; days: number; total?: number; line?: string; excerpts?: ForYouRuleExcerpt[] };
  /** molde = texto montado por código (não gasta nada); maestro = redigido pelo Maestro com o botão da retrospectiva. */
  source: "molde" | "maestro";
  /** A retrospectiva de onde veio ("2026-W46"). */
  retro: string;
  /** O grupo de padrão (hash estável): recusar guarda este id para a regra não voltar. */
  groupId?: string;
};

/** Pergunta de um questionário (opções e padrão são sugestões; a resposta é texto livre). */
export type ForYouQuestion = { id: string; text: string; options?: string[]; default?: string };
/** Resposta (rascunho até o envio). `skipped` = "decide você". */
export type ForYouAnswer = { text?: string; skipped?: boolean };

export const FOR_YOU_QUESTION_LIMITS = { questions: 15, text: 400, options: 8, option: 120, answer: 2000 } as const;

export type ForYouItem = {
  /** "A-0001", sequencial por workspace. */
  id: string;
  /** Tarefa que pediu a aprovação (a subtarefa do time, quando veio do Maestro). */
  taskId?: string;
  agentId: string;
  roomId: string;
  type: ForYouType;
  status: ForYouStatus;
  /** Título do card quando não há "onde" nem "para" (ex.: a pergunta). */
  title?: string;
  /** Onde o texto vai sair (ex.: "Sobre", "Headline", "Post da Ana"). */
  where?: string;
  /** Para quem (ex.: o nome no convite). */
  to?: string;
  /** Por que o agente está pedindo isso. */
  why?: string;
  /** Metadados extras (ex.: crivo, pedido). */
  meta: Record<string, string>;
  /** Texto que vai sair (com a edição do usuário, se houver). */
  text: string;
  /** Rascunho do agente, para "Desfazer edição" e para saber se foi editado. */
  originalText: string;
  editedByUser: boolean;
  /** Resposta (pergunta) ou nota para o time (demais tipos). */
  response?: string;
  /** Ausente = "aprovacao". */
  kind?: ForYouKind;
  /** Projeto (== id do pedido do Maestro) a que o item pertence: agrupa o "Para você". */
  projectId?: string;
  /** kind "sprint": a sprint (id em `Project.sprints`) cujo resumo de entrega o item pede para aprovar. */
  sprintId?: string;
  /** Tarefa do projeto (`ref`) que o item segura (kind "plano": a que o plano segura). */
  taskRef?: string;
  /** Recusa: o motivo dado pelo usuário e uma categoria opcional (`REJECTION_CATEGORIES`; dados antigos podem trazer outro texto). */
  rejection?: { reason: string; category?: string };
  /** Quem decidiu: o usuário (padrão) ou o Modo Automático. */
  decidedBy?: "usuario" | "automatico";
  /** Lote de aprovações abertas juntas pela mesma tarefa. */
  groupId?: string;
  /** Aprovado em lote pela Gestão (`POST /for-you/batch`): não conta como aprovação individual para liberar o lote de convite e post. */
  viaBatch?: true;
  /** kind "rotina": a rotina e o conteúdo do cartão (proposta para criar ou pergunta de baixar a meta). */
  routineId?: string;
  routine?: RoutineProposalPayload;
  /** kind "regra": a regra e a evidência dela. */
  rule?: ForYouRule;
  /** Mídia da biblioteca anexada ao pedido (ids "M-0001"). */
  mediaIds?: string[];
  /** Contexto do pedido: o que o rascunho analisou (post original, perfil, referências). */
  sources?: ForYouSource[];
  /** Questionário: as perguntas e as respostas (rascunho até o envio). */
  questions?: ForYouQuestion[];
  answers?: Record<string, ForYouAnswer>;
  createdAt: string;
  /** Quando foi decidido ou cancelado. */
  decidedAt?: string;
  /** Histórico de alterações e do cancelamento (o card mostra o selo "Atualizado"). */
  history?: ForYouHistoryEntry[];
  /** Cancelado: quem cancelou e o motivo. */
  cancelledBy?: ForYouActor;
  cancelReason?: string;
};

/** De onde veio o que o agente analisou (o contexto do cartão): post, perfil, artigo… */
export const FOR_YOU_SOURCE_KINDS = ["post", "profile", "article", "message", "page", "other"] as const;
export type ForYouSourceKind = (typeof FOR_YOU_SOURCE_KINDS)[number];
export const FOR_YOU_SOURCE_LIMITS = { sources: 5, url: 2000, title: 200, author: 200, authorDetail: 300, postedAt: 60, content: 6000, summary: 600, facts: 8, factLabel: 60, factValue: 300, mediaIds: 6 } as const;

export type ForYouSource = {
  kind: ForYouSourceKind;
  url?: string;
  /** Ex.: "Post de Mayk Brito". */
  title?: string;
  author?: string;
  /** Headline, seguidores… */
  authorDetail?: string;
  /** Como o site mostra ("hoje", "08/11") ou ISO. */
  postedAt?: string;
  /** Texto inteiro do que foi analisado (até 6000 caracteres). */
  content?: string;
  /** 1 a 3 frases (até 600 caracteres). */
  summary?: string;
  facts?: { label: string; value: string }[];
  /** Itens da biblioteca de mídia (ex.: captura do original). */
  mediaIds?: string[];
};

const cut = (value: string | undefined, max: number): string | undefined => {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

/**
 * Arruma as fontes que o agente mandou: corta o que passa do limite (com "…") em vez de recusar,
 * tira campos vazios e fontes sem nada útil, e respeita o máximo de fontes, fatos e mídias.
 */
export function normalizeSources(input: readonly ForYouSource[] | undefined): ForYouSource[] | undefined {
  const L = FOR_YOU_SOURCE_LIMITS;
  const out: ForYouSource[] = [];
  for (const raw of input ?? []) {
    if (out.length >= L.sources) break;
    const facts = (raw.facts ?? [])
      .map((fact) => ({ label: cut(fact.label, L.factLabel) ?? "", value: cut(fact.value, L.factValue) ?? "" }))
      .filter((fact) => fact.label && fact.value)
      .slice(0, L.facts);
    const mediaIds = [...new Set((raw.mediaIds ?? []).map((id) => id.trim()).filter(Boolean))].slice(0, L.mediaIds);
    const fields = {
      url: cut(raw.url, L.url),
      title: cut(raw.title, L.title),
      author: cut(raw.author, L.author),
      authorDetail: cut(raw.authorDetail, L.authorDetail),
      postedAt: cut(raw.postedAt, L.postedAt),
      content: cut(raw.content, L.content),
      summary: cut(raw.summary, L.summary),
    };
    const source: ForYouSource = { kind: raw.kind };
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) (source as Record<string, unknown>)[key] = value;
    if (facts.length > 0) source.facts = facts;
    if (mediaIds.length > 0) source.mediaIds = mediaIds;
    if (Object.keys(source).length > 1) out.push(source);
  }
  return out.length > 0 ? out : undefined;
}

export function forYouKind(item: Pick<ForYouItem, "kind">): ForYouKind {
  return item.kind ?? "aprovacao";
}

/**
 * Respostas de um questionário em texto (o que vai para o Maestro ou o agente): cada pergunta com a
 * resposta, "decida você" (pulada ou em branco; com o padrão sugerido, se houver).
 */
export function formatAnswers(questions: readonly ForYouQuestion[], answers: Readonly<Record<string, ForYouAnswer>> = {}): string {
  return questions
    .map((question, index) => {
      const answer = answers[question.id];
      const text = answer?.skipped ? "" : (answer?.text ?? "").trim();
      const reply = text || (question.default ? `decida você (sugestão: ${question.default})` : "decida você");
      return `${index + 1}. ${question.text}\n   → ${reply}`;
    })
    .join("\n");
}

/** Quantas perguntas já têm resposta (ou foram puladas). */
export function answeredCount(item: Pick<ForYouItem, "questions" | "answers">): number {
  return (item.questions ?? []).filter((question) => {
    const answer = item.answers?.[question.id];
    return answer?.skipped === true || (answer?.text ?? "").trim().length > 0;
  }).length;
}

const plain = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/**
 * Palavras que dão o tipo, na ordem de prioridade (a mais específica primeiro: "mensagem de
 * boas-vindas" é boas-vindas; "resposta ao comentário" é resposta).
 */
const TYPE_WORDS: readonly [ForYouType, RegExp][] = [
  ["boas-vindas", /\bboas[\s-]vindas\b/],
  ["convite", /\bconvites?\b/],
  ["resposta", /\brespostas?\b/],
  ["comentario", /\bcomentarios?\b/],
  ["mensagem", /\bmensage(m|ns)\b/],
  ["perfil", /\bperf(il|is)\b/],
  ["post", /\bposts?\b/],
];

const QUESTION_START = /^(qual|quais|quem|quando|onde|como|quanto|quantos|quantas|por que|porque|o que|devo|posso|podemos|vale a pena|sera que|e se)\b/;
const DOUBT_WORDS = /\b(duvida|duvidas|pergunta|perguntas)\b/;

/** Os tipos do workspace que valem na dedução (nome e id, sem os embutidos). */
type DeducibleType = { id: string; name: string };

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Tipo do item a partir do pedido: primeiro um tipo novo do workspace citado pelo nome (o nome mais
 * longo vence); depois post, comentário, convite, perfil, mensagem, resposta e boas-vindas; sem
 * nenhum, um pedido que termina em "?" (ou é uma dúvida) vira pergunta; senão, outro. Os
 * marcadores do MockRunner ("[aprovar]") são ignorados.
 */
export function deduceForYouType(prompt: string, types: readonly DeducibleType[] = []): ForYouType {
  const text = plain(prompt).replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  const named = types
    // Os embutidos e os de antes (que têm palavras próprias, com prioridade) ficam de fora.
    .filter((type) => type.id !== "pergunta" && type.id !== "outro" && !TYPE_WORDS.some(([id]) => id === type.id))
    .map((type) => ({ id: type.id, word: plain(type.name).trim() }))
    .filter((type) => type.word.length >= 3)
    .sort((a, b) => b.word.length - a.word.length)
    .find((type) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(type.word)}s?([^a-z0-9]|$)`).test(text));
  if (named) return named.id;
  for (const [type, pattern] of TYPE_WORDS) if (pattern.test(text)) return type;
  if (text.endsWith("?") || QUESTION_START.test(text) || DOUBT_WORDS.test(text)) return "pergunta";
  return "outro";
}

const ID_PATTERN = /^A-(\d+)$/;
export const FOR_YOU_ID_PATTERN = /^A-\d{4,}$/;

/** Próximo id ("A-0001", "A-0002"…): um a mais que o maior existente. */
export function nextForYouId(items: readonly Pick<ForYouItem, "id">[]): string {
  let max = 0;
  for (const item of items) {
    const match = ID_PATTERN.exec(item.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `A-${String(max + 1).padStart(4, "0")}`;
}

/** Última alteração do item (undefined = nunca foi alterado depois de criado). */
export function lastUpdate(item: Pick<ForYouItem, "history">): ForYouHistoryEntry | undefined {
  return item.history?.filter((entry) => entry.action === "alterado").at(-1);
}

/** "pelo Maestro", "por Clara" (o agente), "por você". */
export function actorLabel(by: ForYouActor, agentName?: string): string {
  if (by === "maestro") return "pelo Maestro";
  if (by === "usuario") return "por você";
  if (by === "servidor") return "pelo servidor";
  return agentName ? `por ${agentName}` : "pelo agente";
}

/** Itens esperando o usuário. */
export function pendingForYou(items: readonly ForYouItem[]): ForYouItem[] {
  return items.filter((item) => item.status === "pendente");
}
