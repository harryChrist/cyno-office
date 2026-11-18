import {
  autoForYouType,
  builtinForYouTypes,
  deduceForYouType,
  FOR_YOU_FALLBACK_TYPE,
  FOR_YOU_TYPE_COLORS,
  FOR_YOU_TYPE_ICONS,
  forYouTypeDefSchema,
  forYouTypeIdFrom,
  iconForText,
  isBuiltinForYouType,
  legacyForYouTypes,
  nextFreeColor,
  type CreateForYouTypeBody,
  type ForYouItem,
  type ForYouTypeBehavior,
  type ForYouTypeColor,
  type ForYouTypeCreator,
  type ForYouTypeDef,
  type ForYouTypeFields,
  type ForYouTypeIcon,
  type ForYouTypeLimits,
  type ServerEvent,
  type UpdateForYouTypeBody,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { HttpError } from "../../platform/http/errors";
import type { StateManager } from "../../store/state-manager";
import { writeJsonAtomic } from "../../store/atomic-write";
import { LEGACY_WORKSPACE } from "../../store/legacy-layout";
import type { WriteQueue } from "../../store/write-queue";

export type ForYouTypesDeps = {
  /** data/workspaces/<id>/for-you-types.json */
  file: string;
  /** A mesma fila de escrita do workspace. */
  queue: WriteQueue;
  /** Itens do "Para você" (excluir/juntar tipos move os itens) e o hub do workspace. */
  state: Pick<StateManager, "readForYou" | "commit" | "publish" | "forYouArchive">;
  log: Pick<FastifyBaseLogger, "error">;
  now: () => Date;
};

/** O que o Maestro manda em `set_approval_type` (ícone e cor são só dicas). */
export type DefineForYouTypeInput = {
  name: string;
  description: string;
  behavior?: ForYouTypeBehavior;
  limits?: ForYouTypeLimits;
  fields?: ForYouTypeFields;
  icon?: string;
  color?: string;
};

export type DefineForYouTypeResult = {
  type: ForYouTypeDef;
  /** created = tipo novo; updated = o Maestro refinou um tipo dele/do sistema; kept = é do usuário, ficou como está. */
  outcome: "created" | "updated" | "kept";
};

/**
 * Tipos do arquivo (ou null, se ele ainda não existe) prontos para usar. Sem arquivo: o
 * "principal" e quem já tem itens de tipos que não são os embutidos ganham os 9 tipos de antes
 * (nada muda na tela); os outros nascem só com pergunta e outro. Sempre: os embutidos existem e
 * todo tipo usado por um item está registrado.
 */
export function migrateForYouTypes(
  stored: ForYouTypeDef[] | null,
  items: readonly ForYouItem[],
  workspaceId: string,
  now: string,
): { types: ForYouTypeDef[]; changed: boolean } {
  let changed = stored === null;
  let types: ForYouTypeDef[];
  if (stored === null) {
    const legacy = workspaceId === LEGACY_WORKSPACE.id || items.some((item) => !isBuiltinForYouType(item.type));
    types = legacy ? legacyForYouTypes(now) : builtinForYouTypes(now);
  } else {
    types = stored;
  }
  for (const builtin of builtinForYouTypes(now)) {
    if (types.some((type) => type.id === builtin.id)) continue;
    types.push(builtin);
    changed = true;
  }
  for (const item of items) {
    if (types.some((type) => type.id === item.type)) continue;
    types.push(autoForYouType(item.type, types, now, "system"));
    changed = true;
  }
  return { types, changed };
}

const plain = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

const isIcon = (value: string | undefined): value is ForYouTypeIcon => (FOR_YOU_TYPE_ICONS as readonly string[]).includes(value ?? "");
const isColor = (value: string | undefined): value is ForYouTypeColor => (FOR_YOU_TYPE_COLORS as readonly string[]).includes(value ?? "");

/**
 * Tipos do "Para você" de um workspace (for-you-types.json, escrita atômica pela fila do
 * workspace). Toda mudança publica `foryou-types:upserted`/`foryou-types:deleted`; excluir ou
 * juntar move os itens (foryou:upserted) antes de o tipo sumir. As mudanças em memória são
 * síncronas (o pedido de aprovação cria o tipo e o item no mesmo passo).
 */
export class ForYouTypesService {
  constructor(
    private types: ForYouTypeDef[],
    private readonly deps: ForYouTypesDeps,
  ) {}

  /** Tipos na ordem de criação. */
  list(): ForYouTypeDef[] {
    return structuredClone(this.types);
  }

  find(id: string): ForYouTypeDef | undefined {
    const type = this.types.find((candidate) => candidate.id === id);
    return type ? structuredClone(type) : undefined;
  }

  /**
   * Id do tipo para um pedido de aprovação (nunca falha): o tipo com esse id ou nome; se não
   * existe, cria na hora (veja autoForYouType) e avisa o web.
   */
  ensure(raw: string | undefined, createdBy: ForYouTypeCreator = "maestro"): string {
    const wanted = raw?.trim() || FOR_YOU_FALLBACK_TYPE;
    const existing = this.lookup(wanted);
    if (existing) return existing.id;
    const type = autoForYouType(wanted, this.types, this.deps.now().toISOString(), createdBy);
    this.types.push(type);
    void this.persist([{ type: "foryou-types:upserted", forYouType: structuredClone(type), created: true }]);
    return type.id;
  }

  /**
   * Tipo de um pedido de aprovação: o que o agente pediu, se existe e não é "outro". Quando veio
   * "outro", nada ou um tipo que o workspace não tem, tenta casar por `hints` (onde vai sair, para
   * quem, título, texto do pedido…, em ordem de força) com um tipo que já existe, antes de aceitar
   * "outro" ou de criar um tipo novo. Nunca falha.
   */
  resolve(raw: string | undefined, hints: readonly (string | undefined)[], fallbackPrompt: string, createdBy: ForYouTypeCreator = "maestro"): string {
    const wanted = raw?.trim();
    const existing = wanted ? this.lookup(wanted) : undefined;
    if (existing && existing.id !== FOR_YOU_FALLBACK_TYPE) return existing.id;
    for (const hint of hints) {
      if (!hint?.trim()) continue;
      const guess = deduceForYouType(hint, this.types);
      if (guess === FOR_YOU_FALLBACK_TYPE || guess === "pergunta") continue;
      if (this.types.some((type) => type.id === guess)) return guess;
      // O workspace ainda não tem o tipo (comentário, post, convite…): nasce o de sempre, com o nome e os limites de antes.
      const preset = legacyForYouTypes(this.deps.now().toISOString()).find((type) => type.id === guess);
      if (preset) {
        const created: ForYouTypeDef = { ...preset, createdBy: createdBy, color: nextFreeColor(this.types) };
        this.types.push(created);
        void this.persist([{ type: "foryou-types:upserted", forYouType: structuredClone(created), created: true }]);
        return created.id;
      }
    }
    return this.ensure(wanted || deduceForYouType(fallbackPrompt, this.types), createdBy);
  }

  /**
   * `set_approval_type` do Maestro: cria o tipo ou refina um que ele (ou o sistema) criou.
   * Um tipo do usuário não é mexido. Ícone e cor fora da galeria/paleta viram dica (ícone pelas
   * palavras; próxima cor livre).
   */
  define(input: DefineForYouTypeInput, createdBy: ForYouTypeCreator = "maestro"): DefineForYouTypeResult {
    const current = this.lookup(input.name);
    const icon = isIcon(input.icon) ? input.icon : undefined;
    const iconGuess = () => iconForText(`${input.icon ?? ""} ${input.name} ${input.description}`);
    if (!current) {
      const draft: ForYouTypeDef = {
        id: this.freeId(input.name),
        name: input.name.trim(),
        description: input.description.trim(),
        behavior: input.behavior ?? "texto",
        ...(input.limits ? { limits: input.limits } : {}),
        ...(input.fields ? { fields: input.fields } : {}),
        icon: icon ?? iconGuess(),
        color: isColor(input.color) ? input.color : nextFreeColor(this.types),
        createdBy,
        createdAt: this.deps.now().toISOString(),
      };
      const type = forYouTypeDefSchema.parse(draft);
      this.types.push(type);
      void this.persist([{ type: "foryou-types:upserted", forYouType: structuredClone(type), created: true }]);
      return { type: structuredClone(type), outcome: "created" };
    }
    if (current.createdBy === "user") return { type: structuredClone(current), outcome: "kept" };
    const next: ForYouTypeDef = forYouTypeDefSchema.parse({
      ...current,
      description: input.description.trim() || current.description,
      ...(input.behavior && !isBuiltinForYouType(current.id) ? { behavior: input.behavior } : {}),
      ...(input.limits ? { limits: input.limits } : {}),
      ...(input.fields ? { fields: input.fields } : {}),
      ...(icon ? { icon } : {}),
      ...(isColor(input.color) ? { color: input.color } : {}),
    });
    this.replace(next);
    void this.persist([{ type: "foryou-types:upserted", forYouType: structuredClone(next) }]);
    return { type: structuredClone(next), outcome: "updated" };
  }

  /** O usuário cria um tipo (409 se o id já existe). */
  async create(body: CreateForYouTypeBody): Promise<ForYouTypeDef> {
    const id = body.id ?? forYouTypeIdFrom(body.name);
    if (this.types.some((type) => type.id === id)) throw new HttpError(409, `Já existe um tipo com o id "${id}"`);
    const description = body.description?.trim() ?? "";
    const type = forYouTypeDefSchema.parse({
      id,
      name: body.name.trim(),
      description,
      behavior: body.behavior ?? "texto",
      ...(body.limits ? { limits: body.limits } : {}),
      ...(body.fields ? { fields: body.fields } : {}),
      icon: body.icon ?? iconForText(`${body.name} ${description}`),
      color: body.color ?? nextFreeColor(this.types),
      createdBy: "user",
      createdAt: this.deps.now().toISOString(),
    } satisfies ForYouTypeDef);
    this.types.push(type);
    await this.persist([{ type: "foryou-types:upserted", forYouType: structuredClone(type), created: true }]);
    return structuredClone(type);
  }

  /** Edita um tipo (`null` tira limites/campos). Os embutidos não mudam de comportamento. */
  async update(id: string, patch: UpdateForYouTypeBody): Promise<ForYouTypeDef> {
    const current = this.require(id);
    if (patch.behavior !== undefined && patch.behavior !== current.behavior && isBuiltinForYouType(id)) {
      throw new HttpError(409, `O tipo "${current.name}" é do sistema: o comportamento dele não muda`);
    }
    const merged: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    const next = forYouTypeDefSchema.parse(merged);
    this.replace(next);
    await this.persist([{ type: "foryou-types:upserted", forYouType: structuredClone(next) }]);
    return structuredClone(next);
  }

  /** Exclui um tipo: os itens dele vão para "outro". Os embutidos não saem (409). */
  async remove(id: string): Promise<void> {
    await this.dissolve(id, FOR_YOU_FALLBACK_TYPE);
  }

  /** Junta `id` em `into`: os itens vão para `into` e `id` some. Devolve o tipo que ficou. */
  async merge(id: string, into: string): Promise<ForYouTypeDef> {
    if (id === into) throw new HttpError(400, "Escolha outro tipo para juntar");
    const target = this.require(into);
    await this.dissolve(id, target.id);
    return structuredClone(target);
  }

  /** Grava o arquivo inteiro (a migração do boot usa). */
  save(): Promise<void> {
    return this.persist([]);
  }

  private async dissolve(id: string, movedTo: string): Promise<void> {
    const type = this.require(id);
    if (isBuiltinForYouType(id)) throw new HttpError(409, `O tipo "${type.name}" é do sistema e não pode sair`);
    const items = this.deps.state.readForYou();
    const moved = items.filter((item) => item.type === id);
    for (const item of moved) item.type = movedTo;
    const writes: Promise<unknown>[] = [];
    // Os itens já arquivados do tipo que sai também passam para o novo (o arquivo não pode ficar com um tipo que não existe mais).
    writes.push(this.deps.state.forYouArchive.retype(id, movedTo));
    if (moved.length > 0) {
      writes.push(this.deps.state.commit({ forYou: items, events: moved.map((item): ServerEvent => ({ type: "foryou:upserted", item })) }));
    }
    this.types = this.types.filter((candidate) => candidate.id !== id);
    writes.push(this.persist([{ type: "foryou-types:deleted", id, movedTo }]));
    await Promise.all(writes);
  }

  /** Tipo pelo id ou pelo nome (sem caixa nem acento). */
  private lookup(raw: string): ForYouTypeDef | undefined {
    const id = forYouTypeIdFrom(raw);
    const name = plain(raw);
    return this.types.find((type) => type.id === raw || type.id === id) ?? this.types.find((type) => plain(type.name) === name);
  }

  private freeId(name: string): string {
    const base = forYouTypeIdFrom(name);
    if (!this.types.some((type) => type.id === base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`;
      if (!this.types.some((type) => type.id === candidate)) return candidate;
    }
  }

  private replace(next: ForYouTypeDef): void {
    this.types = this.types.map((type) => (type.id === next.id ? next : type));
  }

  private require(id: string): ForYouTypeDef {
    const type = this.types.find((candidate) => candidate.id === id);
    if (!type) throw new HttpError(404, `Tipo "${id}" não encontrado`);
    return type;
  }

  /** Publica os eventos e grava o arquivo. A promessa nunca rejeita (a falha vai para o log). */
  private persist(events: ServerEvent[]): Promise<void> {
    for (const event of events) this.deps.state.publish(event);
    const data = structuredClone(this.types);
    return this.deps.queue
      .enqueue(() => writeJsonAtomic(this.deps.file, data))
      .catch((error: unknown) => this.deps.log.error({ err: error }, "falha ao gravar os tipos do Para você"));
  }
}
