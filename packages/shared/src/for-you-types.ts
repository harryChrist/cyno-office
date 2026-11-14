import { z } from "zod";
import { MAX_ID_LENGTH, SAFE_ID_PATTERN, slugify } from "./ids";

/**
 * Tipos de item do "Para você", próprios de cada workspace (for-you-types.json). Nascem com o
 * tempo: quase sempre pelo Maestro, quando o projeto precisa (ex.: "Reels"), e o usuário edita
 * depois. Todo workspace tem os embutidos "pergunta" e "outro" (o tipo de reserva).
 */

/** Como o card se comporta: "texto" = editar/aprovar/rejeitar/nota; "pergunta" = responder. */
export const FOR_YOU_TYPE_BEHAVIORS = ["texto", "pergunta"] as const;
export type ForYouTypeBehavior = (typeof FOR_YOU_TYPE_BEHAVIORS)[number];

export const FOR_YOU_TYPE_BEHAVIOR_LABELS: Record<ForYouTypeBehavior, string> = {
  texto: "Texto para aprovar",
  pergunta: "Pergunta para responder",
};

/** Quem criou o tipo. "system" = embutido ou registrado na migração. */
export const FOR_YOU_TYPE_CREATORS = ["maestro", "user", "system"] as const;
export type ForYouTypeCreator = (typeof FOR_YOU_TYPE_CREATORS)[number];

export const FOR_YOU_TYPE_CREATOR_LABELS: Record<ForYouTypeCreator, string> = {
  maestro: "Criado pelo Maestro",
  user: "Criado por você",
  system: "Do sistema",
};

/** Galeria fixa de ícones de traço (os desenhos ficam no web, em iconPaths.ts). */
export const FOR_YOU_TYPE_ICONS = [
  "interrogacao",
  "pessoa",
  "pessoa-mais",
  "sorriso",
  "balao",
  "responder",
  "comentario",
  "pagina",
  "ponto",
  "video",
  "imagem",
  "email",
  "calendario",
  "link",
  "estrela",
  "grafico",
  "megafone",
  "documento",
  "codigo",
  "bug",
  "carrinho",
  "telefone",
  "local",
  "lampada",
  "hashtag",
  "arroba",
  "marcador",
  "coracao",
  "bandeira",
  "escudo",
  "globo",
  "pessoas",
  "maleta",
] as const;
export type ForYouTypeIcon = (typeof FOR_YOU_TYPE_ICONS)[number];

/** Paleta fixa (ajustada ao tema escuro): a cor N usa o token `--ui-tc-N` (veja forYouTypeColorVar). */
export const FOR_YOU_TYPE_COLORS = ["azul", "ciano", "verde", "violeta", "anil", "laranja", "rosa", "ambar", "cinza", "coral"] as const;
export type ForYouTypeColor = (typeof FOR_YOU_TYPE_COLORS)[number];

export const FOR_YOU_TYPE_COLOR_LABELS: Record<ForYouTypeColor, string> = {
  azul: "Azul",
  ciano: "Ciano",
  verde: "Verde",
  violeta: "Violeta",
  anil: "Anil",
  laranja: "Laranja",
  rosa: "Rosa",
  ambar: "Âmbar",
  cinza: "Cinza",
  coral: "Coral",
};

/** `var(--ui-tc-N)` da cor (N começa em 1). */
export function forYouTypeColorVar(color: ForYouTypeColor): string {
  return `var(--ui-tc-${FOR_YOU_TYPE_COLORS.indexOf(color) + 1})`;
}

/** Limite por "onde": o "onde" do item começa com `match` (sem caixa nem acento). */
export type ForYouWhereLimit = { match: string; max: number; name: string };
export type ForYouTypeLimits = { default?: number; byWhere?: ForYouWhereLimit[] };
/** Campos que o tipo usa além do texto: "para" (destinatário) e "onde" (onde o texto sai). */
export type ForYouTypeFields = { to?: boolean; where?: boolean };

