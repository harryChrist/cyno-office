import {
  iconForText,
  nextFreeColor,
  type CreateForYouTypeBody,
  type ForYouTypeBehavior,
  type ForYouTypeColor,
  type ForYouTypeDef,
  type ForYouTypeIcon,
  type ForYouTypeLimits,
  type UpdateForYouTypeBody,
} from "@cyno/shared";

/** Lógica pura da janela "Tipos": o formulário de um tipo, a validação e os resumos da lista. */

export type WhereRow = { match: string; max: string; name: string };

export type TypeForm = {
  name: string;
  description: string;
  behavior: ForYouTypeBehavior;
  icon: ForYouTypeIcon;
  color: ForYouTypeColor;
  /** Limite padrão (texto do campo; vazio = sem limite). */
  limit: string;
  byWhere: WhereRow[];
  to: boolean;
  where: boolean;
};

export type TypeFormErrors = Partial<Record<"name" | "limit" | "byWhere", string>>;

const LIMIT_MAX = 100_000;

/** Formulário de um tipo (ou de um novo: ícone genérico e a próxima cor livre). */
export function formFromType(type: ForYouTypeDef | null, types: readonly ForYouTypeDef[]): TypeForm {
  if (!type) {
    return { name: "", description: "", behavior: "texto", icon: "documento", color: nextFreeColor(types), limit: "", byWhere: [], to: false, where: false };
  }
  return {
    name: type.name,
    description: type.description,
    behavior: type.behavior,
    icon: type.icon,
    color: type.color,
    limit: type.limits?.default !== undefined ? String(type.limits.default) : "",
    byWhere: (type.limits?.byWhere ?? []).map((rule) => ({ match: rule.match, max: String(rule.max), name: rule.name })),
    to: type.fields?.to === true,
    where: type.fields?.where === true,
  };
}

/** Ícone sugerido pelo nome (só enquanto o usuário não escolheu outro num tipo novo). */
export function suggestedIcon(name: string, description: string): ForYouTypeIcon {
  return iconForText(`${name} ${description}`);
}

function parseLimit(text: string): number | null | "invalid" {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed.replace(/\./g, ""));
  return Number.isInteger(value) && value >= 1 && value <= LIMIT_MAX ? value : "invalid";
}

type Parsed = { errors: TypeFormErrors; limits?: ForYouTypeLimits; fields?: { to?: boolean; where?: boolean } };

function parse(form: TypeForm): Parsed {
  const errors: TypeFormErrors = {};
  if (!form.name.trim()) errors.name = "Dê um nome ao tipo.";
  else if (form.name.trim().length > 40) errors.name = "Use até 40 caracteres.";
  const limit = parseLimit(form.limit);
  if (limit === "invalid") errors.limit = `Use um número inteiro de 1 a ${LIMIT_MAX.toLocaleString("pt-BR")}.`;
  const rows = form.byWhere.filter((row) => row.match.trim() || row.max.trim() || row.name.trim());
  const byWhere = rows.map((row) => ({ match: row.match.trim(), max: parseLimit(row.max), name: row.name.trim() || row.match.trim() }));
  if (byWhere.some((rule) => !rule.match || typeof rule.max !== "number")) {
    errors.byWhere = "Cada limite por \"onde\" precisa do começo do \"onde\" e de um máximo.";
  }
  const limits: ForYouTypeLimits = {
    ...(typeof limit === "number" ? { default: limit } : {}),
    ...(byWhere.length > 0 ? { byWhere: byWhere.map((rule) => ({ match: rule.match, max: rule.max as number, name: rule.name })) } : {}),
  };
  const fields = { ...(form.to ? { to: true } : {}), ...(form.where ? { where: true } : {}) };
  return {
    errors,
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  };
}

/** Corpo do POST (tipo novo) ou os erros do formulário. */
export function createBody(form: TypeForm): { body?: CreateForYouTypeBody; errors: TypeFormErrors } {
  const { errors, limits, fields } = parse(form);
  if (Object.keys(errors).length > 0) return { errors };
  return {
    errors,
    body: {
      name: form.name.trim(),
      description: form.description.trim(),
      behavior: form.behavior,
      icon: form.icon,
      color: form.color,
      ...(limits ? { limits } : {}),
      ...(fields ? { fields } : {}),
    },
  };
}

/** Corpo do PATCH (limites e campos vazios viram null: saem do tipo) ou os erros do formulário. */
export function updateBody(form: TypeForm): { body?: UpdateForYouTypeBody; errors: TypeFormErrors } {
  const { errors, limits, fields } = parse(form);
  if (Object.keys(errors).length > 0) return { errors };
  return {
    errors,
    body: {
      name: form.name.trim(),
      description: form.description.trim(),
      behavior: form.behavior,
      icon: form.icon,
      color: form.color,
      limits: limits ?? null,
      fields: fields ?? null,
    },
  };
}

const n = (value: number) => value.toLocaleString("pt-BR");

/** "até 200 caracteres", "headline 220 · Sobre 2.600" ou "sem limite". */
export function limitsSummary(type: Pick<ForYouTypeDef, "limits">): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const rule of type.limits?.byWhere ?? []) {
    const label = `${rule.name} ${n(rule.max)}`;
    if (!seen.has(label)) parts.push(label);
    seen.add(label);
  }
  if (type.limits?.default !== undefined) parts.push(parts.length > 0 ? `demais ${n(type.limits.default)}` : `até ${n(type.limits.default)} caracteres`);
  return parts.length > 0 ? parts.join(" · ") : "sem limite";
}

/** Quantos itens usam cada tipo. */
export function itemCounts(items: readonly { type: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
  return counts;
}

export const itemsLabel = (count: number) => (count === 0 ? "nenhum item" : count === 1 ? "1 item" : `${n(count)} itens`);
