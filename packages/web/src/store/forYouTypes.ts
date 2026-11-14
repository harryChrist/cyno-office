import type { ForYouTypeDef, ServerEvent, ServerEventOf } from "@cyno/shared";

/** Tipos do "Para você" do workspace atual; null = ainda não carregados (GET /for-you/types). */
export type ForYouTypes = readonly ForYouTypeDef[] | null;

export type ForYouTypesEvent = ServerEventOf<"foryou-types:upserted" | "foryou-types:deleted">;

export function isForYouTypesEvent(event: ServerEvent): event is ForYouTypesEvent {
  return event.type === "foryou-types:upserted" || event.type === "foryou-types:deleted";
}

/** Aplica um evento foryou-types:* (os outros devolvem a mesma lista). Antes do GET, ignora. */
export function applyForYouTypesEvent(types: ForYouTypes, event: ServerEvent): ForYouTypes {
  if (types === null || !isForYouTypesEvent(event)) return types;
  if (event.type === "foryou-types:deleted") {
    return types.some((type) => type.id === event.id) ? types.filter((type) => type.id !== event.id) : types;
  }
  const index = types.findIndex((type) => type.id === event.forYouType.id);
  if (index === -1) return [...types, event.forYouType];
  return types.map((type, i) => (i === index ? event.forYouType : type));
}

/** O Maestro (ou um agente) criou um tipo agora: vira um aviso no sino. */
export function createdByMaestro(event: ServerEvent): ForYouTypeDef | null {
  return event.type === "foryou-types:upserted" && event.created === true && event.forYouType.createdBy === "maestro" ? event.forYouType : null;
}