export type ForYouTypeDef = {
  /** Slug ("reels", "post"): é o que vai em ForYouItem.type e no `tipo` das ferramentas. */
  id: string;
  name: string;
  /** Quando usar: é o que o Maestro e os agentes leem para escolher o tipo. */
  description: string;
  behavior: ForYouTypeBehavior;
  limits?: ForYouTypeLimits;
  fields?: ForYouTypeFields;
  icon: ForYouTypeIcon;
  color: ForYouTypeColor;
  createdBy: ForYouTypeCreator;
  createdAt: string;
};

/** Embutidos de todo workspace: não podem ser excluídos nem mudar de comportamento. */
export const FOR_YOU_QUESTION_TYPE = "pergunta";
export const FOR_YOU_FALLBACK_TYPE = "outro";
export const BUILTIN_FOR_YOU_TYPES: readonly string[] = [FOR_YOU_QUESTION_TYPE, FOR_YOU_FALLBACK_TYPE];

export const isBuiltinForYouType = (id: string) => BUILTIN_FOR_YOU_TYPES.includes(id);

type TypePreset = Omit<ForYouTypeDef, "createdBy" | "createdAt">;

/**
 * Os 9 tipos de antes (fixos, do LinkedIn), com os mesmos rótulos, ícones, cores e limites. A
 * migração os registra no "principal" (e em workspaces que já têm itens desses tipos); nos outros,
 * servem de modelo quando um agente pede um deles e o tipo ainda não existe.
 */
export const LEGACY_FOR_YOU_TYPES: readonly TypePreset[] = [
  {
    id: "pergunta",
    name: "Pergunta",
    description: "Uma dúvida que só você pode responder: o agente espera a resposta para seguir.",
    behavior: "pergunta",
    icon: "interrogacao",
    color: "ambar",
  },
  {
    id: "perfil",
    name: "Perfil",
    description: "Trecho do perfil: headline, Sobre, experiência ou projeto (diga onde em \"onde\").",
    behavior: "texto",
    limits: {
      byWhere: [
        { match: "headline", max: 220, name: "headline" },
        { match: "titulo", max: 220, name: "headline" },
        { match: "sobre", max: 2600, name: "Sobre" },
        { match: "about", max: 2600, name: "Sobre" },
        { match: "experi", max: 2000, name: "experiência" },
        { match: "projeto", max: 2000, name: "projeto" },
      ],
    },
    fields: { where: true },
    icon: "pessoa",
    color: "azul",
  },
  {
    id: "convite",
    name: "Convite",
    description: "Convite de conexão para uma pessoa (diga para quem em \"para\").",
    behavior: "texto",
    limits: { default: 200 },
    fields: { to: true },
    icon: "pessoa-mais",
    color: "ciano",
  },
  {
    id: "boas-vindas",
    name: "Boas-vindas",
    description: "Mensagem de boas-vindas para quem acabou de se conectar.",
    behavior: "texto",
    limits: { default: 300 },
    fields: { to: true },
    icon: "sorriso",
    color: "verde",
  },
  {
    id: "mensagem",
    name: "Mensagem",
    description: "Mensagem direta para uma pessoa.",
    behavior: "texto",
    limits: { default: 1000 },
    fields: { to: true },
    icon: "balao",
    color: "violeta",
  },
  {
    id: "resposta",
    name: "Resposta",
    description: "Resposta numa conversa ou a um comentário.",
    behavior: "texto",
    limits: { default: 1000 },
    icon: "responder",
    color: "anil",
  },
  {
    id: "comentario",
    name: "Comentário",
    description: "Comentário no post de alguém (diga qual em \"onde\").",
    behavior: "texto",
    fields: { where: true },
    icon: "comentario",
    color: "laranja",
  },
  {
    id: "post",
    name: "Post",
    description: "Post para publicar no feed.",
    behavior: "texto",
    fields: { where: true },
    icon: "pagina",
    color: "rosa",
  },
  {
    id: "outro",
    name: "Outro",
    description: "O que não se encaixa em nenhum outro tipo.",
    behavior: "texto",
    icon: "ponto",
    color: "cinza",
  },
];

/** Cópia funda (os tipos são JSON puro). */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const presetOf = (id: string) => LEGACY_FOR_YOU_TYPES.find((preset) => preset.id === id);

/** Os embutidos (pergunta e outro), como nascem num workspace novo. */
export function builtinForYouTypes(createdAt: string): ForYouTypeDef[] {
  return BUILTIN_FOR_YOU_TYPES.map((id) => ({ ...clone(presetOf(id)!), createdBy: "system" as const, createdAt }));
}

/** Os 9 tipos de antes, registrados pela migração. */
export function legacyForYouTypes(createdAt: string): ForYouTypeDef[] {
  return LEGACY_FOR_YOU_TYPES.map((preset) => ({ ...clone(preset), createdBy: "system" as const, createdAt }));
}

const plain = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** Limite de caracteres do texto. null = sem limite. */
export type ForYouLimit = { max: number; name: string };

/**
 * Limite do texto pelo tipo e pelo "onde": o primeiro `byWhere` cujo `match` é prefixo do "onde"
 * (sem caixa nem acento); senão o `default` (com o nome do tipo); senão nenhum.
 */
export function forYouLimit(type: Pick<ForYouTypeDef, "name" | "limits"> | undefined, where?: string): ForYouLimit | null {
  if (!type?.limits) return null;
  const place = plain((where ?? "").trim());
  for (const rule of type.limits.byWhere ?? []) {
    if (place && place.startsWith(plain(rule.match.trim()))) return { max: rule.max, name: rule.name };
  }
  return type.limits.default !== undefined ? { max: type.limits.default, name: type.name.toLowerCase() } : null;
}

/**
 * Caracteres de um texto, como o contador do "Para você" conta e o server confere: por code point
 * (um emoji conta 1, não 2 como em `.length`). Web e server usam só esta função, para concordarem.
 */
export function forYouTextLength(text: string): number {
  return Array.from(text).length;
}

/** Os primeiros `max` caracteres (contados como forYouTextLength). */
export function sliceForYouText(text: string, max: number): string {
  return Array.from(text).slice(0, Math.max(0, max)).join("");
}

/** 2450 -> "2.450" (milhar com ponto, como no pt-BR; sem depender do ICU). */
export function formatCharCount(count: number): string {
  return String(Math.trunc(count)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** Quanto o texto passou do limite do tipo (null = cabe ou o tipo não tem limite). */
export type ForYouOverLimit = { limit: ForYouLimit; length: number; over: number };

export function forYouOverLimit(type: Pick<ForYouTypeDef, "name" | "limits"> | undefined, text: string, where?: string): ForYouOverLimit | null {
  const limit = forYouLimit(type, where);
  if (!limit) return null;
  const length = forYouTextLength(text);
  return length > limit.max ? { limit, length, over: length - limit.max } : null;
}

/**
 * "Limite: 2.200 caracteres" ou os limites por "onde" (para o agente que escreve). null = sem
 * limite.
 */
export function forYouLimitsText(limits: ForYouTypeLimits | undefined): string | null {
  if (!limits) return null;
  const lines: string[] = [];
  const rules = limits.byWhere ?? [];
  if (rules.length > 0) {
    const parts = rules.map((rule) => `"${rule.match}…" (${rule.name}) = ${formatCharCount(rule.max)}`);
    lines.push(`Limites conforme o "onde": ${parts.join("; ")} caracteres.`);
  }
  if (limits.default !== undefined) lines.push(`${rules.length > 0 ? "Nos outros casos, limite" : "Limite"}: ${formatCharCount(limits.default)} caracteres.`);
  return lines.length > 0 ? lines.join(" ") : null;
}

/** Tipo existente pelo que o agente mandou: o id, o slug ou o nome (sem caixa nem acento). */
export function findForYouType<T extends Pick<ForYouTypeDef, "id" | "name">>(types: readonly T[], raw: string): T | undefined {
  const id = forYouTypeIdFrom(raw);
  const name = plain(raw.trim());
  return types.find((type) => type.id === raw || type.id === id) ?? types.find((type) => plain(type.name) === name);
}

/**
 * Tipo que um pedido de aprovação vai usar (sem criar nada): o existente; senão o modelo de um
 * dos 9 de antes (que o pedido criaria com os mesmos limites); senão undefined (tipo novo, sem
 * limite). Sem `raw`, o "outro".
 */
export function forYouTypeForRequest(
  types: readonly ForYouTypeDef[],
  raw: string | undefined,
): Pick<ForYouTypeDef, "id" | "name" | "description" | "limits" | "behavior"> | undefined {
  const wanted = raw?.trim() || FOR_YOU_FALLBACK_TYPE;
  return findForYouType(types, wanted) ?? presetOf(forYouTypeIdFrom(wanted));
}

/** Limite de um dos tipos de antes (o MockRunner usa para os rascunhos caberem). */
export function legacyForYouLimit(typeId: string, where?: string): ForYouLimit | null {
  return forYouLimit(presetOf(typeId), where);
}

/**
 * Palavras que dão o ícone de um tipo novo (pelo nome e pela descrição), na ordem de prioridade.
 * Sem nenhuma, o tipo ganha "documento".
 */
const ICON_WORDS: readonly [ForYouTypeIcon, RegExp][] = [
  ["video", /\b(videos?|reels?|shorts?|youtube|tiktok|stories|story|lives?|vlog)\b/],
  ["imagem", /\b(imagens?|fotos?|carross[eé]is|carrossel|banners?|artes?|thumbnails?|thumbs?|capas?|ilustrac\w*|design)\b/],
  ["email", /\b(e-?mails?|newsletters?)\b/],
  ["calendario", /\b(eventos?|agendas?|agendamentos?|reunio\w*|reuniao|calendarios?|webinars?)\b/],
  ["link", /\b(links?|urls?|backlinks?)\b/],
  ["estrela", /\b(avaliac\w*|reviews?|depoimentos?|destaques?|feedbacks?)\b/],
  ["grafico", /\b(relatorios?|metricas?|graficos?|dados|analytics|dashboards?|kpis?)\b/],
  ["megafone", /\b(anuncios?|campanhas?|divulgac\w*|ads|press|release|lancamentos?)\b/],
  ["codigo", /\b(codigos?|pull|prs?|deploys?|scripts?|commits?|api)\b/],
  ["bug", /\b(bugs?|erros?|issues?|falhas?|incidentes?)\b/],
  ["carrinho", /\b(produtos?|pedidos? de compra|compras?|vendas?|lojas?|ofertas?|precos?)\b/],
  ["telefone", /\b(ligac\w*|telefon\w*|whatsapp|sms|chamadas?)\b/],
  ["local", /\b(enderecos?|locais|local|mapas?|lugares?)\b/],
  ["lampada", /\b(ideias?|sugest\w*|brainstorms?|pautas?)\b/],
  ["hashtag", /\b(hashtags?|tags?)\b/],
  ["arroba", /\b(tweets?|twitter|threads?|mencoes|mencao)\b/],
  ["coracao", /\b(curtidas?|likes?|agradeciment\w*)\b/],
  ["bandeira", /\b(metas?|objetivos?|marcos?|okrs?)\b/],
  ["escudo", /\b(seguranca|privacidade|senhas?|acessos?|permiss\w*)\b/],
  ["globo", /\b(sites?|web|seo|traduc\w*|idiomas?|landing)\b/],
  ["pessoas", /\b(equipes?|grupos?|comunidades?|times?)\b/],
  ["maleta", /\b(vagas?|empregos?|propostas?|clientes?|candidatur\w*|contratos?)\b/],
  ["sorriso", /\bboas[\s-]vindas\b/],
  ["pessoa-mais", /\b(convites?|conex\w*)\b/],
  ["responder", /\brespostas?\b/],
  ["comentario", /\bcomentarios?\b/],
  ["balao", /\b(mensage(m|ns)|dms?|chats?|directs?)\b/],
  ["pessoa", /\b(perf(il|is)|bios?|headlines?)\b/],
  ["pagina", /\b(posts?|publicac\w*|artigos?|blogs?)\b/],
  ["documento", /\b(documentos?|roteiros?|textos?|copys?|legendas?)\b/],
  ["interrogacao", /\b(perguntas?|duvidas?)\b/],
];

/** Ícone da galeria para um texto (nome + descrição do tipo). */
export function iconForText(text: string): ForYouTypeIcon {
  const words = plain(text);
  for (const [icon, pattern] of ICON_WORDS) if (pattern.test(words)) return icon;
  return "documento";
}

/**
 * Próxima cor livre da paleta (o cinza fica para o "outro"); com todas em uso, a menos usada
 * (empate: a primeira da paleta).
 */
export function nextFreeColor(types: readonly Pick<ForYouTypeDef, "color">[]): ForYouTypeColor {
  const candidates = FOR_YOU_TYPE_COLORS.filter((color) => color !== "cinza");
  const uses = new Map<ForYouTypeColor, number>(candidates.map((color) => [color, 0]));
  for (const type of types) if (uses.has(type.color)) uses.set(type.color, uses.get(type.color)! + 1);
  let best = candidates[0]!;
  for (const color of candidates) if (uses.get(color)! < uses.get(best)!) best = color;
  return best;
}

/** "reels-curtos" -> "Reels curtos"; um nome com espaços ou maiúsculas fica como veio. */
export function forYouTypeNameFrom(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  const base = /[\sA-ZÀ-Ý]/.test(trimmed) ? trimmed : trimmed.replace(/[-_]+/g, " ");
  const name = base.charAt(0).toUpperCase() + base.slice(1);
  return name.slice(0, FOR_YOU_TYPE_NAME_MAX) || "Outro";
}

/** Id (slug) de um tipo a partir do que o agente mandou ("Reels curtos" -> "reels-curtos"). */
export function forYouTypeIdFrom(raw: string): string {
  return slugify(raw, FOR_YOU_FALLBACK_TYPE).slice(0, FOR_YOU_TYPE_ID_MAX).replace(/-+$/g, "") || FOR_YOU_FALLBACK_TYPE;
}

/**
 * Tipo criado na hora quando um pedido de aprovação usa um tipo que o workspace não tem (nunca
 * falha): um dos 9 de antes vem do modelo; os outros ganham comportamento "texto", ícone pelas
 * palavras do nome e a próxima cor livre.
 */
export function autoForYouType(
  raw: string,
  types: readonly ForYouTypeDef[],
  createdAt: string,
  createdBy: ForYouTypeCreator = "maestro",
): ForYouTypeDef {
  const id = forYouTypeIdFrom(raw);
  const preset = presetOf(id);
  if (preset) {
    const taken = types.some((type) => type.color === preset.color);
    return { ...clone(preset), color: taken ? nextFreeColor(types) : preset.color, createdBy, createdAt };
  }
  const name = forYouTypeNameFrom(raw);
  return {
    id,
    name,
    description: `Criado quando um agente pediu aprovação de "${name}". Edite para dizer quando usar.`,
    behavior: "texto",
    icon: iconForText(name),
    color: nextFreeColor(types),
    createdBy,
    createdAt,
  };
}

/** Nome do tipo (o id, se o tipo não existe mais). */
export function forYouTypeName(types: readonly Pick<ForYouTypeDef, "id" | "name">[] | null | undefined, id: string): string {
  return types?.find((type) => type.id === id)?.name ?? forYouTypeNameFrom(id);
}

/** O card responde (pergunta) ou aprova um texto? Sem o tipo, só o "pergunta" responde. */
export function forYouBehavior(types: readonly Pick<ForYouTypeDef, "id" | "behavior">[] | null | undefined, id: string): ForYouTypeBehavior {
  return types?.find((type) => type.id === id)?.behavior ?? (id === FOR_YOU_QUESTION_TYPE ? "pergunta" : "texto");
}

// ---------- Validação (zod) ----------

export const FOR_YOU_TYPE_ID_MAX = 40;
export const FOR_YOU_TYPE_NAME_MAX = 40;
const LIMIT_MAX = 100_000;

export const forYouTypeIdSchema = z
  .string()
  .max(MAX_ID_LENGTH)
  .regex(SAFE_ID_PATTERN, "id inválido: use letras minúsculas, números e hífens");

const typeNameSchema = z.string().trim().min(1).max(FOR_YOU_TYPE_NAME_MAX);
const typeDescriptionSchema = z.string().trim().max(500);
const limitNumber = z.number().int().min(1).max(LIMIT_MAX);

export const forYouWhereLimitSchema = z.object({
  match: z.string().trim().min(1).max(60),
  max: limitNumber,
  name: z.string().trim().min(1).max(40),
});

export const forYouTypeLimitsSchema = z.object({
  default: limitNumber.optional(),
  byWhere: z.array(forYouWhereLimitSchema).max(20).optional(),
});

export const forYouTypeFieldsSchema = z.object({ to: z.boolean().optional(), where: z.boolean().optional() });

export const forYouTypeDefSchema = z.object({
  id: forYouTypeIdSchema,
  name: typeNameSchema,
  description: typeDescriptionSchema,
  behavior: z.enum(FOR_YOU_TYPE_BEHAVIORS),
  limits: forYouTypeLimitsSchema.optional(),
  fields: forYouTypeFieldsSchema.optional(),
  icon: z.enum(FOR_YOU_TYPE_ICONS),
  color: z.enum(FOR_YOU_TYPE_COLORS),
  createdBy: z.enum(FOR_YOU_TYPE_CREATORS),
  createdAt: z.iso.datetime(),
}) satisfies z.ZodType<ForYouTypeDef>;

export const forYouTypesFileSchema = z.array(forYouTypeDefSchema);

/** POST /for-you/types (o usuário cria; id opcional: sai do nome). */
export const createForYouTypeBodySchema = z.strictObject({
  id: forYouTypeIdSchema.max(FOR_YOU_TYPE_ID_MAX).optional(),
  name: typeNameSchema,
  description: typeDescriptionSchema.optional(),
  behavior: z.enum(FOR_YOU_TYPE_BEHAVIORS).optional(),
  limits: forYouTypeLimitsSchema.optional(),
  fields: forYouTypeFieldsSchema.optional(),
  icon: z.enum(FOR_YOU_TYPE_ICONS).optional(),
  color: z.enum(FOR_YOU_TYPE_COLORS).optional(),
});

/** PATCH /for-you/types/:typeId (`null` em limits/fields tira os limites/campos). */
export const updateForYouTypeBodySchema = z.strictObject({
  name: typeNameSchema.optional(),
  description: typeDescriptionSchema.optional(),
  behavior: z.enum(FOR_YOU_TYPE_BEHAVIORS).optional(),
  limits: forYouTypeLimitsSchema.nullable().optional(),
  fields: forYouTypeFieldsSchema.nullable().optional(),
  icon: z.enum(FOR_YOU_TYPE_ICONS).optional(),
  color: z.enum(FOR_YOU_TYPE_COLORS).optional(),
});

/** POST /for-you/types/:typeId/merge: os itens vão para `into` e o tipo some. */
export const mergeForYouTypeBodySchema = z.strictObject({ into: forYouTypeIdSchema });

export const forYouTypeParamsSchema = z.object({ typeId: forYouTypeIdSchema });

export type CreateForYouTypeBody = z.input<typeof createForYouTypeBodySchema>;
export type UpdateForYouTypeBody = z.input<typeof updateForYouTypeBodySchema>;
export type MergeForYouTypeBody = z.input<typeof mergeForYouTypeBodySchema>;
